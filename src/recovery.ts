/**
 * Recoveries: what to do once a stall is confirmed.
 *
 * The built-in recovery sends a plain message that lands in the transcript as if
 * the human typed it. That is deliberate — it re-enters the normal agent loop
 * with no special path, so it behaves exactly like you reaching over and typing
 * "continue" yourself.
 *
 * Other packages can add recoveries through `createUnstall({ recoveries })`.
 */

import type { Recovery, RecoveryContext } from "./types.ts";

/** The default recovery: send `continueText` as a user message. */
export function continueMessageRecovery(): Recovery {
	return {
		name: "continue-message",
		run(context: RecoveryContext): boolean {
			context.sendUserMessage(context.config.continueText);
			return true;
		},
	};
}

export function defaultRecoveries(): Recovery[] {
	return [continueMessageRecovery()];
}
