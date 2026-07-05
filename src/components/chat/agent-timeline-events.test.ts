import { describe, expect, it } from "vitest"
import type { AgentProgressSummaryPayload } from "@/lib/agent/agent-types"
import {
  classifyAgentPermissionDecision,
  parseAgentProgressSummaryPayload,
} from "./agent-timeline-events"

describe("agent timeline event helpers", () => {
  it("classifies permission timeout before deny interrupt", () => {
    expect(
      classifyAgentPermissionDecision(
        {
          behavior: "deny",
          message: "Permission request timed out",
          interrupt: true,
        },
        "Permission request timed out",
      ),
    ).toBe("timeout")
  })

  it("classifies deny interrupt separately from plain deny", () => {
    expect(
      classifyAgentPermissionDecision(
        {
          behavior: "deny",
          message: "blocked",
          interrupt: true,
        },
        "Permission request timed out",
      ),
    ).toBe("deny_interrupt")

    expect(
      classifyAgentPermissionDecision(
        {
          behavior: "deny",
          message: "blocked",
        },
        "Permission request timed out",
      ),
    ).toBe("deny")
  })

  it("parses progress summary strings and object summaries", () => {
    expect(
      parseAgentProgressSummaryPayload(
        [
          "  Reading files  ",
          { summary: "Analyzing module", timestamp: "2026-07-05T01:02:03.000Z" },
          { text: "Checking references", timestamp: 42 },
        ],
        10,
      ),
    ).toEqual([
      { text: "Reading files", timestamp: 10 },
      { text: "Analyzing module", timestamp: Date.parse("2026-07-05T01:02:03.000Z") },
      { text: "Checking references", timestamp: 42 },
    ])
  })

  it("ignores malformed progress summary payload items", () => {
    const malformed = [
      "",
      { summary: "" },
      { text: 123 },
      null,
      42,
    ] as unknown as AgentProgressSummaryPayload

    expect(parseAgentProgressSummaryPayload(malformed, 10)).toEqual([])
  })
})
