import { describe, expect, it } from "vitest";
import type { DingTalkConfig } from "../examples/extensions/dingtalk/config.js";
import { DingTalkApi, DingTalkApiError, type FetchLike } from "../examples/extensions/dingtalk/dingtalk-api.js";
import type { ReplyTarget } from "../examples/extensions/dingtalk/types.js";

function config(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
	return {
		clientId: "app-key",
		clientSecret: "app-secret",
		robotCode: "robot-1",
		allowUsers: ["staff-alice"],
		mirrorConversationIds: [],
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
	headers: Record<string, string>;
}

function recorder(responder: (url: string) => { status?: number; body: unknown } = () => ({ body: {} })) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({
			url,
			body: JSON.parse(String(init.body)),
			headers: (init.headers ?? {}) as Record<string, string>,
		});
		const { status = 200, body } = responder(url);
		return new Response(JSON.stringify(body), { status });
	};
	return { calls, fetchImpl };
}

const tokenBody = { accessToken: "token-abc", expireIn: 7200 };

describe("DingTalkApi — access token", () => {
	it("caches the token across calls", async () => {
		const { calls, fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config(), fetchImpl);

		expect(await api.getAccessToken()).toBe("token-abc");
		expect(await api.getAccessToken()).toBe("token-abc");
		expect(calls.filter((call) => call.url.includes("accessToken"))).toHaveLength(1);
	});

	it("refreshes once the cached token ages out", async () => {
		let now = 0;
		const { calls, fetchImpl } = recorder((url) => ({
			body: url.includes("accessToken") ? { accessToken: "t", expireIn: 600 } : {},
		}));
		const api = new DingTalkApi(config(), fetchImpl, () => now);

		await api.getAccessToken();
		now = 600_000; // past expiry minus the 5-minute safety margin
		await api.getAccessToken();

		expect(calls.filter((call) => call.url.includes("accessToken"))).toHaveLength(2);
	});

	it("shares one in-flight request between concurrent callers", async () => {
		const { calls, fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config(), fetchImpl);

		await Promise.all([api.getAccessToken(), api.getAccessToken(), api.getAccessToken()]);

		expect(calls.filter((call) => call.url.includes("accessToken"))).toHaveLength(1);
	});

	it("reports a missing token instead of sending an empty header", async () => {
		const { fetchImpl } = recorder(() => ({ body: { message: "nope" } }));
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(api.getAccessToken()).rejects.toThrow(DingTalkApiError);
	});

	it("surfaces a non-2xx response with its body", async () => {
		const { fetchImpl } = recorder(() => ({ status: 401, body: { code: "unauthorized" } }));
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(api.getAccessToken()).rejects.toThrow(/failed with 401/);
	});
});

describe("DingTalkApi — delivery routing", () => {
	const message = { title: "t", text: "hello" };

	it("prefers the session webhook while it is still valid", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl, () => 1_000);
		const target: ReplyTarget = {
			conversationId: "conv",
			kind: "private",
			sessionWebhook: "https://example.invalid/hook",
			sessionWebhookExpiredTime: 10_000_000,
			askerStaffId: "staff-alice",
		};

		await api.sendToTarget(target, { ...message, atUserIds: ["staff-alice"] });

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://example.invalid/hook");
		expect(calls[0].body.msgtype).toBe("markdown");
		expect(calls[0].body.at.atUserIds).toEqual(["staff-alice"]);
	});

	it("falls back to the group API once the webhook has expired", async () => {
		const { calls, fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config(), fetchImpl, () => 10_000_000);

		await api.sendToTarget(
			{
				conversationId: "conv-group",
				kind: "group",
				sessionWebhook: "https://example.invalid/hook",
				sessionWebhookExpiredTime: 1_000,
			},
			message,
		);

		const send = calls.find((call) => call.url.includes("groupMessages/send"));
		expect(send).toBeDefined();
		expect(send?.body.openConversationId).toBe("conv-group");
		expect(send?.body.robotCode).toBe("robot-1");
		expect(JSON.parse(send?.body.msgParam).text).toBe("hello");
		expect(send?.headers["x-acs-dingtalk-access-token"]).toBe("token-abc");
	});

	it("falls back to the 1:1 API for a private target", async () => {
		const { calls, fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config(), fetchImpl, () => 10_000_000);

		await api.sendToTarget({ conversationId: "conv", kind: "private", askerStaffId: "staff-alice" }, message);

		const send = calls.find((call) => call.url.includes("oToMessages/batchSend"));
		expect(send?.body.userIds).toEqual(["staff-alice"]);
	});

	it("refuses a private target with no staff id rather than sending nowhere", async () => {
		const { fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config(), fetchImpl, () => 10_000_000);

		await expect(api.sendToTarget({ conversationId: "conv", kind: "private" }, message)).rejects.toThrow(/staff id/);
	});

	it("treats a non-zero webhook errcode as a failure", async () => {
		const { fetchImpl } = recorder(() => ({ body: { errcode: 310000, errmsg: "keywords not in content" } }));
		const api = new DingTalkApi(config(), fetchImpl, () => 1_000);

		await expect(
			api.sendToTarget(
				{ conversationId: "c", kind: "private", sessionWebhook: "https://example.invalid/hook" },
				message,
			),
		).rejects.toThrow(/keywords not in content/);
	});

	it("skips the 1:1 API when there are no recipients", async () => {
		const { calls, fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		await api.sendToUsers([], message);

		expect(calls).toHaveLength(0);
	});
});

describe("DingTalkApi — AI cards", () => {
	it("refuses to create a card when no template is configured", async () => {
		const { fetchImpl } = recorder();
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(api.createCard({ conversationId: "c", kind: "group" }, "track-1", "…")).rejects.toThrow(
			/cardTemplateId/,
		);
	});

	it("streams the configured markdown key and marks the final push", async () => {
		const { calls, fetchImpl } = recorder((url) => ({ body: url.includes("accessToken") ? tokenBody : {} }));
		const api = new DingTalkApi(config({ cardTemplateId: "tpl-1", cardMarkdownKey: "body" }), fetchImpl);

		await api.streamCard("track-1", "partial");
		await api.streamCard("track-1", "final", { finalize: true });

		const streams = calls.filter((call) => call.url.includes("card/streaming"));
		expect(streams).toHaveLength(2);
		expect(streams[0].body).toMatchObject({
			outTrackId: "track-1",
			key: "body",
			content: "partial",
			isFinalize: false,
		});
		expect(streams[1].body).toMatchObject({ content: "final", isFinalize: true });
	});
});
