import { randomUUID } from "node:crypto";
import type { AgentMessage } from "./types.js";

export interface AppToolRequestPayload {
	requestId: string;
	toolName: string;
	args: Record<string, unknown>;
	budget?: AppToolBudget;
}

/** Current app-tool file budget for one Agent run. */
export interface AppToolBudget {
	/** Maximum distinct wiki files the app tool may add to the run. */
	maxFilesChanged: number;
	/** Maximum UTF-8 bytes allowed for a single app-tool write. */
	maxWriteBytes?: number;
	/** Distinct wiki-relative paths already changed in the current Agent run. */
	changedPaths: string[];
	/** Plumbing-only toggle for future stricter file-count preflight.
	 * Current fan-out tools still use the unknown-write guard plus
	 * postflight enforcement. */
	maxFilesChangedEnabled?: boolean;
}

export interface AppToolResponseMessage {
	type: "app_tool_response";
	streamId: string;
	requestId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface AppToolBridge {
	callTool(
		streamId: string,
		toolName: string,
		args: Record<string, unknown>,
		budget?: AppToolBudget,
	): Promise<unknown>;
	handleResponse(response: AppToolResponseMessage): void;
	rejectStream(streamId: string, reason: string): void;
	/** True if any app-tool call is awaiting a host response. The sidecar
	 *  idle-exit guard uses this so it doesn't kill the process mid-bridge. */
	hasPending(): boolean;
}

interface PendingCall {
	streamId: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export function createAppToolBridge(args: {
	send: (msg: AgentMessage) => void;
	timeoutMs?: number;
}): AppToolBridge {
	const pending = new Map<string, PendingCall>();
	const timeoutMs = args.timeoutMs ?? 120_000;

	return {
		callTool(streamId, toolName, toolArgs, budget) {
			const requestId = randomUUID();
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					reject(new Error(`App tool timed out: ${toolName}`));
				}, timeoutMs);
				pending.set(requestId, {
					streamId,
					resolve,
					reject,
					timer,
				});
				args.send({
					streamId,
					type: "app_tool_request",
					data: {
						requestId,
						toolName,
						args: toolArgs,
						...(budget ? { budget } : {}),
					},
				});
			});
		},

		handleResponse(response) {
			const call = pending.get(response.requestId);
			if (!call) return;
			pending.delete(response.requestId);
			clearTimeout(call.timer);
			if (response.ok) {
				call.resolve(response.data);
			} else {
				call.reject(new Error(response.error || "App tool failed"));
			}
		},

		rejectStream(streamId, reason) {
			for (const [requestId, call] of pending) {
				if (call.streamId !== streamId) continue;
				pending.delete(requestId);
				clearTimeout(call.timer);
				call.reject(new Error(reason));
			}
		},

		hasPending() {
			return pending.size > 0;
		},
	};
}
