/**
 * Inbound routing for the DingTalk bridge.
 *
 * This is where the private-vs-group contract lives:
 *
 *   private chat        -> conversational; allowlisted users drive the agent
 *   group (mirror)      -> spectator only; questions and answers are broadcast, nothing is injected
 *   group (interactive) -> allowlisted users may also drive the agent from the group
 *
 * Every decision is pure apart from the de-duplication and notice-cooldown caches,
 * which are explicit state with an injectable clock.
 */

import type { DingTalkConfig } from "./config.js";
import { stripMention } from "./markdown.js";
import type { BridgeCommand, InboundDecision, InboundMessage, ReplyTarget } from "./types.js";

/** Cap on remembered message ids. DingTalk redelivers on ack timeouts, not indefinitely. */
const SEEN_LIMIT = 512;

const MIRROR_ONLY_NOTICE =
	"本群是围观模式：这里只同步问答记录，不接受指令。请**私聊我**下达任务，过程会自动同步到本群。";

const NOT_ALLOWED_NOTICE =
	"你不在本 Agent 的白名单里，指令未执行。请联系管理员把你的 staffId 加入 `DINGTALK_ALLOW_USERS`。";

/** Recognize the bridge-level commands that never reach the agent. */
export function parseBridgeCommand(text: string): BridgeCommand | undefined {
	const normalized = text.trim().toLowerCase();
	if (normalized === "/stop" || normalized === "/abort" || normalized === "停") return "stop";
	if (normalized === "/status" || normalized === "状态") return "status";
	return undefined;
}

export function replyTargetFor(message: InboundMessage): ReplyTarget {
	return {
		conversationId: message.conversationId,
		kind: message.kind,
		sessionWebhook: message.sessionWebhook,
		sessionWebhookExpiredTime: message.sessionWebhookExpiredTime,
		askerStaffId: message.senderStaffId || undefined,
		askerNick: message.senderNick || undefined,
		question: message.text,
	};
}

/**
 * Spectator groups that should receive a copy of this exchange.
 *
 * `exclude` drops the conversation the exchange already happened in, so an interactive
 * group never sees the same message twice.
 */
export function mirrorTargets(config: DingTalkConfig, exclude?: string): string[] {
	return config.mirrorConversationIds.filter((id) => id !== exclude);
}

export class InboundRouter {
	private readonly seen = new Map<string, number>();
	private readonly noticedAt = new Map<string, number>();

	constructor(
		private readonly config: DingTalkConfig,
		private readonly now: () => number = () => Date.now(),
	) {}

	/** Decide what to do with one inbound bot message. */
	decide(raw: InboundMessage): InboundDecision {
		const message: InboundMessage = { ...raw, text: stripMention(raw.text) };

		if (message.msgId && this.isDuplicate(message.msgId)) {
			return { action: "ignore", reason: "duplicate message id" };
		}

		// Echo guard: never feed the bot's own output back into the agent.
		if (message.chatbotUserId && message.senderStaffId === message.chatbotUserId) {
			return { action: "ignore", reason: "message from the bot itself" };
		}

		if (message.text.length === 0) {
			return { action: "ignore", reason: "empty message body" };
		}

		const target = replyTargetFor(message);

		if (message.kind === "group" && this.config.groupMode === "mirror") {
			return this.notice(target, "group is in mirror mode", MIRROR_ONLY_NOTICE);
		}

		if (!message.senderStaffId || !this.config.allowUsers.includes(message.senderStaffId)) {
			return this.notice(target, "sender is not allowlisted", NOT_ALLOWED_NOTICE);
		}

		return { action: "inject", target, text: message.text };
	}

	/**
	 * Rate-limit a notice so a busy spectator group is not spammed with the same reply.
	 *
	 * Keyed by conversation *and* reason: a newcomer's "not allowlisted" notice is not
	 * swallowed by an earlier mirror-mode notice in the same chat.
	 */
	private notice(target: ReplyTarget, reason: string, notice: string): InboundDecision {
		const key = `${target.conversationId}::${reason}`;
		const last = this.noticedAt.get(key);
		const now = this.now();
		if (last !== undefined && now - last < this.config.noticeCooldownMs) {
			return { action: "ignore", reason: `${reason} (notice on cooldown)` };
		}
		this.noticedAt.set(key, now);
		return { action: "notice", target, reason, notice };
	}

	private isDuplicate(msgId: string): boolean {
		if (this.seen.has(msgId)) return true;
		this.seen.set(msgId, this.now());
		while (this.seen.size > SEEN_LIMIT) {
			const oldest = this.seen.keys().next();
			if (oldest.done) break;
			this.seen.delete(oldest.value);
		}
		return false;
	}
}

/**
 * FIFO of pending reply targets.
 *
 * Questions are queued with `followUp`, so each one produces its own agent run and its own
 * `agent_end`. Answers are therefore handed back in the order the questions were accepted.
 * A run started from the terminal has no queued target and only reaches the mirror groups.
 */
export class ReplyQueue {
	private readonly targets: ReplyTarget[] = [];

	push(target: ReplyTarget): void {
		this.targets.push(target);
	}

	shift(): ReplyTarget | undefined {
		return this.targets.shift();
	}

	peek(): ReplyTarget | undefined {
		return this.targets[0];
	}

	get size(): number {
		return this.targets.length;
	}

	clear(): void {
		this.targets.length = 0;
	}
}
