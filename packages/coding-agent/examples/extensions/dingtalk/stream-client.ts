/**
 * DingTalk Stream (long-connection) client.
 *
 * Stream mode is what makes a local agent reachable from DingTalk without a public callback
 * URL: the process dials out to the gateway and receives bot messages over a WebSocket.
 *
 * Uses the global `WebSocket` and `fetch` from Node >= 22, so the extension needs no dependencies.
 */

import { randomUUID } from "node:crypto";
import type { DingTalkConfig } from "./config.js";
import type { ConversationKind, InboundMessage } from "./types.js";

const GATEWAY_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * How often to put a byte on an otherwise idle socket.
 *
 * The gateway health-checks with its own ping, but a quiet conversation can leave the socket
 * carrying no traffic for minutes, and a NAT or proxy in the path reaps an idle TCP flow long
 * before either end notices — typically at 300s, and the drop arrives as a 1006 with no close
 * handshake rather than the `disconnect` frame the protocol promises. Measured on a TUN-mode
 * proxy: an idle socket died at 278s, while the same socket kept alive at this interval was
 * still up past 400s. Well under any common idle timeout, and one small frame per interval.
 */
const KEEPALIVE_MS = 30_000;

/**
 * How long one connection attempt may take before it is abandoned and retried.
 *
 * Generous enough for a slow gateway — the observed handshake takes 2–8s — while still bounding
 * the case that matters: an attempt that hangs forever and takes the whole reconnect loop with it.
 */
const CONNECT_TIMEOUT_MS = 30_000;

interface StreamFrame {
	type?: string;
	headers?: Record<string, string>;
	data?: string;
}

export interface StreamHandlers {
	onBotMessage(message: InboundMessage): void | Promise<void>;
	/** Non-text messages (images, files, …) that the bridge cannot forward. */
	onUnsupported?(raw: Record<string, any>): void;
	onLog?(level: "info" | "warn" | "error", message: string): void;
}

/**
 * Convert a raw DingTalk bot-message payload into the bridge's normalized shape.
 *
 * Returns undefined for anything that is not a text message.
 */
export function normalizeBotMessage(raw: Record<string, any>): InboundMessage | undefined {
	if (raw.msgtype !== "text") return undefined;
	const content = raw.text?.content;
	if (typeof content !== "string") return undefined;

	// DingTalk sends "1" for a 1:1 chat and "2" for a group.
	const kind: ConversationKind = String(raw.conversationType) === "2" ? "group" : "private";

	return {
		msgId: typeof raw.msgId === "string" ? raw.msgId : "",
		conversationId: typeof raw.conversationId === "string" ? raw.conversationId : "",
		kind,
		senderStaffId: typeof raw.senderStaffId === "string" ? raw.senderStaffId : "",
		senderNick: typeof raw.senderNick === "string" ? raw.senderNick : "unknown",
		text: content,
		sessionWebhook: typeof raw.sessionWebhook === "string" ? raw.sessionWebhook : undefined,
		sessionWebhookExpiredTime:
			typeof raw.sessionWebhookExpiredTime === "number" ? raw.sessionWebhookExpiredTime : undefined,
		chatbotUserId: typeof raw.chatbotUserId === "string" ? raw.chatbotUserId : undefined,
	};
}

export class DingTalkStreamClient {
	private socket: WebSocket | undefined;
	private stopped = false;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly config: DingTalkConfig,
		private readonly handlers: StreamHandlers,
	) {}

	/**
	 * Begin connecting. Deliberately does not wait for the socket.
	 *
	 * The caller is `session_start`; blocking it on a gateway round trip delays the whole agent
	 * by seconds on a good day, and by however long the network hangs on a bad one. Failures
	 * reschedule themselves, so there is nothing here worth awaiting.
	 */
	async start(): Promise<void> {
		this.stopped = false;
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.stopKeepalive();
		this.socket?.close();
		this.socket = undefined;
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = undefined;
		}
	}

	/**
	 * Keep the socket's TCP flow warm for as long as it is the live one.
	 *
	 * The gateway tolerates an unsolicited ack envelope, which is the only client-to-server frame
	 * the protocol defines, so this borrows that shape rather than inventing one.
	 */
	private startKeepalive(socket: WebSocket): void {
		this.stopKeepalive();
		this.keepaliveTimer = setInterval(() => {
			if (this.stopped || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
			try {
				socket.send(
					JSON.stringify({
						code: 200,
						headers: { contentType: "application/json", messageId: randomUUID() },
						message: "OK",
						data: "{}",
					}),
				);
			} catch (error) {
				// A send that throws means the socket is already gone; let the close path reconnect.
				this.log("warn", `keepalive failed: ${error instanceof Error ? error.message : String(error)}`);
				socket.close();
			}
		}, KEEPALIVE_MS);
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.handlers.onLog?.(level, message);
	}

	/**
	 * Open one connection, guaranteeing exactly one outcome: a live socket, or a scheduled retry.
	 *
	 * Every step here can hang instead of failing. `fetch` has no default timeout in Node, and a
	 * WebSocket handshake against a stale route may never produce `open` or `close` — both are
	 * ordinary after a laptop sleeps or the network changes. Without a watchdog the attempt
	 * simply never finishes: nothing schedules another retry, and the bridge stays silently dead
	 * until someone restarts the agent.
	 */
	private async connect(): Promise<void> {
		if (this.stopped) return;

		const controller = new AbortController();
		let settled = false;
		let opened = false;
		let pending: WebSocket | undefined;

		const abandon = (reason: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			controller.abort();
			if (pending) {
				// Detach first, so this socket's own close cannot queue a second retry.
				if (this.socket === pending) this.socket = undefined;
				try {
					pending.close();
				} catch {
					// Already dead; the retry below is what matters.
				}
			}
			this.scheduleReconnect(reason);
		};

		const watchdog = setTimeout(() => abandon(`connect stalled for ${CONNECT_TIMEOUT_MS}ms`), CONNECT_TIMEOUT_MS);

		try {
			const { endpoint, ticket } = await this.openConnection(controller.signal);
			if (this.stopped || settled) return;

			const url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
			const socket = new WebSocket(url);
			pending = socket;
			this.socket = socket;

			socket.addEventListener("open", () => {
				opened = true;
				settled = true;
				clearTimeout(watchdog);
				this.attempt = 0;
				this.startKeepalive(socket);
				this.log("info", "DingTalk stream connected");
			});
			socket.addEventListener("message", (event) => {
				void this.handleFrame(String((event as MessageEvent).data));
			});
			socket.addEventListener("error", () => {
				this.log("warn", "DingTalk stream socket error");
			});
			socket.addEventListener("close", () => {
				if (this.socket === socket) {
					this.socket = undefined;
					this.stopKeepalive();
				}
				if (opened) {
					clearTimeout(watchdog);
					this.scheduleReconnect("socket closed");
				} else {
					abandon("socket closed before opening");
				}
			});
		} catch (error) {
			abandon(error instanceof Error ? error.message : String(error));
		}
	}

	private async openConnection(signal?: AbortSignal): Promise<{ endpoint: string; ticket: string }> {
		const response = await fetch(GATEWAY_URL, {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				clientId: this.config.clientId,
				clientSecret: this.config.clientSecret,
				subscriptions: [{ type: "CALLBACK", topic: BOT_MESSAGE_TOPIC }],
				ua: "prime-agent-dingtalk-bridge/1.0",
			}),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`gateway open failed with ${response.status}: ${text}`);
		}
		const body = JSON.parse(text) as { endpoint?: string; ticket?: string };
		if (!body.endpoint || !body.ticket) {
			throw new Error(`gateway open returned no endpoint/ticket: ${text}`);
		}
		return { endpoint: body.endpoint, ticket: body.ticket };
	}

	private scheduleReconnect(reason: string): void {
		if (this.stopped || this.reconnectTimer) return;
		this.attempt += 1;
		const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.attempt - 1));
		const delay = backoff / 2 + Math.random() * (backoff / 2);
		this.log("warn", `DingTalk stream reconnecting in ${Math.round(delay)}ms (${reason})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
	}

	private async handleFrame(payload: string): Promise<void> {
		let frame: StreamFrame;
		try {
			frame = JSON.parse(payload) as StreamFrame;
		} catch {
			this.log("warn", "dropped a non-JSON stream frame");
			return;
		}

		const headers = frame.headers ?? {};
		const topic = headers.topic;

		if (frame.type === "SYSTEM") {
			if (topic === "ping") {
				this.ack(headers.messageId, frame.data ?? "{}");
				return;
			}
			if (topic === "disconnect") {
				this.log("info", "gateway asked us to reconnect");
				this.socket?.close();
				return;
			}
			return;
		}

		if (frame.type !== "CALLBACK" || topic !== BOT_MESSAGE_TOPIC) return;

		// Ack first: the gateway redelivers on timeout, and agent runs take far longer than the window.
		this.ack(headers.messageId, JSON.stringify({}));

		let raw: Record<string, any>;
		try {
			raw = JSON.parse(frame.data ?? "{}") as Record<string, any>;
		} catch {
			this.log("warn", "dropped a bot message with a non-JSON body");
			return;
		}

		const message = normalizeBotMessage(raw);
		if (!message) {
			this.handlers.onUnsupported?.(raw);
			return;
		}

		try {
			await this.handlers.onBotMessage(message);
		} catch (error) {
			this.log("error", `bot message handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private ack(messageId: string | undefined, data: string): void {
		if (!messageId || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(
			JSON.stringify({
				code: 200,
				headers: { contentType: "application/json", messageId },
				message: "OK",
				data,
			}),
		);
	}
}
