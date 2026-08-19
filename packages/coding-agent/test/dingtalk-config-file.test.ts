import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverConfigPath, readConfigFile } from "../examples/extensions/dingtalk/config-file.js";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dingtalk-config-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, contents: unknown): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

describe("discoverConfigPath", () => {
	it("prefers the CLI flag over everything else", () => {
		const flagPath = writeJson(join(root, "flag.json"), {});
		writeJson(join(cwd, ".prime", "agent", "dingtalk.json"), {});
		writeJson(join(agentDir, "dingtalk.json"), {});

		expect(discoverConfigPath({ flag: flagPath, env: { DINGTALK_CONFIG: "env.json" }, cwd, agentDir })).toEqual({
			path: flagPath,
			explicit: true,
		});
	});

	it("resolves a relative flag path against the working directory", () => {
		const result = discoverConfigPath({ flag: "bots/a.json", env: {}, cwd, agentDir });
		expect(result).toEqual({ path: join(cwd, "bots", "a.json"), explicit: true });
	});

	it("falls back to DINGTALK_CONFIG", () => {
		const envPath = writeJson(join(root, "env.json"), {});
		expect(discoverConfigPath({ env: { DINGTALK_CONFIG: envPath }, cwd, agentDir })).toEqual({
			path: envPath,
			explicit: true,
		});
	});

	it("then the project file, then the global one", () => {
		const globalPath = writeJson(join(agentDir, "dingtalk.json"), {});
		expect(discoverConfigPath({ env: {}, cwd, agentDir })).toEqual({ path: globalPath, explicit: false });

		const projectPath = writeJson(join(cwd, ".prime", "agent", "dingtalk.json"), {});
		expect(discoverConfigPath({ env: {}, cwd, agentDir })).toEqual({ path: projectPath, explicit: false });
	});

	it("returns nothing when no file is specified or present", () => {
		expect(discoverConfigPath({ env: {}, cwd, agentDir })).toBeUndefined();
	});

	it("ignores a blank flag value", () => {
		expect(discoverConfigPath({ flag: "   ", env: {}, cwd, agentDir })).toBeUndefined();
	});
});

describe("readConfigFile", () => {
	it("parses a config file", () => {
		const path = writeJson(join(root, "bot.json"), { clientId: "k" });
		const result = readConfigFile({ path, explicit: true });

		expect(result.errors).toEqual([]);
		expect(result.file).toEqual({ path, contents: { clientId: "k" } });
	});

	it("errors when an explicitly named file is missing", () => {
		const result = readConfigFile({ path: join(root, "nope.json"), explicit: true });

		expect(result.file).toBeUndefined();
		expect(result.errors.join(" ")).toContain("config file not found");
	});

	it("stays quiet when a discovered default is missing", () => {
		const result = readConfigFile({ path: join(root, "nope.json"), explicit: false });

		expect(result.file).toBeUndefined();
		expect(result.errors).toEqual([]);
	});

	it("reports invalid JSON with the path", () => {
		const path = join(root, "bad.json");
		writeFileSync(path, "{ not json");
		const result = readConfigFile({ path, explicit: true });

		expect(result.file).toBeUndefined();
		expect(result.errors.join(" ")).toContain("is not valid JSON");
		expect(result.errors.join(" ")).toContain(path);
	});

	it("warns when the file holding the AppSecret is world-readable", () => {
		const path = writeJson(join(root, "loose.json"), { clientId: "k" });
		chmodSync(path, 0o644);
		const result = readConfigFile({ path, explicit: true });

		expect(result.warnings.join(" ")).toContain("readable by other users");
		expect(result.file).toBeDefined();
	});

	it("does not warn for a private file", () => {
		const path = writeJson(join(root, "tight.json"), { clientId: "k" });
		chmodSync(path, 0o600);

		expect(readConfigFile({ path, explicit: true }).warnings).toEqual([]);
	});
});
