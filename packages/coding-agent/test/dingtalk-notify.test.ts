import { describe, expect, it } from "vitest";
import type { DingTalkConfig } from "../examples/extensions/dingtalk/config.js";
import { DingTalkApi, type FetchLike } from "../examples/extensions/dingtalk/dingtalk-api.js";
import { parseNotifyArgs, sendNotification } from "../examples/extensions/dingtalk/notify.js";

function config(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
	return {
		clientId: "app-key",
		clientSecret: "app-secret",
		robotCode: "robot-1",
		allowUsers: ["staff-alice", "staff-bob"],
		mirrorConversationIds: ["cid-team"],
		groupMode: "mirror",
		mirrorTools: false,
		maxChars: 3500,
		streamingBehavior: "followUp",
		cardMarkdownKey: "content",
		noticeCooldownMs: 1000,
		progressAfterMs: 0,
		...overrides,
	};
}

interface Call {
	url: string;
	body: any;
}

function recorder() {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		let body: any = init.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {}
		}
		calls.push({ url, body });
		if (url.includes("oauth2/accessToken")) {
			return new Response(JSON.stringify({ accessToken: "token-abc", expireIn: 7200 }));
		}
		if (url.includes("media/upload")) {
			return new Response(JSON.stringify({ errcode: 0, errmsg: "ok", media_id: "@lAMedia" }));
		}
		return new Response(JSON.stringify({}));
	};
	return { calls, fetchImpl };
}

function deps(overrides: Partial<Parameters<typeof sendNotification>[2]> = {}) {
	return {
		readFile: () => new Uint8Array([1, 2, 3]),
		readStdin: async () => "",
		...overrides,
	};
}

const userSends = (calls: Call[]) => calls.filter((call) => call.url.includes("oToMessages/batchSend"));
const groupSends = (calls: Call[]) => calls.filter((call) => call.url.includes("groupMessages/send"));
const textOf = (call: Call) => JSON.parse(call.body.msgParam).text as string;

describe("parseNotifyArgs", () => {
	// With several bots configured, a default would eventually deliver to the wrong audience,
	// and a chat message cannot be recalled. So the path is always spelled out.
	it("requires an explicit config path", () => {
		const result = parseNotifyArgs(["hello"]);
		expect(result.error).toMatch(/--config/);
		expect(result.options).toBeUndefined();
	});

	it("rejects --config without a value instead of silently continuing", () => {
		expect(parseNotifyArgs(["--config"]).error).toMatch(/--config/);
	});

	it("takes the message from the positional arguments", () => {
		const { options } = parseNotifyArgs(["--config", "/bots/a.json", "构建", "完成"]);
		expect(options).toMatchObject({ configPath: "/bots/a.json", text: "构建 完成" });
	});

	it("parses the optional flags", () => {
		const { options } = parseNotifyArgs([
			"--config",
			"/bots/a.json",
			"--image",
			"./shot.png",
			"--title",
			"巡检",
			"--groups",
			"看这里",
		]);
		expect(options).toMatchObject({
			configPath: "/bots/a.json",
			imagePath: "./shot.png",
			title: "巡检",
			toGroups: true,
			text: "看这里",
		});
	});

	it("refuses an unknown flag rather than treating it as message text", () => {
		expect(parseNotifyArgs(["--config", "/bots/a.json", "--shout", "hi"]).error).toMatch(/--shout/);
	});
});

describe("sendNotification", () => {
	it("pushes text to every allowlisted user and leaves the groups alone", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		const delivered = await sendNotification(
			{ configPath: "/bots/a.json", text: "构建完成", title: "通知", toGroups: false },
			{ config: config(), api },
			deps(),
		);

		expect(userSends(calls)).toHaveLength(1);
		expect(userSends(calls)[0].body).toMatchObject({ userIds: ["staff-alice", "staff-bob"] });
		expect(groupSends(calls)).toHaveLength(0);
		expect(delivered).toContain("2 位用户");
	});

	it("also pushes to the spectator groups when asked", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		await sendNotification(
			{ configPath: "/bots/a.json", text: "发布开始", title: "通知", toGroups: true },
			{ config: config(), api },
			deps(),
		);

		expect(groupSends(calls)).toHaveLength(1);
		expect(groupSends(calls)[0].body).toMatchObject({ openConversationId: "cid-team" });
	});

	it("splits a long message using the config's own limit", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config({ maxChars: 64 }), fetchImpl);

		await sendNotification(
			{ configPath: "/bots/a.json", text: "x".repeat(200), title: "通知", toGroups: false },
			{ config: config({ maxChars: 64 }), api },
			deps(),
		);

		expect(userSends(calls).length).toBeGreaterThan(1);
	});

	it("uploads an image once and delivers it to each user", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config({ allowUsers: ["staff-alice"] }), fetchImpl);

		await sendNotification(
			{ configPath: "/bots/a.json", imagePath: "/tmp/shot.png", title: "通知", toGroups: false },
			{ config: config({ allowUsers: ["staff-alice"] }), api },
			deps(),
		);

		expect(calls.filter((call) => call.url.includes("media/upload"))).toHaveLength(1);
		const image = userSends(calls).find((call) => call.body.msgKey === "sampleImageMsg");
		expect(JSON.parse(image?.body.msgParam)).toEqual({ photoURL: "@lAMedia" });
	});

	it("reads the message from stdin when no text was given", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		await sendNotification(
			{ configPath: "/bots/a.json", title: "夜间巡检", toGroups: false },
			{ config: config(), api },
			deps({ readStdin: async () => "磁盘 90%" }),
		);

		expect(textOf(userSends(calls)[0])).toContain("磁盘 90%");
	});

	it("refuses to send an empty notification", async () => {
		const { fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(
			sendNotification(
				{ configPath: "/bots/a.json", title: "通知", toGroups: false },
				{ config: config(), api },
				deps(),
			),
		).rejects.toThrow(/nothing to send/i);
	});

	it("refuses when the bot has no allowlisted users and groups were not requested", async () => {
		const { fetchImpl } = recorder();
		const empty = config({ allowUsers: [] });
		const api = new DingTalkApi(empty, fetchImpl);

		await expect(
			sendNotification(
				{ configPath: "/bots/a.json", text: "hi", title: "通知", toGroups: false },
				{ config: empty, api },
				deps(),
			),
		).rejects.toThrow(/nowhere to send/i);
	});
});
