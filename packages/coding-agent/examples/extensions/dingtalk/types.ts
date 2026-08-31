/**
 * Shared types for the DingTalk bridge extension.
 *
 * Kept free of Node/network imports so the routing and formatting logic stays unit-testable.
 */

/** Private (1:1) chat with the bot, or a group the bot was added to. */
export type ConversationKind = "private" | "group";

/** How the bridge treats group conversations. */
export type GroupMode = "mirror" | "interactive";

/** A bot message received from the DingTalk Stream gateway, normalized. */
export interface InboundMessage {
	/** DingTalk message id, used for de-duplication across redeliveries. */
	msgId: string;
	/** Open conversation id (stable per chat). */
	conversationId: string;
	kind: ConversationKind;
	/** Sender's staff id inside the organization. Empty for unknown senders. */
	senderStaffId: string;
	senderNick: string;
	/** Plain text body, already stripped of the leading @robot mention. */
	text: string;
	/** Short-lived webhook that replies into the originating conversation. */
	sessionWebhook?: string;
	/** Epoch millis after which `sessionWebhook` is rejected by DingTalk. */
	sessionWebhookExpiredTime?: number;
	/** The bot's own user id, used to drop the bot's own messages. */
	chatbotUserId?: string;
}

/** Where a reply should be delivered. */
export interface ReplyTarget {
	conversationId: string;
	kind: ConversationKind;
	sessionWebhook?: string;
	sessionWebhookExpiredTime?: number;
	/** Staff id to @-mention in group replies so concurrent askers can tell replies apart. */
	askerStaffId?: string;
	askerNick?: string;
	/** The original question, echoed as a short title for correlation. */
	question?: string;
}

/** A message to push to DingTalk. */
export interface OutboundMessage {
	title: string;
	text: string;
	atUserIds?: string[];
}

/** What the bridge decided to do with an inbound message. */
export type InboundDecision =
	/** Feed it to the agent. */
	| { action: "inject"; target: ReplyTarget; text: string }
	/** Do not feed it to the agent, but tell the sender why. */
	| { action: "notice"; target: ReplyTarget; reason: string; notice: string }
	/** Drop silently (duplicate, echo of our own message, empty body, rate-limited notice). */
	| { action: "ignore"; reason: string };

/** Bridge-level commands handled before anything reaches the agent. */
/**
 * Commands the bridge answers itself instead of forwarding to the agent.
 *
 * These mirror terminal affordances that a chat has no substitute for. Without them the text
 * reaches the LLM as an ordinary prompt, so `/model` used to make the model talk *about* models
 * while quietly staying the one it already was.
 */
export type BridgeCommandKind = "stop" | "status" | "model" | "thinking" | "context" | "compact" | "tools" | "help";

/** `query` is present only for the commands that take an argument. */
export interface BridgeCommand {
	kind: BridgeCommandKind;
	query?: string;
}
