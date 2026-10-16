/**
 * Configuration: defaults, tolerant merging, and file locations.
 *
 * An unreadable or malformed config never throws: every invalid field falls
 * back to its default so a typo cannot take the extension down.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { UnstallConfig } from "./types.ts";

export const CONFIG_FILE = "pi-unstall.json";
export const PROMPT_FILE = "pi-unstall-prompt.md";

export function defaultConfig(): UnstallConfig {
	return {
		enabled: true,
		continueText: "continue",
		maxConsecutive: 3,
		judge: {
			model: null,
			tailMessages: 12,
			maxTailChars: 6000,
			timeoutMs: 60_000,
			promptFile: null,
		},
		stalledStopReasons: ["error", "length"],
		stalledOnEmptyText: true,
		onJudgeFailure: "skip",
		onUnparsable: "skip",
		suppressAfterAbort: true,
		notify: true,
		debug: false,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: fallback;
}

function mode(value: unknown, fallback: "skip" | "recover"): "skip" | "recover" {
	return value === "skip" || value === "recover" ? value : fallback;
}

/** Merge an untrusted parsed value over a base config. Never throws. */
export function mergeConfig(base: UnstallConfig, raw: unknown): UnstallConfig {
	if (!isPlainObject(raw)) return base;
	const judge = isPlainObject(raw.judge) ? raw.judge : {};
	const model = isPlainObject(judge.model) ? judge.model : null;
	const judgeModel =
		model && typeof model.provider === "string" && typeof model.model === "string"
			? { provider: model.provider, model: model.model }
			: base.judge.model;

	return {
		enabled: bool(raw.enabled, base.enabled),
		continueText:
			typeof raw.continueText === "string" && raw.continueText.trim().length > 0
				? raw.continueText
				: base.continueText,
		maxConsecutive: int(raw.maxConsecutive, base.maxConsecutive, 1, 50),
		judge: {
			model: judgeModel,
			tailMessages: int(judge.tailMessages, base.judge.tailMessages, 1, 100),
			maxTailChars: int(judge.maxTailChars, base.judge.maxTailChars, 500, 200_000),
			timeoutMs: int(judge.timeoutMs, base.judge.timeoutMs, 1000, 600_000),
			promptFile:
				typeof judge.promptFile === "string" ? judge.promptFile : base.judge.promptFile,
		},
		stalledStopReasons: Array.isArray(raw.stalledStopReasons)
			? raw.stalledStopReasons.filter((x): x is string => typeof x === "string")
			: base.stalledStopReasons,
		stalledOnEmptyText: bool(raw.stalledOnEmptyText, base.stalledOnEmptyText),
		onJudgeFailure: mode(raw.onJudgeFailure, base.onJudgeFailure),
		onUnparsable: mode(raw.onUnparsable, base.onUnparsable),
		suppressAfterAbort: bool(raw.suppressAfterAbort, base.suppressAfterAbort),
		notify: bool(raw.notify, base.notify),
		debug: bool(raw.debug, base.debug),
	};
}

/** Read a file, returning `null` for missing files and never throwing. */
export function readTextOrNull(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE);
}

/** Resolve the judge prompt file, honouring an absolute or agent-relative override. */
export function promptPath(agentDir: string, config: UnstallConfig): string {
	const configured = config.judge.promptFile;
	if (!configured) return join(agentDir, PROMPT_FILE);
	return isAbsolute(configured) ? configured : join(agentDir, configured);
}

export interface LoadedConfig {
	config: UnstallConfig;
	/** Absolute path of the config file, whether or not it exists. */
	path: string;
	/** The parsed file contents, before defaults were applied. */
	raw: unknown;
	/** Set when the file exists but could not be parsed. */
	error?: string;
}

/** Load and merge the config file for `agentDir`. */
export function loadConfig(agentDir: string): LoadedConfig {
	const path = configPath(agentDir);
	const base = defaultConfig();
	const text = readTextOrNull(path);
	if (text === null) return { config: base, path, raw: undefined };
	try {
		const raw: unknown = JSON.parse(text);
		return { config: mergeConfig(base, raw), path, raw };
	} catch (error) {
		return {
			config: base,
			path,
			raw: undefined,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
