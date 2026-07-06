import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentRewindRequestRecord, DisplayMessage } from "@/stores/chat-store"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, contents: string) => Promise<void>>(),
  deleteFile: vi.fn<(path: string) => Promise<void>>(),
}))

const AFTER_SHA256 = "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8"

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  deleteFile: fsMocks.deleteFile,
}))

import {
  parseManifestEntry,
  restoreAgentWikiSnapshots,
  restoreSingleAgentWikiSnapshot,
} from "./agent-wiki-snapshot-restore"

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
    afterSha256: AFTER_SHA256,
    timestamp: 1,
    ...entry,
  })
}

async function sha256Text(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

describe("restoreAgentWikiSnapshots", () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset().mockResolvedValue(undefined)
    fsMocks.deleteFile.mockReset().mockResolvedValue(undefined)
  })

  it("restores same-file entries in reverse order so each sha guard matches", async () => {
    let current = "after second write"
    const afterFirstSha256 = await sha256Text("after first write")
    const afterSecondSha256 = await sha256Text("after second write")
    const beforeFirstSha256 = await sha256Text("before first write")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({
            seq: 1,
            path: "wiki/a.md",
            toolUseId: "tool-1",
            snapshotFile: "000001-a.md",
            beforeSha256: beforeFirstSha256,
            afterSha256: afterFirstSha256,
          }),
          line({
            seq: 2,
            path: "wiki/a.md",
            toolUseId: "tool-2",
            snapshotFile: "000002-a.md",
            beforeSha256: afterFirstSha256,
            afterSha256: afterSecondSha256,
          }),
        ].join("\n")
      }
      if (path === "/proj/wiki/a.md") return current
      if (path.endsWith("000001-a.md")) return "before first write"
      if (path.endsWith("000002-a.md")) return "after first write"
      throw new Error(`unexpected read ${path}`)
    })
    fsMocks.writeFile.mockImplementation(async (_path, contents) => {
      current = contents
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
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(2)
    expect(fsMocks.writeFile).toHaveBeenNthCalledWith(1, "/proj/wiki/a.md", "after first write")
    expect(fsMocks.writeFile).toHaveBeenNthCalledWith(2, "/proj/wiki/a.md", "before first write")

    fsMocks.writeFile.mockClear()
    const retry = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{ path: "wiki/a.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true }]),
        msg("m2", 2, [{ path: "wiki/a.md", operation: "update", timestamp: 2, toolUseId: "tool-2", snapshotted: true }]),
      ],
    })

    expect(retry).toEqual({ ok: true, restoredPaths: [], failures: [] })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("restores every path for a batch toolUseId", async () => {
    const afterASha = await sha256Text("after a")
    const afterBSha = await sha256Text("after b")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({
            seq: 1,
            path: "wiki/a.md",
            toolUseId: "tool-batch",
            snapshotFile: "000001-a.md",
            afterSha256: afterASha,
          }),
          line({
            seq: 2,
            path: "wiki/b.md",
            toolUseId: "tool-batch",
            snapshotFile: "000002-b.md",
            afterSha256: afterBSha,
          }),
        ].join("\n")
      }
      if (path === "/proj/wiki/a.md") return "after a"
      if (path === "/proj/wiki/b.md") return "after b"
      if (path.endsWith("000001-a.md")) return "before a"
      if (path.endsWith("000002-b.md")) return "before b"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          { path: "wiki/a.md", operation: "update", timestamp: 1, toolUseId: "tool-batch", snapshotted: true },
          { path: "wiki/b.md", operation: "update", timestamp: 2, toolUseId: "tool-batch", snapshotted: true },
        ]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/a.md", "wiki/b.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/a.md", "before a")
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/b.md", "before b")
  })

  it("deletes files created after the target", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({
          seq: 1,
          path: "wiki/entities/new.md",
          operation: "create",
          existedBefore: false,
          toolUseId: "tool-1",
          snapshotFile: "000001-new.md",
        })
      }
      if (path === "/proj/wiki/entities/new.md") return "after"
      throw new Error(`unexpected read ${path}`)
    })

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

  it("parses delete manifest entries and restores deleted files from snapshots", async () => {
    const emptySha256 = await sha256Text("")
    const entryLine = line({
      seq: 1,
      path: "wiki/entities/deleted.md",
      operation: "delete",
      existedBefore: true,
      beforeSha256: await sha256Text("before delete"),
      afterSha256: emptySha256,
      toolUseId: "tool-delete",
      snapshotFile: "000001-deleted.md",
    })

    expect(parseManifestEntry(entryLine)).toMatchObject({
      operation: "delete",
      afterSha256: emptySha256,
    })

    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) return entryLine
      if (path === "/proj/wiki/entities/deleted.md") throw new Error("ENOENT: no such file")
      if (path.endsWith("000001-deleted.md")) return "before delete"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{
          path: "wiki/entities/deleted.md",
          operation: "delete",
          timestamp: 1,
          toolUseId: "tool-delete",
          snapshotted: true,
        }]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/entities/deleted.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/entities/deleted.md", "before delete")
  })

  it("blocks delete restore when the deleted path was recreated even with empty content", async () => {
    const emptySha256 = await sha256Text("")
    const entryLine = line({
      seq: 1,
      path: "wiki/entities/deleted.md",
      operation: "delete",
      existedBefore: true,
      beforeSha256: await sha256Text("before delete"),
      afterSha256: emptySha256,
      toolUseId: "tool-delete",
      snapshotFile: "000001-deleted.md",
    })

    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) return entryLine
      if (path === "/proj/wiki/entities/deleted.md") return ""
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{
          path: "wiki/entities/deleted.md",
          operation: "delete",
          timestamp: 1,
          toolUseId: "tool-delete",
          snapshotted: true,
        }]),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([{
      path: "wiki/entities/deleted.md",
      error: "文件已被后续修改，请用 rewind 或手动处理",
    }])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("rewinds create then delete on the same path as a no-op when the file is already absent", async () => {
    const createdSha256 = await sha256Text("created")
    const emptySha256 = await sha256Text("")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({
            seq: 1,
            path: "wiki/transient.md",
            operation: "create",
            existedBefore: false,
            afterSha256: createdSha256,
            toolUseId: "tool-create",
            snapshotFile: "000001-transient.md",
          }),
          line({
            seq: 2,
            path: "wiki/transient.md",
            operation: "delete",
            existedBefore: true,
            beforeSha256: createdSha256,
            afterSha256: emptySha256,
            toolUseId: "tool-delete",
            snapshotFile: "000002-transient.md",
          }),
        ].join("\n")
      }
      if (path === "/proj/wiki/transient.md") throw new Error("ENOENT: no such file")
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          { path: "wiki/transient.md", operation: "create", timestamp: 1, toolUseId: "tool-create", snapshotted: true },
          { path: "wiki/transient.md", operation: "delete", timestamp: 2, toolUseId: "tool-delete", snapshotted: true },
        ]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: [], failures: [] })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("rewinds delete then create on the same path by deleting replacement and restoring deleted content", async () => {
    let current: string | null = "replacement"
    const beforeSha256 = await sha256Text("before delete")
    const replacementSha256 = await sha256Text("replacement")
    const emptySha256 = await sha256Text("")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({
            seq: 1,
            path: "wiki/replaced.md",
            operation: "delete",
            existedBefore: true,
            beforeSha256,
            afterSha256: emptySha256,
            toolUseId: "tool-delete",
            snapshotFile: "000001-replaced.md",
          }),
          line({
            seq: 2,
            path: "wiki/replaced.md",
            operation: "create",
            existedBefore: false,
            afterSha256: replacementSha256,
            toolUseId: "tool-create",
            snapshotFile: "000002-replaced.md",
          }),
        ].join("\n")
      }
      if (path === "/proj/wiki/replaced.md") {
        if (current === null) throw new Error("ENOENT: no such file")
        return current
      }
      if (path.endsWith("000001-replaced.md")) return "before delete"
      throw new Error(`unexpected read ${path}`)
    })
    fsMocks.deleteFile.mockImplementation(async () => {
      current = null
    })
    fsMocks.writeFile.mockImplementation(async (_path, contents) => {
      current = contents
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          { path: "wiki/replaced.md", operation: "delete", timestamp: 1, toolUseId: "tool-delete", snapshotted: true },
          { path: "wiki/replaced.md", operation: "create", timestamp: 2, toolUseId: "tool-create", snapshotted: true },
        ]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/replaced.md"], failures: [] })
    expect(fsMocks.deleteFile).toHaveBeenCalledWith("/proj/wiki/replaced.md")
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/replaced.md", "before delete")
    expect(current).toBe("before delete")
  })

  it("returns failures when a restore write fails", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({ seq: 1, path: "wiki/a.md", toolUseId: "tool-1", snapshotFile: "000001-a.md" })
      }
      if (path === "/proj/wiki/a.md") return "after"
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
      if (path === "/proj/wiki/after.md") return "after"
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

  it("restores only non-reverted wiki changes from a mixed manifest", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({ seq: 1, path: "wiki/reverted.md", toolUseId: "tool-reverted", snapshotFile: "000001-reverted.md" }),
          line({ seq: 2, path: "wiki/keep.md", toolUseId: "tool-keep", snapshotFile: "000002-keep.md" }),
        ].join("\n")
      }
      if (path === "/proj/wiki/keep.md") return "after"
      if (path.endsWith("000002-keep.md")) return "before keep"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          {
            path: "wiki/reverted.md",
            operation: "update",
            timestamp: 1,
            toolUseId: "tool-reverted",
            snapshotted: true,
            reverted: true,
          },
          {
            path: "wiki/keep.md",
            operation: "update",
            timestamp: 2,
            toolUseId: "tool-keep",
            snapshotted: true,
          },
        ]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/keep.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/keep.md", "before keep")
    expect(fsMocks.writeFile).not.toHaveBeenCalledWith("/proj/wiki/reverted.md", expect.any(String))
  })

  it("restores one snapshotted agent write only when current content matches afterSha256", async () => {
    const afterSha256 = await sha256Text("after")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({
          seq: 1,
          path: "wiki/a.md",
          toolUseId: "tool-1",
          snapshotFile: "000001-a.md",
          afterSha256,
        })
      }
      if (path === "/proj/wiki/a.md") return "after"
      if (path.endsWith("000001-a.md")) return "before"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreSingleAgentWikiSnapshot({
      projectPath: "/proj",
      streamId: "stream-1",
      path: "wiki/a.md",
      toolUseId: "tool-1",
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/a.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/a.md", "before")
  })

  it("refuses one-write restore when the file changed after the agent write", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({
          seq: 1,
          path: "wiki/a.md",
          toolUseId: "tool-1",
          snapshotFile: "000001-a.md",
          afterSha256: await sha256Text("after"),
        })
      }
      if (path === "/proj/wiki/a.md") return "changed later"
      if (path.endsWith("000001-a.md")) return "before"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreSingleAgentWikiSnapshot({
      projectPath: "/proj",
      streamId: "stream-1",
      path: "wiki/a.md",
      toolUseId: "tool-1",
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error).toBe("文件已被后续修改，请用 rewind 或手动处理")
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("rejects unsafe manifest paths before restoring", async () => {
    fsMocks.readFile.mockResolvedValue(
      line({
        seq: 1,
        path: "../outside.md",
        toolUseId: "tool-1",
        snapshotFile: "000001-a.md",
      }),
    )

    const result = await restoreSingleAgentWikiSnapshot({
      projectPath: "/proj",
      streamId: "stream-1",
      path: "../outside.md",
      toolUseId: "tool-1",
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0]?.error).toBe("manifest entry has unsafe path")
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("skips reverted wiki changes during rewind snapshot restore", async () => {
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({ seq: 1, path: "wiki/a.md", toolUseId: "tool-1", snapshotFile: "000001-a.md" })
      }
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{
          path: "wiki/a.md",
          operation: "update",
          timestamp: 1,
          toolUseId: "tool-1",
          snapshotted: true,
          reverted: true,
        }]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: [], failures: [] })
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("is idempotent when retrying after a partial batch restore", async () => {
    const beforeSha256 = await sha256Text("before")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({
            seq: 1,
            path: "wiki/already.md",
            toolUseId: "tool-1",
            snapshotFile: "000001-already.md",
            beforeSha256,
          }),
          line({
            seq: 2,
            path: "wiki/pending.md",
            toolUseId: "tool-2",
            snapshotFile: "000002-pending.md",
            beforeSha256,
          }),
        ].join("\n")
      }
      if (path === "/proj/wiki/already.md") return "before"
      if (path === "/proj/wiki/pending.md") return "after"
      if (path.endsWith("000002-pending.md")) return "before"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          { path: "wiki/already.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true },
          { path: "wiki/pending.md", operation: "update", timestamp: 2, toolUseId: "tool-2", snapshotted: true },
        ]),
      ],
    })

    expect(result).toEqual({ ok: true, restoredPaths: ["wiki/pending.md"], failures: [] })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/pending.md", "before")
  })

  it("refuses an entry when current content is neither after nor before sha", async () => {
    const beforeSha256 = await sha256Text("before")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return line({
          seq: 1,
          path: "wiki/user.md",
          toolUseId: "tool-1",
          snapshotFile: "000001-user.md",
          beforeSha256,
        })
      }
      if (path === "/proj/wiki/user.md") return "user changed"
      if (path.endsWith("000001-user.md")) return "before"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [{ path: "wiki/user.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true }]),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([{ path: "wiki/user.md", error: "文件已被后续修改，请用 rewind 或手动处理" }])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("handles a mixed batch with restored, already-restored, missing-created, and refused entries", async () => {
    const beforeSha256 = await sha256Text("before")
    fsMocks.readFile.mockImplementation(async (path) => {
      if (path.endsWith("manifest.jsonl")) {
        return [
          line({ seq: 1, path: "wiki/restore.md", toolUseId: "tool-1", snapshotFile: "000001-restore.md", beforeSha256 }),
          line({ seq: 2, path: "wiki/already.md", toolUseId: "tool-2", snapshotFile: "000002-already.md", beforeSha256 }),
          line({ seq: 3, path: "wiki/new.md", operation: "create", existedBefore: false, toolUseId: "tool-3", snapshotFile: "000003-new.md" }),
          line({ seq: 4, path: "wiki/refuse.md", toolUseId: "tool-4", snapshotFile: "000004-refuse.md", beforeSha256 }),
        ].join("\n")
      }
      if (path === "/proj/wiki/restore.md") return "after"
      if (path === "/proj/wiki/already.md") return "before"
      if (path === "/proj/wiki/new.md") throw new Error("ENOENT: no such file")
      if (path === "/proj/wiki/refuse.md") return "user changed"
      if (path.endsWith("000001-restore.md")) return "before"
      throw new Error(`unexpected read ${path}`)
    })

    const result = await restoreAgentWikiSnapshots({
      projectPath: "/proj",
      target: target(),
      messages: [
        msg("m1", 1, [
          { path: "wiki/restore.md", operation: "update", timestamp: 1, toolUseId: "tool-1", snapshotted: true },
          { path: "wiki/already.md", operation: "update", timestamp: 2, toolUseId: "tool-2", snapshotted: true },
          { path: "wiki/new.md", operation: "create", timestamp: 3, toolUseId: "tool-3", snapshotted: true },
          { path: "wiki/refuse.md", operation: "update", timestamp: 4, toolUseId: "tool-4", snapshotted: true },
        ]),
      ],
    })

    expect(result).toEqual({
      ok: false,
      restoredPaths: ["wiki/restore.md"],
      failures: [{ path: "wiki/refuse.md", error: "文件已被后续修改，请用 rewind 或手动处理" }],
    })
    expect(fsMocks.writeFile).toHaveBeenCalledWith("/proj/wiki/restore.md", "before")
    expect(fsMocks.deleteFile).not.toHaveBeenCalledWith("/proj/wiki/new.md")
  })
})
