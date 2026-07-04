import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ParsedSessionTranscript {
	/**
	 * Every `file-history-snapshot` entry's messageId — the SDK's own record
	 * of which message uuid a checkpoint is anchored to. Verified against a
	 * real transcript (SPEC-7 PR2 review round): this can be EITHER a
	 * genuine human-turn "user" uuid (the turn's first checkpoint,
	 * `isSnapshotUpdate: false`) OR a later "assistant" uuid (a subsequent
	 * in-turn write, `isSnapshotUpdate: true`) — both shapes are directly
	 * observed, so membership in this set is the only authoritative test;
	 * the message's own `type`/`toolUseResult` shape is not reliable enough
	 * on its own to guess which uuid a checkpoint is keyed to.
	 */
	snapshotMessageIds: Set<string>;
	/** uuid -> parentUuid, for walking back from a live-stream-reliable
	 * assistant uuid to the nearest ancestor that IS a valid snapshot
	 * anchor. */
	parentByUuid: Map<string, string | undefined>;
	/**
	 * uuids of genuine human-turn boundary nodes: `type: "user"` entries
	 * with NO `toolUseResult` field (as opposed to a synthetic tool-result
	 * "user" frame, which DOES carry one). Each real turn has exactly one.
	 * The ancestor walk in `nearestSnapshotAncestor` must treat this as a
	 * hard stop (checked, then no further) — without it, walking past a
	 * turn with no checkpoint of its own would silently land on an EARLIER
	 * turn's checkpoint and over-rewind past the user's intended target
	 * (Codex review-round P1: Turn2 has no checkpoint, but Turn1 does —
	 * rewinding "to Turn2" must never reach back into Turn1's anchor).
	 */
	humanTurnBoundaryUuids: Set<string>;
}

/**
 * Parse raw session-transcript JSONL text into the two facts rewind anchor
 * resolution needs. Malformed lines are skipped (best-effort — a
 * partially-written last line from a crashed process shouldn't break the
 * whole parse).
 */
export function parseSessionTranscript(content: string): ParsedSessionTranscript {
	const snapshotMessageIds = new Set<string>();
	const parentByUuid = new Map<string, string | undefined>();
	const humanTurnBoundaryUuids = new Set<string>();

	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (obj.type === "file-history-snapshot") {
			const messageId = obj.messageId;
			if (typeof messageId === "string" && messageId) {
				snapshotMessageIds.add(messageId);
			}
			const snapshot = obj.snapshot as Record<string, unknown> | undefined;
			const snapshotMessageId = snapshot?.messageId;
			if (typeof snapshotMessageId === "string" && snapshotMessageId) {
				snapshotMessageIds.add(snapshotMessageId);
			}
			continue;
		}
		const uuid = obj.uuid;
		if (typeof uuid === "string" && uuid) {
			const parentUuid = obj.parentUuid;
			parentByUuid.set(uuid, typeof parentUuid === "string" ? parentUuid : undefined);
			if (obj.type === "user" && !("toolUseResult" in obj)) {
				humanTurnBoundaryUuids.add(uuid);
			}
		}
	}

	return { snapshotMessageIds, parentByUuid, humanTurnBoundaryUuids };
}

// Every entry in a real transcript carries a parentUuid forming a single
// linear chain back to session start; this cap is just a runaway/cycle
// guard, not a realistic depth.
const MAX_ANCESTOR_HOPS = 500;

/**
 * Walk `startUuid`'s own parentUuid chain (including itself, at hop 0) and
 * return the first uuid that is a recorded checkpoint anchor — bounded by
 * the target turn's own human-turn boundary node (Codex review-round P1):
 * once the walk reaches a genuine human-turn node, it is checked (a
 * checkpoint CAN be keyed to the human turn itself) but the walk stops
 * there regardless of whether it matched — continuing past it would cross
 * into an EARLIER turn and could land on that turn's own checkpoint,
 * silently rewinding further back than the target turn ever asked for.
 * Guards against cycles/corrupted chains with both a hop cap and a visited
 * set.
 */
function nearestSnapshotAncestor(
	transcript: ParsedSessionTranscript,
	startUuid: string,
): string | undefined {
	const visited = new Set<string>();
	let current: string | undefined = startUuid;
	let hops = 0;
	while (current !== undefined && hops < MAX_ANCESTOR_HOPS && !visited.has(current)) {
		if (transcript.snapshotMessageIds.has(current)) return current;
		if (transcript.humanTurnBoundaryUuids.has(current)) {
			// Reached the target turn's own human-turn node without finding
			// a checkpoint anywhere from startUuid down to here — do not
			// continue into the previous turn.
			return undefined;
		}
		visited.add(current);
		current = transcript.parentByUuid.get(current);
		hops += 1;
	}
	return undefined;
}

export type RewindAnchorResolution =
	| { ok: true; uuid: string; source: "client_verified" | "reverse_lookup_verified" }
	| { ok: false; reason: "session_transcript_missing" | "anchor_unresolved" };

/**
 * SPEC-7 PR2 review-round fix: the uuid chat-panel.tsx captures live off the
 * SDK stream is not reliable enough to hand straight to `rewindFiles` (E1
 * probe: a plain-string-prompt turn's genuine human-turn frame never echoes
 * on the live stream at all, and when the turn used tools, the first "user"
 * frame actually seen is a synthetic tool-result frame — neither is
 * guaranteed to be a real checkpoint anchor). The session's persisted JSONL
 * transcript is the only authoritative record of which uuids the SDK
 * actually anchored a file-history checkpoint to, so every uuid this
 * resolves MUST be verified against it before ever reaching `rewindFiles`:
 *
 *   1. If the client-supplied `candidateUserMessageId` is itself a recorded
 *      checkpoint anchor, use it directly (the common case — no tool use in
 *      the turn, so the live-captured uuid happened to be genuine).
 *   2. Otherwise, walk the parent chain from `fallbackAssistantMessageId`
 *      (reliably echoed live per the E1 probe) up to the nearest ancestor
 *      that IS a recorded anchor — covers both the "assistant-keyed update
 *      snapshot" and "genuine human-turn snapshot several hops up" shapes
 *      observed in a real transcript. This walk is HARD-BOUNDED by the
 *      target turn's own human-turn node (Codex review-round P1): if that
 *      turn has no checkpoint of its own, the walk must fail rather than
 *      cross into an earlier turn and rewind further back than the user
 *      ever asked for — see `nearestSnapshotAncestor`.
 *   3. If neither resolves, fail closed — never guess.
 */
export function resolveRewindAnchorFromTranscript(
	transcript: ParsedSessionTranscript,
	args: { candidateUserMessageId?: string; fallbackAssistantMessageId?: string },
): RewindAnchorResolution {
	if (
		args.candidateUserMessageId &&
		transcript.snapshotMessageIds.has(args.candidateUserMessageId)
	) {
		return { ok: true, uuid: args.candidateUserMessageId, source: "client_verified" };
	}
	if (args.fallbackAssistantMessageId) {
		const resolved = nearestSnapshotAncestor(transcript, args.fallbackAssistantMessageId);
		if (resolved) {
			return { ok: true, uuid: resolved, source: "reverse_lookup_verified" };
		}
	}
	return { ok: false, reason: "anchor_unresolved" };
}

export type SessionTranscriptLoader = (sessionId: string) => Promise<string | undefined>;

/**
 * Locate `<sessionId>.jsonl` under `~/.claude/projects/*` by exact filename
 * rather than reproducing the CLI's project-path-to-directory-name scheme
 * (undocumented, transliteration-based, version-fragile) — session ids are
 * SDK-generated UUIDs, so a name collision across projects is not a
 * realistic concern. Mirrors the E1 probe's own lookup approach.
 */
export async function defaultLoadSessionTranscript(sessionId: string): Promise<string | undefined> {
	const projectsDir = join(homedir(), ".claude", "projects");
	let entries: string[];
	try {
		entries = await readdir(projectsDir);
	} catch {
		return undefined;
	}
	const targetName = `${sessionId}.jsonl`;
	for (const entry of entries) {
		const candidate = join(projectsDir, entry, targetName);
		try {
			return await readFile(candidate, "utf8");
		} catch {
			continue;
		}
	}
	return undefined;
}

export async function resolveVerifiedRewindAnchor(
	args: {
		agentSessionId: string;
		candidateUserMessageId?: string;
		fallbackAssistantMessageId?: string;
	},
	loadTranscript: SessionTranscriptLoader = defaultLoadSessionTranscript,
): Promise<RewindAnchorResolution> {
	const content = await loadTranscript(args.agentSessionId);
	if (content === undefined) {
		return { ok: false, reason: "session_transcript_missing" };
	}
	const transcript = parseSessionTranscript(content);
	return resolveRewindAnchorFromTranscript(transcript, args);
}
