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
import type { BridgeCommand, BridgeCommandKind, InboundDecision, InboundMessage, ReplyTarget } from "./types.js";

/** Cap on remembered message ids. DingTalk redelivers on ack timeouts, not indefinitely. */
const SEEN_LIMIT = 512;

const MIRROR_ONLY_NOTICE =
	"本群是围观模式：这里只同步问答记录，不接受指令。请**私聊我**下达任务，过程会自动同步到本群。";

/**
 * Echoes the sender's own staff id back to them.
 *
 * The allowlist is mandatory, so the first thing a new user needs is their own id to hand to
 * whoever runs the agent. Without this the setup is a chicken-and-egg problem.
 */
function notAllowedNotice(staffId: string): string {
	const who = staffId
		? `你的 staffId 是 \`${staffId}\`。`
		: "钉钉没有返回你的 staffId（外部联系人无法使用本 Agent）。";
	return `你不在本 Agent 的白名单里，指令未执行。${who}请联系管理员把它加入 \`DINGTALK_ALLOW_USERS\`。`;
}

/** Keyword to command, in both spellings. */
const COMMAND_KEYWORDS = new Map<string, BridgeCommandKind>([
	["/stop", "stop"],
	["/abort", "stop"],
	["停", "stop"],
	["/status", "status"],
	["状态", "status"],
	["/model", "model"],
	["/models", "model"],
	["模型", "model"],
	["/thinking", "thinking"],
	["思考", "thinking"],
	["/context", "context"],
	["上下文", "context"],
	["/compact", "compact"],
	["压缩", "compact"],
	["/tools", "tools"],
	["工具", "tools"],
	["/help", "help"],
	["/commands", "help"],
	["帮助", "help"],
]);

/**
 * Commands that mean something with an argument. Every other keyword must stand alone, so
 * "/status 一下部署" stays the question it is instead of being swallowed as a command.
 */
const TAKES_QUERY: ReadonlySet<BridgeCommandKind> = new Set<BridgeCommandKind>(["model", "thinking", "compact"]);

/**
 * Recognize the bridge-level commands that never reach the agent.
 *
 * Only an exact keyword counts, so "which model are you" stays a prompt. The query keeps its
 * original case: model ids are matched against it and some are case-sensitive.
 */
export function parseBridgeCommand(text: string): BridgeCommand | undefined {
	const trimmed = text.trim();
	const separator = trimmed.search(/\s/);
	const keyword = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
	const kind = COMMAND_KEYWORDS.get(keyword);
	if (!kind) return undefined;

	const query = separator === -1 ? "" : trimmed.slice(separator).trim();
	if (query.length === 0) return { kind };
	return TAKES_QUERY.has(kind) ? { kind, query } : undefined;
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
			return this.notice(target, "sender is not allowlisted", notAllowedNotice(message.senderStaffId));
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
