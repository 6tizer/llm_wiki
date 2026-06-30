import { describe, expect, it, vi } from "vitest"
import {
  appendMarkdownContent,
  canonicalizeMarkdownContentForHash,
  commitMarkdownArtifact,
  hashMarkdownContent,
  type MarkdownCommitAdapters,
  type MarkdownCommitArtifact,
} from "./index"

function fakeHash(content: string): string {
  return `hash:${canonicalizeMarkdownContentForHash(content)}`
}

function artifact(
  overrides: Partial<MarkdownCommitArtifact> = {},
): MarkdownCommitArtifact {
  const staged = overrides.operationIntent === "delete" ? "" : "staged"
  return {
    artifactId: "artifact-1",
    jobId: "job-1",
    artifactPath: "job-1/artifact.md",
    artifactHash: fakeHash(staged),
    targetPath: "wiki/Page.md",
    baseHash: null,
    operationIntent: "create",
    sourceKind: "test",
    ...overrides,
  }
}

function adapters(
  overrides: Partial<MarkdownCommitAdapters> = {},
): MarkdownCommitAdapters {
  return {
    claimBudget: vi.fn(async () => ({ claimId: "claim-1" })),
    releaseBudget: vi.fn(async () => undefined),
    readStagedArtifactBody: vi.fn(async () => "staged"),
    readCommittedMarkdown: vi.fn(async () => null),
    writeCommittedMarkdownAtomic: vi.fn(async () => undefined),
    deleteCommittedMarkdown: vi.fn(async () => undefined),
    cleanupCommittedArtifact: vi.fn(async () => undefined),
    hashContent: vi.fn(async (content) => fakeHash(content)),
    ...overrides,
  }
}

describe("markdown commit operation", () => {
  it("creates a missing target and cleans the committed artifact after release", async () => {
    const io = adapters()
    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("committed")
    expect(result.finalHash).toBe(fakeHash("staged"))
    expect(io.claimBudget).toHaveBeenCalledWith({
      affectedPath: "wiki/Page.md",
      holder: "tester:1",
      jobId: "job-1",
      claimId: undefined,
      ttlMs: undefined,
    })
    expect(io.writeCommittedMarkdownAtomic).toHaveBeenCalledWith(
      "wiki/Page.md",
      "staged",
    )
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
    expect(io.cleanupCommittedArtifact).toHaveBeenCalledWith("artifact-1")
  })

  it("rejects claim failure without releasing an unclaimed budget", async () => {
    const io = adapters({
      claimBudget: vi.fn(async () => {
        throw new Error("claim failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toBe("claim failed")
    expect(io.releaseBudget).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
  })

  it("conflicts instead of overwriting when create sees an existing target", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "current"),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("conflicted")
    expect(result.currentHash).toBe(fakeHash("current"))
    expect(io.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("updates only when the base hash matches current content", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "current"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "update",
          baseHash: fakeHash("current"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("committed")
    expect(io.writeCommittedMarkdownAtomic).toHaveBeenCalledWith(
      "wiki/Page.md",
      "staged",
    )
  })

  it("releases and rejects when atomic write fails", async () => {
    const io = adapters({
      writeCommittedMarkdownAtomic: vi.fn(async () => {
        throw new Error("write failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toBe("write failed")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
  })

  it("conflicts when update sees a different current hash", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "changed"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "update",
          baseHash: fakeHash("current"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("conflicted")
    expect(io.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()
  })

  it("appends with an exact deterministic newline join and returns merged", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "current\r\n"),
      readStagedArtifactBody: vi.fn(async () => "\nstaged"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash("\nstaged"),
          operationIntent: "append",
          baseHash: fakeHash("current\n"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("merged")
    expect(io.writeCommittedMarkdownAtomic).toHaveBeenCalledWith(
      "wiki/Page.md",
      "current\nstaged",
    )
    expect(io.cleanupCommittedArtifact).toHaveBeenCalledWith("artifact-1")
  })

  it("conflicts when append sees a different current hash", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "changed"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "append",
          baseHash: fakeHash("current"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("conflicted")
    expect(io.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
  })

  it("treats existing empty files as present content", async () => {
    const createIo = adapters({
      readCommittedMarkdown: vi.fn(async () => ""),
    })
    const appendIo = adapters({
      readCommittedMarkdown: vi.fn(async () => ""),
    })
    const deleteIo = adapters({
      readStagedArtifactBody: vi.fn(async () => ""),
      readCommittedMarkdown: vi.fn(async () => ""),
    })

    await expect(
      commitMarkdownArtifact(
        { artifact: artifact({ operationIntent: "create" }), holder: "tester:1" },
        createIo,
      ),
    ).resolves.toMatchObject({ result: "conflicted", currentHash: fakeHash("") })
    expect(createIo.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()

    await expect(
      commitMarkdownArtifact(
        { artifact: artifact({ operationIntent: "append" }), holder: "tester:1" },
        appendIo,
      ),
    ).resolves.toMatchObject({ result: "conflicted", currentHash: fakeHash("") })
    expect(appendIo.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()

    await expect(
      commitMarkdownArtifact(
        {
          artifact: artifact({
            artifactHash: fakeHash(""),
            operationIntent: "delete",
            baseHash: fakeHash(""),
          }),
          holder: "tester:1",
        },
        deleteIo,
      ),
    ).resolves.toMatchObject({ result: "committed", currentHash: fakeHash("") })
    expect(deleteIo.deleteCommittedMarkdown).toHaveBeenCalledWith("wiki/Page.md")
  })

  it("accepts staged artifact hashes computed from canonical LF content", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => "line 1\r\nline 2\r"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash("line 1\nline 2\n"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("committed")
    expect(io.writeCommittedMarkdownAtomic).toHaveBeenCalledWith(
      "wiki/Page.md",
      "line 1\r\nline 2\r",
    )
  })

  it("creates append content when the target is missing", async () => {
    const io = adapters()

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "append",
          baseHash: null,
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("committed")
    expect(io.writeCommittedMarkdownAtomic).toHaveBeenCalledWith(
      "wiki/Page.md",
      "staged",
    )
  })

  it("skips a missing delete target without cleanup", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => ""),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash(""),
          operationIntent: "delete",
          baseHash: fakeHash("old"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("skipped")
    expect(io.deleteCommittedMarkdown).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("deletes only when the base hash matches current content", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => ""),
      readCommittedMarkdown: vi.fn(async () => "old"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash(""),
          operationIntent: "delete",
          baseHash: fakeHash("old"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("committed")
    expect(result.finalHash).toBeNull()
    expect(io.deleteCommittedMarkdown).toHaveBeenCalledWith("wiki/Page.md")
  })

  it("releases and rejects when delete fails", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => ""),
      readCommittedMarkdown: vi.fn(async () => "old"),
      deleteCommittedMarkdown: vi.fn(async () => {
        throw new Error("delete failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash(""),
          operationIntent: "delete",
          baseHash: fakeHash("old"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toBe("delete failed")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
  })

  it("conflicts when delete sees a different current hash", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => ""),
      readCommittedMarkdown: vi.fn(async () => "changed"),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          artifactHash: fakeHash(""),
          operationIntent: "delete",
          baseHash: fakeHash("old"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("conflicted")
    expect(io.deleteCommittedMarkdown).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
  })

  it("rejects unsupported operation intents visibly", async () => {
    const io = adapters()

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "rename" as never,
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toBe("unsupported-operation: rename")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("rejects a staged hash mismatch and still releases the budget", async () => {
    const io = adapters()

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({ artifactHash: fakeHash("different") }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toContain("artifact-hash-mismatch")
    expect(io.writeCommittedMarkdownAtomic).not.toHaveBeenCalled()
    expect(io.cleanupCommittedArtifact).not.toHaveBeenCalled()
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("releases the budget when staged body read throws", async () => {
    const io = adapters({
      readStagedArtifactBody: vi.fn(async () => {
        throw new Error("staging read failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("rejected")
    expect(result.error).toBe("staging read failed")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("releases the budget when current read or hash throws", async () => {
    const readErrorIo = adapters({
      readCommittedMarkdown: vi.fn(async () => {
        throw new Error("current read failed")
      }),
    })
    const hashErrorIo = adapters({
      hashContent: vi.fn(async () => {
        throw new Error("hash failed")
      }),
    })

    expect(
      await commitMarkdownArtifact(
        { artifact: artifact(), holder: "tester:1" },
        readErrorIo,
      ),
    ).toMatchObject({ result: "rejected", error: "current read failed" })
    expect(readErrorIo.releaseBudget).toHaveBeenCalledWith("claim-1")

    expect(
      await commitMarkdownArtifact(
        { artifact: artifact(), holder: "tester:1" },
        hashErrorIo,
      ),
    ).toMatchObject({ result: "rejected", error: "hash failed" })
    expect(hashErrorIo.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("keeps committed result when cleanup fails after release", async () => {
    const io = adapters({
      cleanupCommittedArtifact: vi.fn(async () => {
        throw new Error("cleanup failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("committed")
    expect(result.cleanupError).toBe("cleanup failed")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("keeps merged result when cleanup fails after release", async () => {
    const io = adapters({
      readCommittedMarkdown: vi.fn(async () => "current"),
      cleanupCommittedArtifact: vi.fn(async () => {
        throw new Error("cleanup failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      {
        artifact: artifact({
          operationIntent: "append",
          baseHash: fakeHash("current"),
        }),
        holder: "tester:1",
      },
      io,
    )

    expect(result.result).toBe("merged")
    expect(result.cleanupError).toBe("cleanup failed")
    expect(io.releaseBudget).toHaveBeenCalledWith("claim-1")
  })

  it("surfaces release failures without hiding the committed result", async () => {
    const io = adapters({
      releaseBudget: vi.fn(async () => {
        throw new Error("release failed")
      }),
    })

    const result = await commitMarkdownArtifact(
      { artifact: artifact(), holder: "tester:1" },
      io,
    )

    expect(result.result).toBe("committed")
    expect(result.releaseError).toBe("release failed")
    expect(io.cleanupCommittedArtifact).toHaveBeenCalledWith("artifact-1")
  })

  it("canonicalizes hash and append inputs without trimming content", () => {
    expect(canonicalizeMarkdownContentForHash("a\r\nb\rc\n")).toBe("a\nb\nc\n")
    expect(appendMarkdownContent("old\n\n", "\nnew\n")).toBe("old\nnew\n")
    expect(appendMarkdownContent("existing", "")).toBe("existing")
  })

  it("hashes canonical markdown content with SHA-256", async () => {
    await expect(hashMarkdownContent("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    )
    await expect(hashMarkdownContent("a\r\nb\rc")).resolves.toBe(
      await hashMarkdownContent("a\nb\nc"),
    )
  })
})
