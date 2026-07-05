import assert from "node:assert/strict";
import test from "node:test";
import type { QueryControl, QueryFn, QueryInput } from "./core.js";
import type { SessionTranscriptLoader } from "./rewind-anchor.js";
import { handleRewindSessionRequest } from "./rewind-session-bridge.js";
import type { AgentMessage, RewindSessionRequest } from "./types.js";

const baseRequest: RewindSessionRequest = {
	type: "rewind_session",
	streamId: "stream-1",
	agentSessionId: "session-abc",
	rewindUserMessageId: "user-uuid-1",
	fallbackAssistantMessageId: "assistant-uuid-1",
	cwd: "/tmp/project",
	model: "claude-sonnet-4-5",
};

function initMessage(sessionId: string) {
	return { type: "system", subtype: "init", session_id: sessionId };
}

function transcriptLine(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** A transcript where `baseRequest.rewindUserMessageId` is itself a
 * recorded checkpoint anchor — the common "client uuid verifies directly"
 * case most of these tests don't care about anchor resolution beyond. */
function workingTranscriptLoader(): SessionTranscriptLoader {
	return async () =>
		[
			transcriptLine({ type: "user", uuid: "user-uuid-1" }),
			transcriptLine({
				type: "file-history-snapshot",
				messageId: "user-uuid-1",
				snapshot: { messageId: "user-uuid-1" },
			}),
			transcriptLine({ type: "assistant", uuid: "assistant-uuid-1", parentUuid: "user-uuid-1" }),
		].join("\n");
}

test("rewind_session: matching init session_id calls rewindFiles and reports success (A1 happy path)", async () => {
	const sent: AgentMessage[] = [];
	let rewindCalledWith: string | undefined;
	let closed = false;
	let capturedInput: QueryInput | undefined;
	const queryFn: QueryFn = (input) => {
		capturedInput = input;
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async (uuid: string) => {
			rewindCalledWith = uuid;
			return { canRewind: true, filesChanged: ["wiki/page.md"] };
		};
		query.close = () => {
			closed = true;
		};
		return query;
	};

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
		loadTranscript: workingTranscriptLoader(),
	});

	assert.equal(rewindCalledWith, "user-uuid-1");
	assert.equal(closed, true);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0], {
		streamId: "stream-1",
		type: "rewind_session",
		data: {
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
			error: undefined,
		},
	});

	// A8: two-layer no-tools lock + maxTurns:1 + real minimal prompt (never
	// empty streaming input, per the E1 probe finding).
	assert.ok(capturedInput);
	const options = capturedInput.options ?? {};
	assert.equal(capturedInput.prompt, "OK");
	assert.deepEqual(options.tools, []);
	assert.deepEqual(options.allowedTools, []);
	assert.equal(options.maxTurns, 1);
	assert.equal(options.resume, "session-abc");
	assert.equal(options.persistSession, true);
	assert.equal(options.enableFileCheckpointing, true);
	assert.equal((options as { mcpServers?: unknown }).mcpServers, undefined);
});

test("rewind_session: managed bearer profile isolates user settings sources", async () => {
	let capturedInput: QueryInput | undefined;
	const queryFn: QueryFn = (input) => {
		capturedInput = input;
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async () => ({ canRewind: true });
		return query;
	};

	await handleRewindSessionRequest({
		request: {
			...baseRequest,
			agentProfileAuthStyle: "bearer",
			apiKey: "bearer-token",
		},
		queryFn,
		activeQueries: new Map(),
		send: () => {},
		loadTranscript: workingTranscriptLoader(),
	});

	assert.deepEqual(capturedInput?.options?.settingSources, ["project", "local"]);
});

test("rewind_session: baseUrl-only profile isolates user settings sources", async () => {
	let capturedInput: QueryInput | undefined;
	const queryFn: QueryFn = (input) => {
		capturedInput = input;
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async () => ({ canRewind: true });
		return query;
	};

	await handleRewindSessionRequest({
		request: {
			...baseRequest,
			agentProfileAuthStyle: "none",
			baseUrl: "https://bedrock-runtime.example.com",
		},
		queryFn,
		activeQueries: new Map(),
		send: () => {},
		loadTranscript: workingTranscriptLoader(),
	});

	assert.deepEqual(capturedInput?.options?.settingSources, ["project", "local"]);
});

test("rewind_session: oauth-local-cli keeps default settings sources", async () => {
	let capturedInput: QueryInput | undefined;
	const queryFn: QueryFn = (input) => {
		capturedInput = input;
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async () => ({ canRewind: true });
		return query;
	};

	await handleRewindSessionRequest({
		request: {
			...baseRequest,
			agentProfileAuthStyle: "oauth-local-cli",
		},
		queryFn,
		activeQueries: new Map(),
		send: () => {},
		loadTranscript: workingTranscriptLoader(),
	});

	assert.equal(capturedInput?.options?.settingSources, undefined);
});

test("rewind_session: a synthetic/unverified rewindUserMessageId is corrected via the JSONL fallback before rewindFiles is called (review-round anchor fix)", async () => {
	const sent: AgentMessage[] = [];
	let rewindCalledWith: string | undefined;
	const queryFn: QueryFn = () => {
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async (uuid: string) => {
			rewindCalledWith = uuid;
			return { canRewind: true };
		};
		return query;
	};

	// rewindUserMessageId ("synthetic-tool-result-uuid") is NOT a recorded
	// checkpoint anchor in this transcript — only the genuine human turn
	// ("real-human-turn-uuid") is, reachable by walking up from the
	// fallback assistant uuid's parent chain.
	const loadTranscript: SessionTranscriptLoader = async () =>
		[
			transcriptLine({ type: "user", uuid: "real-human-turn-uuid" }),
			transcriptLine({
				type: "file-history-snapshot",
				messageId: "real-human-turn-uuid",
				snapshot: { messageId: "real-human-turn-uuid" },
			}),
			transcriptLine({ type: "assistant", uuid: "assistant-a", parentUuid: "real-human-turn-uuid" }),
			transcriptLine({ type: "user", uuid: "synthetic-tool-result-uuid", parentUuid: "assistant-a", toolUseResult: {} }),
			transcriptLine({ type: "assistant", uuid: "assistant-uuid-1", parentUuid: "synthetic-tool-result-uuid" }),
		].join("\n");

	await handleRewindSessionRequest({
		request: { ...baseRequest, rewindUserMessageId: "synthetic-tool-result-uuid" },
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
		loadTranscript,
	});

	assert.equal(rewindCalledWith, "real-human-turn-uuid");
	assert.equal((sent[0]?.data as { ok: boolean }).ok, true);
});

test("rewind_session: an unresolvable anchor fails closed without ever calling rewindFiles (review-round anchor fix)", async () => {
	const sent: AgentMessage[] = [];
	let rewindCalled = false;
	const queryFn: QueryFn = () => {
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async () => {
			rewindCalled = true;
			return { canRewind: true };
		};
		return query;
	};

	const loadTranscript: SessionTranscriptLoader = async () =>
		transcriptLine({ type: "user", uuid: "some-unrelated-uuid" });

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
		loadTranscript,
	});

	assert.equal(rewindCalled, false);
	assert.equal((sent[0]?.data as { ok: boolean }).ok, false);
	assert.equal(
		(sent[0]?.data as { unavailableReason?: string }).unavailableReason,
		"missing_message_id",
	);
});

test("rewind_session: mismatched init session_id aborts without calling rewindFiles (A1)", async () => {
	const sent: AgentMessage[] = [];
	let rewindCalled = false;
	const queryFn: QueryFn = () => {
		const query = (async function* () {
			yield initMessage("some-other-session");
		})() as QueryControl;
		query.rewindFiles = async () => {
			rewindCalled = true;
			return { canRewind: true };
		};
		return query;
	};

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
	});

	assert.equal(rewindCalled, false);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.type, "rewind_session");
	assert.equal((sent[0]?.data as { ok: boolean }).ok, false);
	assert.equal(
		(sent[0]?.data as { unavailableReason?: string }).unavailableReason,
		"session_mismatch",
	);
});

test("rewind_session: init never arrives times out fail-closed (A13)", async () => {
	const sent: AgentMessage[] = [];
	const queryFn: QueryFn = () => {
		const query = (async function* () {
			// Never yields — simulates a stuck/unreachable transport.
			await new Promise(() => {});
			yield initMessage("session-abc");
		})() as QueryControl;
		return query;
	};

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
		initTimeoutMs: 20,
	});

	assert.equal(sent.length, 1);
	assert.equal((sent[0]?.data as { ok: boolean }).ok, false);
	assert.equal(
		(sent[0]?.data as { unavailableReason?: string }).unavailableReason,
		"transport_not_ready",
	);
});

test("rewind_session: missing rewindUserMessageId fails closed without spawning a Query (A11)", async () => {
	const sent: AgentMessage[] = [];
	let queryFnCalled = false;
	const queryFn: QueryFn = () => {
		queryFnCalled = true;
		return (async function* () {})() as QueryControl;
	};

	await handleRewindSessionRequest({
		request: { ...baseRequest, rewindUserMessageId: "" },
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
	});

	assert.equal(queryFnCalled, false);
	assert.equal(sent.length, 1);
	assert.equal(
		(sent[0]?.data as { unavailableReason?: string }).unavailableReason,
		"missing_message_id",
	);
});

test("rewind_session: resumed query without rewindFiles support fails closed (A5-adjacent)", async () => {
	const sent: AgentMessage[] = [];
	const queryFn: QueryFn = () => {
		return (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
	};

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
	});

	assert.equal(
		(sent[0]?.data as { unavailableReason?: string }).unavailableReason,
		"unsupported",
	);
});

test("rewind_session: rewindFiles throwing is reported and the query is still closed (A5)", async () => {
	const sent: AgentMessage[] = [];
	let closed = false;
	const queryFn: QueryFn = () => {
		const query = (async function* () {
			yield initMessage("session-abc");
		})() as QueryControl;
		query.rewindFiles = async () => {
			throw new Error("checkpoint missing");
		};
		query.close = () => {
			closed = true;
		};
		return query;
	};

	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries: new Map(),
		send: (msg) => sent.push(msg),
		loadTranscript: workingTranscriptLoader(),
	});

	assert.equal(closed, true);
	assert.equal((sent[0]?.data as { ok: boolean }).ok, false);
	assert.match(String((sent[0]?.data as { error?: string }).error), /checkpoint missing/);
});

test("rewind_session: registers and releases the abort controller around the run (kill support)", async () => {
	const activeQueries = new Map<string, AbortController>();
	let sawRegisteredDuringRun = false;
	const queryFn: QueryFn = () => {
		return (async function* () {
			sawRegisteredDuringRun = activeQueries.has("stream-1");
			yield initMessage("session-abc");
		})() as QueryControl;
	};

	let settledCount = 0;
	await handleRewindSessionRequest({
		request: baseRequest,
		queryFn,
		activeQueries,
		send: () => {},
		onSettled: () => {
			settledCount += 1;
		},
	});

	assert.equal(sawRegisteredDuringRun, true);
	assert.equal(activeQueries.has("stream-1"), false);
	assert.equal(settledCount, 1);
});
