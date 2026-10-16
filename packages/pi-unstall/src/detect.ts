/**
 * Built-in detectors: the cheap, deterministic half of the decision.
 *
 * Each detector inspects the settled run and returns `ok`, `stalled`, or
 * `unknown`. `unknown` means "this rule cannot tell" and passes the decision to
 * the next detector, and finally to the judge. Keeping the certain cases here
 * means the common failures (provider error, truncation, empty stop) are
 * decided with no model call at all — which also means they still work when the
 * configured model, key, or provider is the thing that broke.
 */

import type {
	Detector,
	DetectorResult,
	ResolvedContext,
	StallEvidence,
	UnstallConfig,
} from "./types.ts";

/** Terminal stop reasons that are not a stall and not worth judging. */
const NOT_A_STALL = new Set(["pending", "toolUse", "deferred", "aborted"]);

/**
 * Bail out on stop reasons that are neither a stall nor decidable here.
 * Returning `ok` stops the pipeline: no judge call, no recovery.
 */
export function stopReasonGuard(evidence: StallEvidence): DetectorResult {
	const stopReason = String(evidence.message.stopReason ?? "");
	if (NOT_A_STALL.has(stopReason)) return { verdict: "ok", reason: `stopReason=${stopReason}` };
	return { verdict: "unknown" };
}

/**
 * Stop reasons that mean the run did not finish: an explicit provider/runtime
 * error, or a response cut off at the output-token limit. Both are certain, so
 * no judge is needed. Configurable through `stalledStopReasons`.
 */
export function stopReasonDetector(evidence: StallEvidence, config: UnstallConfig): DetectorResult {
	const stopReason = String(evidence.message.stopReason ?? "");
	if (config.stalledStopReasons.includes(stopReason)) {
		return { verdict: "stalled", reason: `stopReason=${stopReason}` };
	}
	return { verdict: "unknown" };
}

/**
 * A `stop` with no prose and no tool call: the model ended the turn without
 * saying anything. There is nothing for a human to read or answer, so a judge
 * would only add latency. Configurable through `stalledOnEmptyText`.
 */
export function emptyTextDetector(evidence: StallEvidence, config: UnstallConfig): DetectorResult {
	if (!config.stalledOnEmptyText) return { verdict: "unknown" };
	if (String(evidence.message.stopReason ?? "") !== "stop") return { verdict: "unknown" };
	if (evidence.text.trim().length > 0) return { verdict: "unknown" };
	return { verdict: "stalled", reason: "silent stop (no prose)" };
}

/**
 * The built-in chain, in order. Everything that survives it (`stop` with prose)
 * is genuinely ambiguous and goes to the judge.
 *
 * Compose with these when adding your own rules:
 * `detectors: [...defaultDetectors(), myDetector]`
 */
export function defaultDetectors(): Detector[] {
	return [
		{ name: "stop-reason-guard", detect: (evidence) => stopReasonGuard(evidence) },
		{
			name: "stalled-stop-reason",
			detect: (evidence: StallEvidence, context: ResolvedContext) =>
				stopReasonDetector(evidence, context.config),
		},
		{
			name: "empty-prose",
			detect: (evidence: StallEvidence, context: ResolvedContext) =>
				emptyTextDetector(evidence, context.config),
		},
	];
}
