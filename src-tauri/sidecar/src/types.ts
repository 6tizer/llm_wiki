/** Subagent configuration — mirrors the shape in the main app's agent-types.ts. */
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

export interface AgentRequest {
	type: "query";
	streamId: string;
	prompt: string;
	options: {
		systemPrompt?: string;
		cwd?: string;
		model?: string;
		maxTurns?: number;
		maxBudgetUsd?: number;
		sessionId?: string;
		resume?: string;
		continue?: boolean;
		forkSession?: boolean;
		resumeSessionAt?: string;
		intentOverride?: string;
		apiKey?: string;
		baseUrl?: string;
		agentProfileAuthStyle?: "none" | "bearer" | "x-api-key" | "api-key" | "oauth-local-cli";
		persistSession?: boolean;
		title?: string;
		allowedTools?: string[];
		disallowedTools?: string[];
		permissionPolicy?:
			| "default"
			| "restricted"
			| "bypass"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk"
			| "auto";
		projectId?: string;
		projectPath?: string;
		apiServerBaseUrl?: string;
		apiToken?: string;
		enableWikiTools?: boolean;
		enableWriteTools?: boolean;
		maxWriteBytes?: number;
		maxFilesChanged?: number;
		/** Threaded from AgentResourceConfig.maxFilesChangedEnabled. */
		maxFilesChangedEnabled?: boolean;
		enableFileCheckpointing?: boolean;
		sandbox?: {
			enabled?: boolean;
			autoAllowBashIfSandboxed?: boolean;
			failIfUnavailable?: boolean;
			network?: Record<string, unknown>;
		};

		// PR D: structured output
		outputFormat?:
			| { type: "json_schema"; schema: Record<string, unknown> };

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
	};
}

export interface AgentKillRequest {
	type: "kill";
	streamId: string;
}

export interface AgentToolEventPayload {
	phase: "pre" | "post" | "failure" | "batch";
	toolName: string;
	toolUseId?: string;
	ok?: boolean;
	durationMs?: number;
	inputPreview?: Record<string, unknown>;
	error?: string;
	permissionPolicy?: "default" | "restricted" | "bypass";
	toolCalls?: Array<{
		toolName: string;
		toolUseId?: string;
		inputPreview?: Record<string, unknown>;
	}>;
}

export interface AgentSummaryPayload {
	lastAssistantMessage?: string;
	changedPaths: string[];
	toolCalls: number;
	failedToolCalls: number;
}

export type AgentResourceLimitKind =
	| "max_files_changed"
	| "max_write_bytes"
	| "max_turns_exceeded";

// Keep in sync with src/lib/agent/agent-types.ts.
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

export interface RewindFilesRequest {
	type: "rewind_files";
	streamId: string;
	messageId?: string;
}

/**
 * One-shot resume-only rewind (SPEC-7 PR2, fixes #60): unlike
 * `RewindFilesRequest`, this does NOT require an active stream — the sidecar
 * spins up its own throwaway `resume` Query, verifies it landed on the right
 * session, calls `rewindFiles`, then closes. See rewind-session-bridge.ts.
 */
export interface RewindSessionRequest {
	type: "rewind_session";
	streamId: string;
	agentSessionId: string;
	rewindUserMessageId: string;
	/**
	 * The target turn's assistant uuid — reliably echoed on the live SDK
	 * stream (unlike the "user" uuid, see rewindUserMessageId), used as the
	 * starting point for the JSONL-transcript reverse lookup when
	 * rewindUserMessageId isn't itself a verified checkpoint anchor. See
	 * rewind-anchor.ts.
	 */
	fallbackAssistantMessageId?: string;
	cwd?: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	agentProfileAuthStyle?: "none" | "bearer" | "x-api-key" | "api-key" | "oauth-local-cli";
}

export type RewindSessionUnavailableReason =
	| "missing_message_id"
	| "unsupported"
	| "transport_not_ready"
	| "session_mismatch"
	| "spawn_failed";

export interface AgentMessage {
	streamId: string;
	type:
		| "message"
		| "error"
		| "done"
		| "app_tool_request"
		| "wiki_changed"
		| "tool_event"
		| "agent_summary"
		| "agent_action_required"
		| "agent_permission_request"
		| "agent_task_started"
		| "agent_task_progress"
		| "agent_task_done"
		| "agent_task_error"
		| "rewind_files"
		| "rewind_session"
		| "prompt_suggestion"
		| "partial_message"
		| "hook_event"
		| "subagent_event"
		| "agent_progress_summary";
	data: unknown;
}
