import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import {
	buildTail,
	compact,
	findLastAssistant,
	formatMessage,
	hasUserAfterLastAssistant,
	textOf,
} from "../src/tail.ts";
import type { BranchEntry } from "../src/types.ts";
import { assistantEntry, text, userEntry } from "./harness.ts";

describe("textOf / compact", () => {
	test("joins text blocks and ignores the rest", () => {
		expect(
			textOf([
				{ type: "text", text: "a" },
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "b" },
			]),
		).toBe("ab");
	});

	test("passes strings through", () => {
		expect(textOf("plain")).toBe("plain");
	});

	test("marks truncation", () => {
		expect(compact("abcdef", 3)).toBe("abc…(3 chars omitted)");
		expect(compact("abc", 10)).toBe("abc");
	});
});

describe("formatMessage", () => {
	test("summarises an assistant turn with its run metadata", () => {
		const rendered = formatMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			stopReason: "error",
			errorMessage: "529 overloaded",
			model: "m1",
		});
		expect(rendered).toContain("hello");
		expect(rendered).toContain("stopReason=error");
		expect(rendered).toContain("errorMessage=529 overloaded");
	});

	test("renders thinking and tool calls", () => {
		const rendered = formatMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			],
			stopReason: "toolUse",
		});
		expect(rendered).toContain("[thinking] reasoning");
		expect(rendered).toContain("[tool call bash(");
	});

	test("says so when there is no prose", () => {
		expect(formatMessage({ role: "assistant", content: [], stopReason: "stop" })).toContain(
			"(no prose)",
		);
	});
});

describe("branch helpers", () => {
	test("findLastAssistant skips trailing non-assistant entries", () => {
		const branch: BranchEntry[] = [
			userEntry("u1", "hi"),
			text("done"),
			{ id: "e1", type: "custom", message: { role: "custom", content: "note" } },
		];
		expect(findLastAssistant(branch)?.entry.id).toBe("a1");
	});

	test("findLastAssistant returns undefined for an empty branch", () => {
		expect(findLastAssistant([])).toBeUndefined();
	});

	test("hasUserAfterLastAssistant detects a human follow-up", () => {
		expect(hasUserAfterLastAssistant([text("done"), userEntry("u2", "no, do it")])).toBe(true);
		expect(hasUserAfterLastAssistant([userEntry("u1", "go"), text("done")])).toBe(false);
	});
});

describe("buildTail", () => {
	const config = defaultConfig();

	test("keeps the newest messages and counts them", () => {
		const branch: BranchEntry[] = [];
		for (let i = 0; i < 30; i++) branch.push(assistantEntry(`a${i}`, [{ type: "text", text: `m${i}` }], "stop"));
		const tail = buildTail(branch, { ...config, judge: { ...config.judge, tailMessages: 5 } });
		expect(tail.messageCount).toBe(5);
		expect(tail.text).toContain("m29");
		expect(tail.text).not.toContain("m20");
	});

	test("spends the character budget from the newest message backwards", () => {
		const branch: BranchEntry[] = [
			assistantEntry("a1", [{ type: "text", text: "OLD".repeat(200) }], "stop"),
			assistantEntry("a2", [{ type: "text", text: "NEWEST" }], "stop"),
		];
		const tail = buildTail(branch, {
			...config,
			judge: { ...config.judge, maxTailChars: 500 },
		});
		expect(tail.text).toContain("NEWEST");
		// The newest message fits in full; the oldest is truncated, not dropped.
		expect(tail.text).toContain("OLDOLDOLD");
		expect(tail.text).toContain("earlier content omitted");
		expect(tail.text.length).toBeLessThan(900);
	});

	test("always includes the final message even when it alone exceeds the budget", () => {
		const branch: BranchEntry[] = [
			assistantEntry("a1", [{ type: "text", text: "x".repeat(5000) }], "stop"),
		];
		const tail = buildTail(branch, { ...config, judge: { ...config.judge, maxTailChars: 500 } });
		expect(tail.messageCount).toBe(1);
		expect(tail.text).toContain("x".repeat(100));
	});
});
