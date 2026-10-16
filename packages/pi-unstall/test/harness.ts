/**
 * Test harness: a stub `pi` and a stub `ctx` good enough to drive the whole
 * engine, so the pipeline is verified without a Pi process or a model call.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry, UnstallMessage } from "../src/types.ts";
import { createUnstall, type CreateUnstallOptions, type UnstallPi } from "../src/unstall.ts";

export function makeAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-unstall-test-"));
}

export function writeConfig(agentDir: string, value: unknown): void {
	writeFileSync(join(agentDir, "pi-unstall.json"), JSON.stringify(value, null, 2));
}

export function writePrompt(agentDir: string, text: string): void {
	writeFileSync(join(agentDir, "pi-unstall-prompt.md"), text);
}

export function assistantEntry(
	id: string,
	content: unknown,
	stopReason: string,
	extra: Partial<UnstallMessage> = {},
): BranchEntry {
	return {
		id,
		type: "message",
		message: { role: "assistant", content, stopReason, ...extra },
	};
}

export function userEntry(id: string, text: string): BranchEntry {
	return { id, type: "message", message: { role: "user", content: text } };
}

export function text(value: string, extra: Partial<UnstallMessage> = {}): BranchEntry {
	return assistantEntry("a1", [{ type: "text", text: value }], "stop", extra);
}

export interface Harness {
	pi: UnstallPi;
	/** Messages the extension tried to send, in order. */
	sent: string[];
	/** Everything the engine logged, regardless of UI availability. */
	logs: string[];
	notifications: Array<{ message: string; level: string }>;
	statuses: Array<string | undefined>;
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	branch: BranchEntry[];
	ctx: any;
	/** Deliver a lifecycle event to every registered handler. */
	fire(event: string, payload?: Record<string, unknown>): Promise<void>;
	/** Set state a handler will read. */
	setBranch(branch: BranchEntry[]): void;
}

export function makeHarness(options: {
	agentDir: string;
	engine?: Partial<CreateUnstallOptions>;
	mode?: string;
	hasUI?: boolean;
}): Harness {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const sent: string[] = [];
	const logs: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();

	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
	} as unknown as UnstallPi;

	const harness = {
		pi,
		sent,
		logs,
		notifications,
		statuses,
		commands,
		branch: [] as BranchEntry[],
		ctx: undefined as any,
		setBranch(branch: BranchEntry[]) {
			harness.branch = branch;
		},
		async fire(event: string, payload: Record<string, unknown> = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler({ type: event, ...payload }, harness.ctx);
			}
		},
	};

	harness.ctx = {
		mode: options.mode ?? "print",
		hasUI: options.hasUI ?? true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		model: { provider: "test", id: "test-model" },
		modelRegistry: { find: () => undefined },
		sessionManager: { getBranch: () => harness.branch },
		ui: {
			notify: (message: string, level = "info") => notifications.push({ message, level }),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	const engine = createUnstall({
		agentDir: options.agentDir,
		log: (message: string) => logs.push(message),
		...options.engine,
	});
	engine(pi);

	return harness;
}
