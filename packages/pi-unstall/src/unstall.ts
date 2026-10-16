/**
 * The engine: wire the lifecycle events to detectors, the judge, and recoveries.
 *
 * Everything host-specific is injected, so the whole pipeline runs in tests with
 * a stub `pi` and a stub `ctx` — no Pi process and no model call.
 *
 * The structure is intentionally three-stage so new stall shapes are additive:
 *
 *   detectors (cheap, certain)  ->  judge (one model call)  ->  recoveries
 *          `unknown` falls through to the next stage
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE, loadConfig, mergeConfig, promptPath, readTextOrNull } from "./config.ts";
import { defaultDetectors } from "./detect.ts";
import {
	DEFAULT_JUDGE_PROMPT,
	createModelJudge,
	type JudgeComplete,
	type ResolveJudgeModel,
} from "./judge.ts";
import { defaultRecoveries } from "./recovery.ts";
import { buildTail, findLastAssistant, hasUserAfterLastAssistant, textOf } from "./tail.ts";
import type {
	BranchEntry,
	Detector,
	Judge,
	Recovery,
	StallDecision,
	StallEvidence,
	UnstallConfig,
} from "./types.ts";

/** The extension surface this engine actually uses. */
export type UnstallPi = Pick<ExtensionAPI, "on" | "sendUserMessage" | "registerCommand">;

/** The session-manager surface this engine actually uses. */
export interface UnstallSession {
	getBranch(): unknown;
}

export interface CreateUnstallOptions {
	/** Directory holding `pi-unstall.json` and `pi-unstall-prompt.md`. */
	agentDir: string;
	/** Reach the model registry (the host wires the session model call here). */
	complete?: JudgeComplete;
	/** Pick the judge model. Defaults to whatever the host resolves. */
	resolveModel?: ResolveJudgeModel;
	/** Replace the detector chain. Compose with `defaultDetectors()`. */
	detectors?: Detector[];
	/** Replace the judge entirely. */
	judge?: Judge;
	/** Replace the recovery chain. Compose with `defaultRecoveries()`. */
	recoveries?: Recovery[];
	/** Settings merged over the file config, after the built-in defaults. */
	settingsOverrides?: Record<string, unknown>;
	/** Injectable clock, for tests. */
	now?: () => number;
	/** Diagnostics sink; defaults to the host log. */
	log?: (message: string) => void;
}

const TAG = "[pi-unstall]";

/**
 * Build the extension. Returns a Pi extension factory.
 *
 * @example Custom detectors and an extra recovery
 * ```ts
 * import { createUnstall, defaultDetectors, defaultRecoveries } from "pi-unstall";
 *
 * export default (pi) =>
 *   createUnstall({
 *     agentDir: getAgentDir(),
 *     detectors: [...defaultDetectors(), myDetector],
 *     recoveries: [...defaultRecoveries(), myRecovery],
 *   })(pi);
 * ```
 */
export function createUnstall(options: CreateUnstallOptions) {
	const log = options.log ?? ((message: string) => console.error(`${TAG} ${message}`));
	const now = options.now ?? (() => Date.now());
	const detectors = options.detectors ?? defaultDetectors();
	const recoveries = options.recoveries ?? defaultRecoveries();

	const state = {
		/** Recoveries already run back to back. */
		streak: 0,
		/** Set after a user abort; cleared when the human speaks again. */
		suppressed: false,
		inflight: undefined as AbortController | undefined,
		lastVerdict: "-",
		lastReason: "",
		lastAt: 0,
		enabledOverride: undefined as boolean | undefined,
		tailMessages: 0,
		tailBytes: 0,
		configPath: "",
		configError: undefined as string | undefined,
	};

	/** Read the config fresh on every decision, so edits apply without a reload. */
	function readConfig(): UnstallConfig {
		const loaded = loadConfig(options.agentDir);
		state.configPath = loaded.path;
		state.configError = loaded.error;
		if (loaded.error) log(`${CONFIG_FILE} could not be parsed, using defaults: ${loaded.error}`);
		return options.settingsOverrides
			? mergeConfig(loaded.config, options.settingsOverrides)
			: loaded.config;
	}

	function loadPrompt(config: UnstallConfig): { text: string; source: string } {
		const path = promptPath(options.agentDir, config);
		const fromFile = readTextOrNull(path);
		if (fromFile !== null && fromFile.trim().length > 0) return { text: fromFile, source: path };
		return { text: DEFAULT_JUDGE_PROMPT, source: "(built-in default)" };
	}

	const judge: Judge =
		options.judge ??
		createModelJudge({
			resolveModel: options.resolveModel ?? (() => undefined),
			complete: options.complete ?? (async () => ({ stopReason: "error" })),
			loadPrompt,
		});

	const isEnabled = (config: UnstallConfig): boolean =>
		state.enabledOverride === undefined ? config.enabled : state.enabledOverride;

	function cancelInflight(): void {
		state.inflight?.abort();
		state.inflight = undefined;
	}

	/** The Pi extension factory. */
	return function apply(pi: UnstallPi): void {
		function setStatus(ctx: ExtensionContext, config: UnstallConfig): void {
			if (!ctx.hasUI) return;
			try {
				if (!isEnabled(config)) {
					ctx.ui.setStatus("pi-unstall", undefined);
					return;
				}
				const suffix = state.suppressed
					? " ⏸"
					: state.streak > 0
						? ` ${state.streak}/${config.maxConsecutive}`
						: "";
				ctx.ui.setStatus("pi-unstall", `♻${suffix}`);
			} catch {
				// The footer is never a critical path.
			}
		}

		function notify(
			ctx: ExtensionContext,
			config: UnstallConfig,
			message: string,
			level: "info" | "warning" | "error",
		): void {
			log(message);
			if (!config.notify || !ctx.hasUI) return;
			try {
				ctx.ui.notify(`${TAG} ${message}`, level);
			} catch {
				// ignore UI failures
			}
		}

		function noteHealthy(ctx: ExtensionContext, config: UnstallConfig, reason: string): void {
			state.lastVerdict = "ok";
			state.lastReason = reason;
			state.lastAt = now();
			setStatus(ctx, config);
			if (config.debug) log(`healthy stop: ${reason}`);
		}

		function collectEvidence(
			branch: BranchEntry[],
			aborted: boolean,
			config: UnstallConfig,
		): StallEvidence | undefined {
			const last = findLastAssistant(branch);
			if (!last) return undefined;
			const tail = buildTail(branch, config);
			state.tailMessages = tail.messageCount;
			state.tailBytes = tail.text.length;
			return {
				message: last.message,
				entryId: last.entry.id,
				text: textOf(last.message.content),
				branch,
				aborted,
				tail: tail.text,
			};
		}

		/** Run the recoveries. Returns true when one acted. */
		async function runRecoveries(
			ctx: ExtensionContext,
			config: UnstallConfig,
			evidence: StallEvidence,
			decision: StallDecision,
		): Promise<boolean> {
			if (state.streak >= config.maxConsecutive) {
				notify(
					ctx,
					config,
					`still stalled after ${state.streak} recoveries (${decision.reason}); giving up and leaving it to you.`,
					"error",
				);
				return false;
			}

			const recoveryContext = {
				config,
				evidence,
				decision,
				streak: state.streak,
				sendUserMessage: (text: string) => {
					state.lastVerdict = "stalled";
					state.lastReason = decision.reason;
					state.lastAt = now();
					pi.sendUserMessage(text);
				},
				notify: (message: string, level: "info" | "warning" | "error") =>
					notify(ctx, config, message, level),
			};

			for (const recovery of recoveries) {
				let acted = false;
				try {
					acted = await recovery.run(recoveryContext);
				} catch (error) {
					log(`recovery "${recovery.name}" threw: ${error}`);
					continue;
				}
				if (!acted) continue;
				state.streak += 1;
				setStatus(ctx, config);
				notify(
					ctx,
					config,
					`stalled (${decision.reason}; via ${decision.by}) — sent "${config.continueText}" (${state.streak}/${config.maxConsecutive}).`,
					"info",
				);
				return true;
			}
			return false;
		}

		/** Decide, then recover. Assumes the outer guards already passed. */
		async function evaluate(
			ctx: ExtensionContext,
			config: UnstallConfig,
			evidence: StallEvidence,
		): Promise<void> {
			const resolved = { config, session: ctx };

			for (const detector of detectors) {
				let result;
				try {
					result = detector.detect(evidence, resolved);
				} catch (error) {
					log(`detector "${detector.name}" threw: ${error}`);
					continue;
				}
				if (result.verdict === "ok") {
					state.streak = 0;
					noteHealthy(ctx, config, `${result.reason} (via ${detector.name})`);
					return;
				}
				if (result.verdict === "stalled") {
					await runRecoveries(ctx, config, evidence, {
						reason: result.reason,
						by: detector.name,
					});
					return;
				}
			}

			// Every detector said "unknown": this is the ambiguous case.
			const controller = new AbortController();
			state.inflight = controller;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, config.judge.timeoutMs);

			let outcome;
			try {
				outcome = await judge.adjudicate(evidence, resolved, controller.signal);
			} catch (error) {
				log(`judge "${judge.name}" threw: ${error}`);
				outcome = { verdict: "failed" as const, reason: String(error) };
			} finally {
				clearTimeout(timer);
				if (state.inflight === controller) state.inflight = undefined;
			}

			// A user utterance or a shutdown cancelled the judge: the human owns the
			// conversation now. A timeout is different — that is a judge failure.
			if (controller.signal.aborted && !timedOut) {
				if (config.debug) log("judge cancelled before a verdict; standing down");
				return;
			}

			if (outcome.verdict === "ok") {
				state.streak = 0;
				noteHealthy(ctx, config, `${outcome.reason} (via ${judge.name})`);
				return;
			}

			let decision: StallDecision;
			if (outcome.verdict === "stalled") {
				decision = { reason: outcome.reason, by: judge.name };
			} else if (outcome.verdict === "unparsable") {
				if (config.onUnparsable !== "recover") {
					noteHealthy(ctx, config, `judge output unparsable: ${outcome.reason}`);
					return;
				}
				decision = { reason: `judge output unparsable (${outcome.reason})`, by: judge.name };
			} else {
				if (config.onJudgeFailure !== "recover") {
					noteHealthy(ctx, config, `judge unavailable: ${outcome.reason}`);
					return;
				}
				decision = { reason: `judge unavailable (${outcome.reason})`, by: judge.name };
			}

			// Second guard: the human may have taken over while the judge was thinking.
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				if (config.debug) log("host is busy again; standing down");
				return;
			}
			const fresh = findLastAssistant(ctx.sessionManager.getBranch() as unknown as BranchEntry[]);
			if (!fresh || fresh.entry.id !== evidence.entryId) {
				if (config.debug) log("conversation moved on while judging; standing down");
				return;
			}

			await runRecoveries(ctx, config, evidence, decision);
		}

		// ---------------------------------------------------------------------
		// Lifecycle
		// ---------------------------------------------------------------------

		pi.on("agent_settled", (event, ctx) => {
			const config = readConfig();
			if (!isEnabled(config)) return;

			if (event.aborted) {
				// Escape is the human asking for quiet: never fight for the wheel.
				if (config.suppressAfterAbort) state.suppressed = true;
				state.streak = 0;
				setStatus(ctx, config);
				if (config.debug) log("run was aborted by the user; standing down");
				return;
			}
			if (state.suppressed) {
				if (config.debug) log("suppressed after a user abort; waiting for input");
				return;
			}
			if (ctx.hasPendingMessages()) return;

			const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
			if (hasUserAfterLastAssistant(branch)) {
				if (config.debug) log("a user message follows the assistant turn; standing down");
				return;
			}
			const evidence = collectEvidence(branch, false, config);
			if (!evidence) {
				if (config.debug) log("no assistant message in the branch; standing down");
				return;
			}

			const run = (): Promise<void> =>
				evaluate(ctx, config, evidence).catch((error) => {
					log(`evaluation failed: ${error}`);
				});

			// In the TUI, do not await: Pi defers any prompt submitted while
			// `agent_settled` handlers are still running, so awaiting a model call
			// here would visibly stall the user's next message. Every action is
			// re-guarded before it fires, so yielding is safe.
			//
			// Headless (rpc/json/print) must await: print mode disposes the runtime
			// as soon as `prompt()` resolves, which would otherwise kill an
			// in-flight judge.
			return ctx.mode === "tui" ? void run() : run();
		});

		// A human utterance clears the suppression and the streak. Messages this
		// extension sends are sourced "extension" and must not reset its own
		// bookkeeping.
		pi.on("input", (event, ctx) => {
			if (event.source !== "interactive" && event.source !== "rpc") return;
			cancelInflight();
			state.suppressed = false;
			state.streak = 0;
			setStatus(ctx, readConfig());
		});

		pi.on("agent_start", () => cancelInflight());

		pi.on("session_start", (_event, ctx) => {
			cancelInflight();
			state.streak = 0;
			state.suppressed = false;
			setStatus(ctx, readConfig());
		});

		pi.on("session_shutdown", () => {
			cancelInflight();
			state.streak = 0;
			state.suppressed = false;
		});

		// ---------------------------------------------------------------------
		// Commands
		// ---------------------------------------------------------------------

		function statusLines(config: UnstallConfig): string[] {
			const model = config.judge.model
				? `${config.judge.model.provider}/${config.judge.model.model}`
				: "(session model)";
			return [
				`enabled=${isEnabled(config) ? "yes" : "no"}${
					state.enabledOverride === undefined ? "" : " (overridden this session)"
				}`,
				`recoveries=${state.streak}/${config.maxConsecutive}`,
				`continueText=${JSON.stringify(config.continueText)}`,
				`detectors=${detectors.map((d) => d.name).join(" -> ")}`,
				`judge=${judge.name} model=${model}`,
				`prompt=${loadPrompt(config).source}`,
				`suppressed=${state.suppressed ? "yes (after Escape)" : "no"}`,
				`config=${state.configPath}${state.configError ? ` (ERROR: ${state.configError})` : ""}`,
				state.lastAt > 0
					? `last verdict=${state.lastVerdict}${state.lastReason ? ` (${state.lastReason})` : ""}`
					: "last verdict=-",
			];
		}

		pi.registerCommand("unstall", {
			description:
				"pi-unstall status, or: on | off | judge (dry-run the judge) | send (send the continue text)",
			handler: async (args, ctx) => {
				const command = args.trim().toLowerCase();
				const config = readConfig();

				if (command === "on") {
					state.enabledOverride = true;
					setStatus(ctx, config);
					ctx.ui.notify(`${TAG} enabled`, "info");
					return;
				}
				if (command === "off") {
					state.enabledOverride = false;
					cancelInflight();
					setStatus(ctx, config);
					ctx.ui.notify(`${TAG} disabled`, "warning");
					return;
				}
				if (command === "send") {
					pi.sendUserMessage(config.continueText);
					return;
				}
				if (command === "judge") {
					const branch = ctx.sessionManager.getBranch() as unknown as BranchEntry[];
					if (!findLastAssistant(branch)) {
						ctx.ui.notify(`${TAG} no assistant message in this branch`, "warning");
						return;
					}
					const evidence = collectEvidence(branch, false, config)!;
					const outcome = await judge.adjudicate(
						evidence,
						{ config, session: ctx },
						new AbortController().signal,
					);
					ctx.ui.notify(
						`${TAG} dry-run judge: ${outcome.verdict} — ${outcome.reason}\n(tail: ${state.tailMessages} msgs / ${state.tailBytes} chars)`,
						outcome.verdict === "failed" ? "error" : "info",
					);
					return;
				}

				ctx.ui.notify(`${TAG}\n${statusLines(config).join("\n")}`, "info");
			},
		});
	};
}
