/**
 * QA Saver Agent.
 *
 * Explicitly extracts reusable knowledge from a user-selected conversation
 * and saves it as a QA page in the wiki. This module does not track dirty
 * conversations or run automatic startup/switch flushes.
 */

import {
	createDirectory,
	listDirectory,
	readFile,
	writeFile,
} from "@/commands/fs";
import { parseFrontmatter } from "@/lib/frontmatter";
import { streamChat } from "@/lib/llm-client";
import { buildLanguageDirective } from "@/lib/output-language";
import { normalizePath } from "@/lib/path-utils";
import { type WebSearchResult, webSearch } from "@/lib/web-search";
import { flattenMdFiles } from "@/lib/wiki-utils";
import type { DisplayMessage } from "@/stores/chat-store";
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store";
import type { FileNode } from "@/types/wiki";

// ── Types ────────────────────────────────────────────────────────────────────

export interface QaHookResult {
	ok: boolean;
	saved?: boolean;
	qaPath?: string;
	skipped?: boolean;
	skipReason?: string;
	error?: string;
}

/** Source of an explicit QA save, used to tune extraction. */
export type QaHookTrigger = "manual" | "delete";

/** Optional controls for a single explicit QA save. */
export interface QaSaveOptions {
	/** Describes why QA extraction is running; defaults to a manual save. */
	trigger?: QaHookTrigger;
}

const STORAGE_KEY = "llm-wiki:pendingQa";
const RETRY_STORAGE_KEY = "llm-wiki:pendingQaRetryCounts";

function removeStorageItem(key: string, emptyValue: string): void {
	if (typeof localStorage.removeItem === "function") {
		localStorage.removeItem(key);
		return;
	}
	localStorage.setItem(key, emptyValue);
}

/** Clear legacy pending-QA queue keys from older automatic QA builds. */
export function cleanupLegacyPendingQaStorage(): void {
	try {
		removeStorageItem(STORAGE_KEY, "[]");
		removeStorageItem(RETRY_STORAGE_KEY, "{}");
	} catch {
		// localStorage unavailable (SSR, private browsing edge case)
	}
}

// ── Skip Logic ───────────────────────────────────────────────────────────────

const GREETING_RE = /^(hi|hello|hey|你好|您好|嗨|哈喽|yo|sup)\s*[!?.。！？]*$/i;
// Only used for delete-triggered last-turn filtering. Keep this to explicit
// operation phrases rather than a bare "clean" so topics like clean code do
// not look like cleanup work.
const OPERATION_ONLY_RE =
	/(delete|deleted|deleting|remove|removed|removing|purge|cleanup|cleaned up|clean up|clean references|no changes?|nothing to delete|not deleted|permission denied|access denied|cancelled|canceled|删除|移除|删掉|清理|清除|已删|已删除|已经删除|无需删除|不用删除|未删除|没有删除|没有变更|无变更|无需更改|权限拒绝|权限不足|已取消|取消)/i;
const KNOWLEDGE_SIGNAL_RE =
	/(why|how|because|root cause|workaround|regression|warning|error|bug|insight|lesson|原因|原理|机制|策略|表现|应对|解决|观察|问题|错误|报错|警告|回归|限制|配置)/i;

function isDeleteOnlyConversation(
	userMsgs: DisplayMessage[],
	assistantMsgs: DisplayMessage[],
): boolean {
	const lastUser = userMsgs[userMsgs.length - 1]?.content.trim() ?? "";
	const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.content.trim() ?? "";
	const tail = `${lastUser}\n${lastAssistant}`;

	// Delete-triggered QA is intentionally last-turn biased: if the final
	// exchange is only deletion or cleanup bookkeeping, skip extraction even
	// when older turns had reusable knowledge.
	if (!OPERATION_ONLY_RE.test(tail)) return false;
	if (/[?？]/.test(lastUser)) return false;
	if (KNOWLEDGE_SIGNAL_RE.test(tail)) return false;

	return OPERATION_ONLY_RE.test(lastUser) || OPERATION_ONLY_RE.test(lastAssistant);
}

/**
 * Strip a single complete outer Markdown code fence from LLM QA output.
 * Inner fences in the QA body are preserved because only the file wrapper is removed.
 */
export function stripOuterMarkdownFence(content: string): string {
	const trimmed = content.trim();
	const match = trimmed.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
	return match ? match[1].trim() : trimmed;
}

function startsWithMarkdownFence(content: string): boolean {
	return /^```(?:markdown|md)?[ \t]*\r?\n/i.test(content.trimStart());
}

/** Decide whether a conversation is worth extracting a QA from. */
export function shouldExtractQa(
	messages: DisplayMessage[],
	options: QaSaveOptions = {},
): {
	extract: boolean;
	reason?: string;
} {
	const userMsgs = messages.filter((m) => m.role === "user");
	const assistantMsgs = messages.filter((m) => m.role === "assistant");

	// Need at least one meaningful exchange
	if (userMsgs.length === 0 || assistantMsgs.length === 0) {
		return { extract: false, reason: "no-exchange" };
	}

	// Skip if all user messages are greetings
	const allGreetings = userMsgs.every((m) =>
		GREETING_RE.test(m.content.trim()),
	);
	if (allGreetings) {
		return { extract: false, reason: "greeting-only" };
	}

	if (
		(options.trigger ?? "manual") === "delete" &&
		isDeleteOnlyConversation(userMsgs, assistantMsgs)
	) {
		return { extract: false, reason: "delete-only" };
	}

	// Skip if the last assistant message is too short
	const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
	if (lastAssistant.content.trim().length < 100) {
		return { extract: false, reason: "response-too-short" };
	}

	return { extract: true };
}

// ── Dedup ────────────────────────────────────────────────────────────────────

interface ExistingQa {
	title: string;
	body: string;
}

/** Scan wiki/qa/ directory for existing QA pages. */
async function scanExistingQa(projectPath: string): Promise<ExistingQa[]> {
	const pp = normalizePath(projectPath);
	const qaDir = `${pp}/wiki/qa`;

	let tree: FileNode[];
	try {
		tree = await listDirectory(qaDir);
	} catch {
		return [];
	}

	const files = flattenMdFiles(tree);
	const pages: ExistingQa[] = [];

	for (const f of files) {
		try {
			const content = await readFile(f.path);
			const { frontmatter, body } = parseFrontmatter(content);
			if (!frontmatter) continue;
			const type = String(frontmatter.type || "").toLowerCase();
			if (type !== "qa") continue;
			pages.push({ title: String(frontmatter.title || ""), body });
		} catch {
			// skip unreadable
		}
	}

	return pages;
}

/** CJK character range (unified ideographs + extensions). */
const CJK_RE = /[一-鿿㐀-䶿]/;

/**
 * Extract tokens for body overlap detection.
 * - English/numbers: word tokens (3+ chars)
 * - CJK text: character bigrams for better near-duplicate detection
 */
function extractTokens(text: string): Set<string> {
	const cleaned = text.toLowerCase().replace(/[^\w一-鿿㐀-䶿]+/g, " ");
	const tokens = new Set<string>();

	for (const word of cleaned.split(/\s+/)) {
		if (!word) continue;
		// Check if word contains CJK characters
		if (CJK_RE.test(word)) {
			// Extract CJK bigrams
			for (let i = 0; i < word.length - 1; i++) {
				if (CJK_RE.test(word[i]) && CJK_RE.test(word[i + 1])) {
					tokens.add(word[i] + word[i + 1]);
				}
			}
			// Also add individual CJK chars for single-char overlap
			for (const ch of word) {
				if (CJK_RE.test(ch)) tokens.add(ch);
			}
		} else if (word.length >= 3) {
			tokens.add(word);
		}
	}
	return tokens;
}

/** Check Jaccard similarity between two token sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

/** Check if a similar QA already exists (title match or body overlap). */
export function isDuplicateQa(
	title: string,
	body: string | undefined,
	existing: ExistingQa[],
): boolean {
	const normalizedTitle = title.toLowerCase().trim();
	const titleTokens = extractTokens(normalizedTitle);
	const bodyTokens = body ? extractTokens(body) : new Set<string>();

	for (const qa of existing) {
		const existingTitle = qa.title.toLowerCase().trim();
		// Exact title match
		if (normalizedTitle === existingTitle) return true;
		// Fuzzy: if one title contains the other (and both > 10 chars)
		if (
			normalizedTitle.length > 10 &&
			existingTitle.length > 10 &&
			(normalizedTitle.includes(existingTitle) ||
				existingTitle.includes(normalizedTitle))
		) {
			return true;
		}
		if (titleTokens.size > 5) {
			const existingTitleTokens = extractTokens(existingTitle);
			if (jaccardSimilarity(titleTokens, existingTitleTokens) > 0.45) {
				return true;
			}
		}
		// Body content overlap: Jaccard similarity > 0.3 on significant tokens
		if (bodyTokens.size > 5 && qa.body) {
			const existingTokens = extractTokens(qa.body);
			if (jaccardSimilarity(bodyTokens, existingTokens) > 0.3) {
				return true;
			}
		}
	}
	return false;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildQaExtractionPrompt(
	messages: DisplayMessage[],
	wikiContext: string,
	externalResults: WebSearchResult[],
	languageHint: string,
	trigger: QaHookTrigger,
): string {
	const conversation = messages
		.map((m) => `[${m.role}]: ${m.content}`)
		.join("\n\n");

	const externalSection =
		externalResults.length > 0
			? `\n\n## External Research Sources\n\n${externalResults
					.slice(0, 3)
					.map((r) => `- **${r.title}**: ${r.snippet} (${r.url})`)
					.join("\n")}`
			: "";
	const deleteTriggerRules =
		trigger === "delete"
			? [
					"",
					"## Delete-Triggered Extraction",
					"",
					"The user is deleting this conversation. Extract only the most useful NEW knowledge from the final turns.",
					"Strongly prefer the latest user-observed issue, correction, or conclusion over older operational topics.",
					"If the final turns only describe deleting/removing files or conversation cleanup, output ONLY: SKIP.",
					"If the best candidate duplicates an existing QA topic, output ONLY: SKIP.",
				].join("\n")
			: "";

	return `You are a knowledge extraction expert. Analyze the following conversation and extract the key question and its answer into a structured QA document.

${languageHint}

## Conversation

${conversation}
${externalSection}
${wikiContext ? `\n## Existing Wiki Context\n\n${wikiContext}\n` : ""}
${deleteTriggerRules}

## Your Task

Extract the most important question and answer from this conversation. Produce a QA wiki page with this format:

\`\`\`
---
type: qa
title: "the core question in one sentence"
tags: [qa, <relevant-tag-1>, <relevant-tag-2>]
created: ${new Date().toISOString().slice(0, 10)}
---

# Q: [the core question]

## A: [comprehensive answer synthesized from the conversation]

## Key Insights
- [insight 1]
- [insight 2]

## Source References
- [any wiki pages or external sources mentioned]
\`\`\`

Rules:
- **Recency matters most**: Prioritize the LAST user messages and observations. Earlier operational topics (like config values or tool limits) are less valuable than recent user-discovered issues or insights.
- Output raw Markdown only. Do not wrap the page in triple backticks or any Markdown code fence.
- Title must be a clear, specific question (not a generic topic)
- Answer should be self-contained — readable without the original conversation
- Include 2-5 key insights that capture the most valuable knowledge
- If the conversation is too shallow or operational (e.g., "fix this bug"), output ONLY: SKIP
- Tags should reflect the knowledge domain, not "qa" alone
- Output ONLY the wiki page content or "SKIP", nothing else.`;
}

// ── Core Extraction ──────────────────────────────────────────────────────────

/**
 * Run the QA extraction on a set of messages.
 * Explicit save entrypoint for user-requested QA page creation.
 */
export async function saveQaForConversation(
	projectPath: string,
	llmConfig: LlmConfig,
	searchConfig: SearchApiConfig,
	messages: DisplayMessage[],
	options: QaSaveOptions = {},
): Promise<QaHookResult> {
	const trigger = options.trigger ?? "manual";
	// Step 1: Check skip conditions
	const { extract, reason } = shouldExtractQa(messages, { trigger });
	if (!extract) {
		return { ok: true, skipped: true, skipReason: reason };
	}

	const pp = normalizePath(projectPath);

	// Step 2: Scan existing QA for dedup
	const existingQa = await scanExistingQa(pp);

	// Step 2b: Quick title pre-check — skip LLM if last user question already exists
	const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
	if (
		lastUserMsg &&
		isDuplicateQa(
			lastUserMsg.content.trim().slice(0, 120),
			undefined,
			existingQa,
		)
	) {
		return { ok: true, skipped: true, skipReason: "duplicate" };
	}

	// Step 3: External search (supplementary, non-blocking)
	let externalResults: WebSearchResult[] = [];
	try {
		if (lastUserMsg) {
			const query = lastUserMsg.content.slice(0, 200);
			externalResults = await webSearch(query, searchConfig, 3);
		}
	} catch {
		// External search is optional
	}

	// Step 4: Build wiki context hint
	let wikiContext = "";
	try {
		wikiContext = await readFile(`${pp}/wiki/index.md`);
	} catch {
		// optional
	}

	// Step 5: Generate QA via LLM
	// Limit to last 20 messages to keep prompt size manageable
	const trimmedMessages = messages.slice(-20);
	const languageHint = buildLanguageDirective(
		trimmedMessages.map((m) => m.content).join("\n"),
	);
	const prompt = buildQaExtractionPrompt(
		trimmedMessages,
		wikiContext,
		externalResults,
		languageHint,
		trigger,
	);

	let accumulated = "";
	let streamError: unknown;
	await streamChat(llmConfig, [{ role: "user", content: prompt }], {
		onToken: (token) => {
			accumulated += token;
		},
		onDone: () => {},
		onError: (err) => {
			streamError = err;
		},
	});
	if (streamError) throw streamError;

	const rawTrimmed = accumulated.trim();
	const trimmed = stripOuterMarkdownFence(rawTrimmed);
	if (!trimmed || trimmed === "SKIP") {
		return { ok: true, skipped: true, skipReason: "llm-skipped" };
	}
	if (trimmed === rawTrimmed && startsWithMarkdownFence(rawTrimmed)) {
		return {
			ok: false,
			error: "LLM output wrapped in code fence with trailing content",
		};
	}

	// Step 6: Validate frontmatter
	const { frontmatter } = parseFrontmatter(trimmed);
	if (
		!trimmed.startsWith("---") ||
		!frontmatter ||
		String(frontmatter.type || "").toLowerCase() !== "qa"
	) {
		return { ok: false, error: "LLM output missing valid qa frontmatter" };
	}

	const qaTitle = String(frontmatter.title || "");

	// Step 7: Dedup check
	if (isDuplicateQa(qaTitle, trimmed, existingQa)) {
		return { ok: true, skipped: true, skipReason: "duplicate" };
	}

	// Step 8: Save QA page
	const tagSlug =
		qaTitle
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "untagged";

	const qaPath = `wiki/qa/${tagSlug}.md`;
	const fullPath = `${pp}/${qaPath}`;

	await createDirectory(`${pp}/wiki/qa`);
	await writeFile(fullPath, trimmed);

	return {
		ok: true,
		saved: true,
		qaPath,
	};
}
