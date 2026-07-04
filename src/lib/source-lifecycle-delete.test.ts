import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { withProjectLock, __resetProjectLocksForTesting } from "./project-mutex"

vi.mock("@/commands/fs", () => realFs)

import { deleteSourceFiles } from "./source-lifecycle"

describe("source lifecycle source deletion", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    __resetProjectLocksForTesting()
    tmp = await createTempProject("source-lifecycle-delete")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/shared.md`,
      [
        "---",
        'sources: ["project-a/config.yaml", "project-b/config.yaml"]',
        "---",
        "# Shared",
      ].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/project-b-only.md`,
      [
        "---",
        'sources: ["project-b/config.yaml"]',
        "---",
        "# Project B",
      ].join("\n"),
    )
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("does not remove path-aware source references that only share a basename", async () => {
    if (!tmp) throw new Error("missing temp project")

    const result = await deleteSourceFiles(
      tmp.path,
      [`${tmp.path}/raw/sources/project-a/config.yaml`],
      { fileAlreadyDeleted: true },
    )

    await expect(readFileRaw(`${tmp.path}/wiki/concepts/shared.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    await expect(readFileRaw(`${tmp.path}/wiki/concepts/project-b-only.md`)).resolves.toContain(
      'sources: ["project-b/config.yaml"]',
    )
    expect(result.deletedWikiPaths).toEqual([])
    expect(result.rewrittenSourcePages).toBe(1)
  })

  it("serializes source delete behind an existing project lock before rewriting index.md", async () => {
    if (!tmp) throw new Error("missing temp project")
    const projectPath = tmp.path
    await writeFileRaw(`${projectPath}/raw/sources/locked.md`, "locked\n")
    await writeFileRaw(
      `${projectPath}/wiki/index.md`,
      ["# Index", "", "- [[locked]] Locked page", "- [[shared]] Shared page", ""].join("\n"),
    )
    await writeFileRaw(
      `${projectPath}/wiki/concepts/locked.md`,
      ["---", 'sources: ["locked.md"]', "---", "# Locked"].join("\n"),
    )

    const order: string[] = []
    let release!: () => void
    let markHolderEntered!: () => void
    const holderEntered = new Promise<void>((resolve) => {
      markHolderEntered = resolve
    })
    const holder = withProjectLock(projectPath, async () => {
      order.push("holder:entered")
      markHolderEntered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push("holder:released")
    })
    await holderEntered
    let released = false
    const releaseHolder = () => {
      if (released) return
      released = true
      release()
    }

    const originalWriteFile = realFs.writeFile
    const originalDeleteFile = realFs.deleteFile
    const deleteTouchedFs = new Promise<void>((resolve) => {
      vi.spyOn(realFs, "writeFile").mockImplementation(async (p: string, contents: string) => {
        order.push(`delete:write:${p.replace(projectPath, "<project>")}`)
        resolve()
        return originalWriteFile(p, contents)
      })
      vi.spyOn(realFs, "deleteFile").mockImplementation(async (p: string) => {
        order.push(`delete:delete:${p.replace(projectPath, "<project>")}`)
        resolve()
        return originalDeleteFile(p)
      })
    })

    let deletion: ReturnType<typeof deleteSourceFiles> | undefined
    try {
      deletion = deleteSourceFiles(projectPath, [`${projectPath}/raw/sources/locked.md`], {
        fileAlreadyDeleted: true,
      })

      const preReleaseRace = await Promise.race([
        deleteTouchedFs.then(() => "delete-touched-fs" as const),
        new Promise<"still-blocked">((resolve) => setTimeout(() => resolve("still-blocked"), 50)),
      ])
      expect(preReleaseRace).toBe("still-blocked")
      expect(order).toEqual(["holder:entered"])
      expect(await readFileRaw(`${projectPath}/wiki/index.md`)).toContain("[[locked]]")

      releaseHolder()
      await holder
      const result = await deletion

      expect(result.deletedWikiPaths).toEqual([`${projectPath}/wiki/concepts/locked.md`])
      expect(order[0]).toBe("holder:entered")
      expect(order[1]).toBe("holder:released")
      expect(order.some((step) => step.startsWith("delete:"))).toBe(true)
      const index = await readFileRaw(`${projectPath}/wiki/index.md`)
      expect(index).not.toContain("[[locked]]")
      expect(index).toContain("[[shared]]")
    } finally {
      releaseHolder()
      const pending = deletion ? [holder, deletion] : [holder]
      await Promise.allSettled(pending)
      vi.spyOn(realFs, "writeFile").mockRestore()
      vi.spyOn(realFs, "deleteFile").mockRestore()
    }
  })

  it("treats repeated deletes of the same source as a safe no-op after the first cleanup", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/raw/sources/repeated.md`, "repeat\n")
    await writeFileRaw(
      `${tmp.path}/wiki/index.md`,
      ["# Index", "", "- [[repeated]] Repeated page", "- [[shared]] Shared page", ""].join("\n"),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/repeated.md`,
      ["---", 'sources: ["repeated.md"]', "---", "# Repeated"].join("\n"),
    )

    const first = await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/repeated.md`])
    const second = await deleteSourceFiles(tmp.path, [`${tmp.path}/raw/sources/repeated.md`], {
      fileAlreadyDeleted: true,
      logReason: "external delete",
    })

    expect(first.deletedWikiPaths).toEqual([`${tmp.path}/wiki/concepts/repeated.md`])
    expect(second.deletedWikiPaths).toEqual([])
    expect(second.rewrittenSourcePages).toBe(0)
    const index = await readFileRaw(`${tmp.path}/wiki/index.md`)
    expect(index).not.toContain("[[repeated]]")
    expect(index).toContain("[[shared]]")
  })
})
