/**
 * Conversation-tail extraction and formatting.
 *
 * Pure functions over session entries: no host imports, no I/O.
 */

import type { BranchEntry, UnstallMessage, UnstallConfig } from "./types.ts";

/** Characters kept from a single normal message handed to the judge. */
export const PER_MESSAGE_CHARS = 1500;
/** Characters kept from a single thinking block. */
export const THINKING_CHARS = 500;

export function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

/** Concatenate the text blocks of a message/content value. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	let out = "";
	for (const block of asArray(content)) {
		if (block?.type === "text" && typeof block.text === "string") out += block.text;
	}
	return out;
}

/** Trim trailing whitespace and cut to `max` characters with a visible marker. */
export function compact(text: string, max: number): string {
	const trimmed = text.replace(/\s+$/g, "");
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}…(${trimmed.length - max} chars omitted)`;
}

/** Render one message as a single labelled block for the judge. */
export function formatMessage(message: UnstallMessage): string {
	switch (message.role) {
		case "user":
			return `[user] ${compact(textOf(message.content), PER_MESSAGE_CHARS)}`;
		case "assistant": {
			const parts: string[] = [];
			for (const block of asArray(message.content)) {
				if (block?.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				} else if (block?.type === "thinking") {
					parts.push(`[thinking] ${compact(String(block.thinking ?? ""), THINKING_CHARS)}`);
				} else if (block?.type === "toolCall") {
					const args = compact(JSON.stringify(block.arguments ?? {}), 200);
					parts.push(`[tool call ${String(block.name)}(${args})]`);
				}
			}
			const meta = [
				`stopReason=${message.stopReason ?? "?"}`,
				message.errorMessage ? `errorMessage=${message.errorMessage}` : null,
				message.model ? `model=${message.model}` : null,
			]
				.filter(Boolean)
				.join(", ");
			const body = parts.length > 0 ? compact(parts.join("\n"), PER_MESSAGE_CHARS) : "(no prose)";
			return `[assistant] ${body}\n[run metadata: ${meta}]`;
		}
		case "toolResult":
			return `[tool result ${String(message.toolName)}${message.isError ? " FAILED" : ""}] ${compact(
				textOf(message.content),
				400,
			)}`;
		case "custom":
			return `[injected context] ${compact(textOf(message.content), 400)}`;
		case "bashExecution":
			return `[user ran command] ${compact(String(message.command ?? ""), 200)} -> exit ${String(
				message.exitCode,
			)}`;
		case "compactionSummary":
			return `[compaction summary] ${compact(String(message.summary ?? ""), 600)}`;
		case "branchSummary":
			return `[branch summary] ${compact(String(message.summary ?? ""), 600)}`;
		default:
			return "";
	}
}

/** The last assistant message of the branch, with its session entry id. */
export function findLastAssistant(
	branch: BranchEntry[],
): { entry: BranchEntry; message: UnstallMessage } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return { entry, message: entry.message };
		}
	}
	return undefined;
}

/** Whether a user message appears after the last assistant message. */
export function hasUserAfterLastAssistant(branch: BranchEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "assistant") return false;
		if (role === "user") return true;
	}
	return false;
}

/**
 * Format the trailing messages for the judge.
 *
 * The budget is spent from the newest message backwards, so the most recent
 * turns always survive truncation.
 */
export function buildTail(
	branch: BranchEntry[],
	config: UnstallConfig,
): { text: string; messageCount: number } {
	const picked: string[] = [];
	const maxMessages = config.judge.tailMessages;

	for (let i = branch.length - 1; i >= 0; i--) {
		if (picked.length >= maxMessages) break;
		const entry = branch[i]!;
		if (entry.type !== "message" || !entry.message?.role) continue;
		const rendered = formatMessage(entry.message);
		if (rendered) picked.push(rendered);
	}
	picked.reverse();

	const kept: string[] = [];
	let used = 0;
	for (let i = picked.length - 1; i >= 0; i--) {
		const block = picked[i]!;
		if (used + block.length > config.judge.maxTailChars) {
			const room = config.judge.maxTailChars - used;
			if (room > 200) kept.push(`${block.slice(0, room)}…(earlier content omitted)`);
			break;
		}
		kept.push(block);
		used += block.length + 2;
	}
	kept.reverse();

	const text = `Tail of the conversation (${kept.length} messages, oldest first):\n\n${kept.join(
		"\n\n",
	)}`;
	return { text, messageCount: kept.length };
}
