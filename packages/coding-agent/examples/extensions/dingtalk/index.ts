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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DingTalkConfig, isConfigured, resolveConfig } from "./config.js";
import { CONFIG_FLAG, checkGitExposure, discoverConfigPath, readConfigFile } from "./config-file.js";
import { DingTalkApi } from "./dingtalk-api.js";
import { formatAnswer, formatQuestion, splitMarkdown, summarize } from "./markdown.js";
import { InboundRouter, mirrorTargets, parseBridgeCommand, ReplyQueue } from "./router.js";
import { DingTalkStreamClient } from "./stream-client.js";
import { lastAssistantText } from "./transcript.js";
import type { InboundMessage, OutboundMessage, ReplyTarget } from "./types.js";

/** Minimum gap between two AI-card streaming updates. */
const CARD_THROTTLE_MS = 700;

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

	const handleBridgeCommand = async (command: string, target: ReplyTarget, cfg: DingTalkConfig) => {
		if (!context) return;
		if (command === "stop") {
			queue.clear();
			await context.abort();
			await deliver(() => sendChunked(target, "已停止", "已中止当前任务。", cfg), "stop reply");
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
			await deliver(() => sendChunked(decision.target, "Prime Agent", decision.notice, cfg), "notice");
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
		config = active;
		if (target) log("info", `config loaded from ${target.path}`);

		api = new DingTalkApi(active);
		router = new InboundRouter(active);
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
		const title = target?.question ? `↩ ${summarize(target.question)}` : "Prime Agent";

		if (target && !streamedToCard) {
			await deliver(() => sendChunked(target, title, answer, cfg), "reply");
		}

		await mirror(title, formatAnswer(target?.askerNick, answer), target?.conversationId, cfg);
	});

	pi.on("session_shutdown", async () => {
		clearProgressTimer();
		if (card?.timer) clearTimeout(card.timer);
		card = undefined;
		stream?.stop();
		stream = undefined;
	});
}
