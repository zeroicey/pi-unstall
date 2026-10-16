import { describe, expect, test } from "bun:test";
import { configPath, defaultConfig, loadConfig, mergeConfig, promptPath } from "../src/config.ts";
import { makeAgentDir, writeConfig, writePrompt } from "./harness.ts";

describe("mergeConfig", () => {
	const base = defaultConfig();

	test("ignores non-objects", () => {
		expect(mergeConfig(base, null)).toEqual(base);
		expect(mergeConfig(base, "nope")).toEqual(base);
		expect(mergeConfig(base, [1, 2])).toEqual(base);
	});

	test("applies valid fields", () => {
		const merged = mergeConfig(base, {
			enabled: false,
			continueText: "keep going",
			maxConsecutive: 7,
			stalledStopReasons: ["error"],
			onJudgeFailure: "recover",
		});
		expect(merged.enabled).toBe(false);
		expect(merged.continueText).toBe("keep going");
		expect(merged.maxConsecutive).toBe(7);
		expect(merged.stalledStopReasons).toEqual(["error"]);
		expect(merged.onJudgeFailure).toBe("recover");
	});

	test("merges nested judge fields without dropping the rest", () => {
		const merged = mergeConfig(base, { judge: { tailMessages: 3 } });
		expect(merged.judge.tailMessages).toBe(3);
		expect(merged.judge.maxTailChars).toBe(base.judge.maxTailChars);
		expect(merged.judge.model).toBeNull();
	});

	test("falls back field by field on garbage", () => {
		const merged = mergeConfig(base, {
			enabled: "yes",
			continueText: "   ",
			maxConsecutive: 0,
			judge: { tailMessages: 9999, timeoutMs: "soon", model: { provider: 42 } },
			stalledStopReasons: "error",
			onUnparsable: "explode",
		});
		expect(merged.enabled).toBe(base.enabled);
		expect(merged.continueText).toBe(base.continueText);
		expect(merged.maxConsecutive).toBe(base.maxConsecutive);
		expect(merged.judge.tailMessages).toBe(base.judge.tailMessages);
		expect(merged.judge.timeoutMs).toBe(base.judge.timeoutMs);
		expect(merged.judge.model).toBeNull();
		expect(merged.stalledStopReasons).toEqual(base.stalledStopReasons);
		expect(merged.onUnparsable).toBe(base.onUnparsable);
	});

	test("accepts an explicit judge model", () => {
		const merged = mergeConfig(base, { judge: { model: { provider: "p", model: "m" } } });
		expect(merged.judge.model).toEqual({ provider: "p", model: "m" });
	});
});

describe("loadConfig", () => {
	test("missing file yields defaults and no error", () => {
		const agentDir = makeAgentDir();
		const loaded = loadConfig(agentDir);
		expect(loaded.config).toEqual(defaultConfig());
		expect(loaded.error).toBeUndefined();
		expect(loaded.path).toBe(configPath(agentDir));
	});

	test("reads and merges a real file", () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { maxConsecutive: 2, continueText: "go on" });
		const loaded = loadConfig(agentDir);
		expect(loaded.config.maxConsecutive).toBe(2);
		expect(loaded.config.continueText).toBe("go on");
		expect(loaded.raw).toEqual({ maxConsecutive: 2, continueText: "go on" });
	});

	test("malformed JSON is reported, never thrown, and falls back", () => {
		const agentDir = makeAgentDir();
		writePrompt(agentDir, "unused");
		writeConfig(agentDir, {});
		// overwrite with invalid JSON
		const { writeFileSync } = require("node:fs");
		writeFileSync(configPath(agentDir), "{ not json");
		const loaded = loadConfig(agentDir);
		expect(loaded.config).toEqual(defaultConfig());
		expect(loaded.error).toBeTruthy();
	});
});

describe("promptPath", () => {
	test("defaults inside the agent dir", () => {
		expect(promptPath("/agent", defaultConfig())).toBe("/agent/pi-unstall-prompt.md");
	});

	test("honours a relative override against the agent dir", () => {
		const config = { ...defaultConfig(), judge: { ...defaultConfig().judge, promptFile: "mine.md" } };
		expect(promptPath("/agent", config)).toBe("/agent/mine.md");
	});

	test("honours an absolute override", () => {
		const config = {
			...defaultConfig(),
			judge: { ...defaultConfig().judge, promptFile: "/elsewhere/mine.md" },
		};
		expect(promptPath("/agent", config)).toBe("/elsewhere/mine.md");
	});
});
