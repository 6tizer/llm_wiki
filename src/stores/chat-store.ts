import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import type { ContentBlock } from "@/lib/llm-providers"
import type {
  AgentResourceLimitPayload,
  AgentWikiChangedPayload,
  AgentPermissionDecision,
  AgentPermissionRequestPayload,
  SDKContentBlock,
} from "@/lib/agent/agent-types"
import i18n from "@/i18n"
import type { AgentErrorKind } from "@/lib/agent/agent-run-state"
import { isCompactOnlyAgentMessage } from "@/lib/agent/agent-summary"
import type { ChatAgentMode, ChatAgentStep } from "@/lib/chat-agent"

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
  agentMode: ChatAgentMode
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
  agentResourceLimit?: AgentResourceLimitPayload
  wikiChanges?: AgentWikiChangeRecord[]
  toolCalls?: AgentToolCallRecord[]
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
  mode?: DisplayMessage["mode"]
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
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingContent: string
  mode: "chat" | "agent" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number
  activeAgentPermissionRequest: AgentPermissionRequestRecord | null
  queuedAgentPermissionRequests: AgentPermissionRequestRecord[]
  agentRewindTargets: Record<string, AgentRewindRequestRecord>
  activeAgentRewindRequest: AgentRewindRequestRecord | null
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
  setAgentToolCalls: (messageId: string, toolCalls: AgentToolCallRecord[]) => void
  updateAgentProgress: (messageId: string, event: AgentToolCallRecord) => void
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
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
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

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  mode: "chat",
  ingestSource: null,
  maxHistoryMessages: 10,
  activeAgentPermissionRequest: null,
  queuedAgentPermissionRequests: [],
  agentRewindTargets: {},
  activeAgentRewindRequest: null,
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
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
    }))
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
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
      activeAgentRewindRequest: null,
    }))
    return id
  },

  deleteConversation: (id) =>
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
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      const nextRewindLocks = { ...state.agentRewindLocks }
      delete nextRewindLocks[id]
      return {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
        agentRewindTargets: nextRewindTargets,
        agentRewindLocks: nextRewindLocks,
        activeAgentRewindRequest:
          state.activeAgentRewindRequest &&
          removedMessageIds.has(state.activeAgentRewindRequest.chatMessageId)
            ? null
            : state.activeAgentRewindRequest,
      }
    }),

  setActiveConversation: (id) =>
    set({ activeConversationId: id, activeAgentRewindRequest: null }),

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

      const images =
        role === "user" && (options?.mode === undefined || options.mode === "chat")
          ? options?.images?.filter(Boolean)
          : undefined
      const chatOptions =
        role === "user" && (options?.mode === undefined || options.mode === "chat")
          ? options?.chatOptions
          : undefined
      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        references: options?.references,
        mode: options?.mode,
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

  setConversations: (conversations) => set({ conversations }),

  setStreaming: (isStreaming) => set({ isStreaming }),

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
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: targetId,
        mode: "agent",
        agentSessionId: stats?.agentSessionId,
        costUsd: stats?.costUsd,
        inputTokens: stats?.inputTokens,
        outputTokens: stats?.outputTokens,
        durationMs: stats?.durationMs,
        numTurns: stats?.numTurns,
      }

      return {
        isStreaming: false,
        streamingContent: "",
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
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: messageId,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
        conversationId: activeConversationId,
        mode: "agent",
        agentSessionId: options?.agentSessionId,
      }

      return {
        isStreaming: true,
        streamingContent: "",
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
      return {
        isStreaming: false,
        streamingContent: "",
        messages: state.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content,
                mode: "agent" as const,
                agentSessionId: stats?.agentSessionId ?? m.agentSessionId,
                costUsd: stats?.costUsd,
                inputTokens: stats?.inputTokens,
                outputTokens: stats?.outputTokens,
                durationMs: stats?.durationMs,
                numTurns: stats?.numTurns,
                agentErrorKind: options?.agentErrorKind,
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

  setAgentToolCalls: (messageId, toolCalls) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, toolCalls } : m
      ),
    })),

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
      return {
        agentRewindTargets,
        activeAgentRewindRequest:
          !options?.keepActiveRequest &&
          state.activeAgentRewindRequest?.chatMessageId === messageId
            ? null
            : state.activeAgentRewindRequest,
      }
    }),

  requestAgentRewind: (messageId) =>
    set((state) => ({
      activeAgentRewindRequest: state.agentRewindTargets[messageId] ?? null,
    })),

  clearAgentRewindRequest: () => set({ activeAgentRewindRequest: null }),

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
      return {
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
        activeAgentRewindRequest:
          state.activeAgentRewindRequest &&
          removedIds.has(state.activeAgentRewindRequest.chatMessageId)
            ? null
            : state.activeAgentRewindRequest,
      }
    })
    return applied
  },

  requestAgentPermission: (payload, timeoutMs = DEFAULT_AGENT_PERMISSION_TIMEOUT_MS) =>
    new Promise<AgentPermissionDecision>((resolve) => {
      const now = Date.now()
      const request: AgentPermissionRequestRecord = {
        ...payload,
        receivedAt: now,
        expiresAt: 0,
        timeoutMs,
      }
      pendingAgentPermissionResolvers.set(request.requestId, { resolve, timer: null })

      if (!get().activeAgentPermissionRequest) {
        set({ activeAgentPermissionRequest: startAgentPermissionTimer(request) })
        return
      }

      set((state) => ({
        queuedAgentPermissionRequests: [
          ...state.queuedAgentPermissionRequests,
          request,
        ],
      }))
    }),

  resolveAgentPermission: (requestId, decision) => {
    const pending = pendingAgentPermissionResolvers.get(requestId)
    if (pending) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(decision)
    }

    const state = get()
    const activeMatches = state.activeAgentPermissionRequest?.requestId === requestId
    const remainingQueue = state.queuedAgentPermissionRequests.filter(
      (request) => request.requestId !== requestId
    )
    if (!activeMatches) {
      set({ queuedAgentPermissionRequests: remainingQueue })
      return
    }
    const [nextRequest, ...nextQueue] = remainingQueue
    set({
      activeAgentPermissionRequest: nextRequest
        ? startAgentPermissionTimer(nextRequest)
        : null,
      queuedAgentPermissionRequests: nextQueue,
    })
  },

  clearAgentPermissionRequests: (decision) => {
    const fallbackDecision =
      decision ??
      {
        behavior: "deny" as const,
        message: i18n.t("agent.permission.timeoutDenied"),
        interrupt: true,
        decisionClassification: "user_reject" as const,
      }

    for (const [requestId, pending] of pendingAgentPermissionResolvers) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(fallbackDecision)
    }
    set({
      activeAgentPermissionRequest: null,
      queuedAgentPermissionRequests: [],
    })
  },

  setMode: (mode) => set({ mode }),

  setIngestSource: (ingestSource) => set({ ingestSource }),

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
      const isNormalChat = m.role === "user" && (m.mode === undefined || m.mode === "chat")
      if (!isNormalChat || !m.images || m.images.length === 0) {
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
