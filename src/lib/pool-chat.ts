import { Channel } from "@tauri-apps/api/core"
import {
  runtimeModelCallStream,
  runtimeModelCallStreamCancel,
  runtimeProfileList,
  runtimeProfilePoolClaim,
  runtimeProfilePoolList,
  runtimeProfilePoolRelease,
  type RuntimeProfileRecord,
} from "@/commands/runtime-db"
import type { LlmConfig } from "@/stores/wiki-store"
import { getProviderConfig, type ChatMessage, type RequestOverrides } from "@/lib/llm-providers"
import { parseLines, streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "@/lib/reasoning-detector"
import { syntheticLlmConfig } from "@/lib/profile-llm-config"

export type ModelCallTaskFamily = "chat" | "ingest" | "synthesis" | "review" | "vision"

const MODEL_CALL_PROFILE_CLAIM_TTL_MS = 1_200_000
const PROFILE_CLAIM_INACTIVE_PREFIX = "claim-inactive:"
const PROFILE_PROBE_CAPABILITY_VERSION = "profile-probe.v1"
const MODEL_CALL_CAPABLE_STATUSES = new Set(["supported", "limited"])
const CHAT_STREAM_CONTEXT_BUDGET = 128_000
const textEncoder = new TextEncoder()

interface ClaimedModelCallProfile {
  claimId: string
  profile: RuntimeProfileRecord
}

interface StreamEvent {
  type?: unknown
  data?: unknown
  message?: unknown
  status?: unknown
}

class PoolStreamError extends Error {
  status?: number
  retryAfterMs?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = "PoolStreamError"
    this.status = status
    this.retryAfterMs = retryAfterMsFromMessage(message)
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === null) return "null error thrown"
  if (err === undefined) return "undefined error thrown"
  return String(err)
}

function isRuntimeDisabledError(err: unknown): boolean {
  const message = errorMessage(err)
  return message.startsWith("runtime-disabled:")
    || message === "window is not defined"
    || message.includes("__TAURI__")
    || message.includes("runtimeProfilePoolList is not a function")
    || message.includes("runtimeProfileList is not a function")
}

function profileUnavailable(message: string): Error {
  return new Error(`profile-unavailable: ${message}`)
}

function warnPoolFallback(taskFamily: ModelCallTaskFamily) {
  console.warn(
    `[pool-chat] falling back to legacy streamChat for taskFamily=${taskFamily}: pool disabled/no candidates`,
  )
}

function retryAfterMsFromMessage(message: string): number | undefined {
  const match = /retryAfterMs=(\d+)/.exec(message)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

function profileSupportsModelCall(profile: RuntimeProfileRecord): boolean {
  if (profile.capabilityVersion !== PROFILE_PROBE_CAPABILITY_VERSION) return false
  if (!MODEL_CALL_CAPABLE_STATUSES.has(profile.capabilityStatus)) return false
  try {
    const capabilityJson = JSON.parse(profile.capabilityJson)
    return capabilityJson?.modelCallSupported === true
  } catch {
    return false
  }
}

export function hasModelCallProfileCandidate(
  profile: RuntimeProfileRecord,
  taskFamily: ModelCallTaskFamily,
): boolean {
  return profile.enabled
    && profile.kind === "model-call"
    && profile.taskFamilies.includes(taskFamily)
    && profileSupportsModelCall(profile)
}

export async function claimModelCallProfileForFamily(
  taskFamily: ModelCallTaskFamily,
  holder: string,
): Promise<ClaimedModelCallProfile | null> {
  if (
    typeof window !== "undefined" &&
    !("__TAURI_INTERNALS__" in globalThis)
  ) {
    return null
  }
  let pool
  try {
    pool = await runtimeProfilePoolList({
      kind: "model-call",
      taskFamily,
    })
  } catch (err) {
    if (isRuntimeDisabledError(err)) return null
    throw profileUnavailable(errorMessage(err))
  }
  if (!pool.enabled) {
    warnPoolFallback(taskFamily)
    return null
  }
  if (pool.status !== "healthy") {
    throw profileUnavailable(`profile pool is ${pool.status}`)
  }

  let profiles
  try {
    profiles = await runtimeProfileList()
  } catch (err) {
    if (isRuntimeDisabledError(err)) return null
    throw profileUnavailable(errorMessage(err))
  }
  if (!profiles.enabled) {
    warnPoolFallback(taskFamily)
    return null
  }
  if (profiles.status !== "healthy") {
    throw profileUnavailable(`profile list is ${profiles.status}`)
  }
  const candidates = profiles.profiles.filter((profile) =>
    hasModelCallProfileCandidate(profile, taskFamily)
  )
  if (candidates.length === 0) {
    warnPoolFallback(taskFamily)
    return null
  }

  let claim
  try {
    claim = await runtimeProfilePoolClaim({
      kind: "model-call",
      taskFamily,
      holder,
      ttlMs: MODEL_CALL_PROFILE_CLAIM_TTL_MS,
    })
  } catch (err) {
    if (isRuntimeDisabledError(err)) return null
    throw profileUnavailable(errorMessage(err))
  }

  const profile = profiles.profiles.find((item) => item.profileId === claim.profileId)
  if (!profile) {
    try {
      await runtimeProfilePoolRelease({
        claimId: claim.claimId,
        outcome: "error",
        error: "claimed profile is not present in profile list",
      })
    } catch {
      // Best-effort cleanup only; preserve the actionable claim resolution error.
    }
    throw profileUnavailable("claimed profile is not present in profile list")
  }
  return { claimId: claim.claimId, profile }
}

function streamIdFor(taskFamily: ModelCallTaskFamily): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${taskFamily}:${crypto.randomUUID()}`
  }
  return `${taskFamily}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
}

function flushLine(
  line: string,
  providerConfig: ReturnType<typeof getProviderConfig>,
  callbacks: StreamCallbacks,
  recordToken: (token: string) => void,
): number {
  const trimmed = line.trim()
  if (!trimmed) return 0
  const reasoningChars = countReasoningCharsInLine(trimmed)
  for (const part of extractReasoningTextFromLine(trimmed)) {
    callbacks.onReasoningToken?.(part)
  }
  const token = providerConfig.parseStream(trimmed)
  if (token !== null) recordToken(token)
  return reasoningChars
}

export async function streamChatViaPool(
  claim: ClaimedModelCallProfile,
  taskFamily: ModelCallTaskFamily,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  // Chat streams do not use ingest's source single-shot character budget; keep the prior model context default explicit.
  const config = syntheticLlmConfig(claim.profile, CHAT_STREAM_CONTEXT_BUDGET)
  const providerConfig = getProviderConfig(config)
  const streamId = streamIdFor(taskFamily)
  const onEvent = new Channel<StreamEvent>()
  let lineBuffer = ""
  let settled = false
  let contentCharsEmitted = 0
  let reasoningCharsObserved = 0

  const recordToken = (token: string) => {
    contentCharsEmitted += token.length
    callbacks.onToken(token)
  }
  const finishDone = () => {
    if (settled) return
    settled = true
    callbacks.onDone()
  }
  const finishError = (err: Error) => {
    if (settled) return
    settled = true
    callbacks.onError(err)
  }
  const flushRemaining = () => {
    if (!lineBuffer.trim()) return
    reasoningCharsObserved += flushLine(lineBuffer, providerConfig, callbacks, recordToken)
    lineBuffer = ""
  }

  onEvent.onmessage = (event) => {
    if (settled) return
    try {
      if (event.type === "chunk" && typeof event.data === "string") {
        const [lines, remaining] = parseLines(textEncoder.encode(event.data), lineBuffer)
        lineBuffer = remaining
        for (const line of lines) {
          reasoningCharsObserved += flushLine(line, providerConfig, callbacks, recordToken)
        }
        return
      }
      if (event.type === "done") {
        flushRemaining()
        if (contentCharsEmitted === 0 && reasoningCharsObserved >= 200) {
          finishError(new Error(
            `Model produced ${reasoningCharsObserved.toLocaleString()} characters of reasoning / chain-of-thought, but no actual response content. ` +
            `This usually means the endpoint hit a thinking-token limit, the model didn't transition from thinking to answering, ` +
            `or the endpoint is misbehaving (the official Anthropic / OpenAI APIs don't have this issue). ` +
            `Try a shorter input, increase max_tokens, or switch to a different model in Settings.`,
          ))
          return
        }
        finishDone()
        return
      }
      if (event.type === "error") {
        const message = typeof event.message === "string"
          ? event.message
          : "model-call-stream-failed: request failed"
        const status = typeof event.status === "number" ? event.status : undefined
        finishError(new PoolStreamError(message, status))
      }
    } catch (err) {
      finishError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  const cancel = () => {
    void runtimeModelCallStreamCancel(streamId).catch((err) => {
      console.warn("[pool-chat] failed to cancel model-call stream:", err)
    })
    finishDone()
  }
  if (signal?.aborted) {
    cancel()
    return
  }
  signal?.addEventListener("abort", cancel, { once: true })

  try {
    await runtimeModelCallStream({
      streamId,
      claimId: claim.claimId,
      provider: claim.profile.providerId,
      apiMode: claim.profile.apiMode,
      model: claim.profile.modelId,
      body: providerConfig.buildBody(messages, requestOverrides),
    }, onEvent)
    if (!settled) finishDone()
  } catch (err) {
    if (signal?.aborted) {
      finishDone()
      return
    }
    finishError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

function releaseOutcomeForError(err: Error | null): {
  outcome: "success" | "rate-limited" | "error"
  retryAfterMs?: number
  error?: string
} {
  if (!err) return { outcome: "success" }
  if (err instanceof PoolStreamError && err.status === 429) {
    return { outcome: "rate-limited", retryAfterMs: err.retryAfterMs, error: err.message }
  }
  return { outcome: "error", error: err.message }
}

export async function streamChatRouted(
  taskFamily: ModelCallTaskFamily,
  llmConfig: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
  holder = `${taskFamily}:${Date.now().toString(36)}`,
): Promise<void> {
  const claim = await claimModelCallProfileForFamily(taskFamily, holder)
  if (!claim) {
    return streamChat(llmConfig, messages, callbacks, signal, requestOverrides)
  }

  let streamError: Error | null = null
  const wrappedCallbacks: StreamCallbacks = {
    ...callbacks,
    onError: (err) => {
      streamError = err
      callbacks.onError(err)
    },
  }

  try {
    await streamChatViaPool(claim, taskFamily, messages, wrappedCallbacks, signal, requestOverrides)
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err))
    callbacks.onError(streamError)
  } finally {
    const release = releaseOutcomeForError(streamError)
    try {
      await runtimeProfilePoolRelease({
        claimId: claim.claimId,
        outcome: release.outcome,
        retryAfterMs: release.retryAfterMs,
        error: release.error,
      })
    } catch (err) {
      if (!errorMessage(err).startsWith(PROFILE_CLAIM_INACTIVE_PREFIX)) {
        console.warn("[pool-chat] failed to release profile claim:", err)
      }
    }
  }
}
