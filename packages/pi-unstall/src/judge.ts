/**
 * The judge: a single non-streaming model call that decides the one case the
 * detectors cannot — a `stop` that did produce prose. That case is genuinely
 * ambiguous: the model may have finished and reported, or it may have trailed
 * off mid-sentence.
 *
 * The model call is injected (`ModelCompleter`), so this module stays host-free
 * and unit-testable, and prompt files stay the host's business.
 */

import { asArray, compact } from "./tail.ts";
import type {
	DetectorResult,
	Judge,
	JudgeOutcome,
	ResolvedContext,
	StallEvidence,
	UnstallConfig,
} from "./types.ts";

/** The default judge prompt. Override it with `pi-unstall-prompt.md`. */
export const DEFAULT_JUDGE_PROMPT = `You are the stall judge for "pi", a terminal coding agent.

You receive the tail of a conversation plus the run metadata of the final
assistant message (stopReason, errorMessage, model). The conversation may be in
any language; judge meaning, never language or style.

Decide exactly one of two outcomes.

A. NORMAL STOP -> {"verdict":"ok"}
   1. The assistant finished the requested work and reported a result or
      conclusion (even a single "done").
   2. The assistant asked the user a question, requested confirmation, or asked
      for missing information - it is clearly waiting for a human.
   3. The assistant stated that it is blocked and needs the user to intervene.
   4. The final user message did not require any further assistant action
      (thanks, acknowledgement, small talk).

B. STALLED -> {"verdict":"stalled"}
   1. The run metadata shows a non-normal termination such as error or length.
   2. The prose clearly breaks off mid-way: an unfinished sentence, code block,
      list or table, with no closing remark.
   3. The assistant announced a next action ("Now I will run the tests", "Next,
      I'll ...") but neither called a tool nor asked a question before stopping.
   4. The assistant produced only reasoning/thinking, with no prose and no tool
      call.
   5. The prose is empty.
   6. The context shows obvious unfinished work and the assistant stopped with
      no reason.

How to decide:
- The only question that matters is: is the message complete, and is it waiting
  for a human?
- Brevity, a missing sign-off, no tool use, or a one-line answer are all NORMAL.
- When in doubt, choose "ok".

Reply with one line of JSON and nothing else - no markdown fence, no prose:
{"verdict":"ok"|"stalled","reason":"under 20 words"}`;

/** The request passed to the host's completion function. */
export interface JudgeRequest {
	systemPrompt: string;
	messages: Array<{
		role: "user";
		content: Array<{ type: "text"; text: string }>;
		timestamp: number;
	}>;
}

/** The subset of an assistant message the judge reads. */
export interface JudgeResponse {
	stopReason?: string;
	content?: unknown;
}

/** How the judge resolves its model. `undefined` means "none available". */
export type ResolveJudgeModel = (config: UnstallConfig, session?: unknown) => unknown;

/** One non-streaming completion through the host's provider layer. */
export type JudgeComplete = (
	model: unknown,
	request: JudgeRequest,
	options: { signal: AbortSignal; session?: unknown },
) => Promise<JudgeResponse>;

/** Read a prompt file, returning `null` when it is missing or empty. */
export type ReadPrompt = (path: string) => string | null;

export function buildJudgeRequest(promptText: string, tail: string): JudgeRequest {
	return {
		systemPrompt: promptText,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: tail }],
				timestamp: Date.now(),
			},
		],
	};
}

/**
 * Extract the verdict from the judge's raw output.
 *
 * Models drift, so this accepts a JSON object anywhere in the text, tolerates a
 * markdown fence, and falls back to bare keywords. A negated answer
 * ("not interrupted") is resolved before keyword matching, because a naive
 * substring test would read it backwards.
 */
export function parseVerdict(raw: string): DetectorResult {
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			const verdict = String(parsed.verdict ?? parsed.result ?? "").toLowerCase();
			const reason =
				typeof parsed.reason === "string" && parsed.reason.trim()
					? parsed.reason.trim()
					: "(no reason given)";
			if (/stall|interrupt|abnormal|truncat|incomplete/.test(verdict)) {
				return { verdict: "stalled", reason };
			}
			if (/^(ok|normal|done|complete|finished|fine)/.test(verdict)) {
				return { verdict: "ok", reason };
			}
		} catch {
			// fall through to the keyword scan below
		}
	}

	if (/not\s+(stalled|interrupted)|no\s+interruption|不是中断|未中断|没有中断/i.test(raw)) {
		return { verdict: "ok", reason: "judge replied in the negative" };
	}
	if (/\b(stalled|interrupted|incomplete|truncated)\b/i.test(raw)) {
		return { verdict: "stalled", reason: "judge reported a stall" };
	}
	if (/\b(ok|normal|complete|finished)\b/i.test(raw)) {
		return { verdict: "ok", reason: "judge reported a normal stop" };
	}
	return { verdict: "unknown" };
}

export interface ModelJudgeOptions {
	resolveModel: ResolveJudgeModel;
	complete: JudgeComplete;
	/** Resolve the prompt text for a config; a fixed string is fine in tests. */
	loadPrompt: (config: UnstallConfig) => { text: string; source: string };
}

/** The default, model-backed judge. */
export function createModelJudge(options: ModelJudgeOptions): Judge {
	return {
		name: "model-judge",
		async adjudicate(
			evidence: StallEvidence,
			context: ResolvedContext,
			signal: AbortSignal,
		): Promise<JudgeOutcome> {
			const model = options.resolveModel(context.config, context.session);
			if (model === undefined || model === null) {
				return { verdict: "failed", reason: "no judge model available" };
			}
			const prompt = options.loadPrompt(context.config);
			let response: JudgeResponse;
			try {
				response = await options.complete(
					model,
					buildJudgeRequest(prompt.text, evidence.tail),
					{ signal, session: context.session },
				);
			} catch (error) {
				return {
					verdict: "failed",
					reason: `judge call threw: ${compact(
						error instanceof Error ? error.message : String(error),
						200,
					)}`,
				};
			}
			if (response?.stopReason !== "stop") {
				return {
					verdict: "failed",
					reason: `judge call did not complete: stopReason=${response?.stopReason ?? "none"}`,
				};
			}
			const raw = asArray(response.content)
				.filter((block) => block?.type === "text")
				.map((block) => String(block.text ?? ""))
				.join("\n");
			const verdict: DetectorResult = parseVerdict(raw);
			if (verdict.verdict === "unknown") {
				return { verdict: "unparsable", reason: compact(raw, 200) || "(empty judge output)" };
			}
			return verdict;
		},
	};
}
