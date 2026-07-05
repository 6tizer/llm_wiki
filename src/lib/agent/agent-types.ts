/**
 * Subset of SDKMessage types the frontend cares about.
 * The sidecar emits full SDKMessage JSON; we only type the fields we use.
 */

export interface SDKTextBlock {
	type: "text";
	text: string;
}

export interface SDKToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface SDKToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | SDKTextBlock[];
}

export type SDKContentBlock =
	| SDKTextBlock
	| SDKToolUseBlock
	| SDKToolResultBlock;

export interface SDKAssistantMessage {
	type: "assistant";
	message: {
		role: "assistant";
		content: SDKContentBlock[];
		model?: string;
		usage?: {
			input_tokens: number;
			output_tokens: number;
		};
	};
	uuid?: string;
	session_id?: string;
}

export interface SDKUserMessage {
	type: "user";
	message: unknown;
	uuid?: string;
	session_id?: string;
}

export interface SDKResultMessage {
	type: "result";
	result: string;
	subtype?: string;
	session_id?: string;
	cost_usd?: number;
	total_cost_usd?: number;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
}

export interface SDKSystemMessage {
	type: "system";
	subtype?: string;
	message?: string;
	[key: string]: unknown;
}

export interface SDKErrorMessage {
	type: "error";
	error: string;
}

export type SDKMessage =
	| SDKAssistantMessage
	| SDKUserMessage
	| SDKResultMessage
	| SDKSystemMessage
	| SDKErrorMessage
	| { type: string; [key: string]: unknown };

export interface AgentDonePayload {
	code: number;
	stderr?: string;
}

export interface AgentWikiChangedPayload {
	path: string;
	operation: "update" | "create" | "delete";
	oldSha256?: string;
	newSha256?: string;
	toolUseId?: string;
	snapshotted?: boolean;
}

export interface AgentToolEventPayload {
	phase: "pre" | "post" | "failure" | "batch";
	toolName: string;
	toolUseId?: string;
	ok?: boolean;
	durationMs?: number;
	inputPreview?: Record<string, unknown>;
	error?: string;
	permissionPolicy?: AgentPermissionPolicy;
	toolCalls?: Array<{
		toolName: string;
		toolUseId?: string;
		inputPreview?: Record<string, unknown>;
	}>;
}

export type AgentPermissionPolicy =
	| "default"
	| "restricted"
	| "bypass"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan"
	| "dontAsk"
	| "auto";

export interface AgentPermissionRequestPayload {
	requestId: string;
	conversationId?: string;
	streamId?: string;
	toolName: string;
	inputPreview: Record<string, unknown>;
	suggestions?: unknown[];
	blockedPath?: string;
	decisionReason?: string;
	title?: string;
	displayName?: string;
	description?: string;
	toolUseID: string;
	agentID?: string;
}

export type AgentPermissionDecision =
	| {
			behavior: "allow";
			updatedInput?: Record<string, unknown>;
			updatedPermissions?: unknown[];
			decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
	  }
	| {
			behavior: "deny";
			message?: string;
			reason?: string;
			interrupt?: boolean;
			decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
	  };

export interface AgentRewindFilesResult {
	canRewind: boolean;
	error?: string;
	filesChanged?: string[];
	insertions?: number;
	deletions?: number;
}

export interface AgentRewindFilesPayload {
	messageId?: string;
	streamId?: string;
	userMessageId?: string;
	ok?: boolean;
	result?: AgentRewindFilesResult;
	error?: string;
	unavailableReason?:
		| "inactive_stream"
		| "unsupported"
		| "missing_message_id"
		| "transport_closed"
		// SPEC-7 PR2 resume-only-for-rewind path (agent_rewind_session):
		| "transport_not_ready"
		| "session_mismatch"
		| "spawn_failed";
}

export interface AgentSummaryPayload {
	lastAssistantMessage?: string;
	changedPaths: string[];
	toolCalls: number;
	failedToolCalls: number;
}

export interface AgentSessionCompactPayload {
	kind: "compact" | "resume_summary";
	message?: SDKAssistantMessage;
}

export type AgentResourceLimitKind =
	| "max_files_changed"
	| "max_write_bytes"
	| "max_turns_exceeded";

// Keep in sync with src-tauri/sidecar/src/types.ts.
export interface AgentResourceLimitPayload {
	kind: "resource_limit";
	limitKind: AgentResourceLimitKind;
	limit?: number;
	used?: number;
	/** For max_turns_exceeded, attempted matches used because the SDK only reports the reached turn count. */
	attempted?: number;
	changedPaths?: string[];
	path?: string;
	bytes?: number;
	toolName?: string;
	message: string;
	recovery: "split_task" | "settings_agent";
}

export type AgentActionRequiredPayload = {
	kind: "lint_recommended";
	paths: string[];
	reason: "agent_write";
} | AgentResourceLimitPayload;

export interface AgentTaskEventPayload {
	taskId: string;
	toolName: string;
	message?: string;
	progress?: number;
	result?: unknown;
	error?: string;
}

export interface AgentAppToolRequestPayload {
	requestId: string;
	toolName: string;
	args: Record<string, unknown>;
	budget?: AgentAppToolBudget;
}

/** Current app-tool file budget for one Agent run. */
export interface AgentAppToolBudget {
	/** Maximum distinct wiki files the app tool may add to the run. */
	maxFilesChanged: number;
	/** Maximum UTF-8 bytes allowed for a single app-tool write. */
	maxWriteBytes?: number;
	/** Distinct wiki-relative paths already changed in the current Agent run. */
	changedPaths: string[];
	/** Plumbing-only toggle threaded from the resource config for future
	 * stricter file-count preflight. Current fan-out tools still use the
	 * unknown-write guard plus postflight enforcement. */
	maxFilesChangedEnabled?: boolean;
}

/** Shared subagent configuration — used by agent-types, agent-transport, and sidecar types. */
export interface SubagentConfig {
	description?: string;
	prompt: string;
	model?: string;
	tools?: string[];
	allowedTools?: string[];
	disallowedTools?: string[];
	permissionMode?: string;
	skills?: "all" | string[];
}

export interface AgentTransportOptions {
	systemPrompt?: string;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
	sessionId?: string;
	resume?: string;
	continueSession?: boolean;
	forkSession?: boolean;
	resumeSessionAt?: string;
	intentOverride?: string;
	persistSession?: boolean;
	title?: string;
	apiKey?: string;
	baseUrl?: string;
	agentProfileId?: string;
	agentProfileClaimId?: string;
	permissionPolicy?: AgentPermissionPolicy;
	disallowedTools?: string[];
	projectId?: string;
	projectPath?: string;
	apiServerBaseUrl?: string;
	apiToken?: string;
	enableWikiTools?: boolean;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
	/** Plumbing-only toggle threaded to app-tool budgets for future stricter
	 * file-count preflight. Current fan-out tools still use the unknown-write
	 * guard plus postflight enforcement. */
	maxFilesChangedEnabled?: boolean;
	enableFileCheckpointing?: boolean;
	sandbox?: {
		enabled?: boolean;
		autoAllowBashIfSandboxed?: boolean;
		failIfUnavailable?: boolean;
		network?: Record<string, unknown>;
	};

	// PR D: structured output
	outputFormat?: {
		type: "json_schema";
		schema: Record<string, unknown>;
	};

	// PR D: thinking / effort / taskBudget
	thinking?:
		| { type: "adaptive" }
		| { type: "enabled"; budgetTokens: number }
		| { type: "disabled" };
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	taskBudget?: { total: number };

	// PR D: event passthrough
	includePartialMessages?: boolean;
	includeHookEvents?: boolean;
	promptSuggestions?: boolean;
	agentProgressSummaries?: boolean;
	forwardSubagentText?: boolean;

	// PR E: subagents + skills + plugins
	agentName?: string;
	agents?: Record<string, SubagentConfig>;
	skills?: "all" | string[];
	plugins?: Array<{
		name: string;
		path: string;
	}>;
}

export interface AgentCallbacks {
	onStreamStart?: (streamId: string) => void;
	onMessage: (msg: SDKMessage) => void;
	onToken: (text: string) => void;
	onDone: (result: SDKResultMessage | null) => void;
	onError: (err: Error) => void;
	onWikiChanged?: (payload: AgentWikiChangedPayload) => void;
	onToolEvent?: (payload: AgentToolEventPayload) => void;
	onAgentSummary?: (payload: AgentSummaryPayload) => void;
	onSessionCompact?: (payload: AgentSessionCompactPayload) => void;
	onActionRequired?: (payload: AgentActionRequiredPayload) => void;
	onTaskEvent?: (type: string, payload: AgentTaskEventPayload) => void;
	onPermissionRequest?: (
		payload: AgentPermissionRequestPayload,
	) => AgentPermissionDecision | Promise<AgentPermissionDecision>;
	onRewindFiles?: (payload: AgentRewindFilesPayload) => void;

	// PR D: SDK native event callbacks
	onPromptSuggestion?: (payload: unknown) => void;
	onPartialMessage?: (payload: unknown) => void;
	onHookEvent?: (payload: unknown) => void;
	onSubagentEvent?: (payload: unknown) => void;
	onAgentProgressSummary?: (payload: AgentProgressSummaryPayload) => void;
}

export type AgentProgressSummaryItem =
	| string
	| {
			text?: unknown;
			summary?: unknown;
			timestamp?: unknown;
	  };

export type AgentProgressSummaryPayload =
	| AgentProgressSummaryItem
	| AgentProgressSummaryItem[];
