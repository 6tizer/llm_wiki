/**
 * Agent sidecar transport.
 *
 * Spawns a Node.js sidecar via Rust that uses the Claude Agent SDK.
 * Communication follows the same emit/listen + streamId pattern as
 * claude-cli-transport.ts. The sidecar outputs JSON-lines with
 * { streamId, type, data } where data is an SDKMessage object.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
	runtimeProfilePoolClaim,
	runtimeProfilePoolList,
	runtimeProfilePoolRelease,
	type RuntimeProfilePoolClaim,
} from "@/commands/runtime-db";
import { AgentRunError } from "./agent-run-state";
import { runAgentAppTool } from "./agent-app-tools";
import { isSdkCompactSummaryMessage } from "./agent-summary";
import type {
	AgentActionRequiredPayload,
	AgentAppToolRequestPayload,
	AgentCallbacks,
	AgentDonePayload,
	AgentPermissionDecision,
	AgentPermissionPolicy,
	AgentPermissionRequestPayload,
	AgentRewindFilesPayload,
	AgentSummaryPayload,
	AgentTaskEventPayload,
	AgentToolEventPayload,
	AgentTransportOptions,
	AgentWikiChangedPayload,
	SDKAssistantMessage,
	SDKContentBlock,
	SDKMessage,
	SDKResultMessage,
	SubagentConfig,
} from "./agent-types";

type InvokePayload = Record<string, unknown> & {
	streamId: string;
	prompt: string;
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
	projectId?: string;
	projectPath?: string;
	apiServerBaseUrl?: string;
	apiToken?: string;
	enableWikiTools?: boolean;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
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
};

// Keep this aligned with MAX_PROFILE_POOL_TTL_MS in src-tauri/src/commands/runtime_db.rs.
const AGENT_PROFILE_CLAIM_TTL_MS = 1_200_000;
// Keep this aligned with PROFILE_CLAIM_INACTIVE_PREFIX in runtime_db.rs.
const PROFILE_CLAIM_INACTIVE_PREFIX = "claim-inactive:";
// TS uses this only before Rust accepts profile claim ownership.
const AGENT_PROFILE_SPAWN_FAILED_REASON = "agent-spawn-failed";

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err === null) return "null error thrown";
	if (err === undefined) return "undefined error thrown";
	return String(err);
}

function isRuntimeDisabledError(err: unknown): boolean {
	return errorMessage(err).startsWith("runtime-disabled:");
}

function profileUnavailable(message: string): AgentRunError {
	return new AgentRunError("profile_unavailable", `profile-unavailable: ${message}`);
}

async function claimAgentProfileForRun(
	streamId: string,
	options: AgentTransportOptions,
): Promise<RuntimeProfilePoolClaim | null> {
	if (!options.projectPath) return null;
	let pool;
	try {
		pool = await runtimeProfilePoolList({
			kind: "agent-run",
			taskFamily: "agent",
		});
	} catch (err) {
		if (isRuntimeDisabledError(err)) return null;
		throw profileUnavailable(errorMessage(err));
	}
	if (!pool.enabled) return null;
	if (pool.status !== "healthy") {
		throw profileUnavailable(`profile pool is ${pool.status}`);
	}
	try {
		return await runtimeProfilePoolClaim({
			kind: "agent-run",
			taskFamily: "agent",
			holder: `agent:${streamId}`,
			ttlMs: AGENT_PROFILE_CLAIM_TTL_MS,
			preferredProfileIds: options.agentProfileId
				? [options.agentProfileId]
				: undefined,
		});
	} catch (err) {
		if (isRuntimeDisabledError(err)) return null;
		throw profileUnavailable(errorMessage(err));
	}
}

async function releaseUntransferredAgentProfileClaim(
	claimId: string,
	err: unknown,
): Promise<void> {
	try {
		await runtimeProfilePoolRelease({
			claimId,
			outcome: "error",
			error: errorMessage(err),
			reason: AGENT_PROFILE_SPAWN_FAILED_REASON,
		});
	} catch (releaseErr) {
		if (!errorMessage(releaseErr).startsWith(PROFILE_CLAIM_INACTIVE_PREFIX)) {
			console.warn(
				"[agent-transport] failed to release untransferred profile claim:",
				releaseErr,
			);
		}
	}
}

function extractText(content: SDKContentBlock[]): string {
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				b.type === "text" && typeof b.text === "string",
		)
		.map((b) => b.text)
		.join("");
}

function sendAppToolResponse(payload: Record<string, unknown>) {
	return invoke("agent_tool_response", payload).catch((err) => {
		console.error("[agent-transport] failed to send app tool response:", err);
	});
}

function sendPermissionResponse(payload: Record<string, unknown>) {
	return invoke("agent_permission_response", payload).catch((err) => {
		console.error("[agent-transport] failed to send permission response:", err);
	});
}

function safeUnlisten(unlisten: UnlistenFn | undefined, label: string): void {
	if (!unlisten) return;
	void Promise.resolve()
		.then(() => unlisten())
		.catch((err) => {
			console.warn(`[agent-transport] failed to unlisten ${label}:`, err);
		});
}

export async function rewindAgentFiles(
	streamId: string,
	messageId?: string,
): Promise<AgentRewindFilesPayload> {
	let unlisten: UnlistenFn | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveResult: (payload: AgentRewindFilesPayload) => void = () => {};
	let rejectResult: (err: Error) => void = () => {};
	const result = new Promise<AgentRewindFilesPayload>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
		timeout = setTimeout(() => {
			reject(new Error("Timed out waiting for Agent rewind result"));
		}, 30_000);
	});

	try {
		unlisten = await listen<string>(`agent:${streamId}`, (event) => {
			try {
				const wrapper = JSON.parse(event.payload) as {
					streamId: string;
					type: string;
					data: unknown;
				};
				if (wrapper.type !== "rewind_files") return;
				resolveResult({
					...(wrapper.data as AgentRewindFilesPayload),
					streamId: wrapper.streamId,
				});
			} catch (err) {
				rejectResult(err instanceof Error ? err : new Error(String(err)));
			}
		});
		await invoke("agent_rewind_files", { streamId, messageId });
		return await result;
	} finally {
		if (timeout) clearTimeout(timeout);
		const off = unlisten;
		unlisten = undefined;
		safeUnlisten(off, `agent:${streamId}:rewind`);
	}
}

function defaultPermissionDecision(): AgentPermissionDecision {
	return {
		behavior: "deny",
		message: "Permission request was not handled",
	};
}

export async function streamAgent(
	prompt: string,
	options: AgentTransportOptions,
	callbacks: AgentCallbacks,
	signal?: AbortSignal,
): Promise<void> {
	const streamId = crypto.randomUUID();
	callbacks.onStreamStart?.(streamId);

	if (signal?.aborted) {
		callbacks.onDone(null);
		return;
	}

	let unlistenData: UnlistenFn | undefined;
	let unlistenDone: UnlistenFn | undefined;
	let finished = false;
	let profileClaimTransferredToRust = false;

	const cleanup = () => {
		const offData = unlistenData;
		const offDone = unlistenDone;
		unlistenData = undefined;
		unlistenDone = undefined;
		safeUnlisten(offData, `agent:${streamId}`);
		safeUnlisten(offDone, `agent:${streamId}:done`);
	};

	const finishWith = (cb: () => void) => {
		if (finished) return;
		finished = true;
		cleanup();
		cb();
	};

	const abortListener = () => {
		void invoke("agent_kill", { streamId }).catch(() => {});
		finishWith(() => callbacks.onDone(null));
	};
	signal?.addEventListener("abort", abortListener);

	try {
		let emittedText = "";
		let resultMessage: SDKResultMessage | null = null;

		unlistenData = await listen<string>(`agent:${streamId}`, (event) => {
			try {
				if (finished) return;

				const raw = event.payload;

				const wrapper = JSON.parse(raw) as {
					streamId: string;
					type: string;
					data: unknown;
				};

				const msg = wrapper.data;
				if (wrapper.type === "done") {
					finishWith(() => callbacks.onDone(resultMessage));
					return;
				}

				if (!msg) {
					return;
				}

				if (wrapper.type === "app_tool_request") {
					const request = msg as AgentAppToolRequestPayload;
					const run = request.budget
						? runAgentAppTool(request.toolName, request.args, { budget: request.budget })
						: runAgentAppTool(request.toolName, request.args);
					void run
						.then((data) => {
							if (finished) return;
							return sendAppToolResponse({
								streamId,
								requestId: request.requestId,
								ok: true,
								data,
							});
						})
						.catch((err) => {
							if (finished) return;
							return sendAppToolResponse({
								streamId,
								requestId: request.requestId,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							});
						});
					return;
				}

				if (wrapper.type === "agent_permission_request") {
					const request = msg as AgentPermissionRequestPayload;
					void Promise.resolve(
						callbacks.onPermissionRequest?.(request) ??
							defaultPermissionDecision(),
					)
						.then((decision) => {
							if (finished) return;
							return sendPermissionResponse({
								streamId,
								requestId: request.requestId,
								ok: true,
								decision,
							});
						})
						.catch((err) => {
							if (finished) return;
							return sendPermissionResponse({
								streamId,
								requestId: request.requestId,
								ok: false,
								error: err instanceof Error ? err.message : String(err),
							});
						});
					return;
				}

				if (wrapper.type === "wiki_changed") {
					callbacks.onWikiChanged?.(msg as unknown as AgentWikiChangedPayload);
					return;
				}

				if (wrapper.type === "tool_event") {
					callbacks.onToolEvent?.(msg as AgentToolEventPayload);
					return;
				}

				if (wrapper.type === "agent_summary") {
					callbacks.onAgentSummary?.(msg as AgentSummaryPayload);
					return;
				}

				if (wrapper.type === "agent_action_required") {
					callbacks.onActionRequired?.(msg as AgentActionRequiredPayload);
					return;
				}

				if (wrapper.type === "rewind_files") {
					callbacks.onRewindFiles?.({
						...(msg as AgentRewindFilesPayload),
						streamId: wrapper.streamId,
					});
					return;
				}

				// PR D: SDK native event passthrough
				if (wrapper.type === "prompt_suggestion") {
					callbacks.onPromptSuggestion?.(msg);
					return;
				}
				if (wrapper.type === "partial_message") {
					callbacks.onPartialMessage?.(msg);
					return;
				}
				if (wrapper.type === "hook_event") {
					callbacks.onHookEvent?.(msg);
					return;
				}
				if (wrapper.type === "agent_progress_summary") {
					callbacks.onAgentProgressSummary?.(msg);
					return;
				}

				if (wrapper.type === "subagent_event") {
					callbacks.onSubagentEvent?.(msg);
					return;
				}

				if (wrapper.type.startsWith("agent_task_")) {
					callbacks.onTaskEvent?.(wrapper.type, msg as AgentTaskEventPayload);
					return;
				}

				// Handle sidecar-level errors (wrapper.type === "error")
				if (wrapper.type === "error") {
					const errMsg =
						(msg as Record<string, unknown>).error ??
						(msg as Record<string, unknown>).stack ??
						"Unknown sidecar error";
					console.error("[agent-transport] sidecar error:", errMsg);
					finishWith(() => callbacks.onError(new Error(String(errMsg))));
					return;
				}

				const sdkMessage = msg as SDKMessage;
				if (isSdkCompactSummaryMessage(sdkMessage)) {
					callbacks.onSessionCompact?.({
						kind: "compact",
						message: sdkMessage,
					});
					return;
				}

				callbacks.onMessage(sdkMessage);

				if (sdkMessage.type === "assistant") {
					const assistant = sdkMessage as unknown as SDKAssistantMessage;
					const content = assistant.message?.content;
					if (!Array.isArray(content)) {
						return;
					}
					const fullText = extractText(content);
					if (fullText.startsWith(emittedText)) {
						const novel = fullText.slice(emittedText.length);
						emittedText = fullText;
						if (novel) callbacks.onToken(novel);
					} else {
						emittedText = fullText;
						callbacks.onToken(fullText);
					}
				}

				if (sdkMessage.type === "result") {
					resultMessage = sdkMessage as SDKResultMessage;
					emittedText = "";
					callbacks.onToken("\n");
				}
			} catch (err) {
				console.error("[agent-transport] parse error:", err);
			}
		});

		unlistenDone = await listen<AgentDonePayload>(
			`agent:${streamId}:done`,
			(event) => {
				const { code, stderr } = event.payload ?? {};
				if (code !== undefined && code !== 0) {
					const detail = stderr?.trim() ? `: ${stderr.trim()}` : "";
					finishWith(() =>
						callbacks.onError(
							new Error(`Agent exited with code ${code}${detail}`),
						),
					);
				} else {
					finishWith(() => callbacks.onDone(resultMessage));
				}
			},
		);

		if (finished) {
			cleanup();
			return;
		}

		const profileClaim = await claimAgentProfileForRun(streamId, options);
		if (finished || signal?.aborted) {
			if (profileClaim) {
				await releaseUntransferredAgentProfileClaim(profileClaim.claimId, "aborted");
			}
			cleanup();
			return;
		}

		const payload: InvokePayload = {
			streamId,
			prompt,
			...options,
		};
		if (profileClaim) {
			delete payload.apiKey;
			delete payload.baseUrl;
			delete payload.model;
			payload.agentProfileId = profileClaim.profileId;
			payload.agentProfileClaimId = profileClaim.claimId;
		}
		try {
			await invoke("agent_spawn", { args: payload });
			profileClaimTransferredToRust = Boolean(profileClaim);
		} catch (invokeErr) {
			console.error("[agent-transport] invoke FAILED:", invokeErr);
			if (profileClaim && !profileClaimTransferredToRust) {
				await releaseUntransferredAgentProfileClaim(
					profileClaim.claimId,
					invokeErr,
				);
			}
			throw invokeErr;
		}
	} catch (err) {
		console.error("[agent-transport] error:", err);
		finishWith(() => {
			if (err instanceof AgentRunError) {
				callbacks.onError(err);
				return;
			}
			callbacks.onError(new Error(errorMessage(err)));
		});
	} finally {
		signal?.removeEventListener("abort", abortListener);
	}
}
