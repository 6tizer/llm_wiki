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
      agentProgressSummaries: true,
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
        defaultPermissionPolicy: "default",
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
        defaultPermissionPolicy: "default",
      },
    })

    expect(options?.maxFilesChangedEnabled).toBe(true)
  })

  it("uses conversation-level profile and permission policy overrides before project defaults", () => {
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
          agentProfileIdOverride: "profile-conversation",
          agentPermissionPolicyOverride: "restricted",
        },
      ],
      activeConversationId: "c1",
      resourceConfig: {
        ...DEFAULT_AGENT_RESOURCE_CONFIG,
        defaultPermissionPolicy: "bypassPermissions",
      },
    })

    expect(options?.agentProfileId).toBe("profile-conversation")
    expect(options?.permissionPolicy).toBe("restricted")
  })

  it("falls back to the project default permission policy when no conversation override is set", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [{ id: "c1", title: "Agent", createdAt: 1, updatedAt: 1 }],
      activeConversationId: "c1",
      resourceConfig: {
        ...DEFAULT_AGENT_RESOURCE_CONFIG,
        defaultPermissionPolicy: "bypassPermissions",
      },
    })

    expect(options?.permissionPolicy).toBe("bypassPermissions")
    expect(options?.agentProfileId).toBeUndefined()
  })

  it("treats a persisted default conversation override as inheriting the project default", () => {
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
          agentPermissionPolicyOverride: "default",
        },
      ],
      activeConversationId: "c1",
      resourceConfig: {
        ...DEFAULT_AGENT_RESOURCE_CONFIG,
        defaultPermissionPolicy: "restricted",
      },
    })

    expect(options?.permissionPolicy).toBe("restricted")
  })

  it("threads disallowed tools through to transport options", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [],
      activeConversationId: null,
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
      disallowedTools: ["WebSearch", "WebFetch"],
    })

    expect(options?.disallowedTools).toEqual(["WebSearch", "WebFetch"])
  })

  it("omits disallowed tools when none are requested", () => {
    const options = buildAgentTransportOptionsFromState({
      project: { id: "project-1", name: "Wiki", path: "/wiki" },
      llmConfig: baseLlmConfig,
      apiConfig,
      conversations: [],
      activeConversationId: null,
      resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
    })

    expect(options).not.toHaveProperty("disallowedTools")
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
