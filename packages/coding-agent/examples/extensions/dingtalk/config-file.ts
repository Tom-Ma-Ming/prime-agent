/**
 * Locating and reading the DingTalk bridge's JSON config file.
 *
 * Split from `config.ts` so the merge/validation logic stays free of filesystem access.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ConfigFileInput } from "./config.js";

export const CONFIG_FLAG = "dingtalk-config";
export const CONFIG_ENV = "DINGTALK_CONFIG";
export const CONFIG_BASENAME = "dingtalk.json";

/**
 * Where Prime Agent keeps global config.
 *
 * Resolved here rather than by importing `getAgentDir()` so this example stays loadable
 * without a built copy of the host package.
 */
export function defaultAgentDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.PRIME_AGENT_CODING_AGENT_DIR?.trim();
	if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
	return join(homedir(), ".prime", "agent");
}

export interface ConfigPath {
	path: string;
	/** An explicit path must exist; a discovered default may be absent without complaint. */
	explicit: boolean;
}

/**
 * Resolve which config file to read, in precedence order:
 *
 *   1. `--dingtalk-config <path>`
 *   2. `DINGTALK_CONFIG=<path>`
 *   3. `<cwd>/.prime/agent/dingtalk.json`
 *   4. `<agentDir>/dingtalk.json`
 *
 * Returns undefined when nothing is specified and no default exists.
 */
export function discoverConfigPath(options: {
	flag?: string;
	env: Record<string, string | undefined>;
	cwd: string;
	/** Defaults to the resolved Prime Agent config directory. */
	agentDir?: string;
}): ConfigPath | undefined {
	const flagValue = options.flag?.trim();
	if (flagValue) return { path: resolve(options.cwd, flagValue), explicit: true };

	const envValue = options.env[CONFIG_ENV]?.trim();
	if (envValue) return { path: resolve(options.cwd, envValue), explicit: true };

	const projectPath = join(options.cwd, ".prime", "agent", CONFIG_BASENAME);
	if (existsSync(projectPath)) return { path: projectPath, explicit: false };

	const globalPath = join(options.agentDir ?? defaultAgentDir(options.env), CONFIG_BASENAME);
	if (existsSync(globalPath)) return { path: globalPath, explicit: false };

	return undefined;
}

export interface ReadConfigFileResult {
	file?: ConfigFileInput;
	errors: string[];
	warnings: string[];
}

/**
 * Read and parse a config file.
 *
 * A missing file is an error only when the path was given explicitly — silently ignoring a
 * `--dingtalk-config` typo would start the wrong bot, or none at all, with no explanation.
 */
export function readConfigFile(target: ConfigPath): ReadConfigFileResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!existsSync(target.path)) {
		if (target.explicit) errors.push(`config file not found: ${target.path}`);
		return { errors, warnings };
	}

	// The file holds an AppSecret. Warn, but do not refuse: the user may have deliberate group access.
	try {
		const mode = statSync(target.path).mode & 0o077;
		if (mode !== 0) {
			warnings.push(`${target.path} is readable by other users; it holds an AppSecret. Run: chmod 600 the file`);
		}
	} catch {
		// Permission probing is best-effort; a stat failure is not worth blocking startup.
	}

	let text: string;
	try {
		text = readFileSync(target.path, "utf-8");
	} catch (error) {
		errors.push(`could not read ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
		return { errors, warnings };
	}

	try {
		return { file: { path: target.path, contents: JSON.parse(text) }, errors, warnings };
	} catch (error) {
		errors.push(`${target.path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return { errors, warnings };
	}
}
