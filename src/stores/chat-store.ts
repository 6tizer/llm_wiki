import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import type { ContentBlock } from "@/lib/llm-providers"
import type {
  AgentPermissionPolicy,
  AgentProfileResolvedPayload,
  AgentResourceLimitPayload,
  AgentWikiChangedPayload,
  AgentPermissionDecision,
  AgentPermissionRequestPayload,
  AgentRewindFilesPayload,
  SDKContentBlock,
} from "@/lib/agent/agent-types"
import i18n from "@/i18n"
import type { AgentErrorKind } from "@/lib/agent/agent-run-state"
import { isCompactOnlyAgentMessage } from "@/lib/agent/agent-summary"
import type { ChatAgentStep } from "@/lib/chat-agent"

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  agentSessionId?: string
  agentForkSessionPending?: boolean
  /**
   * Target assistant uuid for a delayed session-rewind fork (SPEC-7 PR2):
   * applied together with `agentForkSessionPending` on the NEXT send via
   * agent-transport-options.ts's builder. Always set/cleared together with
   * `agentForkSessionPending` by the rewind orchestration — never set alone.
   */
  agentResumeSessionAt?: string
  agentProfileIdOverride?: string
  agentPermissionPolicyOverride?: AgentPermissionPolicy
}

export interface MessageReference {
  title: string
  path: string
  kind?: "wiki" | "external"
  source?: string
  url?: string
  snippet?: string
}

/** Image attached to a normal Chat user message. */
export interface MessageImage {
  mediaType: string
  dataBase64: string
}

/** Normal Chat Router options captured with a user turn for regenerate. */
export interface ChatMessageOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
  mode?: "chat" | "agent" | "ingest"
  images?: MessageImage[]
  chatOptions?: ChatMessageOptions
  agentSteps?: ChatAgentStep[]
  agentSessionId?: string
  agentUserMessageId?: string
  agentAssistantMessageId?: string
  agentBlocks?: SDKContentBlock[]
  sessionCompact?: boolean
  agentErrorKind?: AgentErrorKind
  agentErrorDetail?: string
  agentResourceLimit?: AgentResourceLimitPayload
  agentRewindUnavailableReason?: AgentRewindFilesPayload["unavailableReason"]
  wikiChanges?: AgentWikiChangeRecord[]
  toolCalls?: AgentToolCallRecord[]
  progressSummaries?: AgentProgressSummaryRecord[]
  permissionEvents?: AgentPermissionEventRecord[]
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

/** Agent tool-call event snapshot persisted on an assistant message. */
export interface AgentToolCallRecord {
  toolName: string
  toolUseId?: string
  phase: "pre" | "post" | "failure" | "batch"
  ok?: boolean
  durationMs?: number
  inputPreview?: Record<string, unknown>
  error?: string
}

/** Lightweight Agent progress text persisted on an assistant message. */
export interface AgentProgressSummaryRecord {
  text: string
  timestamp: number
}

export type AgentPermissionEventDecision =
  | "allow_temporary"
  | "allow_permanent"
  | "deny"
  | "deny_interrupt"
  | "timeout"

/** Redacted Agent permission decision persisted on an assistant message. */
export interface AgentPermissionEventRecord {
  toolName: string
  decision: AgentPermissionEventDecision
  timestamp: number
  permissionPolicy?: AgentPermissionPolicy
}

/** Final per-message Agent run statistics emitted by the sidecar result event. */
export interface AgentStreamStats {
  agentSessionId?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

/** Wiki file change emitted during an Agent run and persisted with the message. */
export interface AgentWikiChangeRecord extends AgentWikiChangedPayload {
  timestamp: number
}

/** Runtime-only Agent permission request shown in the approval dialog. */
export interface AgentPermissionRequestRecord extends AgentPermissionRequestPayload {
  receivedAt: number
  expiresAt: number
  timeoutMs: number
}

/** Runtime-only rewind target; live stream ids are intentionally not persisted. */
export interface AgentRewindRequestRecord {
  chatMessageId: string
  /** Conversation this target belongs to — the rewind orchestration
   * addresses by this id, never by "the currently active conversation"
   * (SPEC-7 PR2 matrix A12: a project/conversation switch mid-rewind must
   * not write pending state to the wrong conversation). */
  conversationId: string
  streamId: string
  /** Agent session this target was captured against. The rewind
   * orchestration resumes THIS session, not necessarily the conversation's
   * current agentSessionId (which may have moved on past a fork — matrix
   * A9: a target from before a fork boundary must be gated off, not
   * silently resumed against the wrong/newer session). */
  agentSessionId?: string
  userMessageId: string
  assistantMessageId?: string
  requestedAt: number
}

interface AddMessageOptions {
  agentSessionId?: string
  references?: MessageReference[]
  images?: MessageImage[]
  chatOptions?: ChatMessageOptions
}

interface StartAgentStreamMessageOptions {
  agentSessionId?: string
}

interface AgentStreamMessagePatch {
  content?: string
  agentBlocks?: SDKContentBlock[]
  agentErrorKind?: AgentErrorKind
  agentResourceLimit?: AgentResourceLimitPayload
  agentRewindUnavailableReason?: AgentRewindFilesPayload["unavailableReason"]
  toolCalls?: AgentToolCallRecord[]
  agentUserMessageId?: string
  agentAssistantMessageId?: string
  wikiChanges?: AgentWikiChangeRecord[]
  sessionCompact?: boolean
}

interface AgentRewindablePatch {
  streamId?: string
  agentSessionId?: string
  userMessageId?: string
  assistantMessageId?: string
}

interface ClearAgentRewindableOptions {
  keepActiveRequest?: boolean
}

interface FinishAgentStreamMessageOptions {
  agentErrorKind?: AgentErrorKind
  agentErrorDetail?: string
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingConversationId: string | null
  streamingAgentMessageId: string | null
  streamingContent: string
  ingestSource: string | null
  activeRunModelByConversation: Record<string, string | null>
  activeRunProfileByConversation: Record<string, AgentProfileResolvedPayload | null>
  maxHistoryMessages: number
  activeAgentPermissionRequest: AgentPermissionRequestRecord | null
  queuedAgentPermissionRequests: AgentPermissionRequestRecord[]
  agentPermissionRequestsByConversation: Record<string, AgentPermissionRequestRecord[]>
  agentRewindTargets: Record<string, AgentRewindRequestRecord>
  activeAgentRewindRequest: AgentRewindRequestRecord | null
  agentRewindRequestsByConversation: Record<string, AgentRewindRequestRecord>
  /** Per-conversation rewind-in-progress lock (SPEC-7 PR2 matrix A6): a
   * global `isStreaming` flag can't express "conversation A is mid-rewind
   * while conversation B streams normally" — sends and rewinds within the
   * SAME conversation must mutually exclude each other. */
  agentRewindLocks: Record<string, boolean>

  // Conversation management
  createConversation: () => string
  forkAgentConversation: (sourceId: string) => string | null
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string, options?: AddMessageOptions) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (
    content: string,
    references?: MessageReference[],
    conversationId?: string,
    agentSteps?: ChatAgentStep[],
  ) => void
  finalizeAgentStream: (content: string, stats?: AgentStreamStats, conversationId?: string) => void
  startAgentStreamMessage: (options?: StartAgentStreamMessageOptions) => string | null
  updateAgentStreamMessage: (messageId: string, patch: AgentStreamMessagePatch) => void
  finishAgentStreamMessage: (
    messageId: string,
    content: string,
    stats?: AgentStreamStats,
    options?: FinishAgentStreamMessageOptions
  ) => void
  updateAgentProgress: (messageId: string, event: AgentToolCallRecord) => void
  appendAgentProgressSummary: (
    messageId: string,
    summary: AgentProgressSummaryRecord
  ) => void
  appendAgentPermissionEvent: (
    messageId: string,
    record: AgentPermissionEventRecord
  ) => void
  appendAgentWikiChange: (messageId: string, payload: AgentWikiChangedPayload) => void
  markAgentMessageRewindable: (messageId: string, payload: AgentRewindablePatch) => void
  clearAgentMessageRewindable: (
    messageId: string,
    options?: ClearAgentRewindableOptions
  ) => void
  requestAgentRewind: (messageId: string) => void
  clearAgentRewindRequest: () => void
  setAgentRewindLock: (conversationId: string, locked: boolean) => void
  /**
   * Applies a successful rewind's orchestration atomically: truncates the
   * conversation's timeline to (and including) `throughMessageId`, and sets
   * the delayed-fork pending fields so the NEXT send applies
   * `forkSession + resumeSessionAt` (SPEC-7 PR2 design point 5). Returns
   * false (no-op) if `throughMessageId` isn't found in `conversationId`'s
   * timeline.
   */
  applyAgentRewindSuccess: (
    conversationId: string,
    target: { throughMessageId: string; resumeSessionAt?: string }
  ) => boolean
  /** Queue an Agent permission request and resolve when the user decides or timeout denies it. */
  requestAgentPermission: (
    payload: AgentPermissionRequestPayload,
    timeoutMs?: number
  ) => Promise<AgentPermissionDecision>
  /** Resolve one pending Agent permission request and promote the next queued request. */
  resolveAgentPermission: (requestId: string, decision: AgentPermissionDecision) => void
  /** Deny and clear all active/queued Agent permission requests. */
  clearAgentPermissionRequests: (decision?: AgentPermissionDecision) => void
  /** Deny and clear pending Agent permission requests for one conversation. */
  clearAgentPermissionRequestsForConversation: (
    conversationId: string,
    decision?: AgentPermissionDecision
  ) => void
  setIngestSource: (path: string | null) => void
  setActiveRunModel: (conversationId: string, model: string | null) => void
  setActiveRunProfile: (
    conversationId: string,
    profile: AgentProfileResolvedPayload | null
  ) => void
  setConversationAgentProfileOverride: (
    conversationId: string,
    profileId: string | undefined
  ) => void
  setConversationAgentPermissionPolicyOverride: (
    conversationId: string,
    policy: AgentPermissionPolicy | undefined
  ) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}

function nextId(): string {
  return crypto.randomUUID()
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

const DEFAULT_AGENT_PERMISSION_TIMEOUT_MS = 60_000

const pendingAgentPermissionResolvers = new Map<
  string,
  {
    resolve: (decision: AgentPermissionDecision) => void
    timer: ReturnType<typeof setTimeout> | null
  }
>()

function defaultDenyPermissionDecision(message: string): AgentPermissionDecision {
  return {
    behavior: "deny",
    message,
    decisionClassification: "user_reject",
  }
}

function startAgentPermissionTimer(request: AgentPermissionRequestRecord): AgentPermissionRequestRecord {
  const pending = pendingAgentPermissionResolvers.get(request.requestId)
  if (pending?.timer) clearTimeout(pending.timer)
  const expiresAt = Date.now() + request.timeoutMs
  const activeRequest = { ...request, expiresAt }
  if (pending) {
    pending.timer = setTimeout(() => {
      useChatStore.getState().resolveAgentPermission(
        request.requestId,
        defaultDenyPermissionDecision(i18n.t("agent.permission.timeoutDenied"))
      )
    }, request.timeoutMs)
  }
  return activeRequest
}

function permissionPresentationFor(
  state: Pick<ChatState, "activeConversationId" | "agentPermissionRequestsByConversation">
): Pick<ChatState, "activeAgentPermissionRequest" | "queuedAgentPermissionRequests"> {
  const requests = state.activeConversationId
    ? state.agentPermissionRequestsByConversation[state.activeConversationId] ?? []
    : []
  return {
    activeAgentPermissionRequest: requests[0] ?? null,
    queuedAgentPermissionRequests: requests.slice(1),
  }
}

function rewindPresentationFor(
  state: Pick<ChatState, "activeConversationId" | "agentRewindRequestsByConversation">
): Pick<ChatState, "activeAgentRewindRequest"> {
  return {
    activeAgentRewindRequest: state.activeConversationId
      ? state.agentRewindRequestsByConversation[state.activeConversationId] ?? null
      : null,
  }
}

function withPresentations(
  state: ChatState,
  patch: Partial<ChatState>
): Partial<ChatState> {
  const nextState = { ...state, ...patch }
  return {
    ...patch,
    ...permissionPresentationFor(nextState),
    ...rewindPresentationFor(nextState),
  }
}

function fallbackPermissionDecision(decision?: AgentPermissionDecision): AgentPermissionDecision {
  return (
    decision ??
    {
      behavior: "deny" as const,
      message: i18n.t("agent.permission.timeoutDenied"),
      interrupt: true,
      decisionClassification: "user_reject" as const,
    }
  )
}

const CONVERSATION_AGENT_PERMISSION_POLICIES = new Set<AgentPermissionPolicy>([
  "default",
  "restricted",
  "bypassPermissions",
])

function normalizeConversationAgentPermissionPolicy(
  value: unknown
): AgentPermissionPolicy | undefined {
  return typeof value === "string" &&
    CONVERSATION_AGENT_PERMISSION_POLICIES.has(value as AgentPermissionPolicy)
    ? (value as AgentPermissionPolicy)
    : undefined
}

function normalizeConversation(conversation: Conversation): Conversation {
  const profileId =
    typeof conversation.agentProfileIdOverride === "string" &&
    conversation.agentProfileIdOverride.trim()
      ? conversation.agentProfileIdOverride.trim()
      : undefined
  const permissionPolicy = normalizeConversationAgentPermissionPolicy(
    conversation.agentPermissionPolicyOverride
  )
  const {
    agentProfileIdOverride: _profileOverride,
    agentPermissionPolicyOverride: _policyOverride,
    ...rest
  } = conversation
  return {
    ...rest,
    ...(profileId ? { agentProfileIdOverride: profileId } : {}),
    ...(permissionPolicy ? { agentPermissionPolicyOverride: permissionPolicy } : {}),
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingConversationId: null,
  streamingAgentMessageId: null,
  streamingContent: "",
  ingestSource: null,
  activeRunModelByConversation: {},
  activeRunProfileByConversation: {},
  maxHistoryMessages: 10,
  activeAgentPermissionRequest: null,
  queuedAgentPermissionRequests: [],
  // Fact source for permission queues. The active/queued fields above are
  // display projections for activeConversationId; write via this map only.
  agentPermissionRequestsByConversation: {},
  agentRewindTargets: {},
  activeAgentRewindRequest: null,
  // Fact source for per-conversation rewind dialogs. activeAgentRewindRequest
  // is only the activeConversationId projection; write via this map only.
  agentRewindRequestsByConversation: {},
  agentRewindLocks: {},

  createConversation: () => {
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: i18n.t("chat.newConversation"),
      createdAt: now,
      updatedAt: now,
    }
    set((state) =>
      withPresentations(state, {
        conversations: [newConversation, ...state.conversations],
        activeConversationId: id,
      })
    )
    return id
  },

  forkAgentConversation: (sourceId) => {
    const source = get().conversations.find((conversation) => conversation.id === sourceId)
    if (!source?.agentSessionId) return null
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: `${i18n.t("agent.session.forkPrefix")} ${source.title}`,
      createdAt: now,
      updatedAt: now,
      agentSessionId: source.agentSessionId,
      agentForkSessionPending: true,
    }
    set((state) =>
      withPresentations(state, {
        conversations: [newConversation, ...state.conversations],
        activeConversationId: id,
      })
    )
    return id
  },

  deleteConversation: (id) => {
    get().clearAgentPermissionRequestsForConversation(id)
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const removedMessageIds = new Set(
        state.messages
          .filter((m) => m.conversationId === id)
          .map((m) => m.id)
      )
      const nextRewindTargets = Object.fromEntries(
        Object.entries(state.agentRewindTargets).filter(
          ([messageId]) => !removedMessageIds.has(messageId)
        )
      )
      const nextPermissionRequests = { ...state.agentPermissionRequestsByConversation }
      delete nextPermissionRequests[id]
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      const nextRewindLocks = { ...state.agentRewindLocks }
      delete nextRewindLocks[id]
      const nextActiveRunModel = { ...state.activeRunModelByConversation }
      delete nextActiveRunModel[id]
      const nextActiveRunProfile = { ...state.activeRunProfileByConversation }
      delete nextActiveRunProfile[id]
      const nextRewindRequests = { ...state.agentRewindRequestsByConversation }
      delete nextRewindRequests[id]
      return withPresentations(state, {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
        agentRewindTargets: nextRewindTargets,
        agentRewindLocks: nextRewindLocks,
        activeRunModelByConversation: nextActiveRunModel,
        activeRunProfileByConversation: nextActiveRunProfile,
        agentPermissionRequestsByConversation: nextPermissionRequests,
        agentRewindRequestsByConversation: nextRewindRequests,
      })
    })
  },

  setActiveConversation: (id) =>
    set((state) =>
      withPresentations(state, {
        activeConversationId: id,
      })
    ),

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    })),

  addMessage: (role, content, options) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state

      const images = role === "user" ? options?.images?.filter(Boolean) : undefined
      const chatOptions = role === "user" ? options?.chatOptions : undefined
      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        references: options?.references,
        agentSessionId: options?.agentSessionId,
        ...(images && images.length > 0 ? { images } : {}),
        ...(chatOptions ? { chatOptions } : {}),
      }

      // Auto-set title from first user message (first 50 chars)
      const convMessages = state.messages.filter(
        (m) => m.conversationId === activeConversationId && m.role === "user"
      )
      const updatedConversations =
        role === "user" && convMessages.length === 0
          ? conversations.map((c) =>
              c.id === activeConversationId
                ? {
                    ...c,
                    title:
                      content.slice(0, 50) ||
                      (images && images.length > 0
                        ? i18n.t("chat.imageMessage")
                        : c.title),
                    updatedAt: Date.now(),
                  }
                : c
            )
          : conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, updatedAt: Date.now() }
                : c
            )

      return {
        messages: [...state.messages, newMessage],
        conversations: updatedConversations,
      }
    }),

  setMessages: (messages) => set({ messages }),

  setConversations: (conversations) =>
    set({ conversations: conversations.map(normalizeConversation) }),

  setStreaming: (isStreaming) =>
    set((state) => ({
      isStreaming,
      streamingConversationId: isStreaming ? state.activeConversationId : null,
      streamingAgentMessageId: isStreaming ? state.streamingAgentMessageId : null,
    })),

  appendStreamToken: (token) =>
    set((state) => ({
      streamingContent: state.streamingContent + token,
    })),

  finalizeStream: (content, references, conversationId, agentSteps) =>
    set((state) => {
      // P1-6: bind the finalized message to the conversation that owned
      // the stream when it STARTED, not the live activeConversationId at
      // onDone time. Switching conversations mid-stream previously
      // injected the assistant reply into the wrong conversation.
      const targetId = conversationId ?? state.activeConversationId
      const { conversations } = state
      if (!targetId) {
        return {
          isStreaming: false,
          streamingConversationId: null,
          streamingAgentMessageId: null,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: targetId,
        references,
        agentSteps,
      }

      return {
        isStreaming: false,
        streamingConversationId: null,
        streamingAgentMessageId: null,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === targetId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    }),

  finalizeAgentStream: (content, stats, conversationId) =>
    set((state) => {
      // P1-6: same binding fix as finalizeStream — use the conversation
      // that started the agent stream, not the live activeConversationId.
      const targetId = conversationId ?? state.activeConversationId
      const { conversations } = state
      if (!targetId) {
        return {
          isStreaming: false,
          streamingConversationId: null,
          streamingAgentMessageId: null,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: targetId,
        agentSessionId: stats?.agentSessionId,
        costUsd: stats?.costUsd,
        inputTokens: stats?.inputTokens,
        outputTokens: stats?.outputTokens,
        durationMs: stats?.durationMs,
        numTurns: stats?.numTurns,
      }

      return {
        isStreaming: false,
        streamingConversationId: null,
        streamingAgentMessageId: null,
        streamingContent: "",
        activeRunModelByConversation: {
          ...state.activeRunModelByConversation,
          [targetId]: null,
        },
        activeRunProfileByConversation: {
          ...state.activeRunProfileByConversation,
          [targetId]: null,
        },
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === targetId
            ? {
                ...c,
                agentSessionId: stats?.agentSessionId ?? c.agentSessionId,
                agentForkSessionPending: stats?.agentSessionId
                  ? undefined
                  : c.agentForkSessionPending,
                agentResumeSessionAt: stats?.agentSessionId
                  ? undefined
                  : c.agentResumeSessionAt,
                updatedAt: Date.now(),
              }
            : c
        ),
      }
    }),

  startAgentStreamMessage: (options) => {
    const messageId = nextId()
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingConversationId: null,
          streamingAgentMessageId: null,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: messageId,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
        conversationId: activeConversationId,
        agentSessionId: options?.agentSessionId,
      }

      return {
        isStreaming: true,
        streamingConversationId: activeConversationId,
        streamingAgentMessageId: messageId,
        streamingContent: "",
        activeRunModelByConversation: {
          ...state.activeRunModelByConversation,
          [activeConversationId]: null,
        },
        activeRunProfileByConversation: {
          ...state.activeRunProfileByConversation,
          [activeConversationId]: null,
        },
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    })
    return get().messages.some((message) => message.id === messageId) ? messageId : null
  },

  updateAgentStreamMessage: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, ...patch } : m
      ),
    })),

  finishAgentStreamMessage: (messageId, content, stats, options) =>
    set((state) => {
      // P1-6: bind conversation metadata updates to the conversation the
      // agent message belongs to (looked up by messageId), not the live
      // activeConversationId. The message itself is keyed by messageId so
      // its content always lands correctly, but the conversation-level
      // agentSessionId / agentForkSessionPending / updatedAt were
      // previously written to whatever conversation was active at finish
      // time — corrupting the wrong conversation on a mid-stream switch.
      const target = state.messages.find((m) => m.id === messageId)
      const targetConversationId = target?.conversationId ?? state.activeConversationId
      const finishesCurrentStream = state.streamingAgentMessageId
        ? state.streamingAgentMessageId === messageId
        : state.isStreaming
      return {
        isStreaming: finishesCurrentStream ? false : state.isStreaming,
        streamingConversationId: finishesCurrentStream ? null : state.streamingConversationId,
        streamingAgentMessageId: finishesCurrentStream ? null : state.streamingAgentMessageId,
        streamingContent: finishesCurrentStream ? "" : state.streamingContent,
        activeRunModelByConversation:
          targetConversationId && finishesCurrentStream
            ? {
                ...state.activeRunModelByConversation,
                [targetConversationId]: null,
              }
            : state.activeRunModelByConversation,
        activeRunProfileByConversation:
          targetConversationId && finishesCurrentStream
            ? {
                ...state.activeRunProfileByConversation,
                [targetConversationId]: null,
              }
            : state.activeRunProfileByConversation,
        messages: state.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content: options?.agentErrorKind ? "" : content,
                agentSessionId: stats?.agentSessionId ?? m.agentSessionId,
                costUsd: stats?.costUsd,
                inputTokens: stats?.inputTokens,
                outputTokens: stats?.outputTokens,
                durationMs: stats?.durationMs,
                numTurns: stats?.numTurns,
                agentErrorKind: options?.agentErrorKind,
                agentErrorDetail: options?.agentErrorDetail,
              }
            : m
        ),
        conversations: state.conversations.map((c) =>
          c.id === targetConversationId
            ? {
                ...c,
                agentSessionId: stats?.agentSessionId ?? c.agentSessionId,
                agentForkSessionPending: stats?.agentSessionId
                  ? undefined
                  : c.agentForkSessionPending,
                agentResumeSessionAt: stats?.agentSessionId
                  ? undefined
                  : c.agentResumeSessionAt,
                updatedAt: Date.now(),
              }
            : c
        ),
      }
    }),

  updateAgentProgress: (messageId, event) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m
        const toolCalls = m.toolCalls ?? []
        const normalizedEvent =
          event.phase === "failure" && event.ok === undefined
            ? { ...event, ok: false }
            : event
        const eventKey = normalizedEvent.toolUseId ?? normalizedEvent.toolName
        const idx = toolCalls.findIndex(
          (call) => (call.toolUseId ?? call.toolName) === eventKey
        )
        if (idx === -1) {
          return { ...m, toolCalls: [...toolCalls, normalizedEvent] }
        }
        const nextToolCalls = [...toolCalls]
        nextToolCalls[idx] = { ...nextToolCalls[idx], ...normalizedEvent }
        return { ...m, toolCalls: nextToolCalls }
      }),
    })),

  appendAgentProgressSummary: (messageId, summary) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              progressSummaries: [...(m.progressSummaries ?? []), summary],
            }
          : m
      ),
    })),

  appendAgentPermissionEvent: (messageId, record) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              permissionEvents: [...(m.permissionEvents ?? []), record],
            }
          : m
      ),
    })),

  appendAgentWikiChange: (messageId, payload) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              wikiChanges: [
                ...(m.wikiChanges ?? []),
                {
                  ...payload,
                  timestamp: Date.now(),
                },
              ],
            }
          : m
      ),
    })),

  markAgentMessageRewindable: (messageId, payload) =>
    set((state) => {
      const existingMessage = state.messages.find((m) => m.id === messageId)
      const userMessageId = payload.userMessageId ?? existingMessage?.agentUserMessageId
      const assistantMessageId =
        payload.assistantMessageId ?? existingMessage?.agentAssistantMessageId
      const nextMessages = state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              agentUserMessageId: userMessageId ?? m.agentUserMessageId,
              agentAssistantMessageId: assistantMessageId ?? m.agentAssistantMessageId,
            }
          : m
      )
      if (!payload.streamId || !userMessageId || !existingMessage) {
        return { messages: nextMessages }
      }
      const existingTarget = state.agentRewindTargets[messageId]
      const target: AgentRewindRequestRecord = {
        chatMessageId: messageId,
        conversationId: existingMessage.conversationId,
        streamId: payload.streamId,
        agentSessionId: payload.agentSessionId ?? existingTarget?.agentSessionId,
        userMessageId,
        assistantMessageId,
        requestedAt: Date.now(),
      }
      return {
        messages: nextMessages,
        agentRewindTargets: {
          ...state.agentRewindTargets,
          [messageId]: target,
        },
      }
    }),

  clearAgentMessageRewindable: (messageId, options) =>
    set((state) => {
      if (!state.agentRewindTargets[messageId]) return {}
      const agentRewindTargets = { ...state.agentRewindTargets }
      delete agentRewindTargets[messageId]
      const agentRewindRequestsByConversation = Object.fromEntries(
        Object.entries(state.agentRewindRequestsByConversation).filter(
          ([, request]) => request.chatMessageId !== messageId || options?.keepActiveRequest
        )
      )
      if (options?.keepActiveRequest) {
        return {
          agentRewindTargets,
          agentRewindRequestsByConversation,
          activeAgentRewindRequest: state.activeAgentRewindRequest,
        }
      }
      return withPresentations(state, {
        agentRewindTargets,
        agentRewindRequestsByConversation,
      })
    }),

  requestAgentRewind: (messageId) =>
    set((state) => {
      const request = state.agentRewindTargets[messageId]
      if (!request) {
        const nextRequests = { ...state.agentRewindRequestsByConversation }
        if (state.activeConversationId) delete nextRequests[state.activeConversationId]
        return withPresentations(state, {
          agentRewindRequestsByConversation: nextRequests,
        })
      }
      const nextRequests = {
        ...state.agentRewindRequestsByConversation,
        [request.conversationId]: request,
      }
      return withPresentations(state, {
        agentRewindRequestsByConversation: nextRequests,
      })
    }),

  clearAgentRewindRequest: () =>
    set((state) => {
      if (!state.activeConversationId) return { activeAgentRewindRequest: null }
      const nextRequests = { ...state.agentRewindRequestsByConversation }
      delete nextRequests[state.activeConversationId]
      return withPresentations(state, {
        agentRewindRequestsByConversation: nextRequests,
      })
    }),

  setAgentRewindLock: (conversationId, locked) =>
    set((state) => {
      if (!locked) {
        if (!(conversationId in state.agentRewindLocks)) return {}
        const agentRewindLocks = { ...state.agentRewindLocks }
        delete agentRewindLocks[conversationId]
        return { agentRewindLocks }
      }
      return {
        agentRewindLocks: { ...state.agentRewindLocks, [conversationId]: true },
      }
    }),

  applyAgentRewindSuccess: (conversationId, target) => {
    let applied = false
    set((state) => {
      const conversationMessages = state.messages.filter(
        (m) => m.conversationId === conversationId
      )
      const cutIndex = conversationMessages.findIndex(
        (m) => m.id === target.throughMessageId
      )
      if (cutIndex === -1) return {}
      applied = true
      const removedIds = new Set(
        conversationMessages.slice(cutIndex + 1).map((m) => m.id)
      )
      const keepIds = new Set(
        conversationMessages.slice(0, cutIndex + 1).map((m) => m.id)
      )
      const agentRewindTargets = Object.fromEntries(
        Object.entries(state.agentRewindTargets).filter(
          ([messageId]) => !removedIds.has(messageId)
        )
      )
      const agentRewindRequestsByConversation = { ...state.agentRewindRequestsByConversation }
      const activeRequest = agentRewindRequestsByConversation[conversationId]
      if (activeRequest && removedIds.has(activeRequest.chatMessageId)) {
        delete agentRewindRequestsByConversation[conversationId]
      }
      return withPresentations(state, {
        messages: state.messages.filter(
          (m) => m.conversationId !== conversationId || keepIds.has(m.id)
        ),
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                agentForkSessionPending: true,
                agentResumeSessionAt: target.resumeSessionAt,
                updatedAt: Date.now(),
              }
            : c
        ),
        agentRewindTargets,
        agentRewindRequestsByConversation,
      })
    })
    if (applied) {
      get().clearAgentPermissionRequestsForConversation(conversationId, {
        behavior: "deny",
        interrupt: true,
        message: i18n.t("agent.permission.stopped"),
        decisionClassification: "user_reject",
      })
    }
    return applied
  },

  requestAgentPermission: (payload, timeoutMs = DEFAULT_AGENT_PERMISSION_TIMEOUT_MS) =>
    new Promise<AgentPermissionDecision>((resolve) => {
      const now = Date.now()
      // Defensive bucket for malformed callers. chat-panel always supplies
      // conversationId; this bucket is never displayed and exits by timeout.
      const conversationId = payload.conversationId ?? get().activeConversationId ?? "__unknown__"
      const request: AgentPermissionRequestRecord = {
        ...payload,
        conversationId,
        receivedAt: now,
        expiresAt: 0,
        timeoutMs,
      }
      pendingAgentPermissionResolvers.set(request.requestId, { resolve, timer: null })
      set((state) => {
        const existingRequests =
          state.agentPermissionRequestsByConversation[conversationId] ?? []
        const queuedRequest = existingRequests.length === 0
          ? startAgentPermissionTimer(request)
          : request
        const nextByConversation = {
          ...state.agentPermissionRequestsByConversation,
          [conversationId]: [
            ...existingRequests,
            queuedRequest,
          ],
        }
        return withPresentations(state, {
          agentPermissionRequestsByConversation: nextByConversation,
        })
      })
    }),

  resolveAgentPermission: (requestId, decision) => {
    const pending = pendingAgentPermissionResolvers.get(requestId)
    if (pending) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(decision)
    }

    set((current) => {
      const nextByConversation = Object.fromEntries(
        Object.entries(current.agentPermissionRequestsByConversation)
          .map(([conversationId, requests]) => {
            const requestIndex = requests.findIndex(
              (request) => request.requestId === requestId
            )
            if (requestIndex === -1) return [conversationId, requests] as const
            const remaining = requests.filter(
              (request) => request.requestId !== requestId
            )
            if (requestIndex === 0 && remaining[0]) {
              return [
                conversationId,
                [startAgentPermissionTimer(remaining[0]), ...remaining.slice(1)],
              ] as const
            }
            return [conversationId, remaining] as const
          })
          .filter(([, requests]) => requests.length > 0)
      )
      return withPresentations(current, {
        agentPermissionRequestsByConversation: nextByConversation,
      })
    })
  },

  clearAgentPermissionRequests: (decision) => {
    const fallbackDecision = fallbackPermissionDecision(decision)

    for (const [requestId, pending] of pendingAgentPermissionResolvers) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(fallbackDecision)
    }
    set({
      activeAgentPermissionRequest: null,
      queuedAgentPermissionRequests: [],
      agentPermissionRequestsByConversation: {},
    })
  },

  clearAgentPermissionRequestsForConversation: (conversationId, decision) => {
    const fallbackDecision = fallbackPermissionDecision(decision)
    const requests = get().agentPermissionRequestsByConversation[conversationId] ?? []
    for (const request of requests) {
      const pending = pendingAgentPermissionResolvers.get(request.requestId)
      if (!pending) continue
      pendingAgentPermissionResolvers.delete(request.requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(fallbackDecision)
    }
    set((state) => {
      const nextByConversation = { ...state.agentPermissionRequestsByConversation }
      delete nextByConversation[conversationId]
      return withPresentations(state, {
        agentPermissionRequestsByConversation: nextByConversation,
      })
    })
  },

  setIngestSource: (ingestSource) => set({ ingestSource }),

  setActiveRunModel: (conversationId, model) =>
    set((state) => ({
      activeRunModelByConversation: {
        ...state.activeRunModelByConversation,
        [conversationId]: model,
      },
    })),

  setActiveRunProfile: (conversationId, profile) =>
    set((state) => ({
      activeRunProfileByConversation: {
        ...state.activeRunProfileByConversation,
        [conversationId]: profile,
      },
    })),

  setConversationAgentProfileOverride: (conversationId, profileId) =>
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? normalizeConversation({
              ...conversation,
              agentProfileIdOverride: profileId,
            })
          : conversation
      ),
    })),

  setConversationAgentPermissionPolicyOverride: (conversationId, policy) =>
    set((state) => ({
      conversations: state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? normalizeConversation({
              ...conversation,
              agentPermissionPolicyOverride: policy,
            })
          : conversation
      ),
    })),

  clearMessages: () =>
    set((state) => ({
      messages: state.messages.filter(
        (m) => m.conversationId !== state.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (maxHistoryMessages) => set({ maxHistoryMessages }),

  removeLastAssistantMessage: () =>
    set((state) => {
      const activeId = state.activeConversationId
      if (!activeId) return state
      const activeMessages = state.messages.filter((m) => m.conversationId === activeId)
      // Find last assistant message
      const lastAssistantIdx = [...activeMessages].reverse().findIndex((m) => m.role === "assistant")
      if (lastAssistantIdx === -1) return state
      const msgToRemove = activeMessages[activeMessages.length - 1 - lastAssistantIdx]
      return {
        messages: state.messages.filter((m) => m.id !== msgToRemove.id),
      }
    }),

  getActiveMessages: () => {
    const { messages, activeConversationId } = get()
    if (!activeConversationId) return []
    return messages.filter((m) => m.conversationId === activeConversationId)
  },
}))

export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !isCompactOnlyAgentMessage(m))
    .map((m) => {
      const canSendImages =
        m.role === "user" && (m.mode === undefined || m.mode === "chat")
      if (!canSendImages || !m.images || m.images.length === 0) {
        return {
          role: m.role,
          content: m.content,
        }
      }
      const textBlocks: ContentBlock[] = m.content.trim()
        ? [{ type: "text", text: m.content }]
        : []
      const blocks: ContentBlock[] = [
        ...textBlocks,
        ...m.images.map((img): ContentBlock => ({
          type: "image",
          mediaType: img.mediaType,
          dataBase64: img.dataBase64,
        })),
      ]
      return {
        role: m.role,
        content: blocks,
      }
    })
}
