import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { createModelJudge, buildJudgeRequest, parseVerdict } from "../src/judge.ts";
import type { StallEvidence } from "../src/types.ts";

const config = defaultConfig();

const evidence: StallEvidence = {
	message: { stopReason: "stop" },
	text: "I will now run the tests",
	branch: [],
	aborted: false,
	tail: "TAIL",
};

describe("parseVerdict", () => {
	const cases: Array<[string, string]> = [
		[`{"verdict":"ok","reason":"finished"}`, "ok"],
		[`{"verdict":"stalled","reason":"cut off"}`, "stalled"],
		["```json\n{\"verdict\":\"ok\"}\n```", "ok"],
		[`{"result":"interrupted","reason":"x"}`, "stalled"],
		[`{"verdict":"INTERRUPTED"}`, "stalled"],
		[`{"verdict":"normal"}`, "ok"],
		[`{"verdict":"incomplete"}`, "stalled"],
		[`{"verdict":"complete"}`, "ok"],
		["VERDICT: stalled because the sentence ends mid-way", "stalled"],
		["VERDICT: OK", "ok"],
		["The response was not interrupted; it completed normally.", "ok"],
		["没有中断，正常结束", "ok"],
		["not stalled", "ok"],
		["stalled", "stalled"],
		["blah blah whatever", "unknown"],
		["", "unknown"],
		[`{"verdict":"banana"}`, "unknown"],
	];

	for (const [raw, expected] of cases) {
		test(`${JSON.stringify(raw)} -> ${expected}`, () => {
			expect(parseVerdict(raw).verdict).toBe(expected);
		});
	}

	test("a malformed JSON object still falls back to keywords", () => {
		expect(parseVerdict('{"verdict": broken but stalled').verdict).toBe("stalled");
	});
});

describe("createModelJudge", () => {
	const loadPrompt = () => ({ text: "PROMPT", source: "(test)" });

	test("returns stalled when the model says so", async () => {
		const judge = createModelJudge({
			resolveModel: () => ({ id: "m" }),
			complete: async () => ({
				stopReason: "stop",
				content: [{ type: "text", text: '{"verdict":"stalled","reason":"mid-sentence"}' }],
			}),
			loadPrompt,
		});
		const outcome = await judge.adjudicate(evidence, { config }, new AbortController().signal);
		expect(outcome).toEqual({ verdict: "stalled", reason: "mid-sentence" });
	});

	test("reports a failed call separately from an unparsable answer", async () => {
		const throwing = createModelJudge({
			resolveModel: () => ({ id: "m" }),
			complete: async () => {
				throw new Error("429 too many requests");
			},
			loadPrompt,
		});
		const failed = await throwing.adjudicate(evidence, { config }, new AbortController().signal);
		expect(failed.verdict).toBe("failed");
		expect(failed.reason).toContain("429");

		const garbled = createModelJudge({
			resolveModel: () => ({ id: "m" }),
			complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "hmm" }] }),
			loadPrompt,
		});
		expect(
			(await garbled.adjudicate(evidence, { config }, new AbortController().signal)).verdict,
		).toBe("unparsable");
	});

	test("an error stop reason from the provider counts as a failed call", async () => {
		const judge = createModelJudge({
			resolveModel: () => ({ id: "m" }),
			complete: async () => ({ stopReason: "error", content: [] }),
			loadPrompt,
		});
		const outcome = await judge.adjudicate(evidence, { config }, new AbortController().signal);
		expect(outcome.verdict).toBe("failed");
	});

	test("no model available is a failed call, not a verdict", async () => {
		const judge = createModelJudge({
			resolveModel: () => undefined,
			complete: async () => ({ stopReason: "stop", content: [] }),
			loadPrompt,
		});
		expect(
			(await judge.adjudicate(evidence, { config }, new AbortController().signal)).verdict,
		).toBe("failed");
	});

	test("passes the resolved prompt and the tail through", async () => {
		let seen: unknown;
		const judge = createModelJudge({
			resolveModel: (_config, session) => ({ id: "m", session }),
			complete: async (model, request, options) => {
				seen = { model, request, options };
				return { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"ok"}' }] };
			},
			loadPrompt: () => ({ text: "CUSTOM PROMPT", source: "test" }),
		});
		await judge.adjudicate(evidence, { config, session: "SESSION" }, new AbortController().signal);
		const captured = seen as any;
		expect(captured.request.systemPrompt).toBe("CUSTOM PROMPT");
		expect(captured.request.messages[0].content[0].text).toBe("TAIL");
		expect(captured.model.session).toBe("SESSION");
	});
});

describe("buildJudgeRequest", () => {
	test("wraps the tail as a single user message", () => {
		const request = buildJudgeRequest("SYS", "TAIL");
		expect(request.systemPrompt).toBe("SYS");
		expect(request.messages).toHaveLength(1);
		expect(request.messages[0]!.role).toBe("user");
	});
});
