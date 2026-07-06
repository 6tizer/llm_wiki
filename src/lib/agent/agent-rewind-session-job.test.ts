import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runtimeJobCancel,
	runtimeJobClaimByKind,
	runtimeJobComplete,
	runtimeJobCreate,
	runtimeJobFail,
	runtimeJobHeartbeat,
} from "@/commands/runtime-db";
import {
	AGENT_REWIND_SESSION_JOB_KIND,
	parseAgentRewindSessionJobPayload,
	startAgentRewindSessionJob,
} from "./agent-rewind-session-job";

vi.mock("@/commands/runtime-db", () => ({
	runtimeJobCancel: vi.fn(),
	runtimeJobClaimByKind: vi.fn(),
	runtimeJobComplete: vi.fn(),
	runtimeJobCreate: vi.fn(),
	runtimeJobFail: vi.fn(),
	runtimeJobHeartbeat: vi.fn(),
}));

const runtimeMocks = {
	runtimeJobCancel: vi.mocked(runtimeJobCancel),
	runtimeJobClaimByKind: vi.mocked(runtimeJobClaimByKind),
	runtimeJobComplete: vi.mocked(runtimeJobComplete),
	runtimeJobCreate: vi.mocked(runtimeJobCreate),
	runtimeJobFail: vi.mocked(runtimeJobFail),
	runtimeJobHeartbeat: vi.mocked(runtimeJobHeartbeat),
};

function jobRecord(jobId: string) {
	return {
		jobId,
		kind: AGENT_REWIND_SESSION_JOB_KIND,
		payload: "{}",
		state: "queued" as const,
		attempt: 1,
		maxAttempts: 1,
		priority: 0,
		createdAtMs: 0,
		updatedAtMs: 0,
	};
}

function claim(jobId = "job-rewind-1") {
	return {
		job: jobRecord(jobId),
		lease: {
			leaseId: `${jobId}-lease`,
			jobId,
			holder: "agent-rewind:stream-rewind-1",
			acquiredAtMs: 0,
			heartbeatAtMs: 0,
			expiresAtMs: 30_000,
			status: "active",
		},
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("agent rewind session job ledger", () => {
	beforeEach(() => {
		for (const mock of Object.values(runtimeMocks)) mock.mockReset();
		runtimeMocks.runtimeJobCreate.mockResolvedValue(jobRecord("job-rewind-1"));
		runtimeMocks.runtimeJobClaimByKind.mockResolvedValue(claim("job-rewind-1"));
		runtimeMocks.runtimeJobHeartbeat.mockResolvedValue(claim("job-rewind-1"));
		runtimeMocks.runtimeJobCancel.mockResolvedValue({
			...jobRecord("job-rewind-1"),
			state: "cancelled",
		});
		runtimeMocks.runtimeJobComplete.mockResolvedValue({
			...jobRecord("job-rewind-1"),
			state: "completed",
		});
		runtimeMocks.runtimeJobFail.mockResolvedValue({
			...jobRecord("job-rewind-1"),
			state: "failed",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates and claims the exact rewind session job id", async () => {
		startAgentRewindSessionJob({
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalled());
		expect(runtimeMocks.runtimeJobCreate).toHaveBeenCalledWith({
			kind: AGENT_REWIND_SESSION_JOB_KIND,
			payload: expect.any(String),
			maxAttempts: 1,
		});
		const payload = parseAgentRewindSessionJobPayload(
			runtimeMocks.runtimeJobCreate.mock.calls[0][0].payload,
		);
		expect(payload).toEqual({
			kind: AGENT_REWIND_SESSION_JOB_KIND,
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});
		expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledWith({
			kind: AGENT_REWIND_SESSION_JOB_KIND,
			holder: "agent-rewind:stream-rewind-1",
			jobId: "job-rewind-1",
		});
	});

	it("heartbeats once and completes the claimed job", async () => {
		const controller = startAgentRewindSessionJob({
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});
		await flushPromises();

		controller.heartbeat();
		controller.heartbeat();
		controller.complete();

		await vi.waitFor(() => {
			expect(runtimeMocks.runtimeJobHeartbeat).toHaveBeenCalledTimes(1);
			expect(runtimeMocks.runtimeJobComplete).toHaveBeenCalledWith({
				jobId: "job-rewind-1",
				leaseId: "job-rewind-1-lease",
			});
		});
	});

	it("fails the claimed job with normalized error text", async () => {
		const controller = startAgentRewindSessionJob({
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});
		await flushPromises();

		controller.fail(new Error("rewind crashed"));

		await vi.waitFor(() => {
			expect(runtimeMocks.runtimeJobFail).toHaveBeenCalledWith({
				jobId: "job-rewind-1",
				leaseId: "job-rewind-1-lease",
				error: "rewind crashed",
			});
		});
	});

	it("cancels the created job and keeps rewind fail-open when claim fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		runtimeMocks.runtimeJobClaimByKind.mockRejectedValueOnce(new Error("claim failed"));

		const controller = startAgentRewindSessionJob({
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});
		controller.complete();

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalled());
		await flushPromises();
		expect(runtimeMocks.runtimeJobCancel).toHaveBeenCalledWith("job-rewind-1");
		expect(runtimeMocks.runtimeJobComplete).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[agent-rewind-session-job] create/claim failed:",
			expect.any(Error),
		);
	});

	it("does not cancel an orphan job when create fails before a job id exists", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		runtimeMocks.runtimeJobCreate.mockRejectedValueOnce(new Error("create failed"));

		const controller = startAgentRewindSessionJob({
			conversationId: "conv-1",
			streamId: "stream-rewind-1",
			targetUserMessageId: "user-uuid-1",
		});
		controller.fail("still fail-open");

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobCreate).toHaveBeenCalled());
		await flushPromises();
		expect(runtimeMocks.runtimeJobCancel).not.toHaveBeenCalled();
		expect(runtimeMocks.runtimeJobFail).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[agent-rewind-session-job] create/claim failed:",
			expect.any(Error),
		);
	});
});
