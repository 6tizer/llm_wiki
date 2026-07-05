import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentRewindRequestRecord, DisplayMessage } from "@/stores/chat-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  deleteFile: vi.fn<(path: string) => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  deleteFile: fsMocks.deleteFile,
}))

import { restoreAgentWikiSnapshots } from "./agent-wiki-snapshot-restore"

function target(overrides: Partial<AgentRewindRequestRecord> = {}): AgentRewindRequestRecord {
  return {
    chatMessageId: "m1",
    conversationId: "conv-1",
    streamId: "stream-1",
    agentSessionId: "session-1",
    userMessageId: "user-uuid-1",
    assistantMessageId: "assistant-uuid-1",
    requestedAt: 1,
    ...overrides,
  }
}

function msg(
  id: string,
  timestamp: number,
  wikiChanges?: DisplayMessage["wikiChanges"],
): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "",
    timestamp,
    conversationId: "conv-1",
    mode: "agent",
    wikiChanges,
  }
}

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({
    operation: "update",
    existedBefore: true,
    afterSha256: "after",
    timestamp: 1,
    ...entry,
  })
}

describe("restoreAgentWikiSnapshots", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset().mockResolvedValue(undefined)
    fsMocks.deleteFile.mockReset().mockResolvedValue(undefined)
  })

  it("restores the earliest before snapshot when the same file was written twice after the target", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({ seq: 1, path: "wiki/a.md", toolUseId: "tool-1", snapshotFile: "000001-a.md" }),
          line({ seq: 2, path: "wiki/a.md", toolUseId: "tool-2", snapshotFile: "000002-a.md" }),
        ].join("\n")
      }
      if (path.endsWith("000001-a.md")) return "before first write"
      if (path.endsWith("000002-a.md")) return "before second write"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{ path: "wiki/a.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true }]),
        msg("m2", 2, [{ path: "wiki/a.md", operation: "update", timestamp: 2, toolUseId: "tool-2", snapshotted: true }]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/a.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/a.md", "before first write")
  })

  it("deletes files created after the target", async () => {
    fsMocks.readFile.mockResolvedValue(
      line({
        seq: 1,
        path: "wiki/entities/new.md",
        operation: "create",
        existedBefore: false,
        toolUseId: "tool-1",
        snapshotFile: "000001-new.md",
      }),
    )

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{ path: "wiki/entities/new.md", operation: "create", timestamp: 1, toolUseId: "tool-1", snapshotted: true }]),
      ],
    })

    expect(result.ok).toBe(true)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/entities/new.md")
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("returns failures when a restore write fails", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({ seq: 1, path: "wiki/a.md", toolUseId: "tool-1", snapshotFile: "000001-a.md" })
      }
      return "before"
    })
    fsMocks.writeFile.mockRejectedValue(new Error("disk full"))

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{ path: "wiki/a.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true }]),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([{ path: "wiki/a.md", error: "disk full" }])
  })

  it("does not restore wiki writes before the target", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({ seq: 1, path: "wiki/before.md", toolUseId: "tool-before", snapshotFile: "000001-before.md" }),
          line({ seq: 2, path: "wiki/after.md", toolUseId: "tool-after", snapshotFile: "000002-after.md" }),
        ].join("\n")
      }
      if (path.endsWith("000002-after.md")) return "after target before"
      throw new Error(`over-restore read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target({ chatMessageId: "m1" }),
      messages: [
        msg("m0", 0, [{ path: "wiki/before.md", operation: "update", timestamp: 0, toolUseId: "tool-before", snapshotted: true }]),
        msg("m1", 1),
        msg("m2", 2, [{ path: "wiki/after.md", operation: "update", timestamp: 2, toolUseId: "tool-after", snapshotted: true }]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/after.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/after.md", "after target before")
    expect(fsMocks.writeFile).not.toHaveBeenCalledWith("/proj/wiki/before.md", expect.any(String))
  })
})
