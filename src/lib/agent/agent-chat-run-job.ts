import {
	runtimeJobCancel,
	runtimeJobClaimByKind,
	runtimeJobComplete,
	runtimeJobCreate,
	runtimeJobFail,
	runtimeJobHeartbeat,
	type RuntimeJobClaim,
} from "@/commands/runtime-db";

export const AGENT_CHAT_RUN_JOB_KIND = "agent-chat-run";

const HEARTBEAT_INTERVAL_MS = 10_000;
const TITLE_LIMIT = 120;
const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:";

interface AgentChatRunPayload {
	kind: typeof AGENT_CHAT_RUN_JOB_KIND;
	conversationId: string;
	streamId: string;
	title: string;
}

export interface AgentChatRunJobController {
	streamId: string;
	heartbeat: () => void;
	complete: () => void;
	fail: (error: unknown) => void;
	cancel: (reason: string) => void;
}

const activeJobsByStreamId = new Map<string, AgentChatRunJob>();

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error === null) return "null error thrown";
	if (error === undefined) return "undefined error thrown";
	return String(error);
}

function isRuntimeDisabledError(error: unknown): boolean {
	return errorMessage(error).startsWith(RUNTIME_DISABLED_ERROR_PREFIX);
}

function warnRuntimeJobFailure(action: string, error: unknown): void {
	if (isRuntimeDisabledError(error)) return;
	console.warn(`[agent-chat-run-job] ${action} failed:`, error);
}

function truncateTitle(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (!normalized) return "Agent chat run";
	return normalized.length <= TITLE_LIMIT
		? normalized
		: `${normalized.slice(0, TITLE_LIMIT - 3)}...`;
}

function payloadFor(args: {
	conversationId: string;
	streamId: string;
	title: string;
}): string {
	const payload: AgentChatRunPayload = {
		kind: AGENT_CHAT_RUN_JOB_KIND,
		conversationId: args.conversationId,
		streamId: args.streamId,
		title: truncateTitle(args.title),
	};
	return JSON.stringify(payload);
}

export function parseAgentChatRunJobPayload(payload: string): AgentChatRunPayload | null {
	try {
		const parsed = JSON.parse(payload) as Partial<AgentChatRunPayload>;
		if (parsed.kind !== AGENT_CHAT_RUN_JOB_KIND) return null;
		if (typeof parsed.conversationId !== "string") return null;
		if (typeof parsed.streamId !== "string") return null;
		return {
			kind: AGENT_CHAT_RUN_JOB_KIND,
			conversationId: parsed.conversationId,
			streamId: parsed.streamId,
			title: typeof parsed.title === "string" && parsed.title.trim()
				? parsed.title
				: "Agent chat run",
		};
	} catch {
		return null;
	}
}

export function startAgentChatRunJob(args: {
	conversationId: string;
	streamId: string;
	title: string;
}): AgentChatRunJobController {
	const job = new AgentChatRunJob(args);
	activeJobsByStreamId.set(args.streamId, job);
	return job;
}

export function cancelAgentChatRunJobByStreamId(streamId: string, reason: string): void {
	activeJobsByStreamId.get(streamId)?.cancel(reason);
}

class AgentChatRunJob implements AgentChatRunJobController {
	readonly streamId: string;
	private readonly holder: string;
	private readonly ready: Promise<RuntimeJobClaim | null>;
	private jobId: string | null = null;
	private terminal = false;
	private lastHeartbeatAtMs = -HEARTBEAT_INTERVAL_MS;

	constructor(args: { conversationId: string; streamId: string; title: string }) {
		this.streamId = args.streamId;
		this.holder = `agent:${args.streamId}`;
		this.ready = this.createAndClaim(args);
	}

	heartbeat(): void {
		if (this.terminal) return;
		const now = Date.now();
		if (now - this.lastHeartbeatAtMs < HEARTBEAT_INTERVAL_MS) return;
		this.lastHeartbeatAtMs = now;
		this.withClaim("heartbeat", (claim) =>
			runtimeJobHeartbeat({
				jobId: claim.job.jobId,
				leaseId: claim.lease.leaseId,
			}),
		);
	}

	complete(): void {
		if (!this.markTerminal()) return;
		this.withClaim("complete", (claim) =>
			runtimeJobComplete({
				jobId: claim.job.jobId,
				leaseId: claim.lease.leaseId,
			}),
		);
	}

	fail(error: unknown): void {
		if (!this.markTerminal()) return;
		const message = errorMessage(error);
		this.withClaim("fail", (claim) =>
			runtimeJobFail({
				jobId: claim.job.jobId,
				leaseId: claim.lease.leaseId,
				error: message,
			}),
		);
	}

	cancel(reason: string): void {
		if (!this.markTerminal()) return;
		void this.ready
			.catch((error) => {
				warnRuntimeJobFailure(`cancel:${reason}:ready`, error);
				return null;
			})
			.then(() => {
				if (!this.jobId) return null;
				return runtimeJobCancel(this.jobId);
			})
			.catch((error) => warnRuntimeJobFailure(`cancel:${reason}`, error));
	}

	private markTerminal(): boolean {
		if (this.terminal) return false;
		this.terminal = true;
		activeJobsByStreamId.delete(this.streamId);
		return true;
	}

	private withClaim(
		action: string,
		run: (claim: RuntimeJobClaim) => Promise<unknown>,
	): void {
		void this.ready
			.then((claim) => {
				if (!claim) return null;
				return run(claim);
			})
			.catch((error) => warnRuntimeJobFailure(action, error));
	}

	private async createAndClaim(args: {
		conversationId: string;
		streamId: string;
		title: string;
	}): Promise<RuntimeJobClaim | null> {
		try {
			const job = await runtimeJobCreate({
				kind: AGENT_CHAT_RUN_JOB_KIND,
				payload: payloadFor(args),
				maxAttempts: 1,
			});
			this.jobId = job.jobId;
			const claim = await runtimeJobClaimByKind({
				kind: AGENT_CHAT_RUN_JOB_KIND,
				holder: this.holder,
				jobId: job.jobId,
			});
			return claim;
		} catch (error) {
			if (this.jobId) {
				const orphanJobId = this.jobId;
				this.jobId = null;
				void runtimeJobCancel(orphanJobId).catch((cancelError) => {
					warnRuntimeJobFailure("claim-failed-cancel", cancelError);
				});
			}
			warnRuntimeJobFailure("create/claim", error);
			activeJobsByStreamId.delete(this.streamId);
			return null;
		}
	}
}
