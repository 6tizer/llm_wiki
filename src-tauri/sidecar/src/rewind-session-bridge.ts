import type { QueryControl, QueryFn, QueryInput } from "./core.js";
import { applyAgentProfileEnv } from "./core.js";
import { resolveVerifiedRewindAnchor, type SessionTranscriptLoader } from "./rewind-anchor.js";
import type { AgentMessage, RewindSessionRequest, RewindSessionUnavailableReason } from "./types.js";

interface RewindSessionBridgeDeps {
	request: RewindSessionRequest;
	queryFn: QueryFn;
	activeQueries: Map<string, AbortController>;
	send: (msg: AgentMessage) => void;
	env?: NodeJS.ProcessEnv;
	error?: (...args: unknown[]) => void;
	onSettled?: () => void;
	/** Test-only override for INIT_WAIT_TIMEOUT_MS (A13's transport-not-ready path). */
	initTimeoutMs?: number;
	/** Test-only override for the JSONL transcript loader (rewind-anchor.ts). */
	loadTranscript?: SessionTranscriptLoader;
}

// The resumed one-shot Query must announce its session before rewindFiles
// can be trusted (matrix A1/A13): a `system`/`init` message that never
// arrives (dead sidecar, unreachable endpoint) must fail closed rather than
// hang the rewind dialog forever.
const INIT_WAIT_TIMEOUT_MS = 20_000;

interface SdkInitMessage {
	type: "system";
	subtype: "init";
	session_id?: string;
}

function isInitMessage(message: unknown): message is SdkInitMessage {
	const candidate = message as { type?: unknown; subtype?: unknown };
	return candidate?.type === "system" && candidate?.subtype === "init";
}

function sendRewindSessionResult(
	send: (msg: AgentMessage) => void,
	streamId: string,
	data: {
		ok: boolean;
		error?: string;
		unavailableReason?: RewindSessionUnavailableReason;
		result?: unknown;
	},
): void {
	send({ streamId, type: "rewind_session", data });
}

/**
 * Handle a `rewind_session` request: a resume-only, one-shot rewind that
 * does not require the original turn's stream to still be running (fixes
 * #60's root cause — `core.ts`'s `finally` unconditionally drops
 * `activeSdkQueries` when a stream ends, and the sidecar process may have
 * already exited by the time the user opens the rewind dialog).
 *
 * Hard constraints from the E1/E2 probe (pr2-rewind-investigation.md) and
 * the design-r3 adversarial matrix (pr2-adversarial-matrix.md):
 *   - The resume prompt must be a real minimal string ("OK"), never an
 *     empty/never-yielding streaming input — that reattaches into a BRAND
 *     NEW session that replays the original prompt instead of resuming.
 *   - Tools must be locked down two ways (A8): no MCP servers are ever
 *     passed here (so no wiki tools exist to call), AND built-in tools are
 *     explicitly disabled via `tools: []` + `allowedTools: []` — belt and
 *     suspenders against the model deciding to act on "OK".
 *   - `init.session_id` must match the requested session before calling
 *     `rewindFiles` (A1) — a mismatch means the CLI silently started a new
 *     session, and rewinding it would touch the wrong history.
 *   - `rewindFiles` must only be called once transport is ready (A13); the
 *     SDK reports "ProcessTransport is not ready for writing" otherwise.
 */
export async function handleRewindSessionRequest({
	request,
	queryFn,
	activeQueries,
	send,
	env: baseEnv = process.env,
	error = console.error,
	onSettled,
	initTimeoutMs = INIT_WAIT_TIMEOUT_MS,
	loadTranscript,
}: RewindSessionBridgeDeps): Promise<void> {
	const { streamId } = request;

	if (!request.rewindUserMessageId) {
		sendRewindSessionResult(send, streamId, {
			ok: false,
			error: "Missing SDK user message id",
			unavailableReason: "missing_message_id",
		});
		onSettled?.();
		return;
	}

	const env: Record<string, string | undefined> = { ...baseEnv };
	applyAgentProfileEnv(env, request);
	if (request.baseUrl) env.ANTHROPIC_BASE_URL = request.baseUrl;

	const abortController = new AbortController();
	activeQueries.set(streamId, abortController);

	let query: QueryControl | undefined;
	try {
		const options: QueryInput["options"] = {
			cwd: request.cwd,
			model: request.model,
			resume: request.agentSessionId,
			maxTurns: 1,
			persistSession: true,
			enableFileCheckpointing: true,
			// Two-layer no-tools lock (A8): no MCP servers are registered at
			// all (mcpServers omitted), and built-in tools are explicitly
			// disabled on top of that.
			tools: [],
			allowedTools: [],
			permissionMode: "bypassPermissions",
			abortController,
			env,
		};
		query = queryFn({ prompt: "OK", options });

		let initSessionId: string | undefined;
		const iterator = query[Symbol.asyncIterator]();
		const deadline = Date.now() + initTimeoutMs;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const next = await Promise.race([
				iterator.next(),
				new Promise<{ done: true; timedOut: true }>((resolve) => {
					setTimeout(() => resolve({ done: true, timedOut: true }), remaining);
				}),
			]);
			if ("timedOut" in next && next.timedOut) break;
			if (next.done) break;
			if (isInitMessage(next.value)) {
				initSessionId = next.value.session_id;
				break;
			}
		}

		if (initSessionId === undefined) {
			sendRewindSessionResult(send, streamId, {
				ok: false,
				error: "Timed out waiting for the resumed Agent session to become ready",
				unavailableReason: "transport_not_ready",
			});
			return;
		}
		if (initSessionId !== request.agentSessionId) {
			// A1: the CLI silently started a new session instead of resuming.
			// Abort immediately — rewinding the wrong session is worse than
			// refusing to rewind at all.
			error(
				"[sidecar] rewind_session: resumed session id mismatch",
				{ expected: request.agentSessionId, got: initSessionId },
			);
			sendRewindSessionResult(send, streamId, {
				ok: false,
				error: "Resumed Agent session id did not match the requested session",
				unavailableReason: "session_mismatch",
			});
			return;
		}

		if (typeof query.rewindFiles !== "function") {
			sendRewindSessionResult(send, streamId, {
				ok: false,
				error: "Resumed Agent query does not support file rewind",
				unavailableReason: "unsupported",
			});
			return;
		}

		// SPEC-7 PR2 review-round fix: never trust the client-supplied
		// rewindUserMessageId on its own — it was captured live off the SDK
		// stream (chat-panel.tsx), which the E1 probe proved unreliable
		// (plain-string-prompt human turns never echo live at all; tool-use
		// turns echo a synthetic tool-result "user" frame first). Verify
		// against the session's persisted JSONL transcript before ever
		// calling rewindFiles.
		const anchor = await resolveVerifiedRewindAnchor(
			{
				agentSessionId: request.agentSessionId,
				candidateUserMessageId: request.rewindUserMessageId,
				fallbackAssistantMessageId: request.fallbackAssistantMessageId,
			},
			loadTranscript,
		);
		if (!anchor.ok) {
			sendRewindSessionResult(send, streamId, {
				ok: false,
				error:
					anchor.reason === "session_transcript_missing"
						? "Could not locate the session's persisted transcript to verify the rewind anchor"
						: "Could not verify a safe rewind anchor for this session",
				unavailableReason: "missing_message_id",
			});
			return;
		}

		const result = await query.rewindFiles(anchor.uuid);
		sendRewindSessionResult(send, streamId, {
			ok: result.canRewind,
			result,
			error: result.error,
		});
	} catch (err) {
		error("[sidecar] rewind_session error:", err);
		sendRewindSessionResult(send, streamId, {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		// Never let the one-shot "OK" turn keep running/replying once we
		// have (or have failed to get) a rewind result — this is a
		// resume-only-for-rewind Query, not a real conversation turn.
		try {
			query?.close?.();
		} catch {
			// best-effort
		}
		activeQueries.delete(streamId);
		onSettled?.();
	}
}
