import { describe, expect, it } from "vitest"
import { DEFAULT_AGENT_RESOURCE_CONFIG } from "@/lib/agent/agent-settings"
import { buildAgentTransportOptionsFromState } from "./agent-transport-options"

const baseLlmConfig = {
  provider: "anthropic" as const,
  apiKey: "agent-key",
  maxContextSize: 204800,
  model: "claude-sonnet-4-20250514",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  azureApiVersion: "2024-10-21",
}

const apiConfig = {
  enabled: true,
  allowUnauthenticated: false,
  mcpEnabled: false,
  token: "api-token",
}

describe("buildAgentTransportOptionsFromState", () => {
  it("includes default agent resource limits", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [{ id: "c1", title: "Agent", createdAt: 1, updatedAt: 1 }],
      activeConversationId: "c1",
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
    })

    expect(options).toMatchObject({
      maxTurns: 30,
      maxFilesChanged: 10,
      maxWriteBytes: 262144,
    })
  })

  it("uses project agent resource overrides", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [
        {
          id: "c1",
          title: "Agent",
          createdAt: 1,
          updatedAt: 1,
          agentSessionId: "session-1",
          agentForkSessionPending: true,
        },
      ],
      activeConversationId: "c1",
      resourceConfig: {
        maxTurns: 45,
        maxFilesChanged: 15,
        maxFilesChangedEnabled: false,
        maxWriteBytes: 512 * 1024,
      },
    })

    expect(options).toMatchObject({
      resume: "session-1",
      forkSession: true,
      maxTurns: 45,
      maxFilesChanged: 15,
      maxFilesChangedEnabled: false,
      maxWriteBytes: 512 * 1024,
    })
  })

  it("threads maxFilesChangedEnabled through to transport options when on", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [],
      activeConversationId: null,
      resourceConfig: {
        maxTurns: 30,
        maxFilesChanged: 10,
        maxFilesChangedEnabled: true,
        maxWriteBytes: 256 * 1024,
      },
    })

    expect(options?.maxFilesChangedEnabled).toBe(true)
  })

  it("does not fork without a resume session", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [
        {
          id: "c1",
          title: "Agent",
          createdAt: 1,
          updatedAt: 1,
          agentForkSessionPending: true,
        },
      ],
      activeConversationId: "c1",
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
    })

    expect(options).toMatchObject({
      resume: undefined,
      forkSession: false,
    })
  })

  it("applies resumeSessionAt only alongside a pending fork (SPEC-7 PR2)", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [
        {
          id: "c1",
          title: "Agent",
          createdAt: 1,
          updatedAt: 1,
          agentSessionId: "session-1",
          agentForkSessionPending: true,
          agentResumeSessionAt: "assistant-uuid-1",
        },
      ],
      activeConversationId: "c1",
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
    })

    expect(options).toMatchObject({
      resume: "session-1",
      forkSession: true,
      resumeSessionAt: "assistant-uuid-1",
    })
  })

  it("ignores an orphaned resumeSessionAt when no fork is pending", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [
        {
          id: "c1",
          title: "Agent",
          createdAt: 1,
          updatedAt: 1,
          agentSessionId: "session-1",
          agentResumeSessionAt: "assistant-uuid-1",
        },
      ],
      activeConversationId: "c1",
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
    })

    expect(options?.resumeSessionAt).toBeUndefined()
  })

  it("returns null without an active project", () => {
    expect(
      buildAgentTransportOptionsFromState({
        project: null,
        llmConfig: baseLlmConfig,
        apiConfig,
        conversations: [],
        activeConversationId: null,
        resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
      }),
    ).toBeNull()
  })
})
