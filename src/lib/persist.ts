import { writeFile, readFile, createDirectory } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import type { LintItem } from "@/stores/lint-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

async function ensureDir(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.llm-wiki`).catch(() => {})
  await createDirectory(`${projectPath}/.llm-wiki/chats`).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/review.json`, JSON.stringify(items, null, 2))
}

export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/review.json`)
    return JSON.parse(content) as ReviewItem[]
  } catch {
    return []
  }
}

export async function saveLintItems(projectPath: string, items: LintItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/lint.json`, JSON.stringify(items, null, 2))
}

export async function loadLintItems(projectPath: string): Promise<LintItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/lint.json`)
    return JSON.parse(content) as LintItem[]
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

/** Maximum age for keeping a persisted frontend Agent session reference. */
export const AGENT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Summary of a persisted Agent session reference cleanup pass. */
export interface AgentSessionCleanupResult {
  scanned: number
  cleaned: number
}

function hasValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isConversation(value: unknown): value is Conversation {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    hasValidTimestamp(value.createdAt) &&
    hasValidTimestamp(value.updatedAt)
}

function parseConversationList(value: unknown, source: string): Conversation[] | null {
  if (!Array.isArray(value)) return null

  const conversations: Conversation[] = []
  let skipped = 0
  value.forEach((item, index) => {
    if (isConversation(item)) {
      conversations.push(item)
      return
    }
    skipped += 1
    console.warn(`[persist] skipped malformed conversation at ${source}[${index}]`)
  })

  if (skipped > 0) {
    console.warn(`[persist] quarantined ${skipped} malformed conversation(s) from ${source}`)
  }
  return conversations
}

function isExpiredAgentSessionConversation(
  conversation: Conversation,
  cutoff: number,
): boolean {
  return Boolean(conversation.agentSessionId) &&
    hasValidTimestamp(conversation.updatedAt) &&
    conversation.updatedAt < cutoff
}

function countExpiredAgentSessionRefs(
  conversations: Conversation[],
  now: number,
): number {
  const cutoff = now - AGENT_SESSION_MAX_AGE_MS
  return conversations.filter((conversation) =>
    isExpiredAgentSessionConversation(conversation, cutoff)
  ).length
}

/** Remove expired frontend Agent session references without deleting conversations. */
export function cleanExpiredAgentSessionRefs(
  conversations: Conversation[],
  now: number = Date.now(),
): Conversation[] {
  const cutoff = now - AGENT_SESSION_MAX_AGE_MS
  return conversations.map((conversation) => {
    if (!isExpiredAgentSessionConversation(conversation, cutoff)) {
      return conversation
    }
    const {
      agentSessionId: _agentSessionId,
      agentForkSessionPending: _pending,
      ...cleaned
    } = conversation
    return cleaned
  })
}

/** Clean expired Agent session references from a project's conversations file. */
export async function cleanExpiredAgentSessions(
  projectPath: string,
  now: number = Date.now(),
): Promise<AgentSessionCleanupResult> {
  const pp = normalizePath(projectPath)
  try {
    const filePath = `${pp}/.llm-wiki/conversations.json`
    const content = await readFile(filePath)
    const parsed = JSON.parse(content) as unknown
    const conversations = parseConversationList(parsed, "conversations.json")
    if (conversations === null) {
      return { scanned: 0, cleaned: 0 }
    }
    const cleaned = countExpiredAgentSessionRefs(conversations, now)
    if (cleaned > 0) {
      await writeFile(
        filePath,
        JSON.stringify(cleanExpiredAgentSessionRefs(conversations, now), null, 2),
      )
    }
    return { scanned: conversations.length, cleaned }
  } catch {
    return { scanned: 0, cleaned: 0 }
  }
}

export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[]
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)

  // Save conversation list
  await writeFile(
    `${pp}/.llm-wiki/conversations.json`,
    JSON.stringify(conversations, null, 2)
  )

  // Save each conversation's messages separately
  const byConversation = new Map<string, DisplayMessage[]>()
  for (const msg of messages) {
    const list = byConversation.get(msg.conversationId) ?? []
    list.push(msg)
    byConversation.set(msg.conversationId, list)
  }

  for (const [convId, msgs] of byConversation) {
    // Keep last 100 messages per conversation
    const toSave = msgs.slice(-100)
    await writeFile(
      `${pp}/.llm-wiki/chats/${convId}.json`,
      JSON.stringify(toSave, null, 2)
    )
  }
}

export async function loadChatHistory(
  projectPath: string,
  now: number = Date.now(),
): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  try {
    // Try new format: separate files per conversation
    const convContent = await readFile(`${pp}/.llm-wiki/conversations.json`)
    const parsedConversations = parseConversationList(
      JSON.parse(convContent) as unknown,
      "conversations.json",
    )
    if (parsedConversations === null) {
      throw new Error("conversations.json is not an array")
    }
    const conversations = cleanExpiredAgentSessionRefs(
      parsedConversations,
      now,
    )

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      try {
        const msgContent = await readFile(`${pp}/.llm-wiki/chats/${conv.id}.json`)
        const msgs = JSON.parse(msgContent) as DisplayMessage[]
        allMessages.push(...msgs)
      } catch {
        // Conversation file missing, skip
      }
    }

    return { conversations, messages: allMessages }
  } catch {
    // Fall back to old format
    try {
      const content = await readFile(`${pp}/.llm-wiki/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        // Very old format: flat array
        const legacyMessages = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacyMessages[0]?.timestamp ?? Date.now(),
          updatedAt: legacyMessages[legacyMessages.length - 1]?.timestamp ?? Date.now(),
        }
        const migratedMessages = legacyMessages.map((m) => ({
          ...m,
          conversationId: "default",
        }))
        return { conversations: [defaultConv], messages: migratedMessages }
      }

      // Old combined format
      const data = parsed as PersistedChatData
      const conversations = parseConversationList(
        data.conversations,
        "chat-history.json.conversations",
      ) ?? []
      return {
        conversations: cleanExpiredAgentSessionRefs(conversations, now),
        messages: Array.isArray(data.messages) ? data.messages : [],
      }
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}
