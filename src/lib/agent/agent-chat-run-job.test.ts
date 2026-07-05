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
	AGENT_CHAT_RUN_JOB_KIND,
	cancelAgentChatRunJobByStreamId,
	parseAgentChatRunJobPayload,
	startAgentChatRunJob,
} from "./agent-chat-run-job";

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
		kind: AGENT_CHAT_RUN_JOB_KIND,
		payload: "{}",
		state: "queued" as const,
		attempt: 1,
		maxAttempts: 1,
		priority: 0,
		createdAtMs: 0,
		updatedAtMs: 0,
	};
}

function claim(jobId = "job-1") {
	return {
		job: jobRecord(jobId),
		lease: {
			leaseId: `${jobId}-lease`,
			jobId,
			holder: "agent:stream-1",
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

describe("agent chat run job ledger", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		for (const mock of Object.values(runtimeMocks)) mock.mockReset();
		runtimeMocks.runtimeJobCreate.mockResolvedValue(jobRecord("job-1"));
		runtimeMocks.runtimeJobClaimByKind.mockResolvedValue(claim("job-1"));
		runtimeMocks.runtimeJobHeartbeat.mockResolvedValue(claim("job-1"));
		runtimeMocks.runtimeJobComplete.mockResolvedValue({ ...jobRecord("job-1"), state: "completed" });
		runtimeMocks.runtimeJobFail.mockResolvedValue({ ...jobRecord("job-1"), state: "failed" });
		runtimeMocks.runtimeJobCancel.mockResolvedValue({ ...jobRecord("job-1"), state: "cancelled" });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("creates, claims, and completes an agent chat run", async () => {
		const controller = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "Summarize this source",
		});

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalled());
		expect(runtimeMocks.runtimeJobCreate).toHaveBeenCalledWith({
			kind: AGENT_CHAT_RUN_JOB_KIND,
			payload: expect.any(String),
			maxAttempts: 1,
		});
		const payload = parseAgentChatRunJobPayload(runtimeMocks.runtimeJobCreate.mock.calls[0][0].payload);
		expect(payload).toMatchObject({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "Summarize this source",
		});
		expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledWith({
			kind: AGENT_CHAT_RUN_JOB_KIND,
			holder: "agent:stream-1",
			jobId: "job-1",
		});

		controller.complete();

		await vi.waitFor(() => {
			expect(runtimeMocks.runtimeJobComplete).toHaveBeenCalledWith({
				jobId: "job-1",
				leaseId: "job-1-lease",
			});
		});
	});

	it("maps errors, stop, and rewind to fail/cancel transitions", async () => {
		const failed = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "fail",
		});
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledTimes(1));
		failed.fail(new Error("boom"));
		await vi.waitFor(() => {
			expect(runtimeMocks.runtimeJobFail).toHaveBeenCalledWith({
				jobId: "job-1",
				leaseId: "job-1-lease",
				error: "boom",
			});
		});

		runtimeMocks.runtimeJobCreate.mockResolvedValueOnce(jobRecord("job-2"));
		runtimeMocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim("job-2"));
		const stopped = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-2",
			title: "stop",
		});
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledTimes(2));
		stopped.cancel("stopped");
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobCancel).toHaveBeenCalledWith("job-2"));

		runtimeMocks.runtimeJobCreate.mockResolvedValueOnce(jobRecord("job-3"));
		runtimeMocks.runtimeJobClaimByKind.mockResolvedValueOnce(claim("job-3"));
		startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-3",
			title: "rewind",
		});
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalledTimes(3));
		cancelAgentChatRunJobByStreamId("stream-3", "rewind");
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobCancel).toHaveBeenCalledWith("job-3"));
	});

	it("throttles heartbeats to at least ten seconds", async () => {
		const controller = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "heartbeat",
		});
		await flushPromises();
		expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalled();

		controller.heartbeat();
		controller.heartbeat();
		await flushPromises();
		expect(runtimeMocks.runtimeJobHeartbeat).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(9_999);
		controller.heartbeat();
		expect(runtimeMocks.runtimeJobHeartbeat).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		controller.heartbeat();
		await flushPromises();
		expect(runtimeMocks.runtimeJobHeartbeat).toHaveBeenCalledTimes(2);
	});

	it("silently skips runtime-disabled errors", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		runtimeMocks.runtimeJobCreate.mockRejectedValueOnce(
			new Error("runtime-disabled: work runtime is disabled"),
		);

		const controller = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "disabled",
		});
		controller.complete();

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobCreate).toHaveBeenCalled());
		expect(warn).not.toHaveBeenCalled();
		expect(runtimeMocks.runtimeJobClaimByKind).not.toHaveBeenCalled();
		expect(runtimeMocks.runtimeJobComplete).not.toHaveBeenCalled();
	});

	it("cancels a created job when claim fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		runtimeMocks.runtimeJobClaimByKind.mockRejectedValueOnce(new Error("claim failed"));

		const controller = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "claim failure",
		});
		controller.complete();

		await vi.waitFor(() => expect(runtimeMocks.runtimeJobCancel).toHaveBeenCalledWith("job-1"));
		expect(runtimeMocks.runtimeJobComplete).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[agent-chat-run-job] create/claim failed:",
			expect.any(Error),
		);
	});

	it("logs non-runtime job rejections without throwing to callers", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		runtimeMocks.runtimeJobComplete.mockRejectedValueOnce(new Error("db locked"));

		const controller = startAgentChatRunJob({
			conversationId: "conv-1",
			streamId: "stream-1",
			title: "reject",
		});
		await vi.waitFor(() => expect(runtimeMocks.runtimeJobClaimByKind).toHaveBeenCalled());

		expect(() => controller.complete()).not.toThrow();
		await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
			"[agent-chat-run-job] complete failed:",
			expect.any(Error),
		));
	});
});
