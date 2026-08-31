#!/usr/bin/env -S npx tsx
/**
 * One-way DingTalk push, usable without an agent session.
 *
 *   notify --config ~/bots/monitor.json "磁盘 90%"
 *   notify --config ~/bots/team.json --image ./shot.png "首页渲染结果"
 *   echo "$REPORT" | notify --config ~/bots/team.json --title "夜间巡检"
 *
 * Sending needs only an access token and the proactive robot APIs, so this opens no Stream
 * connection and therefore never competes with a running bridge for message delivery. That is
 * what makes it safe to call from cron, CI, or a shell while the agent is working.
 *
 * `--config` is mandatory. With several bots configured, a default would eventually deliver to
 * the wrong audience, and a chat message cannot be recalled.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { type DingTalkConfig, resolveConfig } from "./config.js";
import { readConfigFile } from "./config-file.js";
import { DingTalkApi } from "./dingtalk-api.js";
import { splitMarkdown } from "./markdown.js";
import type { OutboundMessage } from "./types.js";

export interface NotifyOptions {
	configPath: string;
	/** Omitted when the body comes from stdin, or when only an image is being sent. */
	text?: string;
	title: string;
	imagePath?: string;
	/** Spectator groups are opt-in: most notifications are for the operator, not the room. */
	toGroups: boolean;
}

export interface ParseResult {
	options?: NotifyOptions;
	error?: string;
}

const USAGE = [
	"Usage: notify --config <path> [--title <text>] [--image <path>] [--groups] [message...]",
	"",
	"  --config <path>  Required. The bot config file to send with.",
	"  --title <text>   Message title. Defaults to 通知.",
	"  --image <path>   Also send this image file.",
	"  --groups         Also send to the config's mirrorConversations.",
	"",
	"With no message arguments the body is read from stdin.",
].join("\n");

export function parseNotifyArgs(argv: string[]): ParseResult {
	let configPath: string | undefined;
	let imagePath: string | undefined;
	let title = "通知";
	let toGroups = false;
	const words: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		// A value that itself looks like a flag means the previous one was left dangling.
		const takeValue = (): string | undefined => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) return undefined;
			index += 1;
			return value;
		};

		if (argument === "--config") {
			configPath = takeValue();
			if (!configPath) return { error: "--config needs a path to a bot config file." };
			continue;
		}
		if (argument === "--image") {
			imagePath = takeValue();
			if (!imagePath) return { error: "--image needs a path to an image file." };
			continue;
		}
		if (argument === "--title") {
			const value = takeValue();
			if (!value) return { error: "--title needs some text." };
			title = value;
			continue;
		}
		if (argument === "--groups") {
			toGroups = true;
			continue;
		}
		// An unrecognised flag is a typo, not message text: silently sending "--shout" would hide it.
		if (argument.startsWith("--")) return { error: `Unknown flag ${argument}.\n\n${USAGE}` };
		words.push(argument);
	}

	if (!configPath) return { error: `--config is required; there is no default bot.\n\n${USAGE}` };

	const text = words.join(" ");
	return { options: { configPath, title, toGroups, ...(text ? { text } : {}), ...(imagePath ? { imagePath } : {}) } };
}

export interface NotifyContext {
	config: DingTalkConfig;
	api: DingTalkApi;
}

export interface NotifyDeps {
	readFile: (path: string) => Uint8Array;
	readStdin: () => Promise<string>;
}

/**
 * Deliver one notification.
 *
 * Returns a description of each destination reached, so a caller can report what happened
 * rather than assume it.
 */
export async function sendNotification(
	options: NotifyOptions,
	context: NotifyContext,
	deps: NotifyDeps,
): Promise<string[]> {
	const { config, api } = context;
	const text = options.text ?? (await deps.readStdin()).trim();

	if (!text && !options.imagePath) {
		throw new Error("Nothing to send: no message text and no --image.");
	}

	const users = config.allowUsers;
	const groups = options.toGroups ? config.mirrorConversationIds : [];
	if (users.length === 0 && groups.length === 0) {
		throw new Error(
			options.toGroups
				? "Nowhere to send: the config has no allowUsers and no mirrorConversations."
				: "Nowhere to send: the config has no allowUsers. Pass --groups to reach its spectator groups.",
		);
	}

	if (text) {
		const chunks = splitMarkdown(text, config.maxChars);
		for (const [index, chunk] of chunks.entries()) {
			const message: OutboundMessage = {
				title: chunks.length > 1 ? `${options.title} (${index + 1}/${chunks.length})` : options.title,
				text: chunk,
			};
			if (users.length > 0) await api.sendToUsers(users, message);
			for (const conversationId of groups) await api.sendToGroup(conversationId, message);
		}
	}

	if (options.imagePath) {
		// Uploaded once; the same media id is reusable across every destination.
		const mediaId = await api.uploadImage(deps.readFile(options.imagePath), basename(options.imagePath));
		for (const staffId of users) {
			await api.sendImageToTarget({ conversationId: "", kind: "private", askerStaffId: staffId }, mediaId);
		}
		for (const conversationId of groups) {
			await api.sendImageToTarget({ conversationId, kind: "group" }, mediaId);
		}
	}

	const delivered: string[] = [];
	if (users.length > 0) delivered.push(`${users.length} 位用户`);
	for (const conversationId of groups) delivered.push(`群 ${conversationId}`);
	return delivered;
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf-8");
}

export async function main(argv: string[]): Promise<number> {
	const { options, error } = parseNotifyArgs(argv);
	if (error || !options) {
		console.error(error);
		return 2;
	}

	const file = readConfigFile({ path: options.configPath, explicit: true });
	for (const warning of file.warnings) console.error(`warning: ${warning}`);
	if (file.errors.length > 0) {
		for (const problem of file.errors) console.error(problem);
		return 2;
	}

	// Environment variables are deliberately not consulted: the named file is the whole story.
	const resolved = resolveConfig({ env: {}, file: file.file });
	if (resolved.errors.length > 0 || !resolved.config) {
		for (const problem of resolved.errors) console.error(problem);
		return 2;
	}

	try {
		const delivered = await sendNotification(
			options,
			{ config: resolved.config, api: new DingTalkApi(resolved.config) },
			{
				readFile: (path) => readFileSync(path),
				readStdin,
			},
		);
		console.log(`已发送到：${delivered.join("、")}`);
		return 0;
	} catch (caught) {
		console.error(caught instanceof Error ? caught.message : String(caught));
		return 1;
	}
}

// Only when run directly, so importing this module in tests has no side effects.
// pathToFileURL rather than string concatenation: a path with a space is not a valid URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error);
			process.exit(1);
		},
	);
}
