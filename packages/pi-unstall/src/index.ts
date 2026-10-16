/**
 * pi-unstall — public API.
 *
 * The package's Pi entry point is `./extension.ts` (declared in package.json
 * under `pi.extensions`). Import this module when you want to build your own
 * variant, add detectors or recoveries, or reuse the pieces in tests.
 */

export { createUnstall } from "./unstall.ts";
export type { CreateUnstallOptions, UnstallPi, UnstallSession } from "./unstall.ts";

export { defaultDetectors, emptyTextDetector, stopReasonDetector, stopReasonGuard } from "./detect.ts";
export { continueMessageRecovery, defaultRecoveries } from "./recovery.ts";
export {
	DEFAULT_JUDGE_PROMPT,
	buildJudgeRequest,
	createModelJudge,
	parseVerdict,
} from "./judge.ts";
export type {
	JudgeComplete,
	JudgeRequest,
	JudgeResponse,
	ModelJudgeOptions,
	ReadPrompt,
	ResolveJudgeModel,
} from "./judge.ts";

export {
	CONFIG_FILE,
	PROMPT_FILE,
	configPath,
	defaultConfig,
	loadConfig,
	mergeConfig,
	promptPath,
	readTextOrNull,
} from "./config.ts";
export type { LoadedConfig } from "./config.ts";

export {
	PER_MESSAGE_CHARS,
	THINKING_CHARS,
	asArray,
	buildTail,
	compact,
	findLastAssistant,
	formatMessage,
	hasUserAfterLastAssistant,
	textOf,
} from "./tail.ts";

export type {
	BranchEntry,
	Detector,
	DetectorResult,
	Judge,
	JudgeConfig,
	JudgeOutcome,
	Recovery,
	RecoveryContext,
	ResolvedContext,
	StallDecision,
	StallEvidence,
	UnstallConfig,
	UnstallMessage,
	Verdict,
} from "./types.ts";
