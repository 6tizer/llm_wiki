import fs from "node:fs/promises";
import path from "node:path";
import {
	createSdkMcpServer,
	tool,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppToolBridge } from "./app-tool-bridge.js";
import type { AgentResourceLimitPayload } from "./types.js";
import { createWikiApiClient, type WikiApiClientOptions } from "./wiki-api.js";
import {
	assertFixedDirectoryPath,
	assertWikiMarkdownPath,
	assertWritableContents,
	buildConceptMarkdown,
	buildEntityMarkdown,
	defaultConceptPath,
	defaultEntityPath,
	diffSummary,
	type FileSystemLike,
	pathExists,
	resolveWritePlan,
	sha256,
} from "./wiki-paths.js";

// Keep these defaults in sync with DEFAULT_AGENT_RESOURCE_CONFIG in the frontend.
export const DEFAULT_MAX_WRITE_BYTES = 256 * 1024;
export const DEFAULT_MAX_FILES_CHANGED = 10;
const STRING_ARRAY = z.array(z.string());
const SOURCE_MODE_SCHEMA = z.enum(["web", "anytxt", "both"]);
const RESEARCH_SEED_ERROR = "Provide topic or at least one searchQueries/queries item";
const DUPLICATE_MERGE_SEED_ERROR = "Provide duplicate group.slugs or slugs with at least two page slugs";

export interface WikiChangedPayload {
	path: string;
	operation: "update" | "create" | "delete";
	oldSha256?: string;
	newSha256?: string;
	toolUseId?: string;
	snapshotted?: boolean;
}

interface AppToolResult {
	ok?: boolean;
	result?: unknown;
	changedPaths?: string[];
	wikiChanged?: WikiChangedPayload[];
	resourceLimit?: AgentResourceLimitPayload;
}

export interface LlmWikiToolContext extends WikiApiClientOptions {
	projectPath?: string;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
	/** Plumbing-only toggle threaded from AgentResourceConfig for future
	 * stricter file-count preflight. */
	maxFilesChangedEnabled?: boolean;
	fs?: FileSystemLike;
	onWikiChanged?: (payload: WikiChangedPayload) => void;
	changedPaths?: Set<string>;
	streamId?: string;
	getCurrentToolUseId?: (toolName: string) => string | undefined;
	appToolBridge?: AppToolBridge;
	emitAgentEvent?: (type: string, data: unknown) => void;
}

interface RewindSnapshotManifestEntry {
	seq: number;
	path: string;
	operation: "update" | "create";
	existedBefore: boolean;
	beforeSha256?: string;
	afterSha256: string;
	toolUseId?: string;
	timestamp: number;
	snapshotFile: string;
}

const snapshotSeqByRun = new Map<string, number>();

function snapshotRunKey(projectPath: string, streamId: string): string {
	return `${projectPath}\0${streamId}`;
}

function nextSnapshotSeq(projectPath: string, streamId: string): number {
	const key = snapshotRunKey(projectPath, streamId);
	const next = (snapshotSeqByRun.get(key) ?? 0) + 1;
	snapshotSeqByRun.set(key, next);
	return next;
}

function sanitizeSnapshotPath(relativePath: string): string {
	return relativePath.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "wiki-page";
}

async function writeRewindSnapshot(args: {
	projectPath: string;
	streamId?: string;
	relativePath: string;
	operation: "update" | "create";
	existedBefore: boolean;
	beforeText: string;
	beforeSha256?: string;
	afterSha256: string;
	toolUseId?: string;
}): Promise<boolean> {
	if (!args.streamId) return false;

	const seq = nextSnapshotSeq(args.projectPath, args.streamId);
	const dir = path.join(args.projectPath, ".llm-wiki", "rewind-snapshots", args.streamId);
	const safePath = sanitizeSnapshotPath(args.relativePath);
	const safeToolUseId = args.toolUseId ? sanitizeSnapshotPath(args.toolUseId) : "no-tool-use-id";
	const snapshotFile = `${String(seq).padStart(6, "0")}-${safePath}-${safeToolUseId}.md`;
	const entry: RewindSnapshotManifestEntry = {
		seq,
		path: args.relativePath,
		operation: args.operation,
		existedBefore: args.existedBefore,
		beforeSha256: args.beforeSha256,
		afterSha256: args.afterSha256,
		toolUseId: args.toolUseId,
		timestamp: Date.now(),
		snapshotFile,
	};

	try {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, snapshotFile), args.beforeText, "utf8");
		await fs.appendFile(path.join(dir, "manifest.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

function jsonResult(data: unknown, isError = false): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		structuredContent: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { value: data },
		...(isError ? { isError: true } : {}),
	};
}

function resourceResult(data: Record<string, unknown>, uri: string, text: string): CallToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify(data, null, 2) },
			{
				type: "resource",
				resource: {
					uri,
					mimeType: "text/markdown",
					text,
				},
			},
		],
		structuredContent: data,
	};
}

function emitResourceLimit(
	context: LlmWikiToolContext,
	payload: AgentResourceLimitPayload,
): void {
	context.emitAgentEvent?.("agent_action_required", payload);
}

function resourceLimitResult(
	context: LlmWikiToolContext,
	payload: AgentResourceLimitPayload,
	extra: Record<string, unknown> = {},
): CallToolResult {
	emitResourceLimit(context, payload);
	return jsonResult(
		{
			ok: false,
			kind: payload.limitKind,
			limit: payload.limit,
			used: payload.used,
			attempted: payload.attempted,
			changedPaths: payload.changedPaths,
			path: payload.path,
			bytes: payload.bytes,
			error: payload.message,
			resourceLimit: payload,
			// Legacy structuredContent consumers still read changedCount directly.
			...extra,
		},
		true,
	);
}

function normalizedLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function ensureChangedPaths(context: LlmWikiToolContext): Set<string> {
	context.changedPaths = context.changedPaths ?? new Set<string>();
	return context.changedPaths;
}

function appToolBudget(context: LlmWikiToolContext): { maxFilesChanged: number; maxWriteBytes: number; changedPaths: string[]; maxFilesChangedEnabled?: boolean } {
	return {
		maxFilesChanged: normalizedLimit(context.maxFilesChanged, DEFAULT_MAX_FILES_CHANGED),
		maxWriteBytes: normalizedLimit(context.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES),
		changedPaths: Array.from(ensureChangedPaths(context)).sort(),
		maxFilesChangedEnabled: context.maxFilesChangedEnabled === true,
	};
}

function isAbsoluteSourceDir(value: string): boolean {
	const normalized = value.replace(/\\/g, "/");
	return normalized.startsWith("/")
		|| /^[A-Za-z]:\//.test(normalized)
		|| normalized.startsWith("//");
}

function hasTraversalSegment(value: string): boolean {
	return value.replace(/\\/g, "/").split("/").some((segment) => segment === "..");
}

function pathFromObject(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const candidate = record.relativePath ?? record.path;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

async function safe(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await handler();
	} catch (err) {
		return jsonResult(
			{
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			},
			true,
		);
	}
}

async function appTool(
	context: LlmWikiToolContext,
	toolName: string,
	args: Record<string, unknown>,
	options: { requiresWrite?: boolean; includeTaskId?: boolean } = {},
): Promise<CallToolResult> {
	if (!context.streamId) throw new Error("streamId is required for app tools");
	if (!context.appToolBridge) throw new Error("App tool bridge is not available");
	if (options.requiresWrite && context.enableWriteTools === false) {
		throw new Error("Wiki write tools are disabled for this request");
	}
	if (toolName === "save_query_page") {
		const maxWriteBytes = normalizedLimit(context.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES);
		const content = typeof args.content === "string" ? args.content : "";
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > maxWriteBytes) {
			return resourceLimitResult(context, {
				kind: "resource_limit",
				limitKind: "max_write_bytes",
				limit: maxWriteBytes,
				bytes,
				path: "wiki/queries",
				toolName,
				message: `Write exceeds maxWriteBytes (${bytes} > ${maxWriteBytes})`,
				recovery: "settings_agent",
			});
		}
		if (context.maxFilesChangedEnabled === true) {
			const maxFilesChanged = normalizedLimit(context.maxFilesChanged, DEFAULT_MAX_FILES_CHANGED);
			const changedPaths = ensureChangedPaths(context);
			if (changedPaths.size >= maxFilesChanged) {
				const sortedPaths = Array.from(changedPaths).sort();
				return resourceLimitResult(
					context,
					{
						kind: "resource_limit",
						limitKind: "max_files_changed",
						limit: maxFilesChanged,
						used: changedPaths.size,
						attempted: changedPaths.size + 1,
						changedPaths: sortedPaths,
						path: "wiki/queries",
						toolName,
						message: `Write would exceed maxFilesChanged (${maxFilesChanged})`,
						recovery: "split_task",
					},
					{ changedCount: changedPaths.size },
				);
			}
		}
	}

	const taskId = `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	context.emitAgentEvent?.("agent_task_started", {
		taskId,
		toolName,
		message: `Starting ${toolName}`,
	});
	context.emitAgentEvent?.("agent_task_progress", {
		taskId,
		toolName,
		message: "Waiting for LLM Wiki app service",
	});

	try {
		const raw = await context.appToolBridge.callTool(
			context.streamId,
			toolName,
			args,
			options.requiresWrite ? appToolBudget(context) : undefined,
		);
		const data = normalizeAppToolResult(raw);
		const changedPaths = ensureChangedPaths(context);
		const fallbackSavePath = toolName === "save_query_page"
			? pathFromObject(data.result)
			: undefined;
		for (const changed of data.wikiChanged ?? []) {
			changedPaths.add(changed.path);
			context.onWikiChanged?.(changed);
		}
		for (const changedPath of data.changedPaths ?? []) {
			changedPaths.add(changedPath);
			if (changedPath.startsWith("wiki/")) {
				context.onWikiChanged?.({
					path: changedPath,
					operation: "update",
				});
			}
		}
		if (
			fallbackSavePath &&
			!data.changedPaths?.includes(fallbackSavePath) &&
			!data.wikiChanged?.some((changed) => changed.path === fallbackSavePath)
		) {
			changedPaths.add(fallbackSavePath);
			context.onWikiChanged?.({
				path: fallbackSavePath,
				operation: "create",
			});
		}
		if (data.resourceLimit) {
			const sortedPaths = Array.from(changedPaths).sort();
			return resourceLimitResult(
				context,
				{
					...data.resourceLimit,
					toolName: data.resourceLimit.toolName ?? toolName,
					changedPaths: data.resourceLimit.changedPaths ?? sortedPaths,
				},
				{ changedCount: changedPaths.size },
			);
		}
		const toolResult = data.result ?? raw;
		const resultPayload = options.includeTaskId && toolResult && typeof toolResult === "object" && !Array.isArray(toolResult)
			? { taskId, ...(toolResult as Record<string, unknown>) }
			: toolResult;
		context.emitAgentEvent?.("agent_task_done", {
			taskId,
			toolName,
			message: `Finished ${toolName}`,
			progress: 1,
			result: resultPayload,
		});
		return jsonResult(resultPayload);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		context.emitAgentEvent?.("agent_task_error", {
			taskId,
			toolName,
			error: message,
		});
		return jsonResult({ ok: false, error: message }, true);
	}
}

function normalizeAppToolResult(raw: unknown): AppToolResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("App tool returned an invalid response");
	}
	const data = raw as Record<string, unknown>;
	return {
		ok: typeof data.ok === "boolean" ? data.ok : undefined,
		result: data.result ?? raw,
		changedPaths: parseChangedPaths(data.changedPaths),
		wikiChanged: parseWikiChanged(data.wikiChanged),
		resourceLimit: parseResourceLimit(data.resourceLimit),
	};
}

function parseResourceLimit(value: unknown): AgentResourceLimitPayload | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resourceLimit must be an object");
	}
	const record = value as Record<string, unknown>;
	// App-level MCP bridge limits are write-budget failures only. SDK turn
	// limits use the core stream path, so this is narrower than the shared union.
	type AppToolResourceLimitKind = Extract<
		AgentResourceLimitPayload["limitKind"],
		"max_files_changed" | "max_write_bytes"
	>;
	const limitKind = record.limitKind;
	const allowedLimitKinds: readonly AppToolResourceLimitKind[] = [
		"max_files_changed",
		"max_write_bytes",
	];
	if (
		record.kind !== "resource_limit" ||
		!allowedLimitKinds.includes(limitKind as AppToolResourceLimitKind) ||
		typeof record.message !== "string" ||
		(record.recovery !== "split_task" && record.recovery !== "settings_agent")
	) {
		throw new Error("resourceLimit is invalid");
	}
	const changedPaths = parseChangedPaths(record.changedPaths);
	return {
		kind: "resource_limit",
		limitKind: limitKind as AppToolResourceLimitKind,
		...(typeof record.limit === "number" ? { limit: record.limit } : {}),
		...(typeof record.used === "number" ? { used: record.used } : {}),
		...(typeof record.attempted === "number" ? { attempted: record.attempted } : {}),
		...(record.changedPaths !== undefined ? { changedPaths } : {}),
		...(typeof record.path === "string" ? { path: record.path } : {}),
		...(typeof record.bytes === "number" ? { bytes: record.bytes } : {}),
		...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
		message: record.message,
		recovery: record.recovery,
	};
}

function parseChangedPaths(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("changedPaths must be an array");
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseWikiChanged(value: unknown): WikiChangedPayload[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("wikiChanged must be an array");
	const allowedOperations = new Set(["update", "create", "delete"]);
	return value.flatMap((item): WikiChangedPayload[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		if (
			typeof record.path !== "string" ||
			!allowedOperations.has(String(record.operation))
		) {
			return [];
		}
		return [
			{
				path: record.path,
				operation: record.operation as WikiChangedPayload["operation"],
				...(typeof record.oldSha256 === "string" ? { oldSha256: record.oldSha256 } : {}),
				...(typeof record.newSha256 === "string" ? { newSha256: record.newSha256 } : {}),
			},
		];
	});
}

function hasNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.some((item) => hasNonEmptyString(item));
}

function hasAtLeastTwoNonEmptyStrings(value: unknown): boolean {
	return Array.isArray(value) && value.filter((item) => hasNonEmptyString(item)).length >= 2;
}

function assertResearchSeed(args: Record<string, unknown>): void {
	if (
		hasNonEmptyString(args.topic) ||
		hasNonEmptyStringArray(args.searchQueries) ||
		hasNonEmptyStringArray(args.queries)
	) {
		return;
	}
	throw new Error(RESEARCH_SEED_ERROR);
}

function assertDuplicateMergeSeed(args: Record<string, unknown>): void {
	if (hasAtLeastTwoNonEmptyStrings(args.slugs)) return;
	const group = args.group;
	if (group && typeof group === "object" && !Array.isArray(group)) {
		if (hasAtLeastTwoNonEmptyStrings((group as Record<string, unknown>).slugs)) return;
	}
	throw new Error(DUPLICATE_MERGE_SEED_ERROR);
}

const RESEARCH_TOPIC_FIELD = z.string().min(1)
	.describe("Research topic. Required when searchQueries/queries is omitted.");
const RESEARCH_QUERIES_FIELD = STRING_ARRAY
	.describe("Specific search queries. Empty items are ignored when topic is present.");
const RESEARCH_QUERIES_REQUIRED_FIELD = z.array(z.string().min(1)).min(1)
	.describe("Specific search queries. Required when topic is omitted.");
const RESEARCH_QUERY_ALIAS_FIELD = STRING_ARRAY
	.describe("Alias for searchQueries. Empty items are ignored when topic/searchQueries is present.");
const RESEARCH_QUERY_ALIAS_REQUIRED_FIELD = z.array(z.string().min(1)).min(1)
	.describe("Alias for searchQueries. Required when topic/searchQueries is omitted.");

const researchSeedObjectSchema = z.union([
	z.object({
		topic: RESEARCH_TOPIC_FIELD,
		searchQueries: RESEARCH_QUERIES_FIELD.optional(),
		queries: RESEARCH_QUERY_ALIAS_FIELD.optional(),
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
	z.object({
		topic: RESEARCH_TOPIC_FIELD.optional(),
		searchQueries: RESEARCH_QUERIES_REQUIRED_FIELD,
		queries: RESEARCH_QUERY_ALIAS_FIELD.optional(),
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
	z.object({
		topic: RESEARCH_TOPIC_FIELD.optional(),
		searchQueries: RESEARCH_QUERIES_FIELD.optional(),
		queries: RESEARCH_QUERY_ALIAS_REQUIRED_FIELD,
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
]);

const DUPLICATE_GROUP_FIELD = z.object({
	slugs: z.array(z.string().min(1)).min(2),
	reason: z.string().optional(),
	confidence: z.enum(["high", "medium", "low"]).optional(),
}).describe("Duplicate group returned by detect_duplicates. Required when slugs is omitted.");
const DUPLICATE_SLUGS_FIELD = z.array(z.string().min(1)).min(2)
	.describe("Duplicate page slugs. Required when group is omitted.");

const duplicateMergeObjectSchema = z.union([
	z.object({
		group: DUPLICATE_GROUP_FIELD,
		slugs: DUPLICATE_SLUGS_FIELD.optional(),
		canonicalSlug: z.string().min(1),
		dryRun: z.boolean().optional(),
	}),
	z.object({
		group: DUPLICATE_GROUP_FIELD.optional(),
		slugs: DUPLICATE_SLUGS_FIELD,
		canonicalSlug: z.string().min(1),
		dryRun: z.boolean().optional(),
	}),
]);

const taxonomyActionSchema = z.enum(["bootstrap", "growth"]);
const taxonomyActionObjectSchema = z.object({
	action: taxonomyActionSchema.describe("Taxonomy operation: bootstrap starts from wiki pages; growth extends the existing sidecar taxonomy."),
});
const okfImportObjectSchema = z.object({
	sourceDir: z.string()
		.min(1)
		.refine((value) => value.trim().length > 0, "sourceDir must not be blank")
		.refine((value) => !value.includes("\0"), "sourceDir must not contain NUL bytes")
		.refine(isAbsoluteSourceDir, "sourceDir must be an absolute path")
		.refine((value) => !hasTraversalSegment(value), "sourceDir must not contain path traversal")
		.describe("sourceDir must be an absolute OKF-compatible source project directory. The target is always the active LLM Wiki project."),
	apply: z.boolean().optional().describe("Defaults to false preview mode. Set true to write planned pages after the app-level write budget passes."),
}).strict();
const synthesisPreviewObjectSchema = z.object({
	dimension: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
	targetTag: z.string().min(1).optional(),
	targetTags: z.array(z.string().min(1)).max(8).optional(),
	minClusterSize: z.number().int().positive().max(50).optional(),
	maxCandidates: z.number().int().positive().max(50).optional(),
});
const wikiSynthesisObjectSchema = z.object({
	dimension: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
	targetTag: z.string().optional(),
	targetTags: z.array(z.string()).optional(),
	minClusterSize: z.number().optional(),
	maxCandidates: z.number().optional(),
});

function appMcpTool<Schema extends z.ZodTypeAny>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: (args: z.infer<Schema>) => Promise<CallToolResult>,
): SdkMcpToolDefinition<any> {
	return {
		name,
		description,
		inputSchema,
		handler: (args) => handler(args as z.infer<Schema>),
	};
}

async function readExisting(fsLike: FileSystemLike, absolutePath: string): Promise<string> {
	return fsLike.readFile(absolutePath, "utf8");
}

async function writePage(args: {
	context: LlmWikiToolContext;
	relativePath: string;
	contents: string;
	mode: "replace" | "append";
	expectedSha256?: string;
	dryRun?: boolean;
	operation: "update" | "create";
	toolName: "update_page" | "create_entity" | "create_concept";
	mustExist: boolean;
	fixedDirectory?: "entities" | "concepts";
}): Promise<CallToolResult> {
	const fsLike = args.context.fs ?? fs;
	const projectPath = args.context.projectPath;
	if (!projectPath) throw new Error("projectPath is required for write tools");
	if (args.context.enableWriteTools === false && !args.dryRun) {
		throw new Error("Write tools are disabled for this request");
	}

	const maxWriteBytes = normalizedLimit(args.context.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES);
	const relativePath = args.fixedDirectory
		? assertFixedDirectoryPath(args.relativePath, args.fixedDirectory)
		: assertWikiMarkdownPath(args.relativePath);

	await fsLike.mkdir(path.join(projectPath, "wiki"), { recursive: true });
	if (args.fixedDirectory) {
		await fsLike.mkdir(path.join(projectPath, "wiki", args.fixedDirectory), { recursive: true });
	}

	const plan = await resolveWritePlan(fsLike, projectPath, relativePath);
	const exists = await pathExists(fsLike, plan.absolutePath);
	if (args.mustExist && !exists) throw new Error(`File does not exist: ${plan.relativePath}`);
	if (!args.mustExist && exists) throw new Error(`File already exists: ${plan.relativePath}`);

	const oldText = exists ? await readExisting(fsLike, plan.absolutePath) : "";
	const oldSha256 = exists ? sha256(oldText) : undefined;
	if (args.expectedSha256 && oldSha256 !== args.expectedSha256) {
		throw new Error("expectedSha256 does not match current file");
	}

	const newText = args.mode === "append" && exists ? `${oldText.trimEnd()}\n\n${args.contents.trim()}\n` : args.contents;
	const writeBytes = Buffer.byteLength(newText, "utf8");
	if (writeBytes > maxWriteBytes) {
		return resourceLimitResult(
			args.context,
			{
				kind: "resource_limit",
				limitKind: "max_write_bytes",
				limit: maxWriteBytes,
				bytes: writeBytes,
				path: plan.relativePath,
				message: `Write exceeds maxWriteBytes (${writeBytes} > ${maxWriteBytes})`,
				recovery: "settings_agent",
			},
		);
	}
	assertWritableContents(newText, maxWriteBytes);
	const newSha256 = sha256(newText);
	const summary = diffSummary(oldText, newText);
	const toolUseId = args.context.getCurrentToolUseId?.(`mcp__llm_wiki__${args.toolName}`);

	const payload = {
		ok: true,
		dryRun: args.dryRun === true,
		path: plan.relativePath,
		operation: args.operation,
		oldSha256,
		newSha256,
		toolUseId,
		diffSummary: JSON.parse(summary) as Record<string, unknown>,
	};

	if (args.dryRun) return jsonResult(payload);

	const changedPaths = ensureChangedPaths(args.context);
	const reservesChangedPath = !changedPaths.has(plan.relativePath);
	if (args.context.maxFilesChangedEnabled === true) {
		const maxFilesChanged = normalizedLimit(args.context.maxFilesChanged, DEFAULT_MAX_FILES_CHANGED);
		if (reservesChangedPath && changedPaths.size >= maxFilesChanged) {
			const sortedPaths = Array.from(changedPaths).sort();
			return resourceLimitResult(
				args.context,
				{
					kind: "resource_limit",
					limitKind: "max_files_changed",
					limit: maxFilesChanged,
					used: changedPaths.size,
					attempted: changedPaths.size + 1,
					changedPaths: sortedPaths,
					path: plan.relativePath,
					message: `Write would exceed maxFilesChanged (${maxFilesChanged})`,
					recovery: "split_task",
				},
				{ changedCount: changedPaths.size },
			);
		}
	}

	if (reservesChangedPath) changedPaths.add(plan.relativePath);
	const snapshotStored = await writeRewindSnapshot({
		projectPath,
		streamId: args.context.streamId,
		relativePath: plan.relativePath,
		operation: args.operation,
		existedBefore: exists,
		beforeText: oldText,
		beforeSha256: oldSha256,
		afterSha256: newSha256,
		toolUseId,
	});
	const snapshotted = snapshotStored && Boolean(toolUseId);
	try {
		await fsLike.writeFile(plan.absolutePath, newText, "utf8");
	} catch (err) {
		if (reservesChangedPath) changedPaths.delete(plan.relativePath);
		throw err;
	}
	args.context.onWikiChanged?.({
		path: plan.relativePath,
		operation: args.operation,
		oldSha256,
		newSha256,
		toolUseId,
		snapshotted,
	});
	return jsonResult({ ...payload, snapshotted });
}

export function createLlmWikiTools(
	context: LlmWikiToolContext,
): Array<SdkMcpToolDefinition<any>> {
	const api = createWikiApiClient({
		baseUrl: context.baseUrl,
		token: context.token,
		projectId: context.projectId,
		fetchFn: context.fetchFn,
	});

	return [
		tool("list_projects", "List LLM Wiki projects and the current project.", {}, async () =>
			safe(async () => jsonResult(await api.listProjects())),
		),
		tool(
			"list_pages",
			"List project files exposed by LLM Wiki.",
			{
				root: z.enum(["wiki", "sources", "all"]).optional(),
				recursive: z.boolean().optional(),
				maxFiles: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.listPages(args))),
		),
		tool(
			"read_page",
			"Read a public text file from the current LLM Wiki project.",
			{
				path: z.string().min(1),
			},
			async (args) =>
				safe(async () => {
					const data = (await api.readPage(args.path)) as Record<string, unknown>;
					const content = typeof data.content === "string" ? data.content : "";
					return resourceResult(data, `llm-wiki://current/${args.path}`, content);
				}),
		),
		tool(
			"search_pages",
			"Search the current Wiki using LLM Wiki hybrid retrieval.",
			{
				query: z.string().min(1),
				topK: z.number().int().positive().optional(),
				includeContent: z.boolean().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.searchPages(args))),
		),
		tool(
			"get_graph",
			"Return Wiki graph nodes and edges.",
			{
				q: z.string().optional(),
				limit: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.getGraph(args))),
		),
		tool(
			"build_answer_context",
			"Build the same deterministic Wiki RAG context used by normal Chat.",
			{
				query: z.string().min(1),
				maxContextSize: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => appTool(context, "build_answer_context", args)),
		),
		tool(
			"save_query_page",
			"Save text as a Wiki query page using LLM Wiki's canonical Save-to-Wiki rules.",
			{
				content: z.string().min(1),
				title: z.string().optional(),
				tags: z.array(z.string()).optional(),
				autoIngest: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "save_query_page", args, { requiresWrite: true }),
				),
		),
		tool(
			"run_lint",
			"Run LLM Wiki lint checks on the active Wiki.",
			{
				includeStructural: z.boolean().optional(),
				includeSemantic: z.boolean().optional(),
			},
			async (args) => safe(async () => appTool(context, "run_lint", args)),
		),
		appMcpTool(
			"collect_research_sources",
			"Collect Deep Research sources using LLM Wiki's configured Web Search and/or AnyTXT providers without exposing API keys. Provide topic or at least one searchQueries/queries item.",
			researchSeedObjectSchema,
			async (args) =>
				safe(async () => {
					assertResearchSeed(args);
					return appTool(context, "collect_research_sources", args);
				}),
		),
		appMcpTool(
			"run_deep_research",
			"Queue LLM Wiki's Deep Research workflow. Provide topic or at least one searchQueries/queries item. Tool completion means queued, not finished; poll get_agent_task_status for progress and savedPath.",
			researchSeedObjectSchema,
			async (args) =>
				safe(async () => {
					assertResearchSeed(args);
					return appTool(context, "run_deep_research", args, {
						requiresWrite: true,
						includeTaskId: true,
					});
				}),
		),
		tool(
			"get_agent_task_status",
			"Return status for an app-level Agent task such as Deep Research.",
			{
				taskId: z.string().min(1),
			},
			async (args) => safe(async () => appTool(context, "get_agent_task_status", args)),
		),
		tool(
			"detect_duplicates",
			"Detect duplicate entity/concept pages using LLM Wiki's existing dedup workflow.",
			{
				limit: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => appTool(context, "detect_duplicates", args)),
		),
		appMcpTool(
			"merge_duplicate_group",
			"Preview or execute LLM Wiki's duplicate-page merge. Defaults to dryRun=true; only dryRun=false writes files and requires write tools enabled.",
			duplicateMergeObjectSchema,
			async (args) =>
				safe(async () => {
					assertDuplicateMergeSeed(args);
					return appTool(context, "merge_duplicate_group", args, {
						requiresWrite: args.dryRun === false,
						includeTaskId: true,
					});
				}),
		),
		tool(
			"optimize_research_topic",
			"Generate a context-aware research topic and search queries for a review/gap item.",
			{
				gapTitle: z.string().min(1),
				gapDescription: z.string().optional(),
				gapType: z.string().optional(),
				overview: z.string().optional(),
				purpose: z.string().optional(),
			},
			async (args) => safe(async () => appTool(context, "optimize_research_topic", args)),
		),
		tool(
			"sweep_reviews",
			"Run LLM Wiki's review cleanup and resolve stale review items when the current wiki state addresses them.",
			{},
			async (args) =>
				safe(async () =>
					appTool(context, "sweep_reviews", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"test_provider_connection",
			"Test the active LLM provider connection using LLM Wiki's existing provider test.",
			{},
			async (args) => safe(async () => appTool(context, "test_provider_connection", args)),
		),
		tool(
			"ingest_source",
			"Run LLM Wiki's full auto-ingest pipeline for one raw source, including cache, merge, review items, and image captioning when enabled.",
			{
				sourcePath: z.string().min(1),
				folderContext: z.string().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "ingest_source", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"caption_source_images",
			"Extract and caption embedded images for one raw source, then inject the image section into its source summary.",
			{
				sourcePath: z.string().min(1),
				forceRecaption: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "caption_source_images", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"fix_lint_result",
			"Apply LLM Wiki's existing fixer to one lint result.",
			{
				result: z.object({
					type: z.enum(["orphan", "broken-link", "no-outlinks", "semantic"]),
					severity: z.enum(["warning", "info"]),
					page: z.string().min(1),
					detail: z.string(),
					affectedPages: z.array(z.string()).optional(),
				}),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "fix_lint_result", args, { requiresWrite: true }),
				),
		),
		tool(
			"run_lint_and_report",
			"Run structural + semantic lint, generate a structured report page with health score, auto-fix/human split, and save to wiki. Set autoFix=true to automatically fix all auto-fix items after generating the report.",
			{
				includeStructural: z.boolean().optional(),
				includeSemantic: z.boolean().optional(),
				autoFix: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "run_lint_and_report", args, { requiresWrite: true }),
				),
		),
		tool(
			"fix_lint_report",
			"Auto-fix all auto-fix items in a lint report and append a repair log.",
			{
				report: z.object({ healthScore: z.number(), autoFixItems: z.array(z.object({}).passthrough()), humanItems: z.array(z.object({}).passthrough()), }).passthrough(),
				reportPath: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "fix_lint_report", args, { requiresWrite: true }),
				),
		),

		tool(
			"autofill_properties",
			"Scan wiki concept/entity pages and fill missing Status and Tags frontmatter fields. Default behavior preserves the existing heuristic autofill: status promotion plus heuristic tags for empty tags. With taxonomyAware=true, return taxonomy suggestions/reports in preview mode by default; only autoWriteHighConfidence=true writes high-confidence taxonomy label tags.",
			{
				taxonomyAware: z.boolean().optional(),
				autoWriteHighConfidence: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "autofill_properties", args, { requiresWrite: true }),
				),
		),

		tool(
			"okf_validate",
			"Validate the active LLM Wiki project as an OKF-compatible knowledge bundle. Read-only.",
			{},
			async (args) => safe(async () => appTool(context, "okf_validate", args)),
		),

		tool(
			"okf_export",
			"Build an in-memory OKF export bundle and report for the active project. Read-only; does not accept outputDir or write files.",
			{},
			async (args) => safe(async () => appTool(context, "okf_export", args)),
		),

		appMcpTool(
			"okf_import",
			"Preview an OKF import into the active project by default. Set apply=true to write the previewed pages after write tools and app budget allow it.",
			okfImportObjectSchema,
			async (args) =>
				safe(async () =>
					appTool(context, "okf_import", args, {
						requiresWrite: args.apply === true,
						includeTaskId: args.apply === true,
					}),
				),
		),

		appMcpTool(
			"taxonomy_preview",
			"Preview tag taxonomy bootstrap or growth against the active project. Read-only; never writes the sidecar taxonomy file.",
			taxonomyActionObjectSchema,
			async (args) => safe(async () => appTool(context, "taxonomy_preview", args)),
		),

		appMcpTool(
			"taxonomy_apply",
			"Apply tag taxonomy bootstrap or growth to .llm-wiki/tag-taxonomy.json. Requires write tools and counts the sidecar path in the app write budget.",
			taxonomyActionObjectSchema,
			async (args) =>
				safe(async () =>
					appTool(context, "taxonomy_apply", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),

		tool(
			"taxonomy_rollback",
			"Rollback the most recent tag taxonomy bootstrap/growth batch in .llm-wiki/tag-taxonomy.json. Requires write tools and never edits wiki pages.",
			{},
			async (args) =>
				safe(async () =>
					appTool(context, "taxonomy_rollback", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),

		appMcpTool(
			"synthesis_preview",
			"Discover deterministic synthesis candidates from existing wiki tags. Read-only; does not call LLM/search and does not create synthesis pages.",
			synthesisPreviewObjectSchema,
			async (args) => safe(async () => appTool(context, "synthesis_preview", args)),
		),

		tool(
			"get_knowledge_agents_config",
			"Return the active project's Knowledge Agents config with parse issues/conflict status. Read-only; config writes remain UI-only.",
			{},
			async (args) => safe(async () => appTool(context, "get_knowledge_agents_config", args)),
		),

		appMcpTool(
			"wiki_synthesis",
			"Discover thematic clusters by tag analysis, supplement with external web search (EXA.AI etc.), and generate a cross-article synthesis report via LLM. Saves as a synthesis page in wiki.",
			wikiSynthesisObjectSchema,
			async (args) =>
				safe(async () =>
					appTool(context, "wiki_synthesis", args, { requiresWrite: true }),
				),
		),

		tool(
			"run_pipeline",
			"Execute a built-in multi-agent pipeline by name. Available pipelines: full-ingest (compile→lint→fix), lint-fix (lint→fix). Returns step-by-step results with timing.",
			{
				pipeline: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "run_pipeline", args, { requiresWrite: true }),
				),
		),

		tool(
			"enrich_wikilinks",
			"Add safe wikilinks to one Wiki page using LLM Wiki's enrichment pipeline.",
			{
				path: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "enrich_wikilinks", args, { requiresWrite: true }),
				),
		),
		tool(
			"update_page",
			"Replace or append to an existing Wiki Markdown page.",
			{
				path: z.string().min(1),
				contents: z.string().min(1),
				mode: z.enum(["replace", "append"]).optional(),
				expectedSha256: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.path,
						contents: args.contents,
						mode: args.mode ?? "replace",
						expectedSha256: args.expectedSha256,
						dryRun: args.dryRun,
						operation: "update",
						toolName: "update_page",
						mustExist: true,
					}),
				),
		),
		tool(
			"create_entity",
			"Create a new Wiki entity page.",
			{
				name: z.string().min(1),
				summary: z.string().min(1),
				aliases: z.array(z.string()).optional(),
				sources: z.array(z.string()).optional(),
				pathHint: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.pathHint ?? defaultEntityPath(args.name),
						contents: buildEntityMarkdown(args),
						mode: "replace",
						dryRun: args.dryRun,
						operation: "create",
						toolName: "create_entity",
						mustExist: false,
						fixedDirectory: "entities",
					}),
				),
		),
		tool(
			"create_concept",
			"Create a new Wiki concept page.",
			{
				name: z.string().min(1),
				explanation: z.string().min(1),
				related: z.array(z.string()).optional(),
				sources: z.array(z.string()).optional(),
				pathHint: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.pathHint ?? defaultConceptPath(args.name),
						contents: buildConceptMarkdown(args),
						mode: "replace",
						dryRun: args.dryRun,
						operation: "create",
						toolName: "create_concept",
						mustExist: false,
						fixedDirectory: "concepts",
					}),
				),
		),
	] as Array<SdkMcpToolDefinition<any>>;
}

export function createLlmWikiMcpServer(context: LlmWikiToolContext) {
	return createSdkMcpServer({
		name: "llm_wiki",
		version: "0.1.0",
		instructions:
			"Use these tools to read, search, inspect, and update the active LLM Wiki project. Write tools are gated by LLM Wiki permissions and resource limits.",
		tools: createLlmWikiTools(context),
	});
}
