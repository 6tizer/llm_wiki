import { describe, expect, it } from "vitest"
import { DEFAULT_AGENT_RESOURCE_CONFIG } from "@/lib/agent/agent-settings"
import { resolveConversationPermissionPolicy } from "./permission-policy-resolver"

describe("resolveConversationPermissionPolicy", () => {
  it("uses a conversation override before the global default", () => {
    expect(
      resolveConversationPermissionPolicy(
        { agentPermissionPolicyOverride: "restricted" },
        {
          ...DEFAULT_AGENT_RESOURCE_CONFIG,
          defaultPermissionPolicy: "bypassPermissions",
        },
      ),
    ).toEqual({ policy: "restricted", source: "conversation" })
  })

  it("falls back to the global default when no conversation override is set", () => {
    expect(
      resolveConversationPermissionPolicy(null, {
        ...DEFAULT_AGENT_RESOURCE_CONFIG,
        defaultPermissionPolicy: "bypassPermissions",
      }),
    ).toEqual({ policy: "bypassPermissions", source: "global" })
  })

  it("normalizes a persisted default override to inherit the global default", () => {
    expect(
      resolveConversationPermissionPolicy(
        { agentPermissionPolicyOverride: "default" },
        {
          ...DEFAULT_AGENT_RESOURCE_CONFIG,
          defaultPermissionPolicy: "restricted",
        },
      ),
    ).toEqual({ policy: "restricted", source: "global" })
  })

  it("uses the built-in default when neither layer is configured", () => {
    expect(
      resolveConversationPermissionPolicy(undefined, {
        defaultPermissionPolicy: undefined,
      }),
    ).toEqual({ policy: "default", source: "fallback" })
  })
})
