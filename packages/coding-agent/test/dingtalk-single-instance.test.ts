import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireBotLock, botLockPath } from "../examples/extensions/dingtalk/single-instance.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dingtalk-lock-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * The daemon replays each worker's `--dingtalk-config` on revival, so relaunching prime-agent
 * brings every past bot back at once. Two live connections for one clientId split message
 * delivery between sessions with different contexts; more than two flap. The lock makes the
 * duplicate refuse to connect instead.
 */
describe("acquireBotLock", () => {
	it("acquires when nothing holds the bot", () => {
		const result = acquireBotLock({ dir, clientId: "ding-abc" });

		expect(result.lock).toBeDefined();
		expect(result.heldBy).toBeUndefined();
		expect(existsSync(botLockPath(dir, "ding-abc"))).toBe(true);
	});

	it("reports the holder rather than connecting alongside it", () => {
		const first = acquireBotLock({ dir, clientId: "ding-abc", pid: 4242, isAlive: () => true });
		expect(first.lock).toBeDefined();

		const second = acquireBotLock({ dir, clientId: "ding-abc", pid: 9999, isAlive: () => true });

		expect(second.lock).toBeUndefined();
		expect(second.heldBy).toBe(4242);
	});

	it("takes over a lock whose owner is gone", () => {
		// A SIGKILLed session leaves its lock behind; refusing forever would be worse than the bug.
		writeFileSync(botLockPath(dir, "ding-abc"), "4242");

		const result = acquireBotLock({ dir, clientId: "ding-abc", pid: 7, isAlive: () => false });

		expect(result.lock).toBeDefined();
		expect(readFileSync(botLockPath(dir, "ding-abc"), "utf-8")).toBe("7");
	});

	it("keeps separate bots independent", () => {
		const a = acquireBotLock({ dir, clientId: "ding-aaa", isAlive: () => true });
		const b = acquireBotLock({ dir, clientId: "ding-bbb", isAlive: () => true });

		expect(a.lock).toBeDefined();
		expect(b.lock).toBeDefined();
	});

	it("releases the lock so the next session can take it", () => {
		const first = acquireBotLock({ dir, clientId: "ding-abc", pid: 1, isAlive: () => true });
		first.lock?.release();

		expect(existsSync(botLockPath(dir, "ding-abc"))).toBe(false);
		expect(acquireBotLock({ dir, clientId: "ding-abc", pid: 2, isAlive: () => true }).lock).toBeDefined();
	});

	it("does not delete a lock that another session has already taken over", () => {
		const first = acquireBotLock({ dir, clientId: "ding-abc", pid: 1, isAlive: () => true });
		// Someone reclaimed it after deciding this pid was dead.
		writeFileSync(botLockPath(dir, "ding-abc"), "2");

		first.lock?.release();

		expect(readFileSync(botLockPath(dir, "ding-abc"), "utf-8")).toBe("2");
	});

	it("keeps a clientId with awkward characters inside the lock directory", () => {
		const path = botLockPath(dir, "../../escape/../ding");

		expect(path.startsWith(dir)).toBe(true);
		expect(path).not.toContain("..");
	});

	it("does not refuse the bot when the lock directory cannot be written", () => {
		// A read-only agent dir should degrade to "no protection", never to "no bridge".
		const result = acquireBotLock({ dir: join(dir, "missing", "deeper"), clientId: "ding-abc" });

		expect(result.lock).toBeDefined();
		expect(result.heldBy).toBeUndefined();
	});
});
