/**
 * Public types for pi-unstall.
 *
 * Glossary
 * --------
 * stall     A run that ended although the work was not finished: the provider
 *           returned an error, the response was truncated, the model emitted no
 *           prose at all, or it trailed off mid-sentence / announced a next step
 *           and then stopped.
 * detector  A cheap, deterministic test over the final assistant message.
 * judge     A model call used only for the one case detectors cannot decide.
 * recovery  The action taken when a stall is confirmed (the built-in one sends
 *           a `continue` message exactly as if the human typed it).
 *
 * Nothing in this file imports the Pi packages, so the whole engine stays
 * host-free and unit-testable.
 */

/** Result of a detection or adjudication step. */
export type Verdict = "ok" | "stalled" | "unknown";

/** Minimal structural view of one conversation message; sessions carry more. */
export interface UnstallMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	toolName?: string;
	isError?: boolean;
	command?: string;
	exitCode?: number;
	summary?: string;
}

/** One entry of the active session branch. */
export interface BranchEntry {
	id?: string;
	type: string;
	message?: UnstallMessage;
}

/** Everything a detector, judge, or recovery may inspect. */
export interface StallEvidence {
	/** The final assistant message of the settled run. */
	message: UnstallMessage;
	/** Session entry id of that message, used to re-confirm before acting. */
	entryId?: string;
	/** Plain text of the final assistant message (text blocks only). */
	text: string;
	/** The active branch, oldest first. */
	branch: BranchEntry[];
	/** Whether Pi reported the run as user-aborted (Escape). */
	aborted: boolean;
	/** Conversation tail formatted for a model. */
	tail: string;
}

/** Context handed to detectors and the judge. */
export interface ResolvedContext {
	config: UnstallConfig;
	/**
	 * Opaque host object for this run (Pi passes its `ExtensionContext`).
	 * Typed `unknown` so this package never depends on the host at build time.
	 */
	session?: unknown;
}

export type DetectorResult =
	| { verdict: "ok"; reason: string }
	| { verdict: "stalled"; reason: string }
	| { verdict: "unknown" };

/**
 * The judge's answer. Unlike a detector it distinguishes "I could not decide"
 * from "the call itself failed", because the two are governed by separate
 * configuration switches (`onUnparsable` and `onJudgeFailure`).
 */
export type JudgeOutcome =
	| { verdict: "ok"; reason: string }
	| { verdict: "stalled"; reason: string }
	| { verdict: "unparsable"; reason: string }
	| { verdict: "failed"; reason: string };

/**
 * A deterministic test over the settled run. Return `unknown` to hand the
 * decision to the next detector, and finally to the judge.
 */
export interface Detector {
	/** Shown in notifications and `/unstall` status; keep it short. */
	name: string;
	detect(evidence: StallEvidence, context: ResolvedContext): DetectorResult;
}

/** The model-backed tie-breaker. Runs only when every detector returned `unknown`. */
export interface Judge {
	name: string;
	adjudicate(
		evidence: StallEvidence,
		context: ResolvedContext,
		signal: AbortSignal,
	): Promise<JudgeOutcome>;
}

/** The confirmed-stall verdict passed to a recovery. */
export interface StallDecision {
	reason: string;
	/** Which detector or judge reached this verdict. */
	by: string;
}

/** Context handed to a recovery. */
export interface RecoveryContext extends ResolvedContext {
	evidence: StallEvidence;
	decision: StallDecision;
	/** How many times recovery has already run back to back. */
	streak: number;
	/** Send a message that lands in the transcript as if the human typed it. */
	sendUserMessage(text: string): void;
	/** Human-facing notification; a no-op when the host has no UI. */
	notify(message: string, level: "info" | "warning" | "error"): void;
}

/** The action taken on a confirmed stall. Return `true` when it acted. */
export interface Recovery {
	name: string;
	run(context: RecoveryContext): Promise<boolean> | boolean;
}

/** Judge configuration. */
export interface JudgeConfig {
	/** `null` uses the session's current model. */
	model: { provider: string; model: string } | null;
	/** How many trailing messages are sent to the judge. */
	tailMessages: number;
	/** Hard cap on the tail's size. */
	maxTailChars: number;
	/** Abort the judge call after this long. */
	timeoutMs: number;
	/** `null` uses `pi-unstall-prompt.md` in the agent directory. */
	promptFile: string | null;
}

export interface UnstallConfig {
	enabled: boolean;
	/** The message sent on a confirmed stall. */
	continueText: string;
	/** Give up after this many back-to-back recoveries. */
	maxConsecutive: number;
	judge: JudgeConfig;
	/** Stop reasons that mean "stalled" without consulting a model. */
	stalledStopReasons: string[];
	/** A `stop` with no prose at all counts as stalled. */
	stalledOnEmptyText: boolean;
	/** When the judge call itself fails. */
	onJudgeFailure: "skip" | "recover";
	/** When the judge's output cannot be parsed. */
	onUnparsable: "skip" | "recover";
	/** After a user abort (Escape), stay quiet until the human types again. */
	suppressAfterAbort: boolean;
	/** Show notifications for recoveries and give-ups. */
	notify: boolean;
	/** Verbose engine logging to the host log. */
	debug: boolean;
}
