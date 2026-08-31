/**
 * One Stream connection per bot per machine.
 *
 * The daemon persists each worker's `--dingtalk-config` and replays it when the worker is
 * revived, so relaunching prime-agent can bring several sessions back at once, each opening its
 * own connection for the same clientId. DingTalk then delivers a given message to exactly one of
 * them, so questions land in whichever session happened to win — and with enough duplicates the
 * connections start displacing each other, which shows up as an endless
 * "reconnecting in Nms (socket closed)" loop.
 *
 * A pid file keyed by clientId makes the second session decline instead. No dependencies: an
 * exclusive create is atomic enough, and a dead owner's lock is reclaimed rather than honoured
 * forever.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface InstanceLock {
	release(): void;
}

export interface AcquireResult {
	/** Present when this process may run the bot. */
	lock?: InstanceLock;
	/** Pid of the live session already running it. */
	heldBy?: number;
}

/** A clientId is normally alphanumeric, but never trust it to be a safe filename. */
export function botLockPath(dir: string, clientId: string): string {
	const safe = clientId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
	return join(dir, `dingtalk-${safe}.lock`);
}

function livePid(pid: number): boolean {
	try {
		// Signal 0 checks for existence without touching the process.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function acquireBotLock(options: {
	dir: string;
	clientId: string;
	pid?: number;
	isAlive?: (pid: number) => boolean;
}): AcquireResult {
	const pid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? livePid;
	const path = botLockPath(options.dir, options.clientId);

	const take = (): InstanceLock | undefined => {
		try {
			const handle = openSync(path, "wx");
			try {
				writeFileSync(handle, String(pid));
			} finally {
				closeSync(handle);
			}
			return {
				release() {
					// Only remove a lock this process still owns: a session that was declared dead
					// and replaced must not delete its successor's claim on the way out.
					try {
						if (readFileSync(path, "utf-8").trim() === String(pid)) unlinkSync(path);
					} catch {
						// Already gone, or never ours to begin with.
					}
				},
			};
		} catch {
			return undefined;
		}
	};

	try {
		mkdirSync(options.dir, { recursive: true });
	} catch {
		// Fall through: the create below decides whether this is fatal.
	}

	const first = take();
	if (first) return { lock: first };

	let owner: number | undefined;
	try {
		const raw = readFileSync(path, "utf-8").trim();
		owner = Number.parseInt(raw, 10);
	} catch {
		// Unreadable lock: treat it as stale below rather than blocking the bridge forever.
	}

	if (owner !== undefined && Number.isFinite(owner) && isAlive(owner)) {
		return { heldBy: owner };
	}

	try {
		unlinkSync(path);
	} catch {
		// Someone else cleaned it up first, which is equally fine.
	}
	const second = take();
	if (second) return { lock: second };

	// The lock file cannot be created at all — a read-only or missing agent dir. Losing the
	// duplicate protection is a smaller failure than refusing to run the bot, so proceed.
	return { lock: { release() {} } };
}
