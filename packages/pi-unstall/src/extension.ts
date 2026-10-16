/**
 * Pi entry point.
 *
 * This is the file `package.json` declares under `pi.extensions`, so installing
 * the package is enough: Pi loads this module, which wires the host's services
 * into the host-free engine in `unstall.ts`. Nothing here contains policy — it
 * is pure adapter code between Pi's `ExtensionContext` and the engine's two
 * injected model hooks.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { JudgeComplete, ResolveJudgeModel } from "./judge.ts";
import { createUnstall } from "./unstall.ts";

/** The engine passes back the session it was handed, so no ambient state is needed. */
function sessionOf(session: unknown): ExtensionContext | undefined {
	return session as ExtensionContext | undefined;
}

/**
 * Report a recoverable configuration problem on stderr, without failing the run.
 * Pi captures extension stderr into its log, which is where this belongs.
 */
const reportFallback = (message: string): void => {
	process.stderr.write(`[pi-unstall] ${message}\n`);
};

const resolveModel: ResolveJudgeModel = (config, session) => {
	const ctx = sessionOf(session);
	if (!ctx) return undefined;
	if (config.judge.model) {
		const found = ctx.modelRegistry.find(
			config.judge.model.provider,
			config.judge.model.model,
		);
		if (found) return found;
		reportFallback(
			`judge model ${config.judge.model.provider}/${config.judge.model.model} not found; falling back to the session model`,
		);
	}
	return ctx.model;
};

const complete: JudgeComplete = (model, request, options) => {
	const ctx = sessionOf(options.session);
	if (!ctx) throw new Error("pi-unstall: judge called without a session context");
	// SAFETY: the engine's request shape is a provider-neutral subset of Pi's `Context`
	// (a system prompt plus user messages), so this widening cast loses nothing: Pi
	// receives exactly these fields.
	const context = {
		systemPrompt: request.systemPrompt,
		messages: request.messages,
	} as unknown as Parameters<typeof ctx.modelRegistry.complete>[1];
	return ctx.modelRegistry.complete(
		model as Parameters<typeof ctx.modelRegistry.complete>[0],
		context,
		{ signal: options.signal },
	) as ReturnType<JudgeComplete>;
};

export default function piUnstall(pi: ExtensionAPI): void {
	createUnstall({ agentDir: getAgentDir(), resolveModel, complete })(pi);
}
