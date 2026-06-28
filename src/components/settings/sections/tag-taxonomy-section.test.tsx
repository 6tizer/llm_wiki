// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { TagTaxonomySection } from "./tag-taxonomy-section"
import { defaultTagTaxonomy, tagTaxonomyPath } from "@/lib/agent/tag-taxonomy"
import type { FileNode } from "@/types/wiki"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string) => false),
  listDirectory: vi.fn(async (_path: string) => [] as FileNode[]),
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const project = { path: "/project" }
const sidecarPath = tagTaxonomyPath(project.path)

function renderSection(
  props: Partial<React.ComponentProps<typeof TagTaxonomySection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<TagTaxonomySection {...props} />)
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

function page(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n`
}

function mockProjectWithStorage(initialSidecar = ""): { getSidecar: () => string } {
  let sidecar = initialSidecar
  const pagePath = "/project/wiki/a.md"
  fsMocks.fileExists.mockImplementation(async (path: string) => path === sidecarPath && sidecar !== "")
  fsMocks.listDirectory.mockResolvedValue([
    { name: "a.md", path: pagePath, is_dir: false },
  ])
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path === sidecarPath) return sidecar
    if (path === pagePath) return page("title: A\ntype: concept\ntags: vector")
    return ""
  })
  fsMocks.writeFileAtomic.mockImplementation(async (_path: string, contents: string) => {
    sidecar = contents
  })
  return { getSidecar: () => sidecar }
}

describe("TagTaxonomySection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.listDirectory.mockResolvedValue([])
    fsMocks.readFile.mockResolvedValue("")
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  })

  it("disables actions when no project is open", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-section']")).not.toBeNull()
    expect(container.textContent).toContain("Open a project first")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-previewBootstrap']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-rollback']")?.disabled).toBe(true)

    unmount(root)
  })

  it("renders future schema conflicts as read-only", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: 2,
      updatedAt: 10,
      safety: {},
      tree: [],
      changeLog: [],
    }))

    const { container, root } = renderSection({ project, now: () => 101 })
    await flush()

    expect(container.textContent).toContain("newer than this app supports")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-previewBootstrap']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-applyGrowth']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-rollback']")?.disabled).toBe(true)

    unmount(root)
  })

  it("shows loadFailed for unreadable taxonomy JSON", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("{bad")

    const { container, root } = renderSection({ project, now: () => 102 })
    await flush()

    expect(container.textContent).toContain("Tag taxonomy could not be loaded")

    unmount(root)
  })

  it("renders status and previews bootstrap without writing", async () => {
    mockProjectWithStorage()
    const { container, root } = renderSection({ project, now: () => 100 })
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-node-count']")?.textContent).toBe("0")

    const preview = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-previewBootstrap']")
    if (!preview) throw new Error("preview button not found")
    await click(preview)
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Added 3")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Bootstrap report")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Preview only")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    unmount(root)
  })

  it("applies bootstrap and rolls back the last batch", async () => {
    const storage = mockProjectWithStorage()
    const { container, root } = renderSection({ project, now: () => 200 })
    await flush()

    const apply = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-applyBootstrap']")
    if (!apply) throw new Error("apply button not found")
    await click(apply)
    await flush()

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getSidecar()).tree).toHaveLength(1)
    expect(container.querySelector("[data-testid='tag-taxonomy-node-count']")?.textContent).toBe("3")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Written")

    const rollback = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-rollback']")
    if (!rollback) throw new Error("rollback button not found")
    await click(rollback)
    await flush()

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.getSidecar()).tree).toEqual([])
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Removed 3")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Rollback report")

    unmount(root)
  })

  it("shows no changes when rollback has no batch", async () => {
    mockProjectWithStorage()
    const { container, root } = renderSection({ project, now: () => 250 })
    await flush()

    const rollback = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-rollback']")
    if (!rollback) throw new Error("rollback button not found")
    await click(rollback)
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("No changes")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    unmount(root)
  })

  it("shows not written when apply hits a stale sidecar", async () => {
    const initial = defaultTagTaxonomy(1)
    const changed = defaultTagTaxonomy(2)
    const pagePath = "/project/wiki/a.md"
    let taxonomyReads = 0
    fsMocks.fileExists.mockImplementation(async (path: string) => path === sidecarPath)
    fsMocks.listDirectory.mockResolvedValue([{ name: "a.md", path: pagePath, is_dir: false }])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === sidecarPath) {
        taxonomyReads += 1
        return JSON.stringify(taxonomyReads < 3 ? initial : changed)
      }
      if (path === pagePath) return page("title: A\ntype: concept\ntags: vector")
      return ""
    })
    const { container, root } = renderSection({ project, now: () => 260 })
    await flush()

    const apply = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-applyBootstrap']")
    if (!apply) throw new Error("apply button not found")
    await click(apply)
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Not written")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    unmount(root)
  })

  it("previews and applies growth", async () => {
    const taxonomy = defaultTagTaxonomy(10)
    taxonomy.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 10,
      batchId: "seed",
      children: [],
    })
    const storage = mockProjectWithStorage(JSON.stringify(taxonomy))
    const { container, root } = renderSection({ project, now: () => 300 })
    await flush()

    const previewGrowth = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-previewGrowth']")
    if (!previewGrowth) throw new Error("preview growth button not found")
    await click(previewGrowth)
    await flush()

    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Growth report")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Added 2")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Preview only")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    const applyGrowth = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-applyGrowth']")
    if (!applyGrowth) throw new Error("apply growth button not found")
    await click(applyGrowth)
    await flush()

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.getSidecar()).tree[0].children[0].slug).toBe("vector")
    expect(container.querySelector("[data-testid='tag-taxonomy-report']")?.textContent).toContain("Written")

    unmount(root)
  })

  it("shows actionFailed when an apply write fails", async () => {
    const pagePath = "/project/wiki/a.md"
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.listDirectory.mockResolvedValue([{ name: "a.md", path: pagePath, is_dir: false }])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === pagePath) return page("title: A\ntype: concept\ntags: vector")
      return ""
    })
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    const { container, root } = renderSection({ project, now: () => 400 })
    await flush()

    const apply = container.querySelector<HTMLButtonElement>("[data-testid='tag-taxonomy-applyBootstrap']")
    if (!apply) throw new Error("apply button not found")
    await click(apply)
    await flush()

    expect(container.textContent).toContain("Action failed")

    unmount(root)
  })
})
