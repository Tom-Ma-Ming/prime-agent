/**
 * Configuration for the DingTalk bridge.
 *
 * Two sources, merged:
 *
 *   1. a JSON config file (`--dingtalk-config`, `DINGTALK_CONFIG`, or a discovered default)
 *   2. `DINGTALK_*` environment variables
 *
 * **The file wins.** Pointing at a file is how you pick which bot to run, so a stale
 * `DINGTALK_CLIENT_ID` left in a shell profile must never quietly connect the wrong bot with
 * another bot's allowlist. Environment variables only fill in what the file omits.
 *
 * Pure: file contents are handed in already parsed, so resolution stays unit-testable.
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

/** A parsed config file plus where it came from, for error messages. */
export interface ConfigFileInput {
	path: string;
	contents: unknown;
}

/** Values a source can contribute. Every field is optional; missing ones fall through. */
interface RawSettings {
	clientId?: string;
	clientSecret?: string;
	robotCode?: string;
	allowUsers?: string[];
	mirrorConversations?: string[];
	groupMode?: string;
	mirrorTools?: boolean;
	maxChars?: number;
	streamingBehavior?: string;
	cardTemplateId?: string;
	cardMarkdownKey?: string;
	noticeCooldownMs?: number;
	progressAfterMs?: number;
}

const DEFAULTS = {
	maxChars: 3500,
	cardMarkdownKey: "content",
	noticeCooldownMs: 60 * 60 * 1000,
	progressAfterMs: 20_000,
} as const;

const FILE_KEYS: (keyof RawSettings)[] = [
	"clientId",
	"clientSecret",
	"robotCode",
	"allowUsers",
	"mirrorConversations",
	"groupMode",
	"mirrorTools",
	"maxChars",
	"streamingBehavior",
	"cardTemplateId",
	"cardMarkdownKey",
	"noticeCooldownMs",
	"progressAfterMs",
];

/** Environment variables that, on their own, mean "the user intends to run the bridge". */
export const ENV_PREFIX = "DINGTALK_";

function splitList(raw: string): string[] {
	return raw
		.split(/[,\s]+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function envString(env: Record<string, string | undefined>, name: string): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

function envList(env: Record<string, string | undefined>, name: string): string[] | undefined {
	const raw = env[name];
	if (raw === undefined) return undefined;
	return splitList(raw);
}

function envNumber(env: Record<string, string | undefined>, name: string, errors: string[]): number | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		errors.push(`${name} must be an integer, got ${JSON.stringify(raw)}`);
		return undefined;
	}
	return value;
}

function envBool(env: Record<string, string | undefined>, name: string): boolean | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function fromEnv(env: Record<string, string | undefined>, errors: string[]): RawSettings {
	return {
		clientId: envString(env, "DINGTALK_CLIENT_ID"),
		clientSecret: envString(env, "DINGTALK_CLIENT_SECRET"),
		robotCode: envString(env, "DINGTALK_ROBOT_CODE"),
		allowUsers: envList(env, "DINGTALK_ALLOW_USERS"),
		mirrorConversations: envList(env, "DINGTALK_MIRROR_CONVERSATIONS"),
		groupMode: envString(env, "DINGTALK_GROUP_MODE"),
		mirrorTools: envBool(env, "DINGTALK_MIRROR_TOOLS"),
		maxChars: envNumber(env, "DINGTALK_MAX_CHARS", errors),
		streamingBehavior: envString(env, "DINGTALK_STREAMING_BEHAVIOR"),
		cardTemplateId: envString(env, "DINGTALK_CARD_TEMPLATE_ID"),
		cardMarkdownKey: envString(env, "DINGTALK_CARD_MARKDOWN_KEY"),
		noticeCooldownMs: envNumber(env, "DINGTALK_NOTICE_COOLDOWN_MS", errors),
		progressAfterMs: envNumber(env, "DINGTALK_PROGRESS_AFTER_MS", errors),
	};
}

function fileString(value: unknown, key: string, path: string, errors: string[]): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		errors.push(`${path}: "${key}" must be a string`);
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

/** Accepts an array of ids or one comma/space-separated string. */
function fileList(value: unknown, key: string, path: string, errors: string[]): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return splitList(value);
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		errors.push(`${path}: "${key}" must be an array of strings`);
		return undefined;
	}
	return (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
}

function fileNumber(value: unknown, key: string, path: string, errors: string[]): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		errors.push(`${path}: "${key}" must be an integer`);
		return undefined;
	}
	return value;
}

function fileBool(value: unknown, key: string, path: string, errors: string[]): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		errors.push(`${path}: "${key}" must be true or false`);
		return undefined;
	}
	return value;
}

function fromFile(file: ConfigFileInput, errors: string[], warnings: string[]): RawSettings {
	const { path, contents } = file;
	if (typeof contents !== "object" || contents === null || Array.isArray(contents)) {
		errors.push(`${path}: the config file must contain a JSON object`);
		return {};
	}
	const record = contents as Record<string, unknown>;

	// Typos in a config file are silent failures otherwise: the bot just behaves unexpectedly.
	for (const key of Object.keys(record)) {
		if (!FILE_KEYS.includes(key as keyof RawSettings)) {
			warnings.push(`${path}: unknown setting "${key}" ignored`);
		}
	}

	return {
		clientId: fileString(record.clientId, "clientId", path, errors),
		clientSecret: fileString(record.clientSecret, "clientSecret", path, errors),
		robotCode: fileString(record.robotCode, "robotCode", path, errors),
		allowUsers: fileList(record.allowUsers, "allowUsers", path, errors),
		mirrorConversations: fileList(record.mirrorConversations, "mirrorConversations", path, errors),
		groupMode: fileString(record.groupMode, "groupMode", path, errors),
		mirrorTools: fileBool(record.mirrorTools, "mirrorTools", path, errors),
		maxChars: fileNumber(record.maxChars, "maxChars", path, errors),
		streamingBehavior: fileString(record.streamingBehavior, "streamingBehavior", path, errors),
		cardTemplateId: fileString(record.cardTemplateId, "cardTemplateId", path, errors),
		cardMarkdownKey: fileString(record.cardMarkdownKey, "cardMarkdownKey", path, errors),
		noticeCooldownMs: fileNumber(record.noticeCooldownMs, "noticeCooldownMs", path, errors),
		progressAfterMs: fileNumber(record.progressAfterMs, "progressAfterMs", path, errors),
	};
}

/** Later sources win, but only for keys they actually define. */
function merge(...sources: RawSettings[]): RawSettings {
	const merged: RawSettings = {};
	for (const source of sources) {
		for (const [key, value] of Object.entries(source)) {
			if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
		}
	}
	return merged;
}

/** True when the user has expressed any intent to run the bridge in this session. */
export function isConfigured(env: Record<string, string | undefined>, hasFile: boolean): boolean {
	if (hasFile) return true;
	return Object.keys(env).some((key) => key.startsWith(ENV_PREFIX) && (env[key] ?? "").trim() !== "");
}

/**
 * Resolve the effective config. Never throws.
 *
 * `file` is the parsed config file, when one was found. Environment variables fill in the rest.
 */
export function resolveConfig(input: {
	env: Record<string, string | undefined>;
	file?: ConfigFileInput;
}): ConfigResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const envSettings = fromEnv(input.env, errors);
	const fileSettings = input.file ? fromFile(input.file, errors, warnings) : {};
	// File last: pointing at a file is how a bot is chosen, so it outranks ambient env vars.
	const raw = merge(envSettings, fileSettings);

	const source = input.file ? `config file ${input.file.path}` : "environment";

	if (!raw.clientId) errors.push(`clientId is required (the app's AppKey) — set it in the ${source}`);
	if (!raw.clientSecret) errors.push(`clientSecret is required (the app's AppSecret) — set it in the ${source}`);

	const allowUsers = raw.allowUsers ?? [];
	if (allowUsers.length === 0) {
		errors.push(
			`allowUsers is required and must list the staff ids allowed to drive the agent (${source}). ` +
				"The agent runs shell commands with your permissions, so an empty allowlist is never the safe default.",
		);
	}

	let groupMode: GroupMode = "mirror";
	if (raw.groupMode !== undefined) {
		if (raw.groupMode === "mirror" || raw.groupMode === "interactive") {
			groupMode = raw.groupMode;
		} else {
			errors.push(`groupMode must be "mirror" or "interactive", got ${JSON.stringify(raw.groupMode)}`);
		}
	}

	let streamingBehavior: "followUp" | "steer" = "followUp";
	if (raw.streamingBehavior !== undefined) {
		if (raw.streamingBehavior === "followUp" || raw.streamingBehavior === "steer") {
			streamingBehavior = raw.streamingBehavior;
		} else {
			errors.push(`streamingBehavior must be "followUp" or "steer", got ${JSON.stringify(raw.streamingBehavior)}`);
		}
	}

	const maxChars = raw.maxChars ?? DEFAULTS.maxChars;
	if (maxChars < 200) errors.push(`maxChars must be at least 200, got ${maxChars}`);

	const noticeCooldownMs = raw.noticeCooldownMs ?? DEFAULTS.noticeCooldownMs;
	if (noticeCooldownMs < 0) errors.push(`noticeCooldownMs must not be negative, got ${noticeCooldownMs}`);

	const progressAfterMs = raw.progressAfterMs ?? DEFAULTS.progressAfterMs;
	if (progressAfterMs < 0) errors.push(`progressAfterMs must not be negative, got ${progressAfterMs}`);

	const mirrorConversationIds = raw.mirrorConversations ?? [];
	if (mirrorConversationIds.length === 0) {
		warnings.push(
			"No mirrorConversations configured, so no group will see the conversation. " +
				"Add the bot to a group, @-mention it once, and copy the conversationId from the log.",
		);
	}

	if (errors.length > 0) return { errors, warnings };

	return {
		config: {
			clientId: raw.clientId!,
			clientSecret: raw.clientSecret!,
			robotCode: raw.robotCode ?? raw.clientId!,
			allowUsers,
			mirrorConversationIds,
			groupMode,
			mirrorTools: raw.mirrorTools ?? false,
			maxChars,
			streamingBehavior,
			cardTemplateId: raw.cardTemplateId,
			cardMarkdownKey: raw.cardMarkdownKey ?? DEFAULTS.cardMarkdownKey,
			noticeCooldownMs,
			progressAfterMs,
		},
		errors,
		warnings,
	};
}
