import { describe, expect, it } from "vitest";
import {
	formatAnswer,
	formatQuestion,
	splitMarkdown,
	stripMention,
	summarize,
} from "../examples/extensions/dingtalk/markdown.js";

/** Count unterminated code fences; a well-formed chunk always has an even number. */
function fenceCount(chunk: string): number {
	return chunk.split("\n").filter((line) => line.startsWith("```")).length;
}

describe("splitMarkdown", () => {
	it("returns nothing for blank input", () => {
		expect(splitMarkdown("", 100)).toEqual([]);
		expect(splitMarkdown("   \n\n  ", 100)).toEqual([]);
	});

	it("keeps text that already fits as one chunk", () => {
		expect(splitMarkdown("短回复", 100)).toEqual(["短回复"]);
	});

	it("rejects an unusably small budget instead of looping", () => {
		expect(() => splitMarkdown("x".repeat(500), 10)).toThrow(/maxChars/);
		expect(() => splitMarkdown("x".repeat(500), 3.5)).toThrow(/maxChars/);
	});

	it("splits on line boundaries and respects the budget", () => {
		const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
		const chunks = splitMarkdown(text, 100);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
		expect(chunks.join("\n")).toBe(text);
	});

	it("never leaves a code fence open across a split", () => {
		const code = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const chunks = splitMarkdown(`说明文字\n\n\`\`\`ts\n${code}\n\`\`\`\n\n收尾`, 200);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(200);
			expect(fenceCount(chunk) % 2).toBe(0);
		}
	});

	it("reopens the fence with its original language", () => {
		const code = Array.from({ length: 40 }, (_, index) => `print(${index})`).join("\n");
		const chunks = splitMarkdown(`\`\`\`python\n${code}\n\`\`\``, 128);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.startsWith("```python")).toBe(true);
	});

	it("stays within budget when the fence language is long", () => {
		const code = Array.from({ length: 40 }, (_, index) => `row ${index}`).join("\n");
		const chunks = splitMarkdown(`\`\`\`${"lang".repeat(12)}\n${code}\n\`\`\``, 128);

		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(128);
	});

	it("hard-wraps a single line that exceeds the budget on its own", () => {
		const chunks = splitMarkdown("x".repeat(1000), 128);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(128);
		expect(chunks.join("")).toBe("x".repeat(1000));
	});

	it("hard-wraps a long line inside a code block without breaking the fence", () => {
		const chunks = splitMarkdown(`\`\`\`json\n${"y".repeat(800)}\n\`\`\``, 128);

		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(128);
			expect(fenceCount(chunk) % 2).toBe(0);
		}
	});

	it("emits no empty or fence-only chunks", () => {
		const chunks = splitMarkdown(`\`\`\`ts\n${"z".repeat(900)}\n\`\`\``, 128);

		for (const chunk of chunks) {
			expect(chunk.trim().length).toBeGreaterThan(0);
			expect(chunk.replace(/```\w*/g, "").trim().length).toBeGreaterThan(0);
		}
	});

	it("normalizes CRLF before measuring", () => {
		expect(splitMarkdown("a\r\nb", 100)).toEqual(["a\nb"]);
	});
});

describe("summarize", () => {
	it("collapses whitespace and clips long text", () => {
		expect(summarize("  帮我  看下\n构建  ")).toBe("帮我 看下 构建");
		expect(summarize("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
	});

	it("leaves short text untouched", () => {
		expect(summarize("跑测试", 20)).toBe("跑测试");
	});
});

describe("stripMention", () => {
	it("removes leading mentions only", () => {
		expect(stripMention("@PrimeAgent 看下 CI")).toBe("看下 CI");
		expect(stripMention("  @Bot @Bot2  部署")).toBe("部署");
		expect(stripMention("给 @张三 发个通知")).toBe("给 @张三 发个通知");
	});

	it("returns an empty string when the body was only a mention", () => {
		expect(stripMention(" @PrimeAgent ")).toBe("");
	});
});

describe("mirror formatting", () => {
	it("labels who asked and who answered", () => {
		expect(formatQuestion("Alice", " 跑测试 ")).toBe("**👤 Alice**\n\n跑测试");
		expect(formatAnswer("Alice", "done")).toBe("**🤖 Prime Agent · 回复 Alice**\n\ndone");
		expect(formatAnswer(undefined, "done")).toBe("**🤖 Prime Agent**\n\ndone");
	});
});
