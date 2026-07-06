import {
	runtimeJobCancel,
	runtimeJobClaimByKind,
	runtimeJobComplete,
	runtimeJobCreate,
	runtimeJobFail,
	runtimeJobHeartbeat,
	type RuntimeJobClaim,
} from "@/commands/runtime-db";

/** Runtime job kind used for one-shot resume-only Agent rewind sessions. */
export const AGENT_REWIND_SESSION_JOB_KIND = "agent-rewind-session";

interface AgentRewindSessionPayload {
	kind: typeof AGENT_REWIND_SESSION_JOB_KIND;
	conversationId: string;
	streamId: string;
	targetUserMessageId: string;
}

/** Controls the best-effort runtime ledger row for a rewind session. */
export interface AgentRewindSessionJobController {
	streamId: string;
	heartbeat: () => void;
	complete: () => void;
	fail: (error: unknown) => void;
}

const RUNTIME_DISABLED_ERROR_PREFIX = "runtime-disabled:";

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
	console.warn(`[agent-rewind-session-job] ${action} failed:`, error);
}

function payloadFor(args: {
	conversationId: string;
	streamId: string;
	targetUserMessageId: string;
}): string {
	const payload: AgentRewindSessionPayload = {
		kind: AGENT_REWIND_SESSION_JOB_KIND,
		conversationId: args.conversationId,
		streamId: args.streamId,
		targetUserMessageId: args.targetUserMessageId,
	};
	return JSON.stringify(payload);
}

/** Parses a runtime job payload for display and tests, returning null for unrelated kinds. */
export function parseAgentRewindSessionJobPayload(payload: string): AgentRewindSessionPayload | null {
	try {
		const parsed = JSON.parse(payload) as Partial<AgentRewindSessionPayload>;
		if (parsed.kind !== AGENT_REWIND_SESSION_JOB_KIND) return null;
		if (typeof parsed.conversationId !== "string") return null;
		if (typeof parsed.streamId !== "string") return null;
		if (typeof parsed.targetUserMessageId !== "string") return null;
		return {
			kind: AGENT_REWIND_SESSION_JOB_KIND,
			conversationId: parsed.conversationId,
			streamId: parsed.streamId,
			targetUserMessageId: parsed.targetUserMessageId,
		};
	} catch {
		return null;
	}
}

/** Creates and claims the rewind session runtime job without blocking rewind on ledger failures. */
export function startAgentRewindSessionJob(args: {
	conversationId: string;
	streamId: string;
	targetUserMessageId: string;
}): AgentRewindSessionJobController {
	return new AgentRewindSessionJob(args);
}

class AgentRewindSessionJob implements AgentRewindSessionJobController {
	readonly streamId: string;
	private readonly holder: string;
	private readonly ready: Promise<RuntimeJobClaim | null>;
	private terminal = false;
	private heartbeatSent = false;

	constructor(args: {
		conversationId: string;
		streamId: string;
		targetUserMessageId: string;
	}) {
		this.streamId = args.streamId;
		this.holder = `agent-rewind:${args.streamId}`;
		this.ready = this.createAndClaim(args);
	}

	heartbeat(): void {
		if (this.terminal || this.heartbeatSent) return;
		this.heartbeatSent = true;
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

	private markTerminal(): boolean {
		if (this.terminal) return false;
		this.terminal = true;
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
		targetUserMessageId: string;
	}): Promise<RuntimeJobClaim | null> {
		let jobId: string | null = null;
		try {
			const job = await runtimeJobCreate({
				kind: AGENT_REWIND_SESSION_JOB_KIND,
				payload: payloadFor(args),
				maxAttempts: 1,
			});
			jobId = job.jobId;
			return await runtimeJobClaimByKind({
				kind: AGENT_REWIND_SESSION_JOB_KIND,
				holder: this.holder,
				jobId: job.jobId,
			});
		} catch (error) {
			if (jobId) {
				void runtimeJobCancel(jobId).catch((cancelError) => {
					warnRuntimeJobFailure("claim-failed-cancel", cancelError);
				});
			}
			warnRuntimeJobFailure("create/claim", error);
			return null;
		}
	}
}
