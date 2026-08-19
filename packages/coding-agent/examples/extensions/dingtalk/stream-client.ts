/**
 * DingTalk Stream (long-connection) client.
 *
 * Stream mode is what makes a local agent reachable from DingTalk without a public callback
 * URL: the process dials out to the gateway and receives bot messages over a WebSocket.
 *
 * Uses the global `WebSocket` and `fetch` from Node >= 22, so the extension needs no dependencies.
 */

import type { DingTalkConfig } from "./config.js";
import type { ConversationKind, InboundMessage } from "./types.js";

const GATEWAY_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

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

	constructor(
		private readonly config: DingTalkConfig,
		private readonly handlers: StreamHandlers,
	) {}

	async start(): Promise<void> {
		this.stopped = false;
		await this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.socket?.close();
		this.socket = undefined;
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.handlers.onLog?.(level, message);
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		try {
			const { endpoint, ticket } = await this.openConnection();
			const url = `${endpoint}?ticket=${encodeURIComponent(ticket)}`;
			const socket = new WebSocket(url);
			this.socket = socket;

			socket.addEventListener("open", () => {
				this.attempt = 0;
				this.log("info", "DingTalk stream connected");
			});
			socket.addEventListener("message", (event) => {
				void this.handleFrame(String((event as MessageEvent).data));
			});
			socket.addEventListener("error", () => {
				this.log("warn", "DingTalk stream socket error");
			});
			socket.addEventListener("close", () => {
				if (this.socket === socket) this.socket = undefined;
				this.scheduleReconnect("socket closed");
			});
		} catch (error) {
			this.scheduleReconnect(error instanceof Error ? error.message : String(error));
		}
	}

	private async openConnection(): Promise<{ endpoint: string; ticket: string }> {
		const response = await fetch(GATEWAY_URL, {
			method: "POST",
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
