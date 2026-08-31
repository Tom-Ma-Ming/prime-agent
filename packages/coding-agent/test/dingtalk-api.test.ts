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

/**
 * Screenshots are the one reply a markdown message cannot carry, and the session webhook has no
 * image type at all, so images always take the proactive robot path after an upload.
 */
describe("image delivery", () => {
	interface RawCall {
		url: string;
		body: unknown;
		headers: Record<string, string>;
	}

	function rawRecorder(responder: (url: string) => { status?: number; body: unknown }) {
		const calls: RawCall[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			calls.push({ url, body: init.body, headers: (init.headers ?? {}) as Record<string, string> });
			const { status = 200, body } = responder(url);
			return new Response(JSON.stringify(body), { status });
		};
		return { calls, fetchImpl };
	}

	const uploaded = { errcode: 0, errmsg: "ok", media_id: "@lALPtest", type: "image" };

	function respond(url: string) {
		if (url.includes("oauth2/accessToken")) return { body: tokenBody };
		if (url.includes("media/upload")) return { body: uploaded };
		return { body: {} };
	}

	it("uploads bytes as multipart and returns the media id", async () => {
		const { calls, fetchImpl } = rawRecorder(respond);
		const api = new DingTalkApi(config(), fetchImpl);

		const mediaId = await api.uploadImage(new Uint8Array([1, 2, 3]), "shot.png");

		expect(mediaId).toBe("@lALPtest");
		const upload = calls.find((call) => call.url.includes("media/upload"));
		expect(upload).toBeDefined();
		// The token rides in the query string here: this endpoint predates the v1.0 header auth.
		expect(upload?.url).toContain("access_token=token-abc");
		expect(upload?.body).toBeInstanceOf(FormData);
	});

	it("treats a non-zero errcode as a failure even though the HTTP status is 200", async () => {
		const { fetchImpl } = rawRecorder((url) =>
			url.includes("oauth2/accessToken")
				? { body: tokenBody }
				: { body: { errcode: 40035, errmsg: "invalid media" } },
		);
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(api.uploadImage(new Uint8Array([1]), "shot.png")).rejects.toBeInstanceOf(DingTalkApiError);
	});

	it("sends an image to a private chat with the asker's staff id", async () => {
		const { calls, fetchImpl } = rawRecorder(respond);
		const api = new DingTalkApi(config(), fetchImpl);
		const target: ReplyTarget = { conversationId: "conv-1", kind: "private", askerStaffId: "staff-alice" };

		await api.sendImageToTarget(target, "@lALPtest");

		const send = calls.find((call) => call.url.includes("oToMessages/batchSend"));
		const body = JSON.parse(String(send?.body));
		expect(body).toMatchObject({ robotCode: "robot-1", userIds: ["staff-alice"], msgKey: "sampleImageMsg" });
		expect(JSON.parse(body.msgParam)).toEqual({ photoURL: "@lALPtest" });
	});

	it("sends an image to a group by conversation id", async () => {
		const { calls, fetchImpl } = rawRecorder(respond);
		const api = new DingTalkApi(config(), fetchImpl);
		const target: ReplyTarget = { conversationId: "cid-group", kind: "group" };

		await api.sendImageToTarget(target, "@lALPtest");

		const send = calls.find((call) => call.url.includes("groupMessages/send"));
		const body = JSON.parse(String(send?.body));
		expect(body).toMatchObject({ openConversationId: "cid-group", msgKey: "sampleImageMsg" });
	});

	it("refuses a private target with no staff id rather than sending nowhere", async () => {
		const { fetchImpl } = rawRecorder(respond);
		const api = new DingTalkApi(config(), fetchImpl);

		await expect(
			api.sendImageToTarget({ conversationId: "conv-1", kind: "private" }, "@lALPtest"),
		).rejects.toBeInstanceOf(DingTalkApiError);
	});
});
