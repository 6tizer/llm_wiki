import { saveChatHistory } from "@/lib/persist"
import { useChatStore, type AgentRewindRequestRecord } from "@/stores/chat-store"
import { computeAgentRewindGateDecision, type AgentRewindGateDecision } from "./agent-rewind-gate"
import { rewindAgentFiles, rewindAgentSession } from "./agent-transport"
import type { AgentRewindFilesPayload, AgentTransportOptions } from "./agent-types"

export interface RunAgentRewindResult {
  ok: boolean
  gate?: AgentRewindGateDecision
  payload?: AgentRewindFilesPayload
  /** Rewind + fork-pending succeeded, but the forced persistence flush
   * (design r2 P0) failed — files are reverted and the pending state is in
   * memory, but a crash/reload before the next successful flush could lose
   * the truncation/pending-fork (matrix A4). The caller should offer retry. */
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
    rewindLocked: Boolean(store.agentRewindLocks[target.conversationId]),
  })
  if (!gate.allowed) {
    return { ok: false, gate }
  }

  // A5-adjacent: the fork anchor (assistant uuid) is structurally required
  // by design point 3's dual-uuid contract (rewindFiles uses the user uuid,
  // the delayed fork uses the assistant uuid) — without it there is nothing
  // safe to resumeSessionAt, so this fails closed rather than truncating
  // the timeline with no way to actually fork away from the junk turn.
  if (!target.assistantMessageId) {
    return {
      ok: false,
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
          ok: false,
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
      )
    }

    if (!payload.ok) {
      return { ok: false, payload }
    }

    const applied = store.applyAgentRewindSuccess(target.conversationId, {
      throughMessageId: target.chatMessageId,
      resumeSessionAt: target.assistantMessageId,
    })
    if (!applied || !projectPath) {
      return { ok: true, payload }
    }

    try {
      const fresh = useChatStore.getState()
      await saveChatHistory(projectPath, fresh.conversations, fresh.messages)
    } catch (err) {
      return {
        ok: true,
        payload,
        persistError: err instanceof Error ? err.message : String(err),
      }
    }
    return { ok: true, payload }
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
