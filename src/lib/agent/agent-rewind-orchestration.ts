import { saveChatHistory } from "@/lib/persist"
import { useChatStore, type AgentRewindRequestRecord } from "@/stores/chat-store"
import { cancelAgentChatRunJobByStreamId } from "./agent-chat-run-job"
import { computeAgentRewindGateDecision, type AgentRewindGateDecision } from "./agent-rewind-gate"
import { rewindAgentFiles, rewindAgentSession } from "./agent-transport"
import type { AgentRewindFilesPayload, AgentTransportOptions } from "./agent-types"

/**
 * Precise outcome of one rewind run — replaces the earlier `ok:true` +
 * `persistError?` shape (review-round P3-1), which conflated "fully
 * succeeded" with "succeeded but something after the point of no return
 * didn't stick" under one boolean, and could not express the stale-target
 * half-state at all (see `runAgentRewind`'s state_mismatch handling below).
 *
 * - "success": rewindFiles + the in-memory delayed-fork/truncation + the
 *   forced disk flush all completed.
 * - "persist_failed": rewindFiles + in-memory state both succeeded, but the
 *   disk flush failed (or there was no project to flush to at all) — files
 *   are reverted and the app's live state reflects it, but a crash/reload
 *   before a successful retry could lose the truncation/pending-fork
 *   (matrix A4).
 * - "state_mismatch": rewindFiles succeeded (files on disk ARE already
 *   reverted) but the target message no longer exists in this conversation
 *   (deleted/reset/switched away mid-rewind) — there is nothing to truncate
 *   or fork from. Must never be reported as a plain success: the files
 *   changed, but the visible conversation state doesn't reflect it at all.
 * - "gate_blocked": the fail-closed pre-flight gate refused to attempt
 *   rewindFiles at all (see `gate`).
 * - "rewind_failed": rewindFiles itself failed on every path attempted, or
 *   a precondition for attempting it at all was missing (no fork anchor, no
 *   transport options). No state was touched.
 */
export type RunAgentRewindStatus =
  | "success"
  | "persist_failed"
  | "state_mismatch"
  | "gate_blocked"
  | "rewind_failed"

export interface RunAgentRewindResult {
  status: RunAgentRewindStatus
  gate?: AgentRewindGateDecision
  payload?: AgentRewindFilesPayload
  /** Set for "persist_failed": why the disk flush didn't happen/succeed. */
  persistError?: string
}

/**
 * Runs the full SPEC-7 PR2 rewind orchestration for one target: fail-closed
 * gate check → fast path (`rewindAgentFiles`, active-stream) with fallback
 * to the resume-only slow path (`rewindAgentSession`) → apply the delayed
 * fork + timeline truncation → synchronous forced persistence flush
 * (bypassing the 2s auto-save debounce; design r2 P0 — flush must succeed
 * before the caller reports success to the user, matrix A4).
 *
 * `buildOptions` is supplied by the caller (needs project/llmConfig/
 * apiConfig/resourceConfig from wiki-store/agent-settings-store, which this
 * module intentionally does not import — keeps it framework-agnostic and
 * unit-testable without mounting those stores) and is only invoked if the
 * fast path is unavailable.
 *
 * Rewind fast/slow paths do not register agent_permission_request listeners:
 * `rewindAgentFiles` is a direct bridge call, and `rewindAgentSession` only
 * listens for rewind result/error/done events, so permission dialogs are
 * unreachable during rewind.
 */
export async function runAgentRewind(args: {
  target: AgentRewindRequestRecord
  projectPath: string | undefined
  buildOptions: () => AgentTransportOptions | null
}): Promise<RunAgentRewindResult> {
  const { target, projectPath, buildOptions } = args
  const store = useChatStore.getState()
  const conversation = store.conversations.find((c) => c.id === target.conversationId)

  const gate = computeAgentRewindGateDecision({
    target,
    conversation,
    messages: store.messages,
    isStreaming: store.isStreaming,
    streamingConversationId: store.streamingConversationId,
    rewindLocked: Boolean(store.agentRewindLocks[target.conversationId]),
  })
  if (!gate.allowed) {
    return { status: "gate_blocked", gate }
  }

  // A5-adjacent: the fork anchor (assistant uuid) is structurally required
  // by design point 3's dual-uuid contract (rewindFiles uses the user uuid,
  // the delayed fork uses the assistant uuid) — without it there is nothing
  // safe to resumeSessionAt, so this fails closed rather than truncating
  // the timeline with no way to actually fork away from the junk turn.
  if (!target.assistantMessageId) {
    return {
      status: "rewind_failed",
      payload: {
        ok: false,
        error: "Missing assistant checkpoint uuid for the delayed-fork anchor",
        unavailableReason: "missing_message_id",
      },
    }
  }

  store.setAgentRewindLock(target.conversationId, true)
  try {
    let payload: AgentRewindFilesPayload
    try {
      payload = await rewindAgentFiles(target.streamId, target.userMessageId)
    } catch {
      // Fast path unavailable (stream/process already gone — the common
      // #60 case) — fall through to the resume-only slow path below.
      payload = { ok: false, unavailableReason: "inactive_stream" }
    }

    if (!payload.ok && payload.unavailableReason !== "missing_message_id") {
      const options = buildOptions()
      if (!options || !target.agentSessionId) {
        return {
          status: "rewind_failed",
          payload: {
            ok: false,
            error: "Missing Agent transport options or session id to resume for rewind",
            unavailableReason: "missing_message_id",
          },
        }
      }
      payload = await rewindAgentSession(
        { ...options, resume: target.agentSessionId },
        target.userMessageId,
        target.assistantMessageId,
      )
    }

    if (!payload.ok) {
      return { status: "rewind_failed", payload }
    }

    // Files ARE reverted on disk from this point on — every branch below
    // must fail closed rather than silently report a plain "success" it
    // can't back up (matrix A4/A12-adjacent, review-round P2).
    const applied = store.applyAgentRewindSuccess(target.conversationId, {
      throughMessageId: target.chatMessageId,
      resumeSessionAt: target.assistantMessageId,
    })
    if (!applied) {
      // Stale target: the message we were rewinding to no longer exists in
      // this conversation (deleted/reset, or the conversation itself
      // changed shape mid-rewind). There is nothing to truncate/fork from,
      // so the visible conversation state cannot reflect the file revert
      // at all — this must surface as an explicit half-state, not success.
      return { status: "state_mismatch", payload }
    }
    cancelAgentChatRunJobByStreamId(target.streamId, "rewind")

    if (!projectPath) {
      return {
        status: "persist_failed",
        payload,
        persistError: "No active project to persist the rewound conversation to",
      }
    }

    try {
      const fresh = useChatStore.getState()
      await saveChatHistory(projectPath, fresh.conversations, fresh.messages)
    } catch (err) {
      return {
        status: "persist_failed",
        payload,
        persistError: err instanceof Error ? err.message : String(err),
      }
    }
    return { status: "success", payload }
  } finally {
    store.setAgentRewindLock(target.conversationId, false)
  }
}

/** Retry entry point for a failed forced-persistence flush (matrix A4):
 * re-runs the same synchronous save against the CURRENT store state (the
 * rewind's pending fields + truncated timeline are already applied in
 * memory — this only needs to get them onto disk). */
export async function retryAgentRewindPersistence(
  projectPath: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { conversations, messages } = useChatStore.getState()
    await saveChatHistory(projectPath, conversations, messages)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
