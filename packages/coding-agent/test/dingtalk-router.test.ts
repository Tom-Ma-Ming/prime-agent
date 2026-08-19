import { describe, expect, it } from "vitest";
import { type DingTalkConfig, loadConfig } from "../examples/extensions/dingtalk/config.js";
import {
	InboundRouter,
	mirrorTargets,
	parseBridgeCommand,
	ReplyQueue,
} from "../examples/extensions/dingtalk/router.js";
import { normalizeBotMessage } from "../examples/extensions/dingtalk/stream-client.js";
import { lastAssistantText } from "../examples/extensions/dingtalk/transcript.js";
import type { InboundMessage } from "../examples/extensions/dingtalk/types.js";

function config(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
	return {
		clientId: "app-key",
		clientSecret: "app-secret",
		robotCode: "app-key",
		allowUsers: ["staff-alice"],
		mirrorConversationIds: ["group-watch"],
		groupMode: "mirror",
		mirrorTools: false,
		maxChars: 3500,
		streamingBehavior: "followUp",
		cardMarkdownKey: "content",
		noticeCooldownMs: 60_000,
		progressAfterMs: 20_000,
		...overrides,
	};
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
	return {
		msgId: "msg-1",
		conversationId: "conv-private",
		kind: "private",
		senderStaffId: "staff-alice",
		senderNick: "Alice",
		text: "跑一下测试",
		sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
		sessionWebhookExpiredTime: 9_999_999_999_999,
		chatbotUserId: "bot-user",
		...overrides,
	};
}

describe("InboundRouter — private chat is conversational", () => {
	it("injects an allowlisted user's private message", () => {
		const router = new InboundRouter(config());
		const decision = router.decide(message());

		expect(decision.action).toBe("inject");
		if (decision.action !== "inject") return;
		expect(decision.text).toBe("跑一下测试");
		expect(decision.target.kind).toBe("private");
		expect(decision.target.askerNick).toBe("Alice");
		expect(decision.target.question).toBe("跑一下测试");
	});

	it("refuses a sender who is not on the allowlist", () => {
		const router = new InboundRouter(config());
		const decision = router.decide(message({ senderStaffId: "staff-mallory" }));

		expect(decision.action).toBe("notice");
		if (decision.action !== "notice") return;
		expect(decision.reason).toBe("sender is not allowlisted");
		expect(decision.notice).toContain("白名单");
		// The allowlist is mandatory, so the refusal has to tell the sender what to ask for.
		expect(decision.notice).toContain("staff-mallory");
	});

	it("refuses a sender with no resolvable staff id", () => {
		const router = new InboundRouter(config());
		const decision = router.decide(message({ senderStaffId: "" }));

		expect(decision.action).toBe("notice");
		if (decision.action !== "notice") return;
		expect(decision.notice).toContain("外部联系人");
	});
});

describe("InboundRouter — groups are spectators by default", () => {
	it("never injects a group message in mirror mode, even from an allowlisted user", () => {
		const router = new InboundRouter(config());
		const decision = router.decide(message({ kind: "group", conversationId: "group-watch", msgId: "msg-g1" }));

		expect(decision.action).toBe("notice");
		if (decision.action !== "notice") return;
		expect(decision.reason).toBe("group is in mirror mode");
		expect(decision.notice).toContain("围观模式");
	});

	it("injects a group message when the group is switched to interactive", () => {
		const router = new InboundRouter(config({ groupMode: "interactive" }));
		const decision = router.decide(message({ kind: "group", conversationId: "group-work", msgId: "msg-g2" }));

		expect(decision.action).toBe("inject");
		if (decision.action !== "inject") return;
		expect(decision.target.askerStaffId).toBe("staff-alice");
	});

	it("still enforces the allowlist in an interactive group", () => {
		const router = new InboundRouter(config({ groupMode: "interactive" }));
		const decision = router.decide(
			message({ kind: "group", conversationId: "group-work", senderStaffId: "staff-mallory" }),
		);

		expect(decision.action).toBe("notice");
		if (decision.action !== "notice") return;
		expect(decision.reason).toBe("sender is not allowlisted");
	});
});

describe("InboundRouter — echo and redelivery guards", () => {
	it("drops the bot's own messages so replies cannot feed themselves back", () => {
		const router = new InboundRouter(config());
		const decision = router.decide(message({ senderStaffId: "bot-user" }));

		expect(decision).toEqual({ action: "ignore", reason: "message from the bot itself" });
	});

	it("drops a redelivered message id", () => {
		const router = new InboundRouter(config());
		expect(router.decide(message()).action).toBe("inject");
		expect(router.decide(message())).toEqual({ action: "ignore", reason: "duplicate message id" });
	});

	it("drops a message whose body is only the @robot mention", () => {
		const router = new InboundRouter(config());
		expect(router.decide(message({ text: "  @PrimeAgent  " })).action).toBe("ignore");
	});

	it("strips the leading mention before injecting", () => {
		const router = new InboundRouter(config({ groupMode: "interactive" }));
		const decision = router.decide(message({ kind: "group", text: "@PrimeAgent 看下 CI" }));

		expect(decision.action).toBe("inject");
		if (decision.action !== "inject") return;
		expect(decision.text).toBe("看下 CI");
	});
});

describe("InboundRouter — notice cooldown", () => {
	it("sends a mirror-mode notice once per cooldown window", () => {
		let now = 1_000;
		const router = new InboundRouter(config({ noticeCooldownMs: 60_000 }), () => now);
		const group = { kind: "group", conversationId: "group-watch" } as const;

		expect(router.decide(message({ ...group, msgId: "a" })).action).toBe("notice");
		now += 30_000;
		expect(router.decide(message({ ...group, msgId: "b" })).action).toBe("ignore");
		now += 31_000;
		expect(router.decide(message({ ...group, msgId: "c" })).action).toBe("notice");
	});

	it("does not re-notify for every unauthorized sender in the same conversation", () => {
		const router = new InboundRouter(config({ groupMode: "interactive" }));
		const group = { kind: "group", conversationId: "group-work" } as const;

		expect(router.decide(message({ ...group, msgId: "a", senderStaffId: "staff-mallory" })).action).toBe("notice");
		// Same conversation, same reason: silenced so a busy group is not spammed.
		expect(router.decide(message({ ...group, msgId: "b", senderStaffId: "staff-eve" })).action).toBe("ignore");
	});

	it("tracks the cooldown per conversation", () => {
		const router = new InboundRouter(config({ groupMode: "interactive" }));

		expect(
			router.decide(message({ kind: "group", conversationId: "g1", msgId: "a", senderStaffId: "x" })).action,
		).toBe("notice");
		// A different conversation has its own budget.
		expect(
			router.decide(message({ kind: "group", conversationId: "g2", msgId: "b", senderStaffId: "x" })).action,
		).toBe("notice");
	});
});

describe("mirrorTargets", () => {
	it("returns the configured spectator groups", () => {
		expect(mirrorTargets(config({ mirrorConversationIds: ["g1", "g2"] }))).toEqual(["g1", "g2"]);
	});

	it("excludes the conversation the exchange already happened in", () => {
		expect(mirrorTargets(config({ mirrorConversationIds: ["g1", "g2"] }), "g1")).toEqual(["g2"]);
	});
});

describe("parseBridgeCommand", () => {
	it("recognizes stop and status in both spellings", () => {
		expect(parseBridgeCommand("/stop")).toBe("stop");
		expect(parseBridgeCommand(" /abort ")).toBe("stop");
		expect(parseBridgeCommand("停")).toBe("stop");
		expect(parseBridgeCommand("/status")).toBe("status");
		expect(parseBridgeCommand("状态")).toBe("status");
	});

	it("leaves ordinary prompts alone", () => {
		expect(parseBridgeCommand("stop the deploy")).toBeUndefined();
		expect(parseBridgeCommand("/skill:web-search prime agent")).toBeUndefined();
	});
});

describe("ReplyQueue", () => {
	it("hands answers back in the order questions were accepted", () => {
		const queue = new ReplyQueue();
		queue.push({ conversationId: "a", kind: "private" });
		queue.push({ conversationId: "b", kind: "private" });

		expect(queue.size).toBe(2);
		expect(queue.peek()?.conversationId).toBe("a");
		expect(queue.shift()?.conversationId).toBe("a");
		expect(queue.shift()?.conversationId).toBe("b");
		expect(queue.shift()).toBeUndefined();
	});

	it("clears pending targets when a run is aborted", () => {
		const queue = new ReplyQueue();
		queue.push({ conversationId: "a", kind: "private" });
		queue.clear();
		expect(queue.size).toBe(0);
	});
});

describe("normalizeBotMessage", () => {
	it("maps conversationType 2 to a group and 1 to a private chat", () => {
		const base = { msgtype: "text", text: { content: "hi" }, msgId: "m", conversationId: "c" };
		expect(normalizeBotMessage({ ...base, conversationType: "2" })?.kind).toBe("group");
		expect(normalizeBotMessage({ ...base, conversationType: "1" })?.kind).toBe("private");
	});

	it("returns undefined for non-text messages", () => {
		expect(normalizeBotMessage({ msgtype: "picture", content: {} })).toBeUndefined();
		expect(normalizeBotMessage({ msgtype: "text" })).toBeUndefined();
	});

	it("carries the fields the bridge routes on", () => {
		const normalized = normalizeBotMessage({
			msgtype: "text",
			text: { content: "跑测试" },
			msgId: "m1",
			conversationId: "c1",
			conversationType: "1",
			senderStaffId: "staff-alice",
			senderNick: "Alice",
			sessionWebhook: "https://example.invalid/hook",
			sessionWebhookExpiredTime: 123,
			chatbotUserId: "bot-user",
		});

		expect(normalized).toMatchObject({
			msgId: "m1",
			conversationId: "c1",
			kind: "private",
			senderStaffId: "staff-alice",
			senderNick: "Alice",
			text: "跑测试",
			sessionWebhookExpiredTime: 123,
			chatbotUserId: "bot-user",
		});
	});
});

describe("loadConfig", () => {
	const base = {
		DINGTALK_CLIENT_ID: "key",
		DINGTALK_CLIENT_SECRET: "secret",
		DINGTALK_ALLOW_USERS: "staff-alice, staff-bob",
	};

	it("requires credentials and a non-empty allowlist", () => {
		const result = loadConfig({});
		expect(result.config).toBeUndefined();
		expect(result.errors).toHaveLength(3);
		expect(result.errors.join(" ")).toContain("DINGTALK_ALLOW_USERS");
	});

	it("defaults groups to mirror mode", () => {
		const result = loadConfig(base);
		expect(result.config?.groupMode).toBe("mirror");
		expect(result.config?.allowUsers).toEqual(["staff-alice", "staff-bob"]);
		expect(result.config?.robotCode).toBe("key");
	});

	it("warns when no spectator group is configured", () => {
		expect(loadConfig(base).warnings.join(" ")).toContain("DINGTALK_MIRROR_CONVERSATIONS");
	});

	it("rejects an unknown group mode", () => {
		const result = loadConfig({ ...base, DINGTALK_GROUP_MODE: "readonly" });
		expect(result.config).toBeUndefined();
		expect(result.errors.join(" ")).toContain("DINGTALK_GROUP_MODE");
	});

	it("rejects a nonsensical message size", () => {
		const result = loadConfig({ ...base, DINGTALK_MAX_CHARS: "12" });
		expect(result.config).toBeUndefined();
		expect(result.errors.join(" ")).toContain("DINGTALK_MAX_CHARS");
	});
});

describe("lastAssistantText", () => {
	it("returns the newest assistant text", () => {
		expect(
			lastAssistantText([
				{ role: "assistant", content: [{ type: "text", text: "第一轮" }] },
				{ role: "user", content: "再来" },
				{ role: "assistant", content: [{ type: "text", text: "第二轮" }] },
			] as never),
		).toBe("第二轮");
	});

	it("skips assistant turns that only made tool calls", () => {
		expect(
			lastAssistantText([
				{ role: "assistant", content: [{ type: "text", text: "开始" }] },
				{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "ipython", arguments: {} }] },
			] as never),
		).toBe("开始");
	});

	it("joins multiple text blocks in one message", () => {
		expect(
			lastAssistantText([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "第一段" },
						{ type: "text", text: "第二段" },
					],
				},
			] as never),
		).toBe("第一段\n第二段");
	});

	it("returns an empty string when there is nothing to say", () => {
		expect(lastAssistantText([])).toBe("");
		expect(lastAssistantText([{ role: "user", content: "hi" }] as never)).toBe("");
	});
});
