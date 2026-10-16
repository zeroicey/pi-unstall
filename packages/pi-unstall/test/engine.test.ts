import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config.ts";
import { defaultDetectors } from "../src/detect.ts";
import type { Judge } from "../src/types.ts";
import {
	assistantEntry,
	makeAgentDir,
	makeHarness,
	text,
	userEntry,
	writeConfig,
	writePrompt,
} from "./harness.ts";

/** A judge stub that answers with a fixed verdict and counts its calls. */
function stubJudge(verdict: "ok" | "stalled" | "unparsable" | "failed", reason = "stub"): Judge & {
	calls: number;
} {
	const judge = {
		name: "stub-judge",
		calls: 0,
		async adjudicate() {
			judge.calls += 1;
			return { verdict, reason } as any;
		},
	};
	return judge;
}

/** A judge that never resolves until released, for concurrency assertions. */
function deferredJudge() {
	let release!: (value: any) => void;
	const judge = {
		name: "deferred-judge",
		calls: 0,
		async adjudicate() {
			judge.calls += 1;
			return new Promise((resolve) => {
				release = resolve;
			});
		},
	};
	return { judge, release: (verdict: "ok" | "stalled") => release({ verdict, reason: "released" }) };
}

describe("engine: deterministic stalls", () => {
	test("sends the continue text when the run ended with an error", async () => {
		const agentDir = makeAgentDir();
		const harness = makeHarness({ agentDir });
		harness.setBranch([userEntry("u1", "do the thing"), text("partial", { stopReason: "error", errorMessage: "529 overloaded" })]);

		await harness.fire("agent_settled", { aborted: false });

		expect(harness.sent).toEqual(["continue"]);
		expect(harness.logs.at(-1)).toContain("stalled");
	});

	test("never asks the judge when a detector is already certain", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("ok");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("", { stopReason: "error" })]);

		await harness.fire("agent_settled", { aborted: false });

		expect(judge.calls).toBe(0);
		expect(harness.sent).toEqual(["continue"]);
	});

	test("a silent stop is recovered without a judge", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("ok");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([assistantEntry("a1", [{ type: "thinking", thinking: "hmm" }], "stop")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(judge.calls).toBe(0);
		expect(harness.sent).toEqual(["continue"]);
	});

	test("a completed turn is left alone", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("ok", "reported the result");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("Done — the tests pass.")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(judge.calls).toBe(1);
		expect(harness.sent).toEqual([]);
	});

	test("non-terminal stop reasons are ignored entirely", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("working", { stopReason: "toolUse" })]);

		await harness.fire("agent_settled", { aborted: false });

		expect(judge.calls).toBe(0);
		expect(harness.sent).toEqual([]);
	});
});

describe("engine: judge outcomes", () => {
	test("a stalled verdict triggers the recovery", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled", "mid-sentence");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("I will now run the tests")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(harness.sent).toEqual(["continue"]);
	});

	test("a failed judge call is skipped by default", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("failed", "429");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("some prose")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(harness.sent).toEqual([]);
	});

	test("onJudgeFailure=recover turns a failed call into a recovery", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { onJudgeFailure: "recover" });
		const judge = stubJudge("failed", "429");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("some prose")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(harness.sent).toEqual(["continue"]);
	});

	test("an unparsable answer is skipped by default and recoverable by config", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("unparsable", "???");
		const quiet = makeHarness({ agentDir, engine: { judge } });
		quiet.setBranch([text("some prose")]);
		await quiet.fire("agent_settled", { aborted: false });
		expect(quiet.sent).toEqual([]);

		writeConfig(agentDir, { onUnparsable: "recover" });
		const loud = makeHarness({ agentDir, engine: { judge } });
		loud.setBranch([text("some prose")]);
		await loud.fire("agent_settled", { aborted: false });
		expect(loud.sent).toEqual(["continue"]);
	});
});

describe("engine: streak bookkeeping", () => {
	test("caps back-to-back recoveries at maxConsecutive", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { maxConsecutive: 3 });
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		for (let i = 0; i < 5; i++) await harness.fire("agent_settled", { aborted: false });

		expect(harness.sent).toHaveLength(3);
		expect(harness.logs.at(-1)).toContain("giving up");
	});

	test("a healthy stop resets the streak", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { maxConsecutive: 2 });
		let verdict: "ok" | "stalled" = "stalled";
		const judge: Judge = {
			name: "flip",
			async adjudicate() {
				return { verdict, reason: "flip" } as any;
			},
		};
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toHaveLength(1);

		verdict = "ok";
		await harness.fire("agent_settled", { aborted: false });

		verdict = "stalled";
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toHaveLength(2);
	});

	test("the human speaking resets the streak but our own message does not", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { maxConsecutive: 1 });
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toHaveLength(1);

		// Our own send arrives as an "extension" input and must not reset the cap.
		await harness.fire("input", { source: "extension", text: "continue" });
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toHaveLength(1);

		// A human utterance does reset it.
		await harness.fire("input", { source: "interactive", text: "try again" });
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toHaveLength(2);
	});
});

describe("engine: guards", () => {
	test("a user abort suppresses recovery until the human speaks", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: true });
		expect(harness.sent).toEqual([]);

		// Even a plainly stalled run stays quiet while suppressed.
		harness.setBranch([text("", { stopReason: "error" })]);
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual([]);

		await harness.fire("input", { source: "interactive", text: "go on" });
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual(["continue"]);
	});

	test("suppressAfterAbort=false keeps working after an Escape", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { suppressAfterAbort: false });
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: true });
		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual(["continue"]);
	});

	test("pending messages stop the engine", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.ctx.hasPendingMessages = () => true;
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual([]);
	});

	test("a user message after the assistant turn stops the engine", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose"), userEntry("u2", "actually, wait")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual([]);
	});

	test("standing down when the conversation moved on while judging", async () => {
		const agentDir = makeAgentDir();
		let branch: any[] = [text("prose")];
		const judge: Judge = {
			name: "mover",
			async adjudicate() {
				// The human takes over mid-judge: a newer assistant turn appears.
				branch = [text("prose"), userEntry("u2", "stop"), text("ok", {})];
				branch[2]!.id = "a2";
				return { verdict: "stalled", reason: "moved" };
			},
		};
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch(branch);
		// getBranch must observe the mutation above.
		harness.ctx.sessionManager.getBranch = () => branch;

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual([]);
	});

	test("disabled by config means nothing happens", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { enabled: false });
		const harness = makeHarness({ agentDir });
		harness.setBranch([text("", { stopReason: "error" })]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.sent).toEqual([]);
	});
});

describe("engine: TUI vs headless", () => {
	test("the TUI does not await the judge, so a submitted prompt is never blocked", async () => {
		const agentDir = makeAgentDir();
		const { judge, release } = deferredJudge();
		const harness = makeHarness({ agentDir, engine: { judge }, mode: "tui" });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(judge.calls).toBe(1);
		expect(harness.sent).toEqual([]);

		release("stalled");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.sent).toEqual(["continue"]);
	});

	test("headless awaits the judge so print mode cannot exit early", async () => {
		const agentDir = makeAgentDir();
		const { judge, release } = deferredJudge();
		const harness = makeHarness({ agentDir, engine: { judge }, mode: "print" });
		harness.setBranch([text("prose")]);

		let settled = false;
		const firing = harness.fire("agent_settled", { aborted: false }).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		release("stalled");
		await firing;
		expect(harness.sent).toEqual(["continue"]);
	});
});

describe("engine: extensibility", () => {
	test("a custom detector can flag a stall and short-circuit the judge", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("ok");
		const harness = makeHarness({
			agentDir,
			engine: {
				judge,
				detectors: [
					{
						name: "no-tool-use",
						detect: (evidence) =>
							evidence.text.includes("TODO")
								? { verdict: "stalled" as const, reason: "left a TODO behind" }
								: { verdict: "unknown" as const },
					},
					...defaultDetectors(),
				],
			},
		});
		harness.setBranch([text("Done. TODO: wire it up.")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(judge.calls).toBe(0);
		expect(harness.sent).toEqual(["continue"]);
	});

	test("a custom recovery can act instead of sending a message", async () => {
		const agentDir = makeAgentDir();
		const calls: string[] = [];
		const harness = makeHarness({
			agentDir,
			engine: {
				recoveries: [
					{
						name: "notify-only",
						run(context) {
							calls.push(context.decision.reason);
							context.notify("would have continued", "info");
							return false;
						},
					},
				],
			},
		});
		harness.setBranch([text("", { stopReason: "error" })]);

		await harness.fire("agent_settled", { aborted: false });

		expect(calls).toEqual(["stopReason=error"]);
		expect(harness.sent).toEqual([]);
	});

	test("the recovery receives the configured continue text and the streak", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { continueText: "please continue", maxConsecutive: 5 });
		const seen: Array<{ text: string; streak: number }> = [];
		const harness = makeHarness({
			agentDir,
			engine: {
				recoveries: [
					{
						name: "capture",
						run(context) {
							seen.push({ text: context.config.continueText, streak: context.streak });
							context.sendUserMessage(context.config.continueText);
							return true;
						},
					},
				],
			},
		});
		harness.setBranch([text("", { stopReason: "error" })]);

		await harness.fire("agent_settled", { aborted: false });
		await harness.fire("agent_settled", { aborted: false });

		expect(seen).toEqual([
			{ text: "please continue", streak: 0 },
			{ text: "please continue", streak: 1 },
		]);
		expect(harness.sent).toEqual(["please continue", "please continue"]);
	});

	test("the prompt file is what the judge receives", async () => {
		const agentDir = makeAgentDir();
		writePrompt(agentDir, "JUDGE PROMPT FROM FILE");
		let systemPrompt: string | undefined;
		const harness = makeHarness({
			agentDir,
			engine: {
				complete: async (_model, request) => {
					systemPrompt = request.systemPrompt;
					return { stopReason: "stop", content: [{ type: "text", text: '{"verdict":"ok"}' }] };
				},
				resolveModel: () => ({ id: "stub" }),
			},
		});
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });

		expect(systemPrompt).toBe("JUDGE PROMPT FROM FILE");
	});
});

describe("engine: status and commands", () => {
	test("the footer shows the streak and clears when disabled", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled");
		const harness = makeHarness({ agentDir, engine: { judge }, hasUI: true });
		harness.setBranch([text("prose")]);

		await harness.fire("agent_settled", { aborted: false });
		expect(harness.statuses.at(-1)).toBe("♻ 1/3");

		await harness.commands.get("unstall")!("off", harness.ctx);
		expect(harness.statuses.at(-1)).toBeUndefined();
	});

	test("/unstall send sends the continue text", async () => {
		const agentDir = makeAgentDir();
		writeConfig(agentDir, { continueText: "carry on" });
		const harness = makeHarness({ agentDir });
		await harness.commands.get("unstall")!("send", harness.ctx);
		expect(harness.sent).toEqual(["carry on"]);
	});

	test("/unstall judge dry-runs without sending", async () => {
		const agentDir = makeAgentDir();
		const judge = stubJudge("stalled", "looks cut off");
		const harness = makeHarness({ agentDir, engine: { judge } });
		harness.setBranch([text("prose")]);

		await harness.commands.get("unstall")!("judge", harness.ctx);

		expect(judge.calls).toBe(1);
		expect(harness.sent).toEqual([]);
		expect(harness.notifications.at(-1)?.message).toContain("looks cut off");
	});

	test("/unstall reports the resolved config", async () => {
		const agentDir = makeAgentDir();
		const harness = makeHarness({ agentDir });
		await harness.commands.get("unstall")!("", harness.ctx);
		const message = harness.notifications.at(-1)?.message ?? "";
		expect(message).toContain("enabled=yes");
		expect(message).toContain("detectors=stop-reason-guard -> stalled-stop-reason -> empty-prose");
		expect(message).toContain('continueText="continue"');
	});
});
