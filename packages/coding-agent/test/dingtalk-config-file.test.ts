import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGitExposure, discoverConfigPath, readConfigFile } from "../examples/extensions/dingtalk/config-file.js";

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

	it("finds the project file from a subdirectory, up to the git root", () => {
		// One bot per repo: running the agent from packages/api must still find the repo's bot.
		writeJson(join(cwd, ".prime", "agent", "dingtalk.json"), {});
		mkdirSync(join(cwd, ".git"), { recursive: true });
		const deep = join(cwd, "packages", "api", "src");
		mkdirSync(deep, { recursive: true });

		expect(discoverConfigPath({ env: {}, cwd: deep, agentDir })).toEqual({
			path: join(cwd, ".prime", "agent", "dingtalk.json"),
			explicit: false,
		});
	});

	it("does not escape the git root when the repo has no config", () => {
		// An outer directory's config must not leak into an unrelated repository.
		writeJson(join(root, ".prime", "agent", "dingtalk.json"), {});
		mkdirSync(join(cwd, ".git"), { recursive: true });

		expect(discoverConfigPath({ env: {}, cwd, agentDir })).toBeUndefined();
	});

	it("prefers the innermost project config", () => {
		writeJson(join(cwd, ".prime", "agent", "dingtalk.json"), {});
		mkdirSync(join(cwd, ".git"), { recursive: true });
		const inner = join(cwd, "packages", "api");
		const innerPath = writeJson(join(inner, ".prime", "agent", "dingtalk.json"), {});

		expect(discoverConfigPath({ env: {}, cwd: inner, agentDir })?.path).toBe(innerPath);
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

describe("checkGitExposure", () => {
	const path = "/repo/.prime/agent/dingtalk.json";

	function exec(codes: Record<string, number>) {
		return async (_command: string, args: string[]) => ({
			code: args.includes("check-ignore") ? codes.checkIgnore : codes.inWorkTree,
		});
	}

	it("warns when the config is in a repo and not ignored", async () => {
		const warning = await checkGitExposure(path, exec({ inWorkTree: 0, checkIgnore: 1 }));
		expect(warning).toContain("not ignored");
		expect(warning).toContain("AppSecret");
	});

	it("stays quiet when the file is ignored", async () => {
		expect(await checkGitExposure(path, exec({ inWorkTree: 0, checkIgnore: 0 }))).toBeUndefined();
	});

	it("stays quiet outside a git work tree", async () => {
		expect(await checkGitExposure(path, exec({ inWorkTree: 128, checkIgnore: 1 }))).toBeUndefined();
	});

	it("stays quiet when git cannot answer, rather than crying wolf", async () => {
		expect(await checkGitExposure(path, exec({ inWorkTree: 0, checkIgnore: 128 }))).toBeUndefined();
	});

	it("stays quiet when git is missing entirely", async () => {
		const throwing = async () => {
			throw new Error("spawn git ENOENT");
		};
		expect(await checkGitExposure(path, throwing)).toBeUndefined();
	});
});
