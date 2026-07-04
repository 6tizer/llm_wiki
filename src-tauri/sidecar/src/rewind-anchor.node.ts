import assert from "node:assert/strict";
import test from "node:test";
import {
	parseSessionTranscript,
	resolveRewindAnchorFromTranscript,
	resolveVerifiedRewindAnchor,
} from "./rewind-anchor.js";

function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

// Shape mirrors a real transcript captured during the E1/E2 probe work
// (probe session id 40fbe413-...): a genuine human turn (no toolUseResult)
// gets a snapshot keyed to ITS OWN uuid; a later in-turn write (after tool
// use) gets an `isSnapshotUpdate: true` snapshot keyed to the ASSISTANT
// uuid instead — both shapes appear for real, so the resolver must accept
// either.
const HUMAN_UUID = "51769f4a-da1e-46f6-9f82-1d490f31b7e5";
const ASSISTANT_1_UUID = "e0c457cf-960f-4277-b274-cb44c36b3634";
const ASSISTANT_2_UUID = "64b439a5-5c30-4040-8c05-15693c93ef1c";
const TOOL_RESULT_USER_UUID = "52e5ed38-7f63-4a37-86d3-f62d290f2ed7";
const ASSISTANT_3_UUID = "89b8d8c6-976b-49aa-81f0-d9ca21fdc49c";
const SECOND_WRITE_ASSISTANT_UUID = "cb86306b-acbd-47b3-bdad-c38fe2bb66a8";

function sampleTranscriptContent(): string {
	return [
		line({ type: "queue-operation", operation: "start" }),
		line({ type: "user", uuid: HUMAN_UUID, parentUuid: undefined }),
		line({ type: "file-history-snapshot", messageId: HUMAN_UUID, isSnapshotUpdate: false, snapshot: { messageId: HUMAN_UUID } }),
		line({ type: "assistant", uuid: ASSISTANT_1_UUID, parentUuid: HUMAN_UUID }),
		line({ type: "assistant", uuid: ASSISTANT_2_UUID, parentUuid: ASSISTANT_1_UUID }),
		line({ type: "user", uuid: TOOL_RESULT_USER_UUID, parentUuid: ASSISTANT_2_UUID, toolUseResult: { ok: true } }),
		line({ type: "assistant", uuid: ASSISTANT_3_UUID, parentUuid: TOOL_RESULT_USER_UUID }),
		line({ type: "file-history-snapshot", messageId: SECOND_WRITE_ASSISTANT_UUID, isSnapshotUpdate: true, snapshot: { messageId: SECOND_WRITE_ASSISTANT_UUID } }),
		line({ type: "assistant", uuid: SECOND_WRITE_ASSISTANT_UUID, parentUuid: ASSISTANT_3_UUID }),
		"", // trailing blank line, as real files have
	].join("\n");
}

test("parseSessionTranscript collects snapshot messageIds and the parent chain", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	assert.equal(transcript.snapshotMessageIds.has(HUMAN_UUID), true);
	assert.equal(transcript.snapshotMessageIds.has(SECOND_WRITE_ASSISTANT_UUID), true);
	assert.equal(transcript.parentByUuid.get(ASSISTANT_1_UUID), HUMAN_UUID);
	assert.equal(transcript.parentByUuid.get(TOOL_RESULT_USER_UUID), ASSISTANT_2_UUID);
});

test("parseSessionTranscript skips malformed lines instead of throwing", () => {
	const content = [line({ type: "user", uuid: HUMAN_UUID }), "{not json", ""].join("\n");
	const transcript = parseSessionTranscript(content);
	assert.equal(transcript.parentByUuid.has(HUMAN_UUID), true);
});

test("branch 1: client-supplied uuid is directly used when it IS a recorded checkpoint anchor", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	const result = resolveRewindAnchorFromTranscript(transcript, {
		candidateUserMessageId: HUMAN_UUID,
		fallbackAssistantMessageId: ASSISTANT_1_UUID,
	});
	assert.deepEqual(result, { ok: true, uuid: HUMAN_UUID, source: "client_verified" });
});

test("branch 2: a synthetic/wrong live-captured uuid is corrected via the assistant fallback's parent chain", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	// The live stream captured the synthetic tool-result "user" uuid (not a
	// checkpoint anchor at all) — the fallback assistant anchor from the
	// SAME turn (ASSISTANT_1_UUID, whose parent chain leads straight back to
	// the genuine human turn) must correct it.
	const result = resolveRewindAnchorFromTranscript(transcript, {
		candidateUserMessageId: TOOL_RESULT_USER_UUID,
		fallbackAssistantMessageId: ASSISTANT_1_UUID,
	});
	assert.deepEqual(result, { ok: true, uuid: HUMAN_UUID, source: "reverse_lookup_verified" });
});

test("branch 2b: the fallback assistant uuid itself can BE the recorded anchor (isSnapshotUpdate case)", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	const result = resolveRewindAnchorFromTranscript(transcript, {
		candidateUserMessageId: undefined,
		fallbackAssistantMessageId: SECOND_WRITE_ASSISTANT_UUID,
	});
	assert.deepEqual(result, {
		ok: true,
		uuid: SECOND_WRITE_ASSISTANT_UUID,
		source: "reverse_lookup_verified",
	});
});

test("branch 3: neither the candidate nor any ancestor of the fallback resolves — fail closed", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	const result = resolveRewindAnchorFromTranscript(transcript, {
		candidateUserMessageId: "totally-unknown-uuid",
		fallbackAssistantMessageId: "also-unknown-uuid",
	});
	assert.deepEqual(result, { ok: false, reason: "anchor_unresolved" });
});

test("branch 3b: missing fallback with an unverifiable candidate fails closed (no chain to walk)", () => {
	const transcript = parseSessionTranscript(sampleTranscriptContent());
	const result = resolveRewindAnchorFromTranscript(transcript, {
		candidateUserMessageId: TOOL_RESULT_USER_UUID,
		fallbackAssistantMessageId: undefined,
	});
	assert.deepEqual(result, { ok: false, reason: "anchor_unresolved" });
});

test("resolveVerifiedRewindAnchor fails closed with session_transcript_missing when the loader finds nothing", async () => {
	const result = await resolveVerifiedRewindAnchor(
		{ agentSessionId: "no-such-session", candidateUserMessageId: HUMAN_UUID },
		async () => undefined,
	);
	assert.deepEqual(result, { ok: false, reason: "session_transcript_missing" });
});

test("resolveVerifiedRewindAnchor wires the injected loader's content through parsing + resolution", async () => {
	const result = await resolveVerifiedRewindAnchor(
		{
			agentSessionId: "session-abc",
			candidateUserMessageId: TOOL_RESULT_USER_UUID,
			fallbackAssistantMessageId: ASSISTANT_1_UUID,
		},
		async (sessionId) => {
			assert.equal(sessionId, "session-abc");
			return sampleTranscriptContent();
		},
	);
	assert.deepEqual(result, { ok: true, uuid: HUMAN_UUID, source: "reverse_lookup_verified" });
});

test("cyclic parentUuid data does not hang the resolver", () => {
	const content = [
		line({ type: "assistant", uuid: "a", parentUuid: "b" }),
		line({ type: "assistant", uuid: "b", parentUuid: "a" }),
	].join("\n");
	const transcript = parseSessionTranscript(content);
	const result = resolveRewindAnchorFromTranscript(transcript, {
		fallbackAssistantMessageId: "a",
	});
	assert.deepEqual(result, { ok: false, reason: "anchor_unresolved" });
});
