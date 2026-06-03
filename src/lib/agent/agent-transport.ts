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
import { runAgentAppTool } from "./agent-app-tools";
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
	persistSession?: boolean;
	title?: string;
	apiKey?: string;
	baseUrl?: string;
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
		unlisten?.();
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
	let unlistenData: UnlistenFn | undefined;
	let unlistenDone: UnlistenFn | undefined;
	let finished = false;

	const cleanup = () => {
		unlistenData?.();
		unlistenDone?.();
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
					void runAgentAppTool(request.toolName, request.args)
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

				callbacks.onMessage(msg as SDKMessage);

				if ((msg as SDKMessage).type === "assistant") {
					const assistant = msg as SDKAssistantMessage;
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

				if ((msg as SDKMessage).type === "result") {
					resultMessage = msg as SDKResultMessage;
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

		const payload: InvokePayload = {
			streamId,
			prompt,
			...options,
		};
		try {
			await invoke("agent_spawn", { args: payload });
		} catch (invokeErr) {
			console.error("[agent-transport] invoke FAILED:", invokeErr);
			throw invokeErr;
		}
	} catch (err) {
		console.error("[agent-transport] error:", err);
		finishWith(() => {
			let message: string;
			if (err instanceof Error) {
				message = err.message;
			} else if (err === null) {
				message = "null error thrown";
			} else if (err === undefined) {
				message = "undefined error thrown";
			} else {
				message = String(err);
			}
			callbacks.onError(new Error(message));
		});
	} finally {
		signal?.removeEventListener("abort", abortListener);
	}
}
