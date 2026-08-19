/**
 * Configuration for the DingTalk bridge, read from environment variables.
 *
 * Pure: takes an env record and returns either a config or a list of problems.
 */

import type { GroupMode } from "./types.js";

export interface DingTalkConfig {
	/** AppKey of the DingTalk internal app; also the Stream client id. */
	clientId: string;
	/** AppSecret; also the Stream client secret. */
	clientSecret: string;
	/** Robot code used by the proactive send APIs. Defaults to `clientId`. */
	robotCode: string;
	/** Staff ids allowed to drive the agent. Empty means nobody. */
	allowUsers: string[];
	/** Group conversations that receive a mirror of every question and answer. */
	mirrorConversationIds: string[];
	/** `mirror` (default): groups are read-only spectators. `interactive`: allowlisted users may drive from a group. */
	groupMode: GroupMode;
	/** Also mirror tool-execution activity into the spectator groups. Noisy; off by default. */
	mirrorTools: boolean;
	/** Max characters per DingTalk message before splitting. */
	maxChars: number;
	/** How a question is queued when the agent is mid-run. */
	streamingBehavior: "followUp" | "steer";
	/** Optional AI-card template id. When set, replies stream into a card instead of arriving as one message. */
	cardTemplateId?: string;
	/** Card template variable that holds the markdown body. */
	cardMarkdownKey: string;
	/** Minimum gap between two identical notices in the same conversation. */
	noticeCooldownMs: number;
	/** Send a "still working" note if a run has not finished after this long. 0 disables it. */
	progressAfterMs: number;
}

export interface ConfigResult {
	config?: DingTalkConfig;
	errors: string[];
	warnings: string[];
}

const DEFAULTS = {
	maxChars: 3500,
	cardMarkdownKey: "content",
	noticeCooldownMs: 60 * 60 * 1000,
	progressAfterMs: 20_000,
} as const;

function list(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[,\s]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function bool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined || raw === "") return fallback;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function positiveInt(raw: string | undefined, fallback: number, min: number, errors: string[], name: string): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
		errors.push(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
		return fallback;
	}
	return value;
}

/** Build the bridge config from environment variables. Never throws. */
export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const clientId = env.DINGTALK_CLIENT_ID?.trim() ?? "";
	const clientSecret = env.DINGTALK_CLIENT_SECRET?.trim() ?? "";
	if (!clientId) errors.push("DINGTALK_CLIENT_ID is required (the app's AppKey)");
	if (!clientSecret) errors.push("DINGTALK_CLIENT_SECRET is required (the app's AppSecret)");

	const allowUsers = list(env.DINGTALK_ALLOW_USERS);
	if (allowUsers.length === 0) {
		errors.push(
			"DINGTALK_ALLOW_USERS is required and must list the staff ids allowed to drive the agent. " +
				"The agent runs shell commands with your permissions, so an empty allowlist is never the safe default.",
		);
	}

	const rawGroupMode = env.DINGTALK_GROUP_MODE?.trim().toLowerCase() ?? "mirror";
	let groupMode: GroupMode = "mirror";
	if (rawGroupMode === "mirror" || rawGroupMode === "interactive") {
		groupMode = rawGroupMode;
	} else {
		errors.push(`DINGTALK_GROUP_MODE must be "mirror" or "interactive", got ${JSON.stringify(rawGroupMode)}`);
	}

	const maxChars = positiveInt(env.DINGTALK_MAX_CHARS, DEFAULTS.maxChars, 200, errors, "DINGTALK_MAX_CHARS");
	const noticeCooldownMs = positiveInt(
		env.DINGTALK_NOTICE_COOLDOWN_MS,
		DEFAULTS.noticeCooldownMs,
		0,
		errors,
		"DINGTALK_NOTICE_COOLDOWN_MS",
	);
	const progressAfterMs = positiveInt(
		env.DINGTALK_PROGRESS_AFTER_MS,
		DEFAULTS.progressAfterMs,
		0,
		errors,
		"DINGTALK_PROGRESS_AFTER_MS",
	);

	const rawBehavior = env.DINGTALK_STREAMING_BEHAVIOR?.trim() ?? "followUp";
	let streamingBehavior: "followUp" | "steer" = "followUp";
	if (rawBehavior === "followUp" || rawBehavior === "steer") {
		streamingBehavior = rawBehavior;
	} else {
		errors.push(`DINGTALK_STREAMING_BEHAVIOR must be "followUp" or "steer", got ${JSON.stringify(rawBehavior)}`);
	}

	const mirrorConversationIds = list(env.DINGTALK_MIRROR_CONVERSATIONS);
	if (mirrorConversationIds.length === 0) {
		warnings.push(
			"DINGTALK_MIRROR_CONVERSATIONS is empty, so no group will see the conversation. " +
				"Add the bot to a group, @-mention it once, and copy the conversationId from the log.",
		);
	}

	const cardTemplateId = env.DINGTALK_CARD_TEMPLATE_ID?.trim() || undefined;

	if (errors.length > 0) return { errors, warnings };

	return {
		config: {
			clientId,
			clientSecret,
			robotCode: env.DINGTALK_ROBOT_CODE?.trim() || clientId,
			allowUsers,
			mirrorConversationIds,
			groupMode,
			mirrorTools: bool(env.DINGTALK_MIRROR_TOOLS, false),
			maxChars,
			streamingBehavior,
			cardTemplateId,
			cardMarkdownKey: env.DINGTALK_CARD_MARKDOWN_KEY?.trim() || DEFAULTS.cardMarkdownKey,
			noticeCooldownMs,
			progressAfterMs,
		},
		errors,
		warnings,
	};
}
