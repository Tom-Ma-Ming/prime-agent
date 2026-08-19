/**
 * Markdown adaptation for DingTalk.
 *
 * DingTalk caps message size and renders only a subset of markdown, so long agent answers
 * have to be split. Splitting never cuts a fenced code block in half: an open fence is
 * closed at the end of a chunk and reopened at the start of the next one.
 */

/** Longest fence info string carried across a split, so the reopen line stays bounded. */
const MAX_FENCE_INFO = 32;

function isFence(line: string): boolean {
	return line.startsWith("```");
}

function fenceInfo(line: string): string {
	return line.slice(3).trim().slice(0, MAX_FENCE_INFO);
}

/** Break a single oversized line into pieces that each fit the budget. */
function hardWrap(line: string, budget: number): string[] {
	const width = Math.max(1, budget);
	if (line.length <= width) return [line];
	const pieces: string[] = [];
	for (let index = 0; index < line.length; index += width) {
		pieces.push(line.slice(index, index + width));
	}
	return pieces;
}

/**
 * Split markdown into chunks of at most `maxChars` characters.
 *
 * Returns an empty array for blank input, and a single chunk when the text already fits.
 */
export function splitMarkdown(text: string, maxChars: number): string[] {
	if (!Number.isInteger(maxChars) || maxChars < 64) {
		throw new Error(`maxChars must be an integer >= 64, got ${maxChars}`);
	}

	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length === 0) return [];
	if (normalized.length <= maxChars) return [normalized];

	const chunks: string[] = [];
	let current: string[] = [];
	let currentLength = 0;
	/** Info string of the fence currently open in `current`, or undefined when not inside one. */
	let openFence: string | undefined;

	/** Room a chunk must leave for the closing fence it may have to append. */
	const closingCost = () => (openFence === undefined ? 0 : 4);
	/** Room the *next* chunk needs for its reopened fence line. */
	const reopenCost = () => (openFence === undefined ? 0 : openFence.length + 4);
	const budget = () => maxChars - closingCost();

	const emit = (reopen: boolean) => {
		// A buffer holding nothing but fence lines carries no information: keep accumulating
		// instead of shipping an empty code block.
		if (!current.some((line) => !isFence(line) && line.trim().length > 0)) return;

		const parts = [...current];
		if (openFence !== undefined) parts.push("```");
		const chunk = parts.join("\n").trim();
		if (chunk.length > 0) chunks.push(chunk);
		current = [];
		currentLength = 0;
		if (reopen && openFence !== undefined) {
			const reopenLine = `\`\`\`${openFence}`;
			current.push(reopenLine);
			currentLength = reopenLine.length + 1;
		}
	};

	for (const rawLine of normalized.split("\n")) {
		// A piece must fit a fresh chunk that may already carry a reopened fence line.
		for (const line of hardWrap(rawLine, budget() - reopenCost())) {
			if (currentLength > 0 && currentLength + line.length + 1 > budget()) emit(true);
			current.push(line);
			currentLength += line.length + 1;
			if (isFence(line)) {
				openFence = openFence === undefined ? fenceInfo(line) : undefined;
			}
		}
	}

	emit(false);
	return chunks;
}

/** Collapse text to a single line and clip it, for use as a message/card title. */
export function summarize(text: string, maxLength = 20): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxLength) return flat;
	return `${flat.slice(0, Math.max(1, maxLength - 1))}…`;
}

/** Strip the leading `@robot` mention DingTalk keeps in group message bodies. */
export function stripMention(text: string): string {
	return text.replace(/^(?:\s*@[^\s@]+)+/u, "").trim();
}

/** Render the "someone asked" line mirrored into spectator groups. */
export function formatQuestion(nick: string, question: string): string {
	return `**👤 ${nick}**\n\n${question.trim()}`;
}

/** Render the answer mirrored into spectator groups, tagged with who asked. */
export function formatAnswer(nick: string | undefined, answer: string): string {
	const who = nick ? ` · 回复 ${nick}` : "";
	return `**🤖 Prime Agent${who}**\n\n${answer.trim()}`;
}
