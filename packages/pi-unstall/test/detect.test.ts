import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { defaultDetectors, emptyTextDetector, stopReasonGuard } from "../src/detect.ts";
import type { ResolvedContext, StallEvidence, UnstallMessage } from "../src/types.ts";

const config = defaultConfig();

function evidence(message: UnstallMessage): StallEvidence {
	return { message, text: "", branch: [], aborted: false, tail: "" };
}

describe("stopReasonGuard", () => {
	test("non-terminal stop reasons stop the pipeline without judging", () => {
		for (const stopReason of ["pending", "toolUse", "deferred", "aborted"]) {
			expect(stopReasonGuard(evidence({ stopReason }))).toEqual({
				verdict: "ok",
				reason: `stopReason=${stopReason}`,
			});
		}
	});

	test("a plain stop falls through", () => {
		expect(stopReasonGuard(evidence({ stopReason: "stop" })).verdict).toBe("unknown");
	});
});

describe("defaultDetectors", () => {
	function run(
		message: Record<string, unknown>,
		text: string,
		overrides: Partial<typeof config> = {},
	) {
		const resolved: ResolvedContext = { config: { ...config, ...overrides } };
		const bag: StallEvidence = { message, text, branch: [], aborted: false, tail: "" };
		for (const detector of defaultDetectors()) {
			const result = detector.detect(bag, resolved);
			if (result.verdict !== "unknown") return result;
		}
		return { verdict: "unknown" as const };
	}

	test("error stop reason is a stall", () => {
		expect(run({ stopReason: "error", errorMessage: "529 overloaded" }, "")).toEqual({
			verdict: "stalled",
			reason: "stopReason=error",
		});
	});

	test("length stop reason is a stall", () => {
		expect(run({ stopReason: "length" }, "half a sentence")).toEqual({
			verdict: "stalled",
			reason: "stopReason=length",
		});
	});

	test("silent stop with prose is left to the judge", () => {
		expect(run({ stopReason: "stop" }, "I will now run the tests")).toEqual({
			verdict: "unknown",
		});
	});

	test("empty prose on a stop is a stall without a judge", () => {
		expect(run({ stopReason: "stop" }, "   \n  ")).toEqual({
			verdict: "stalled",
			reason: "silent stop (no prose)",
		});
	});

	test("empty-prose detection can be switched off", () => {
		expect(run({ stopReason: "stop" }, "", { stalledOnEmptyText: false }).verdict).toBe("unknown");
	});

	test("stalled stop reasons are configurable", () => {
		expect(run({ stopReason: "error" }, "", { stalledStopReasons: [] }).verdict).toBe("unknown");
	});

	test("a completed turn with prose is never decided by a detector", () => {
		expect(run({ stopReason: "stop" }, "Done. Everything passes.").verdict).toBe("unknown");
	});
});

describe("emptyTextDetector", () => {
	test("ignores non-stop reasons", () => {
		expect(
			emptyTextDetector(
				{ message: { stopReason: "error" }, text: "", branch: [], aborted: false, tail: "" },
				config,
			).verdict,
		).toBe("unknown");
	});
});
