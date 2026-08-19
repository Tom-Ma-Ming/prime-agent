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
		calls.push({ url, body: JSON.parse(String(init.body)) });
		if (url.includes("gateway/connections/open")) {
			return new Response(JSON.stringify({ endpoint: "wss://stream.invalid/ws", ticket: "ticket-1" }));
		}
		if (url.includes("oauth2/accessToken")) {
			return new Response(JSON.stringify({ accessToken: "token-abc", expireIn: 7200 }));
		}
		return new Response(JSON.stringify({}));
	});
	return { calls, fetchImpl };
}

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function setupExtension(flags: Record<string, string> = {}) {
	const handlers = new Map<string, Handler[]>();
	const sendUserMessage = vi.fn();
	const api = {
		on: (event: string, handler: Handler) => {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		sendUserMessage,
		sendMessage: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: (name: string) => flags[name],
	} as unknown as ExtensionAPI;

	const abort = vi.fn(async () => {});
	let idle = true;
	const ctx = {
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd: sandboxDir,
		isIdle: () => idle,
		abort,
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
	} as unknown as ExtensionContext;

	const fire = async (event: string, payload: Record<string, unknown>) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};

	dingTalkExtension(api);
	return { api, ctx, fire, sendUserMessage, abort, setIdle: (value: boolean) => (idle = value) };
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
