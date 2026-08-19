/**
 * Thin DingTalk Open Platform client: access-token caching, message delivery, AI-card streaming.
 *
 * `fetchImpl` is injectable so the delivery paths can be tested without network access.
 */

import type { DingTalkConfig } from "./config.js";
import type { OutboundMessage, ReplyTarget } from "./types.js";

const API_BASE = "https://api.dingtalk.com";
/** Refresh the token this long before it actually expires. */
const TOKEN_SAFETY_MS = 5 * 60 * 1000;
/** A session webhook is only used while it stays valid for at least this long. */
const WEBHOOK_SAFETY_MS = 30 * 1000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class DingTalkApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = "DingTalkApiError";
	}
}

interface CachedToken {
	value: string;
	expiresAt: number;
}

export class DingTalkApi {
	private token: CachedToken | undefined;
	private pendingToken: Promise<string> | undefined;

	constructor(
		private readonly config: DingTalkConfig,
		private readonly fetchImpl: FetchLike = fetch,
		private readonly now: () => number = () => Date.now(),
	) {}

	/** Fetch and cache an app access token. Concurrent callers share one in-flight request. */
	async getAccessToken(): Promise<string> {
		const cached = this.token;
		if (cached && cached.expiresAt > this.now()) return cached.value;
		if (this.pendingToken) return this.pendingToken;

		this.pendingToken = this.requestToken().finally(() => {
			this.pendingToken = undefined;
		});
		return this.pendingToken;
	}

	private async requestToken(): Promise<string> {
		const body = await this.postJson(`${API_BASE}/v1.0/oauth2/accessToken`, {
			appKey: this.config.clientId,
			appSecret: this.config.clientSecret,
		});
		const accessToken = typeof body.accessToken === "string" ? body.accessToken : undefined;
		const expireIn = typeof body.expireIn === "number" ? body.expireIn : 7200;
		if (!accessToken) {
			throw new DingTalkApiError("accessToken missing from DingTalk response", 200, JSON.stringify(body));
		}
		this.token = {
			value: accessToken,
			expiresAt: this.now() + Math.max(0, expireIn * 1000 - TOKEN_SAFETY_MS),
		};
		return accessToken;
	}

	/**
	 * Deliver a markdown message to a reply target.
	 *
	 * Prefers the short-lived session webhook (no token, and it supports @-mentions),
	 * and falls back to the proactive robot APIs once that webhook has expired.
	 */
	async sendToTarget(target: ReplyTarget, message: OutboundMessage): Promise<void> {
		const webhookUsable =
			target.sessionWebhook !== undefined &&
			(target.sessionWebhookExpiredTime === undefined ||
				target.sessionWebhookExpiredTime - WEBHOOK_SAFETY_MS > this.now());

		if (webhookUsable && target.sessionWebhook) {
			await this.sendViaWebhook(target.sessionWebhook, message);
			return;
		}

		if (target.kind === "group") {
			await this.sendToGroup(target.conversationId, message);
			return;
		}

		if (!target.askerStaffId) {
			throw new DingTalkApiError("cannot reach a private chat without a staff id", 0, "");
		}
		await this.sendToUsers([target.askerStaffId], message);
	}

	/** Reply into the originating conversation using its session webhook. */
	async sendViaWebhook(webhook: string, message: OutboundMessage): Promise<void> {
		const body = await this.postJson(webhook, {
			msgtype: "markdown",
			markdown: { title: message.title, text: message.text },
			at: { atUserIds: message.atUserIds ?? [], isAtAll: false },
		});
		const errcode = typeof body.errcode === "number" ? body.errcode : 0;
		if (errcode !== 0) {
			throw new DingTalkApiError(
				`webhook rejected the message: ${body.errmsg ?? errcode}`,
				200,
				JSON.stringify(body),
			);
		}
	}

	/** Proactively push into a group the bot belongs to. */
	async sendToGroup(openConversationId: string, message: OutboundMessage): Promise<void> {
		await this.postJson(
			`${API_BASE}/v1.0/robot/groupMessages/send`,
			{
				robotCode: this.config.robotCode,
				openConversationId,
				msgKey: "sampleMarkdown",
				msgParam: JSON.stringify({ title: message.title, text: message.text }),
			},
			await this.authHeaders(),
		);
	}

	/** Proactively push a 1:1 message to one or more staff ids. */
	async sendToUsers(userIds: string[], message: OutboundMessage): Promise<void> {
		if (userIds.length === 0) return;
		await this.postJson(
			`${API_BASE}/v1.0/robot/oToMessages/batchSend`,
			{
				robotCode: this.config.robotCode,
				userIds,
				msgKey: "sampleMarkdown",
				msgParam: JSON.stringify({ title: message.title, text: message.text }),
			},
			await this.authHeaders(),
		);
	}

	/**
	 * Create an AI card and deliver it into a conversation.
	 *
	 * Optional: only used when `cardTemplateId` is configured. `outTrackId` identifies the card
	 * for later streaming updates.
	 */
	async createCard(target: ReplyTarget, outTrackId: string, initialText: string): Promise<void> {
		const templateId = this.config.cardTemplateId;
		if (!templateId) throw new DingTalkApiError("cardTemplateId is not configured", 0, "");

		const openSpaceId =
			target.kind === "group"
				? `dtv1.card//IM_GROUP.${target.conversationId}`
				: `dtv1.card//IM_ROBOT.${target.askerStaffId ?? ""}`;

		const deliverModel =
			target.kind === "group"
				? { imGroupOpenDeliverModel: { robotCode: this.config.robotCode } }
				: { imRobotOpenDeliverModel: { spaceType: "IM_ROBOT" } };

		await this.postJson(
			`${API_BASE}/v1.0/card/instances/createAndDeliver`,
			{
				cardTemplateId: templateId,
				outTrackId,
				cardData: { cardParamMap: { [this.config.cardMarkdownKey]: initialText } },
				openSpaceId,
				...deliverModel,
			},
			await this.authHeaders(),
		);
	}

	/** Push an incremental (or final) body into a previously created AI card. */
	async streamCard(outTrackId: string, content: string, options: { finalize?: boolean; isError?: boolean } = {}) {
		await this.postJson(
			`${API_BASE}/v1.0/card/streaming`,
			{
				outTrackId,
				guid: outTrackId,
				key: this.config.cardMarkdownKey,
				content,
				isFull: true,
				isFinalize: options.finalize === true,
				isError: options.isError === true,
			},
			await this.authHeaders(),
		);
	}

	private async authHeaders(): Promise<Record<string, string>> {
		return { "x-acs-dingtalk-access-token": await this.getAccessToken() };
	}

	private async postJson(
		url: string,
		payload: unknown,
		headers: Record<string, string> = {},
	): Promise<Record<string, any>> {
		const response = await this.fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(payload),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new DingTalkApiError(`DingTalk request to ${url} failed with ${response.status}`, response.status, text);
		}
		if (text.trim().length === 0) return {};
		try {
			return JSON.parse(text) as Record<string, any>;
		} catch {
			throw new DingTalkApiError(`DingTalk returned non-JSON from ${url}`, response.status, text);
		}
	}
}
