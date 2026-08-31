import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkConfig } from "../examples/extensions/dingtalk/config.js";
import { DingTalkStreamClient } from "../examples/extensions/dingtalk/stream-client.js";

const BOT_TOPIC = "/v1.0/im/bot/messages/get";

/** Minimal stand-in for the global WebSocket the stream client dials. */
class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly OPEN = 1;

	readyState: number = FakeSocket.OPEN;
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
		this.emit("close", { code: 1006, reason: "" });
	}

	emit(type: string, event: unknown): void {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}

	/** Frames the client sends that are not acks of something the gateway asked for. */
	get unsolicited(): any[] {
		return this.sent.map((raw) => JSON.parse(raw));
	}
}

function config(): DingTalkConfig {
	return {
		clientId: "client-id",
		clientSecret: "client-secret",
		robotCode: "client-id",
		allowUsers: ["staff-1"],
		mirrorConversationIds: [],
		groupMode: "mirror",
		mirrorTools: false,
		maxChars: 3500,
		streamingBehavior: "followUp",
		cardMarkdownKey: "content",
		noticeCooldownMs: 3_600_000,
		progressAfterMs: 20_000,
	};
}

let originalWebSocket: unknown;
let originalFetch: unknown;

beforeEach(() => {
	vi.useFakeTimers();
	FakeSocket.instances = [];
	originalWebSocket = (globalThis as any).WebSocket;
	originalFetch = (globalThis as any).fetch;
	(globalThis as any).WebSocket = FakeSocket;
	(globalThis as any).fetch = vi.fn(
		async () => new Response(JSON.stringify({ endpoint: "wss://stream.invalid/ws", ticket: "ticket-1" })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	(globalThis as any).WebSocket = originalWebSocket;
	(globalThis as any).fetch = originalFetch;
});

async function connect() {
	const logs: string[] = [];
	const client = new DingTalkStreamClient(config(), {
		onBotMessage: () => {},
		onLog: (level, message) => logs.push(`${level}: ${message}`),
	});
	await client.start();
	// start() no longer waits for the gateway, so let the request settle before touching the socket.
	await vi.advanceTimersByTimeAsync(0);
	const socket = FakeSocket.instances[0];
	socket.emit("open", {});
	return { client, socket, logs };
}

describe("DingTalkStreamClient keepalive", () => {
	it("sends a keepalive frame while the socket sits idle", async () => {
		const { client, socket } = await connect();

		expect(socket.sent).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(30_000);

		// A middlebox reaps a TCP flow that carries no bytes. One frame per interval keeps it warm.
		expect(socket.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(socket.sent).toHaveLength(2);

		client.stop();
	});

	it("stops the keepalive once the socket closes", async () => {
		const { client, socket } = await connect();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(socket.sent).toHaveLength(1);

		socket.close();
		await vi.advanceTimersByTimeAsync(120_000);

		// The dead socket must not keep collecting frames; only the reconnect path may write.
		expect(socket.sent).toHaveLength(1);
		client.stop();
	});

	it("stops the keepalive when the client is stopped", async () => {
		const { client, socket } = await connect();

		client.stop();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(socket.sent).toHaveLength(0);
	});

	it("does not write to a socket that is no longer open", async () => {
		const { client, socket } = await connect();

		socket.readyState = 3;
		await vi.advanceTimersByTimeAsync(60_000);

		expect(socket.sent).toHaveLength(0);
		client.stop();
	});
});

/**
 * A reconnect loop that can wedge is worse than one that fails loudly: the bridge goes quiet
 * for hours with no error, and every message sent in the meantime is simply lost.
 */
describe("DingTalkStreamClient stuck-connect recovery", () => {
	/** A request that answers only when aborted — how a real hung fetch behaves. */
	function hangingFetch(onCall?: () => void) {
		return vi.fn((_url: string, init: RequestInit) => {
			onCall?.();
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
	}

	it("gives up on a gateway request that never answers and tries again", async () => {
		let attempts = 0;
		// Node's fetch has no default timeout: after a sleep or a network change this
		// request can hang forever against a stale route.
		(globalThis as any).fetch = hangingFetch(() => {
			attempts += 1;
		});

		const client = new DingTalkStreamClient(config(), { onBotMessage: () => {} });
		await client.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		await vi.advanceTimersByTimeAsync(120_000);

		expect(attempts).toBeGreaterThan(1);
		client.stop();
	});

	it("passes an abort signal so the hung request is actually released", async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const hanging = hangingFetch();
		(globalThis as any).fetch = vi.fn((url: string, init: RequestInit) => {
			seen.push(init.signal ?? undefined);
			return hanging(url, init);
		});

		const client = new DingTalkStreamClient(config(), { onBotMessage: () => {} });
		await client.start();
		await vi.advanceTimersByTimeAsync(0);

		expect(seen[0]).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(seen[0]?.aborted).toBe(true);

		client.stop();
	});

	it("retries when the socket is created but never opens", async () => {
		const client = new DingTalkStreamClient(config(), { onBotMessage: () => {} });
		await client.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeSocket.instances).toHaveLength(1);

		// No "open" event: a handshake that hangs leaves the client waiting forever.
		await vi.advanceTimersByTimeAsync(120_000);

		expect(FakeSocket.instances.length).toBeGreaterThan(1);
		client.stop();
	});

	it("does not tear down a socket that opened in time", async () => {
		const { client, socket } = await connect();

		await vi.advanceTimersByTimeAsync(120_000);

		expect(socket.readyState).toBe(FakeSocket.OPEN);
		expect(FakeSocket.instances).toHaveLength(1);
		client.stop();
	});
});

describe("DingTalkStreamClient ping handling", () => {
	it("echoes the gateway's opaque back when answering a ping", async () => {
		const { client, socket } = await connect();

		socket.emit("message", {
			data: JSON.stringify({
				type: "SYSTEM",
				headers: { topic: "ping", messageId: "ping-1" },
				data: JSON.stringify({ opaque: "123-dsfs" }),
			}),
		});

		expect(socket.sent).toHaveLength(1);
		const ack = JSON.parse(socket.sent[0]);
		expect(ack.headers.messageId).toBe("ping-1");
		// The protocol requires the same opaque to come back, so the health check can be correlated.
		expect(JSON.parse(ack.data)).toEqual({ opaque: "123-dsfs" });

		client.stop();
	});

	it("acks a bot message before the handler runs", async () => {
		const acked: string[] = [];
		let handlerRan = false;
		const client = new DingTalkStreamClient(config(), {
			onBotMessage: () => {
				handlerRan = true;
				// The ack must already be on the wire: a run outlasts the gateway's redelivery window.
				expect(acked).toEqual(["frame-1"]);
			},
		});
		await client.start();
		await vi.advanceTimersByTimeAsync(0);
		const socket = FakeSocket.instances[0];
		socket.emit("open", {});
		const originalSend = socket.send.bind(socket);
		socket.send = (raw: string) => {
			acked.push(JSON.parse(raw).headers.messageId);
			originalSend(raw);
		};

		socket.emit("message", {
			data: JSON.stringify({
				type: "CALLBACK",
				headers: { topic: BOT_TOPIC, messageId: "frame-1" },
				data: JSON.stringify({
					msgtype: "text",
					text: { content: "hi" },
					msgId: "m-1",
					conversationId: "conv-1",
					conversationType: "1",
					senderStaffId: "staff-1",
					senderNick: "Tester",
				}),
			}),
		});

		expect(handlerRan).toBe(true);
		client.stop();
	});
});
