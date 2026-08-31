import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dingTalkExtension from "../examples/extensions/dingtalk/index.js";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.js";

const BOT_TOPIC = "/v1.0/im/bot/messages/get";

/** Minimal stand-in for the global WebSocket the stream client dials. */
class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly OPEN = 1;

	readyState = FakeSocket.OPEN;
	sent: string[] = [];
	private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		const existing = this.listeners.get(type) ?? [];
		existing.push(handler);
		this.listeners.set(type, existing);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}

	emit(type: string, event: unknown): void {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}

	/** Deliver a bot message frame the way the gateway would. */
	deliverBotMessage(payload: Record<string, unknown>, messageId = "frame-1"): void {
		this.emit("message", {
			data: JSON.stringify({
				type: "CALLBACK",
				headers: { topic: BOT_TOPIC, messageId },
				data: JSON.stringify(payload),
			}),
		});
	}
}

interface HttpCall {
	url: string;
	body: any;
}

function setupFetch() {
	const calls: HttpCall[] = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		// The media upload posts FormData, so a body is not always JSON.
		let body: any = init.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {}
		}
		calls.push({ url, body });
		if (url.includes("gateway/connections/open")) {
			return new Response(JSON.stringify({ endpoint: "wss://stream.invalid/ws", ticket: "ticket-1" }));
		}
		if (url.includes("oauth2/accessToken")) {
			return new Response(JSON.stringify({ accessToken: "token-abc", expireIn: 7200 }));
		}
		if (url.includes("media/upload")) {
			return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", media_id: "@lATestMedia" }));
		}
		return new Response(JSON.stringify({}));
	});
	return { calls, fetchImpl };
}

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function setupExtension(flags: Record<string, string> = {}) {
	const handlers = new Map<string, Handler[]>();
	const sendUserMessage = vi.fn();
	const setModel = vi.fn(async () => true);
	let thinkingLevel = "medium";
	const api = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		sendUserMessage,
		sendMessage: vi.fn(),
		setModel,
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: string) => {
			thinkingLevel = level;
		},
		getActiveTools: () => ["bash", "read"],
		getCommands: () => [{ name: "compact", description: "Compact the context" }],
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: (name: string) => flags[name],
		// The bridge probes git to warn about a committable config; report "ignored".
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
	} as unknown as ExtensionAPI;

	const availableModels = [
		{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
		{ id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
		{ id: "gpt-5", name: "GPT-5", provider: "openai" },
	];

	const abort = vi.fn(async () => {});
	const compact = vi.fn((options?: { onComplete?: (result: unknown) => void }) => options?.onComplete?.({}));
	let idle = true;
	const ctx = {
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd: sandboxDir,
		isIdle: () => idle,
		abort,
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		model: availableModels[0],
		modelRegistry: { getAvailable: () => availableModels },
		getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6 }),
		compact,
	} as unknown as ExtensionContext;

	const fire = async (event: string, payload: Record<string, unknown>) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};

	dingTalkExtension(api);
	return {
		api,
		ctx,
		fire,
		sendUserMessage,
		abort,
		setModel,
		compact,
		availableModels,
		getThinkingLevel: () => thinkingLevel,
		setIdle: (value: boolean) => (idle = value),
	};
}

function botMessage(overrides: Record<string, unknown> = {}) {
	return {
		msgtype: "text",
		text: { content: "跑一下测试" },
		msgId: `m-${Math.random()}`,
		conversationId: "conv-private",
		conversationType: "1",
		senderStaffId: "staff-alice",
		senderNick: "Alice",
		sessionWebhook: "https://oapi.invalid/session",
		sessionWebhookExpiredTime: Date.now() + 3_600_000,
		chatbotUserId: "bot-user",
		...overrides,
	};
}

function groupSends(calls: HttpCall[], conversationId: string) {
	return calls.filter(
		(call) => call.url.includes("groupMessages/send") && call.body.openConversationId === conversationId,
	);
}

function userSends(calls: HttpCall[]) {
	return calls.filter((call) => call.url.includes("oToMessages/batchSend"));
}

function webhookSends(calls: HttpCall[]) {
	return calls.filter((call) => call.url.includes("oapi.invalid/session"));
}

function textOf(call: HttpCall): string {
	if (call.body.markdown) return call.body.markdown.text;
	return JSON.parse(call.body.msgParam).text;
}

function titleOf(call: HttpCall): string {
	if (call.body.markdown) return call.body.markdown.title;
	return JSON.parse(call.body.msgParam).title;
}

/** Isolated cwd + agent dir, so a real ~/.prime/agent/dingtalk.json cannot leak into these tests. */
let sandboxDir: string;

describe("dingtalk bridge extension", () => {
	let calls: HttpCall[];

	beforeEach(() => {
		sandboxDir = mkdtempSync(join(tmpdir(), "dingtalk-ext-"));
		// A .git marker bounds the upward project-config search inside the sandbox.
		mkdirSync(join(sandboxDir, ".git"), { recursive: true });
		vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", sandboxDir);
		FakeSocket.instances = [];
		const fetchSetup = setupFetch();
		calls = fetchSetup.calls;
		vi.stubGlobal("fetch", fetchSetup.fetchImpl);
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubEnv("DINGTALK_CLIENT_ID", "app-key");
		vi.stubEnv("DINGTALK_CLIENT_SECRET", "app-secret");
		vi.stubEnv("DINGTALK_ALLOW_USERS", "staff-alice");
		vi.stubEnv("DINGTALK_MIRROR_CONVERSATIONS", "group-watch");
		vi.stubEnv("DINGTALK_GROUP_MODE", "mirror");
		vi.stubEnv("DINGTALK_PROGRESS_AFTER_MS", "0");
		vi.stubEnv("DINGTALK_CARD_TEMPLATE_ID", "");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(sandboxDir, { recursive: true, force: true });
	});

	async function start(flags: Record<string, string> = {}) {
		const harness = setupExtension(flags);
		await harness.fire("session_start", {});
		// The stream client no longer blocks session start on the gateway request, so give that
		// request a turn to settle before reaching for the socket it creates.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const socket = FakeSocket.instances[0];
		expect(socket).toBeDefined();
		socket.emit("open", {});
		return { ...harness, socket };
	}

	it("dials the stream gateway on session start", async () => {
		const { socket } = await start();
		expect(socket.url).toBe("wss://stream.invalid/ws?ticket=ticket-1");
	});

	it("acks a bot message frame before running the agent", async () => {
		const { socket } = await start();
		socket.deliverBotMessage(botMessage(), "frame-9");
		await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));

		expect(JSON.parse(socket.sent[0])).toMatchObject({ code: 200, headers: { messageId: "frame-9" } });
	});

	it("answers a ping with a pong ack", async () => {
		const { socket } = await start();
		socket.emit("message", {
			data: JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "p1" }, data: "{}" }),
		});

		expect(JSON.parse(socket.sent[0])).toMatchObject({ code: 200, headers: { messageId: "p1" } });
	});

	describe("private chat drives the agent", () => {
		it("injects the question and mirrors it to the spectator group", async () => {
			const { socket, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage());

			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("跑一下测试"));
			await vi.waitFor(() => expect(groupSends(calls, "group-watch")).toHaveLength(1));
			expect(textOf(groupSends(calls, "group-watch")[0])).toContain("👤 Alice");
			expect(textOf(groupSends(calls, "group-watch")[0])).toContain("跑一下测试");
		});

		it("queues instead of interrupting when the agent is mid-run", async () => {
			const { socket, sendUserMessage, setIdle } = await start();
			setIdle(false);
			socket.deliverBotMessage(botMessage());

			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("跑一下测试", { deliverAs: "followUp" }));
			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(titleOf(webhookSends(calls)[0])).toBe("已排队");
			expect(textOf(webhookSends(calls)[0])).toContain("排在第 1 位");
		});

		it("delivers the answer to the asker and mirrors it to the group", async () => {
			const { socket, fire, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage());
			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalled());

			const before = calls.length;
			await fire("agent_end", {
				messages: [{ role: "assistant", content: [{ type: "text", text: "测试通过" }] }],
			});

			const after = calls.slice(before);
			expect(webhookSends(after)).toHaveLength(1);
			expect(textOf(webhookSends(after)[0])).toBe("测试通过");
			expect(groupSends(after, "group-watch")).toHaveLength(1);
			expect(textOf(groupSends(after, "group-watch")[0])).toContain("回复 Alice");
		});

		it("refuses a sender outside the allowlist without touching the agent", async () => {
			const { socket, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage({ senderStaffId: "staff-mallory" }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("白名单");
			expect(sendUserMessage).not.toHaveBeenCalled();
		});
	});

	describe("group chat is a spectator", () => {
		it("does not inject a group message and says why once", async () => {
			const { socket, sendUserMessage } = await start();
			socket.deliverBotMessage(
				botMessage({ conversationId: "group-watch", conversationType: "2", text: { content: "@Bot 部署一下" } }),
			);

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("围观模式");
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("injects from a group when the group is switched to interactive", async () => {
			vi.stubEnv("DINGTALK_GROUP_MODE", "interactive");
			const { socket, sendUserMessage } = await start();
			socket.deliverBotMessage(
				botMessage({ conversationId: "group-work", conversationType: "2", text: { content: "@Bot 部署一下" } }),
			);

			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("部署一下"));
		});
	});

	describe("echo safety", () => {
		it("mirrors terminal input but never its own injected messages", async () => {
			const { fire } = await start();

			await fire("input", { text: "本地敲的指令", source: "interactive" });
			await vi.waitFor(() => expect(groupSends(calls, "group-watch")).toHaveLength(1));
			expect(textOf(groupSends(calls, "group-watch")[0])).toContain("终端");

			await fire("input", { text: "桥注入的指令", source: "extension" });
			expect(groupSends(calls, "group-watch")).toHaveLength(1);
		});

		it("ignores a message the bot itself posted", async () => {
			const { socket, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage({ senderStaffId: "bot-user" }));

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(webhookSends(calls)).toHaveLength(0);
		});

		it("ignores a redelivered frame", async () => {
			const { socket, sendUserMessage } = await start();
			const payload = botMessage({ msgId: "same-id" });

			socket.deliverBotMessage(payload);
			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
			socket.deliverBotMessage(payload);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(sendUserMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe("terminal-only runs", () => {
		it("mirrors the answer to the group when nobody asked from DingTalk", async () => {
			const { fire } = await start();

			await fire("agent_end", {
				messages: [{ role: "assistant", content: [{ type: "text", text: "本地任务完成" }] }],
			});

			expect(webhookSends(calls)).toHaveLength(0);
			expect(groupSends(calls, "group-watch")).toHaveLength(1);
			expect(textOf(groupSends(calls, "group-watch")[0])).toContain("本地任务完成");
		});
	});

	describe("bridge commands", () => {
		it("aborts the run on /stop without prompting the agent", async () => {
			const { socket, abort, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/stop" } }));

			await vi.waitFor(() => expect(abort).toHaveBeenCalled());
			expect(sendUserMessage).not.toHaveBeenCalled();
		});

		it("reports queue depth on /status", async () => {
			const { socket } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/status" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("空闲");
		});

		// Switching models used to require walking to the terminal: `/model` reached the agent as
		// a prompt, so the model answered a question about itself and nothing changed.
		it("reports the current model on /model without switching", async () => {
			const { socket, setModel } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/model" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("claude-opus-5");
			expect(setModel).not.toHaveBeenCalled();
		});

		it("switches to the only model matching the query", async () => {
			const { socket, setModel, availableModels, sendUserMessage } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/model sonnet" } }));

			await vi.waitFor(() => expect(setModel).toHaveBeenCalledWith(availableModels[1]));
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(textOf(webhookSends(calls)[0])).toContain("claude-sonnet-5");
		});

		it("lists the candidates instead of guessing when a query is ambiguous", async () => {
			const { socket, setModel } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/model claude" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			const text = textOf(webhookSends(calls)[0]);
			expect(text).toContain("claude-opus-5");
			expect(text).toContain("claude-sonnet-5");
			expect(setModel).not.toHaveBeenCalled();
		});

		it("says so when nothing matches", async () => {
			const { socket, setModel } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/model llama" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("没有匹配");
			expect(setModel).not.toHaveBeenCalled();
		});

		it("reports the failure when the model has no usable credentials", async () => {
			const harness = await start();
			harness.setModel.mockResolvedValueOnce(false);
			harness.socket.deliverBotMessage(botMessage({ text: { content: "/model gpt-5" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("切换失败");
		});

		it("switches the thinking level and reads back what was applied", async () => {
			const { socket, getThinkingLevel } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/thinking high" } }));

			await vi.waitFor(() => expect(getThinkingLevel()).toBe("high"));
			expect(textOf(webhookSends(calls)[0])).toContain("high");
		});

		it("refuses an unknown thinking level instead of guessing", async () => {
			const { socket, getThinkingLevel } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/thinking turbo" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("不是有效等级");
			expect(getThinkingLevel()).toBe("medium");
		});

		it("reports context usage on /context", async () => {
			const { socket } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/context" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("12,345");
		});

		it("passes custom instructions through to compaction", async () => {
			const { socket, compact } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/compact 保留部署细节" } }));

			await vi.waitFor(() => expect(compact).toHaveBeenCalled());
			expect(compact.mock.calls[0][0]).toMatchObject({ customInstructions: "保留部署细节" });
		});

		it("lists the active tools on /tools", async () => {
			const { socket } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/tools" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(textOf(webhookSends(calls)[0])).toContain("bash");
		});

		it("lists both bridge and session commands on /help", async () => {
			const { socket } = await start();
			socket.deliverBotMessage(botMessage({ text: { content: "/help" } }));

			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			const text = textOf(webhookSends(calls)[0]);
			expect(text).toContain("/model");
			expect(text).toContain("compact");
		});
	});

	// A skill that verifies a page can screenshot it, but markdown cannot carry the picture and a
	// chat cannot open a local path, so without this tool the screenshot never leaves the machine.
	describe("image tool", () => {
		const PNG = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P8z8Dwn4EIwESMolGFowpHFQ4dhQCK0wMBs1a3TQAAAABJRU5ErkJggg==",
			"base64",
		);

		function registeredTool(harness: { api: ExtensionAPI }) {
			const calls = (harness.api.registerTool as unknown as { mock: { calls: any[][] } }).mock.calls;
			return calls.map((call) => call[0]).find((tool) => tool.name === "dingtalk_send_image");
		}

		it("is not registered when no bot is configured", async () => {
			const harness = setupExtension();
			delete process.env.DINGTALK_CLIENT_ID;
			delete process.env.DINGTALK_CLIENT_SECRET;
			delete process.env.DINGTALK_ALLOW_USERS;
			await harness.fire("session_start", {});

			expect(registeredTool(harness)).toBeUndefined();
		});

		it("uploads the file and delivers it to the asker", async () => {
			const harness = await start();
			const shot = join(sandboxDir, "shot.png");
			writeFileSync(shot, PNG);

			// A queued asker is what gives the picture somewhere to go.
			harness.socket.deliverBotMessage(botMessage({ text: { content: "看看页面" } }));
			await vi.waitFor(() => expect(harness.sendUserMessage).toHaveBeenCalled());

			const tool = registeredTool(harness);
			expect(tool).toBeDefined();
			const result = await tool.execute("call-1", { path: shot });

			expect(calls.some((call) => call.url.includes("media/upload"))).toBe(true);
			const send = calls.find((call) => call.url.includes("oToMessages/batchSend"));
			expect(send?.body).toMatchObject({ msgKey: "sampleImageMsg" });
			expect(JSON.parse(send?.body.msgParam)).toEqual({ photoURL: "@lATestMedia" });
			expect(result.content[0].text).toContain("shot.png");
		});

		it("refuses a path that does not exist instead of reporting success", async () => {
			const harness = await start();
			harness.socket.deliverBotMessage(botMessage({ text: { content: "看看页面" } }));
			await vi.waitFor(() => expect(harness.sendUserMessage).toHaveBeenCalled());

			const tool = registeredTool(harness);
			await expect(tool.execute("call-1", { path: join(sandboxDir, "missing.png") })).rejects.toThrow(
				/Could not read/,
			);
		});

		// A terminal run is watched in the terminal. Pushing its screenshots into a spectator
		// group would be noise nobody asked for, so the groups are opt-in.
		it("sends nothing when the run came from the terminal", async () => {
			const harness = await start();
			const shot = join(sandboxDir, "local.png");
			writeFileSync(shot, PNG);

			const result = await registeredTool(harness).execute("call-1", { path: shot });

			expect(groupSends(calls, "group-watch")).toHaveLength(0);
			expect(userSends(calls)).toHaveLength(0);
			expect(result.content[0].text).toContain("未推送");
		});

		it("reaches the spectator groups only when explicitly asked", async () => {
			const harness = await start();
			const shot = join(sandboxDir, "local.png");
			writeFileSync(shot, PNG);

			await registeredTool(harness).execute("call-1", { path: shot, alsoGroups: true });

			expect(groupSends(calls, "group-watch").length).toBeGreaterThan(0);
		});

		it("still sends to the asker without asking for groups", async () => {
			const harness = await start();
			const shot = join(sandboxDir, "asked.png");
			writeFileSync(shot, PNG);

			harness.socket.deliverBotMessage(botMessage({ text: { content: "看看页面" } }));
			await vi.waitFor(() => expect(harness.sendUserMessage).toHaveBeenCalled());

			await registeredTool(harness).execute("call-1", { path: shot });

			expect(userSends(calls).some((call) => call.body.msgKey === "sampleImageMsg")).toBe(true);
			// The question itself is still mirrored to the group; only the *image* stays private.
			expect(groupSends(calls, "group-watch").filter((call) => call.body.msgKey === "sampleImageMsg")).toHaveLength(
				0,
			);
		});
	});

	// The daemon replays each worker's --dingtalk-config on revival, so a second session for the
	// same bot is the default outcome of relaunching, not a rare mistake.
	describe("single instance per bot", () => {
		it("declines to connect when another live session already runs the bot", async () => {
			await start();
			expect(FakeSocket.instances).toHaveLength(1);

			const second = setupExtension();
			await second.fire("session_start", {});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(FakeSocket.instances).toHaveLength(1);
		});

		it("lets the next session take over once the first has shut down", async () => {
			const first = await start();
			await first.fire("session_shutdown", {});

			const second = setupExtension();
			await second.fire("session_start", {});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(FakeSocket.instances).toHaveLength(2);
		});

		it("keeps two different bots independent", async () => {
			await start();

			vi.stubEnv("DINGTALK_CLIENT_ID", "other-app-key");
			const second = setupExtension();
			await second.fire("session_start", {});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(FakeSocket.instances).toHaveLength(2);
		});
	});

	describe("configuration", () => {
		function writeConfig(name: string, contents: unknown): string {
			const path = join(sandboxDir, name);
			writeFileSync(path, JSON.stringify(contents));
			return path;
		}

		it("stays disabled and opens no connection when credentials are missing", async () => {
			vi.stubEnv("DINGTALK_CLIENT_ID", "");
			const harness = setupExtension();
			await harness.fire("session_start", {});

			expect(FakeSocket.instances).toHaveLength(0);
		});

		it("stays completely silent when nothing configures the bridge", async () => {
			vi.unstubAllEnvs();
			vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", sandboxDir);
			const errors: string[] = [];
			const spy = vi.spyOn(console, "error").mockImplementation((line) => void errors.push(String(line)));

			const harness = setupExtension();
			await harness.fire("session_start", {});

			expect(FakeSocket.instances).toHaveLength(0);
			expect(errors).toEqual([]);
			spy.mockRestore();
		});

		it("runs the bot named by --dingtalk-config", async () => {
			const path = writeConfig("bot-a.json", {
				clientId: "file-key",
				clientSecret: "file-secret",
				allowUsers: ["staff-carol"],
				mirrorConversations: ["group-a"],
			});

			await start({ "dingtalk-config": path });

			const open = calls.find((call) => call.url.includes("gateway/connections/open"));
			expect(open?.body.clientId).toBe("file-key");
		});

		it("lets the chosen file override a stale environment variable", async () => {
			// A leftover DINGTALK_CLIENT_ID must not connect the wrong bot with this bot's allowlist.
			const path = writeConfig("bot-b.json", {
				clientId: "file-key",
				clientSecret: "file-secret",
				allowUsers: ["staff-carol"],
			});

			const { socket, sendUserMessage } = await start({ "dingtalk-config": path });

			const open = calls.find((call) => call.url.includes("gateway/connections/open"));
			expect(open?.body.clientId).toBe("file-key");

			// The env allowlist (staff-alice) no longer applies; the file's does.
			socket.deliverBotMessage(botMessage({ senderStaffId: "staff-alice" }));
			await vi.waitFor(() => expect(webhookSends(calls)).toHaveLength(1));
			expect(sendUserMessage).not.toHaveBeenCalled();

			socket.deliverBotMessage(botMessage({ senderStaffId: "staff-carol" }));
			await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("跑一下测试"));
		});

		it("refuses to start when the named config file is missing", async () => {
			const harness = setupExtension({ "dingtalk-config": join(sandboxDir, "absent.json") });
			await harness.fire("session_start", {});

			expect(FakeSocket.instances).toHaveLength(0);
		});

		it("picks up a project config file with no flag at all", async () => {
			mkdirSync(join(sandboxDir, ".prime", "agent"), { recursive: true });
			writeFileSync(
				join(sandboxDir, ".prime", "agent", "dingtalk.json"),
				JSON.stringify({ clientId: "project-key", clientSecret: "s", allowUsers: ["staff-alice"] }),
			);
			vi.unstubAllEnvs();
			vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", sandboxDir);

			await start();

			const open = calls.find((call) => call.url.includes("gateway/connections/open"));
			expect(open?.body.clientId).toBe("project-key");
		});
	});

	it("closes the stream on session shutdown", async () => {
		const { socket, fire } = await start();
		await fire("session_shutdown", { reason: "quit" });

		expect(socket.readyState).toBe(3);
	});
});
