/**
 * DingTalk Bridge Extension
 *
 * Drives a Prime Agent session from DingTalk, and lets a group watch it happen.
 *
 *   private chat        conversational — an allowlisted user talks to the agent 1:1
 *   group (mirror)      spectator — every question and answer is broadcast, nothing is injected
 *   group (interactive) opt-in — allowlisted users may also drive the agent from the group
 *
 * Inbound uses DingTalk Stream mode, so no public callback URL is needed. Outbound replies go
 * back through the originating conversation's session webhook, falling back to the proactive
 * robot APIs, and optionally stream into an AI card.
 *
 * Setup and configuration: see README.md next to this file.
 *
 * Usage — one JSON file per bot, chosen at launch:
 *   prime-agent --dingtalk-config ~/bots/team-a.json
 *
 * Environment variables (DINGTALK_*) work too, and fill in whatever the file omits.
 * With neither, the extension stays silent, so it is safe to install globally.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DingTalkConfig, isConfigured, resolveConfig } from "./config.js";
import { CONFIG_FLAG, checkGitExposure, defaultAgentDir, discoverConfigPath, readConfigFile } from "./config-file.js";
import { DingTalkApi } from "./dingtalk-api.js";
import { formatAnswer, formatQuestion, splitMarkdown, summarize } from "./markdown.js";
import { InboundRouter, mirrorTargets, parseBridgeCommand, ReplyQueue } from "./router.js";
import { acquireBotLock, type InstanceLock } from "./single-instance.js";
import { DingTalkStreamClient } from "./stream-client.js";
import { lastAssistantText } from "./transcript.js";
import type { BridgeCommand, InboundMessage, OutboundMessage, ReplyTarget } from "./types.js";

/** Minimum gap between two AI-card streaming updates. */
const CARD_THROTTLE_MS = 700;

/** Thinking levels a chat user may name. Kept here so the reply can list them. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/**
 * Parameters for the image tool, written as plain JSON Schema.
 *
 * The host builds these with typebox, but this bridge takes no npm dependencies — including the
 * host's — so that it keeps loading from `~/.prime/agent/extensions/` with nothing installed.
 */
const SEND_IMAGE_PARAMS = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: "Path to an existing image file. Relative paths resolve against the working directory.",
		},
		caption: {
			type: "string",
			description: "Optional line of text sent just before the image.",
		},
		alsoGroups: {
			type: "boolean",
			description:
				"Also send to the spectator groups. Off by default: a terminal run is watched in the terminal, so pushing its screenshots to a group is noise.",
		},
	},
	required: ["path"],
	additionalProperties: false,
};

interface CardSession {
	outTrackId: string;
	target: ReplyTarget;
	buffer: string;
	lastPushAt: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Cleared when a card call fails, so the run falls back to a plain message. */
	active: boolean;
}

export default function dingTalkExtension(pi: ExtensionAPI): void {
	pi.registerFlag(CONFIG_FLAG, {
		description: "Path to a DingTalk bridge config file (one per bot)",
		type: "string",
	});

	// Resolved on session_start: CLI flags are not available while the factory runs.
	let config: DingTalkConfig | undefined;

	let context: ExtensionContext | undefined;
	let api: DingTalkApi | undefined;
	let stream: DingTalkStreamClient | undefined;
	let router: InboundRouter | undefined;
	const queue = new ReplyQueue();

	let botLock: InstanceLock | undefined;
	let progressTimer: ReturnType<typeof setTimeout> | undefined;
	let card: CardSession | undefined;

	const log = (level: "info" | "warn" | "error", message: string) => {
		const line = `[dingtalk] ${message}`;
		if (context?.hasUI) {
			context.ui.notify(line, level === "error" ? "error" : level === "warn" ? "warning" : "info");
		} else {
			console.error(line);
		}
	};

	/** Fire-and-forget delivery: a DingTalk outage must never break the agent loop. */
	const deliver = async (send: () => Promise<void>, what: string) => {
		try {
			await send();
		} catch (error) {
			log("error", `${what} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const sendChunked = async (target: ReplyTarget, title: string, text: string, cfg: DingTalkConfig) => {
		if (!api) return;
		const chunks = splitMarkdown(text, cfg.maxChars);
		for (const [index, chunk] of chunks.entries()) {
			const message: OutboundMessage = {
				title: chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title,
				text: chunk,
				atUserIds: target.askerStaffId ? [target.askerStaffId] : undefined,
			};
			await api.sendToTarget(target, message);
		}
	};

	const mirror = async (title: string, text: string, exclude: string | undefined, cfg: DingTalkConfig) => {
		if (!api) return;
		const groups = mirrorTargets(cfg, exclude);
		if (groups.length === 0) return;
		const chunks = splitMarkdown(text, cfg.maxChars);
		for (const conversationId of groups) {
			for (const [index, chunk] of chunks.entries()) {
				await deliver(
					() =>
						api!.sendToGroup(conversationId, {
							title: chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title,
							text: chunk,
						}),
					`mirror to ${conversationId}`,
				);
			}
		}
	};

	const clearProgressTimer = () => {
		if (progressTimer) {
			clearTimeout(progressTimer);
			progressTimer = undefined;
		}
	};

	const finishCard = async (text: string): Promise<boolean> => {
		const session = card;
		card = undefined;
		if (!session || !session.active || !api) return false;
		if (session.timer) clearTimeout(session.timer);
		try {
			await api.streamCard(session.outTrackId, text, { finalize: true });
			return true;
		} catch (error) {
			log(
				"warn",
				`card finalize failed, falling back to a plain message: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
	};

	const pushCard = (session: CardSession) => {
		if (!api || !session.active) return;
		const now = Date.now();
		const wait = Math.max(0, session.lastPushAt + CARD_THROTTLE_MS - now);
		if (session.timer) return;
		session.timer = setTimeout(() => {
			session.timer = undefined;
			session.lastPushAt = Date.now();
			void api!.streamCard(session.outTrackId, session.buffer).catch((error) => {
				session.active = false;
				log("warn", `card streaming stopped: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, wait);
	};

	/** `provider/id`, the form a chat user can type back at the bridge. */
	const modelLabel = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

	/**
	 * Answer `/model`, the one terminal affordance a chat has no substitute for.
	 *
	 * A picker needs a screen, so the query is matched as a substring and an ambiguous one lists
	 * its candidates rather than guessing: silently landing on the wrong model is worse than
	 * asking again.
	 */
	const handleModelCommand = async (query: string | undefined, target: ReplyTarget, cfg: DingTalkConfig) => {
		if (!context) return;
		const available = context.modelRegistry?.getAvailable() ?? [];
		const current = context.model;
		const currentLine = current ? `当前模型：\`${modelLabel(current)}\`` : "当前没有选定模型。";

		if (!query) {
			await deliver(
				() =>
					sendChunked(
						target,
						"模型",
						`${currentLine}\n\n可用模型 ${available.length} 个。发送 \`/model <关键词>\` 切换，例如 \`/model sonnet\`。`,
						cfg,
					),
				"model reply",
			);
			return;
		}

		const needle = query.toLowerCase();
		const matches = available.filter(
			(model) => modelLabel(model).toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
		);

		if (matches.length === 0) {
			await deliver(
				() => sendChunked(target, "模型", `没有匹配 \`${query}\` 的可用模型。\n\n${currentLine}`, cfg),
				"model reply",
			);
			return;
		}

		// An exact id still wins when it is also a prefix of longer ids.
		const exact = matches.find(
			(model) => modelLabel(model).toLowerCase() === needle || model.id.toLowerCase() === needle,
		);
		const chosen = exact ?? (matches.length === 1 ? matches[0] : undefined);

		if (!chosen) {
			const shown = matches.slice(0, 15).map((model) => `- \`${modelLabel(model)}\``);
			const more =
				matches.length > shown.length
					? `\n\n…另有 ${matches.length - shown.length} 个未列出，请给更精确的关键词。`
					: "";
			await deliver(
				() =>
					sendChunked(
						target,
						"模型",
						`\`${query}\` 匹配到 ${matches.length} 个模型：\n\n${shown.join("\n")}${more}`,
						cfg,
					),
				"model reply",
			);
			return;
		}

		const switched = await pi.setModel(chosen);
		const text = switched
			? `已切换到 \`${modelLabel(chosen)}\`。`
			: `切换失败：\`${modelLabel(chosen)}\` 没有可用的凭证。\n\n${currentLine}`;
		await deliver(() => sendChunked(target, "模型", text, cfg), "model reply");
	};

	const handleThinkingCommand = async (level: string | undefined, target: ReplyTarget, cfg: DingTalkConfig) => {
		const current = pi.getThinkingLevel();
		if (!level) {
			await deliver(
				() =>
					sendChunked(
						target,
						"思考等级",
						`当前：\`${current}\`\n\n可选：${THINKING_LEVELS.map((value) => `\`${value}\``).join(" ")}\n\n发送 \`/thinking high\` 切换。`,
						cfg,
					),
				"thinking reply",
			);
			return;
		}

		const wanted = level.toLowerCase();
		if (!THINKING_LEVELS.includes(wanted as ThinkingLevelName)) {
			await deliver(
				() =>
					sendChunked(
						target,
						"思考等级",
						`\`${level}\` 不是有效等级。可选：${THINKING_LEVELS.map((value) => `\`${value}\``).join(" ")}`,
						cfg,
					),
				"thinking reply",
			);
			return;
		}

		pi.setThinkingLevel(wanted as ThinkingLevelName);
		// Read back rather than echo: the level is clamped to what the model actually supports.
		const applied = pi.getThinkingLevel();
		const text =
			applied === wanted
				? `思考等级已设为 \`${applied}\`。`
				: `已设为 \`${applied}\`（\`${wanted}\` 超出当前模型的能力，被收敛到这一级）。`;
		await deliver(() => sendChunked(target, "思考等级", text, cfg), "thinking reply");
	};

	const handleContextCommand = async (target: ReplyTarget, cfg: DingTalkConfig) => {
		const usage = context?.getContextUsage();
		if (!usage) {
			await deliver(() => sendChunked(target, "上下文", "当前拿不到上下文用量。", cfg), "context reply");
			return;
		}
		const used =
			usage.tokens === null
				? "刚压缩过，下一次回复前无法估算"
				: `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens（${usage.percent ?? "?"}%）`;
		await deliver(() => sendChunked(target, "上下文", `已用：${used}`, cfg), "context reply");
	};

	const handleCompactCommand = async (instructions: string | undefined, target: ReplyTarget, cfg: DingTalkConfig) => {
		if (!context) return;
		// compact() is fire-and-forget, so the outcome comes back through its callbacks.
		context.compact({
			customInstructions: instructions,
			onComplete: () => {
				void deliver(() => sendChunked(target, "压缩", "上下文压缩完成。", cfg), "compact reply");
			},
			onError: (error) => {
				void deliver(() => sendChunked(target, "压缩", `压缩失败：${error.message}`, cfg), "compact reply");
			},
		});
		await deliver(() => sendChunked(target, "压缩", "正在压缩上下文，完成后会通知你。", cfg), "compact reply");
	};

	const handleToolsCommand = async (target: ReplyTarget, cfg: DingTalkConfig) => {
		const active = pi.getActiveTools();
		const text =
			active.length === 0
				? "当前没有启用的工具。"
				: `启用中的工具 ${active.length} 个：\n\n${active.map((name) => `- \`${name}\``).join("\n")}`;
		await deliver(() => sendChunked(target, "工具", text, cfg), "tools reply");
	};

	const handleHelpCommand = async (target: ReplyTarget, cfg: DingTalkConfig) => {
		const bridge = [
			"**桥接命令**（在钉钉里直接生效）",
			"- `/stop` `/abort` `停` — 中止当前任务",
			"- `/status` `状态` — 是否忙、排队几条",
			"- `/model [关键词]` `模型` — 查看或切换模型",
			"- `/thinking [等级]` `思考` — 查看或切换思考等级",
			"- `/context` `上下文` — 上下文用量",
			"- `/compact [说明]` `压缩` — 压缩上下文",
			"- `/tools` `工具` — 已启用的工具",
			"- `/help` `帮助` — 本说明",
		].join("\n");

		const commands = pi.getCommands();
		const shown = commands
			.slice(0, 30)
			.map((command) => `- \`/${command.name}\`${command.description ? ` — ${command.description}` : ""}`);
		const more = commands.length > shown.length ? `\n\n…另有 ${commands.length - shown.length} 个未列出。` : "";
		const session = shown.length === 0 ? "" : `\n\n**会话命令**（作为提示词发给 Agent）\n${shown.join("\n")}${more}`;

		await deliver(() => sendChunked(target, "帮助", `${bridge}${session}`, cfg), "help reply");
	};

	/**
	 * Give the agent a way to show, not just tell.
	 *
	 * A skill that verifies a page can screenshot it, but the answer travels as markdown and a
	 * chat cannot open a local file, so the picture never arrives. Registered on session_start
	 * rather than at load time: an unconfigured session should not grow a DingTalk tool.
	 */
	const registerSendImageTool = (cfg: DingTalkConfig) => {
		pi.registerTool({
			name: "dingtalk_send_image",
			label: "发送图片到钉钉",
			description:
				"Send an existing local image file (screenshot, chart, rendered page) into the DingTalk " +
				"conversation that asked the current question, and into any spectator groups. Use it when " +
				"the user needs to *see* something rather than read a description of it. This tool does not " +
				"capture screenshots; take one first, then pass its path.",
			promptSnippet: "Send a local image file to the DingTalk conversation",
			promptGuidelines: [
				"Use after producing a screenshot the asker should look at, e.g. verifying a page renders correctly.",
				"The path must already exist. Relative paths resolve against the working directory.",
				"Prefer PNG or JPEG; DingTalk rejects anything it does not recognise as an image.",
			],
			parameters: SEND_IMAGE_PARAMS,
			async execute(_toolCallId: string, params: { path: string; caption?: string; alsoGroups?: boolean }) {
				if (!api) throw new Error("The DingTalk bridge is not active in this session.");

				const resolved = isAbsolute(params.path) ? params.path : resolvePath(context?.cwd ?? ".", params.path);
				let bytes: Buffer;
				try {
					bytes = readFileSync(resolved);
				} catch (error) {
					throw new Error(`Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (bytes.byteLength === 0) throw new Error(`${resolved} is empty.`);

				const mediaId = await api.uploadImage(bytes, basename(resolved));

				// Only the asker by default. A terminal run is already being watched in the terminal,
				// so mirroring its screenshots into a group is noise nobody asked for.
				const asker = queue.peek();
				const groups = params.alsoGroups ? mirrorTargets(cfg, asker?.conversationId) : [];
				const delivered: string[] = [];

				if (asker) {
					if (params.caption)
						await deliver(() => sendChunked(asker, "图片", params.caption!, cfg), "image caption");
					await api.sendImageToTarget(asker, mediaId);
					delivered.push(asker.conversationId);
				}
				for (const conversationId of groups) {
					await deliver(
						() => api!.sendImageToTarget({ conversationId, kind: "group" }, mediaId),
						`image to ${conversationId}`,
					);
					delivered.push(conversationId);
				}

				// Not an error: nothing was asked for from DingTalk, so nothing is owed to it.
				if (delivered.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `本次运行不是来自钉钉提问，未推送。图片在 ${resolved}。需要发到围观群请带 alsoGroups。`,
							},
						],
						details: { mediaId, conversations: [] },
					};
				}
				return {
					content: [
						{ type: "text" as const, text: `已把 ${basename(resolved)} 发送到 ${delivered.length} 个会话。` },
					],
					details: { mediaId, conversations: delivered },
				};
			},
			// The hand-written schema stands in for a typebox TSchema, which this file will not import.
		} as Parameters<ExtensionAPI["registerTool"]>[0]);
	};

	const handleBridgeCommand = async (command: BridgeCommand, target: ReplyTarget, cfg: DingTalkConfig) => {
		if (!context) return;
		if (command.kind === "stop") {
			queue.clear();
			await context.abort();
			await deliver(() => sendChunked(target, "已停止", "已中止当前任务。", cfg), "stop reply");
			return;
		}
		if (command.kind === "model") {
			await handleModelCommand(command.query, target, cfg);
			return;
		}
		if (command.kind === "thinking") {
			await handleThinkingCommand(command.query, target, cfg);
			return;
		}
		if (command.kind === "context") {
			await handleContextCommand(target, cfg);
			return;
		}
		if (command.kind === "compact") {
			await handleCompactCommand(command.query, target, cfg);
			return;
		}
		if (command.kind === "tools") {
			await handleToolsCommand(target, cfg);
			return;
		}
		if (command.kind === "help") {
			await handleHelpCommand(target, cfg);
			return;
		}
		const state = context.isIdle() ? "空闲" : "正在处理任务";
		const pending = queue.size;
		await deliver(
			() => sendChunked(target, "状态", `Agent ${state}。\n\n排队中的问题：${pending} 条。`, cfg),
			"status reply",
		);
	};

	const handleInbound = async (message: InboundMessage, cfg: DingTalkConfig) => {
		if (!router || !context) return;

		// Logged so a new user or spectator group can be wired up: @-mention the bot once,
		// then copy the staff id into DINGTALK_ALLOW_USERS or the conversation id into
		// DINGTALK_MIRROR_CONVERSATIONS.
		log(
			"info",
			`message from ${message.senderNick} (staffId=${message.senderStaffId || "unknown"}) in ${message.kind} ${message.conversationId}`,
		);

		const decision = router.decide(message);
		if (decision.action === "ignore") {
			log("info", `ignored: ${decision.reason}`);
			return;
		}
		if (decision.action === "notice") {
			await deliver(() => sendChunked(decision.target, cfg.botName, decision.notice, cfg), "notice");
			return;
		}

		const command = parseBridgeCommand(decision.text);
		if (command) {
			await handleBridgeCommand(command, decision.target, cfg);
			return;
		}

		const busy = !context.isIdle();
		queue.push(decision.target);

		await mirror(
			`👤 ${decision.target.askerNick ?? "用户"}`,
			formatQuestion(decision.target.askerNick ?? "用户", decision.text),
			decision.target.conversationId,
			cfg,
		);

		if (busy) {
			await deliver(
				() =>
					sendChunked(
						decision.target,
						"已排队",
						`Agent 正在处理上一个任务，你的问题排在第 ${queue.size} 位，完成后会自动回复。`,
						cfg,
					),
				"queue notice",
			);
			pi.sendUserMessage(decision.text, { deliverAs: cfg.streamingBehavior });
			return;
		}

		pi.sendUserMessage(decision.text);
	};

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;

		const target = discoverConfigPath({
			flag: pi.getFlag(CONFIG_FLAG) as string | undefined,
			env: process.env,
			cwd: ctx.cwd,
		});
		const fileResult = target ? readConfigFile(target) : { errors: [], warnings: [] };

		// Nothing points at this bridge, so this session simply does not want a bot.
		// Staying quiet is what makes the extension safe to install globally.
		if (!isConfigured(process.env, target !== undefined)) return;

		const resolved = resolveConfig({ env: process.env, file: fileResult.file });
		const gitWarning = target
			? await checkGitExposure(target.path, (command, args, options) => pi.exec(command, args, options))
			: undefined;
		for (const warning of [...fileResult.warnings, ...(gitWarning ? [gitWarning] : []), ...resolved.warnings]) {
			log("warn", warning);
		}

		const problems = [...fileResult.errors, ...resolved.errors];
		if (problems.length > 0 || !resolved.config) {
			for (const problem of problems) log("error", problem);
			log("error", "DingTalk bridge disabled. Fix the configuration above and restart.");
			return;
		}

		const active = resolved.config;

		// One connection per bot per machine. Reviving several sessions for the same bot splits
		// message delivery between them, and enough duplicates make the gateway drop connections
		// in a loop, so the later session declines instead of joining the fight.
		const claim = acquireBotLock({ dir: defaultAgentDir(process.env), clientId: active.clientId });
		if (!claim.lock) {
			log(
				"warn",
				`另一个会话（pid ${claim.heldBy}）已在运行这个机器人，本会话不连接钉钉。停掉那个会话后重启即可接管。`,
			);
			return;
		}
		botLock = claim.lock;

		config = active;
		if (target) log("info", `config loaded from ${target.path}`);

		api = new DingTalkApi(active);
		router = new InboundRouter(active);
		registerSendImageTool(active);
		stream = new DingTalkStreamClient(active, {
			onBotMessage: (message) => handleInbound(message, active),
			onUnsupported: (raw) => log("info", `ignored an unsupported message type: ${raw.msgtype}`),
			onLog: log,
		});

		await stream.start();
		log(
			"info",
			`bridge started · 群模式=${active.groupMode} · 围观群=${active.mirrorConversationIds.length} · 白名单=${active.allowUsers.length} 人`,
		);
	});

	// Mirror what a human types at the terminal. Never mirror source === "extension":
	// that is this bridge's own injection coming back around, and mirroring it would loop.
	pi.on("input", async (event) => {
		if (!config || event.source === "extension") return { action: "continue" as const };
		await mirror("👤 终端", formatQuestion("终端", event.text), undefined, config);
		return { action: "continue" as const };
	});

	pi.on("agent_start", async () => {
		if (!config || !api) return;
		const cfg = config;
		const target = queue.peek();

		if (cfg.progressAfterMs > 0 && target) {
			clearProgressTimer();
			progressTimer = setTimeout(() => {
				progressTimer = undefined;
				void deliver(
					() => sendChunked(target, "处理中", "任务还在进行中，完成后会把结果发给你。", cfg),
					"progress notice",
				);
			}, cfg.progressAfterMs);
		}

		if (cfg.cardTemplateId && target) {
			const outTrackId = randomUUID();
			try {
				await api.createCard(target, outTrackId, "…");
				card = { outTrackId, target, buffer: "", lastPushAt: 0, timer: undefined, active: true };
			} catch (error) {
				log(
					"warn",
					`card creation failed, falling back to plain messages: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	});

	pi.on("message_update", async (event) => {
		if (!card || !card.active) return;
		const delta = event.assistantMessageEvent;
		if (delta.type !== "text_delta") return;
		card.buffer += delta.delta;
		pushCard(card);
	});

	pi.on("tool_execution_start", async (event) => {
		if (!config || !config.mirrorTools) return;
		await mirror("🔧 工具", `**🔧 ${event.toolName}**`, undefined, config);
	});

	pi.on("agent_end", async (event) => {
		if (!config) return;
		const cfg = config;
		clearProgressTimer();

		const target = queue.shift();
		const answer = lastAssistantText(event.messages);
		if (answer.length === 0) {
			await finishCard("（本轮没有产生文本回复）");
			return;
		}

		const streamedToCard = await finishCard(answer);
		const title = target?.question ? `↩ ${summarize(target.question)}` : cfg.botName;

		if (target && !streamedToCard) {
			await deliver(() => sendChunked(target, title, answer, cfg), "reply");
		}

		await mirror(title, formatAnswer(target?.askerNick, answer, cfg.botName), target?.conversationId, cfg);
	});

	pi.on("session_shutdown", async () => {
		clearProgressTimer();
		if (card?.timer) clearTimeout(card.timer);
		card = undefined;
		stream?.stop();
		stream = undefined;
		botLock?.release();
		botLock = undefined;
	});
}
