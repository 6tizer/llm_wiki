import type { Conversation } from "@/stores/chat-store"
import type { LlmConfig, ApiConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { AgentResourceConfig } from "@/lib/agent/agent-settings"
import type { AgentTransportOptions } from "@/lib/agent/agent-types"
import { API_SERVER_PORT } from "@/lib/api-server-constants"

function agentBaseUrl(config: LlmConfig): string | undefined {
  if (config.provider === "custom") return config.customEndpoint || undefined
  if (config.provider === "ollama") return config.ollamaUrl || undefined
  return undefined
}

function agentApiServerBaseUrl(): string {
  return `http://127.0.0.1:${API_SERVER_PORT}`
}

export function buildAgentTransportOptionsFromState({
  project,
  llmConfig,
  apiConfig,
  conversations,
  activeConversationId,
  resourceConfig,
  disallowedTools,
}: {
  project: WikiProject | null
  llmConfig: LlmConfig
  apiConfig: ApiConfig
  conversations: Conversation[]
  activeConversationId: string | null
  resourceConfig: AgentResourceConfig
  disallowedTools?: string[]
}): AgentTransportOptions | null {
  if (!project) return null
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const agentSessionId = activeConversation?.agentSessionId || undefined
  const forkSession = Boolean(agentSessionId) &&
    activeConversation?.agentForkSessionPending === true
  // SPEC-7 PR2 design point 5: resumeSessionAt only ever applies alongside
  // a pending fork — the "copy conversation" fork (forkAgentConversation in
  // chat-store.ts) legitimately sets agentForkSessionPending WITHOUT a
  // resumeSessionAt (it forks to a fresh continuation, no rewind target
  // involved), so the inverse (resumeSessionAt with no pending fork) is the
  // only truly inconsistent state worth flagging.
  const resumeSessionAt = forkSession ? activeConversation?.agentResumeSessionAt : undefined
  if (!forkSession && activeConversation?.agentResumeSessionAt) {
    console.warn(
      "[agent-transport-options] agentResumeSessionAt set without a pending fork — ignoring",
    )
  }

  return {
    cwd: project.path,
    projectId: project.id,
    projectPath: project.path,
    model: llmConfig.model || undefined,
    apiKey: llmConfig.apiKey || undefined,
    baseUrl: agentBaseUrl(llmConfig),
    resume: agentSessionId,
    forkSession,
    resumeSessionAt,
    persistSession: true,
    permissionPolicy: "default",
    ...(disallowedTools ? { disallowedTools } : {}),
    enableWikiTools: true,
    enableWriteTools: true,
    enableFileCheckpointing: true,
    apiServerBaseUrl: agentApiServerBaseUrl(),
    apiToken: apiConfig.token || undefined,
    maxTurns: resourceConfig.maxTurns,
    maxFilesChanged: resourceConfig.maxFilesChanged,
    maxFilesChangedEnabled: resourceConfig.maxFilesChangedEnabled,
    maxWriteBytes: resourceConfig.maxWriteBytes,
  }
}
