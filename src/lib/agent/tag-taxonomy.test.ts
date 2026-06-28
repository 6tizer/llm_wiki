import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import {
  DEFAULT_TAG_TAXONOMY_SAFETY,
  applyTagTaxonomyBootstrap,
  applyTagTaxonomyGrowth,
  buildTagTaxonomyPageReport,
  defaultTagTaxonomy,
  isTagTaxonomyStale,
  loadTagTaxonomy,
  normalizeTagTaxonomy,
  previewTagTaxonomyBootstrap,
  previewTagTaxonomyGrowth,
  rollbackLastTagTaxonomyBatch,
  saveTagTaxonomy,
  tagTaxonomyPath,
} from "./tag-taxonomy"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string) => false),
  listDirectory: vi.fn(async (_path: string) => [] as FileNode[]),
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

const projectPath = "/project"
const taxonomyPath = tagTaxonomyPath(projectPath)

function file(path: string): FileNode {
  const parts = path.split("/")
  return { name: parts[parts.length - 1] ?? path, path, is_dir: false }
}

function tree(...paths: string[]): FileNode[] {
  return paths.map((path) => file(path))
}

function page(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n${body}`
}

function mockProject(files: Record<string, string>, taxonomy?: unknown): void {
  fsMocks.listDirectory.mockResolvedValue(tree(...Object.keys(files)))
  fsMocks.fileExists.mockImplementation(async (path: string) => path === taxonomyPath && taxonomy !== undefined)
  fsMocks.readFile.mockImplementation(async (path: string) => {
    if (path === taxonomyPath) return JSON.stringify(taxonomy)
    return files[path] ?? ""
  })
}

function lastWrittenTaxonomy() {
  const calls = fsMocks.writeFileAtomic.mock.calls
  const content = calls[calls.length - 1]?.[1] ?? ""
  return JSON.parse(content)
}

describe("tag taxonomy config", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.listDirectory.mockResolvedValue([])
    fsMocks.readFile.mockResolvedValue("")
  })

  it("returns deterministic defaults and sidecar path when missing", async () => {
    expect(tagTaxonomyPath("/project/")).toBe("/project/.llm-wiki/tag-taxonomy.json")
    expect(tagTaxonomyPath("C:\\project\\")).toBe("C:/project/.llm-wiki/tag-taxonomy.json")
    await expect(loadTagTaxonomy(projectPath)).resolves.toEqual({
      taxonomy: defaultTagTaxonomy(),
      issues: [],
      conflict: false,
    })
  })

  it("falls back for bad JSON, invalid roots, and future schemas", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValueOnce("{bad")
    expect((await loadTagTaxonomy(projectPath)).issues[0]?.code).toBe("bad_json")

    expect(normalizeTagTaxonomy(null).issues[0]?.code).toBe("invalid_root")
    expect(normalizeTagTaxonomy([]).issues[0]?.code).toBe("invalid_root")

    const future = normalizeTagTaxonomy({ schemaVersion: 2, updatedAt: 1 })
    expect(future.conflict).toBe(true)
    expect(future.issues[0]?.code).toBe("future_schema_version")
  })

  it("normalizes safety defaults and invalid nodes without preserving bad entries", () => {
    const normalized = normalizeTagTaxonomy({
      schemaVersion: 1,
      updatedAt: "now",
      safety: {
        maxL1: 0,
        maxL2PerL1: "bad",
        maxL3PerL2: -1,
        maxTotalNodes: 0,
        maxNewNodesPerRun: -1,
        allowNewL1ByDefault: true,
      },
      tree: [
        { slug: "Valid Node", label: "", level: 1, evidence: ["b", "a"], confidence: 2, createdBy: "bootstrap", updatedAt: 1, batchId: "b" },
        { slug: "", level: 1 },
      ],
      changeLog: [],
    })

    expect(normalized.taxonomy.updatedAt).toBe(0)
    expect(normalized.taxonomy.safety.maxL1).toBe(1)
    expect(normalized.taxonomy.safety.maxL2PerL1).toBe(DEFAULT_TAG_TAXONOMY_SAFETY.maxL2PerL1)
    expect(normalized.taxonomy.safety.allowNewL1ByDefault).toBe(true)
    expect(normalized.taxonomy.tree).toHaveLength(1)
    expect(normalized.taxonomy.tree[0]).toMatchObject({
      slug: "valid-node",
      label: "Valid Node",
      evidence: ["a", "b"],
      confidence: 0,
    })
    expect(normalized.issues.some((item) => item.code === "invalid_node")).toBe(true)
  })

  it("saves with injected time and rejects stale updatedAt", async () => {
    const current = defaultTagTaxonomy(10)
    mockProject({}, current)

    const stale = await saveTagTaxonomy(projectPath, current, {
      expectedUpdatedAt: 9,
      now: () => 20,
    })
    expect(stale.saved).toBe(false)
    expect(stale.issues.some((item) => item.code === "stale_updated_at")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    const saved = await saveTagTaxonomy(projectPath, current, {
      expectedUpdatedAt: 10,
      now: () => 20,
    })
    expect(saved.saved).toBe(true)
    expect(saved.taxonomy.updatedAt).toBe(20)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(taxonomyPath, expect.stringMatching(/\n$/))
  })

  it("dirty-check covers mismatch and invalid timestamps", () => {
    expect(isTagTaxonomyStale(1, 1)).toBe(false)
    expect(isTagTaxonomyStale(1, 2)).toBe(true)
    expect(isTagTaxonomyStale(undefined, 1)).toBe(true)
    expect(isTagTaxonomyStale(1, Number.NaN)).toBe(true)
  })
})

describe("taxonomy-aware tag matching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("matches taxonomy nodes with labels, slugs, confidence, and evidence", () => {
    const taxonomy = defaultTagTaxonomy(1)
    taxonomy.tree.push({
      slug: "concept",
      label: "Concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [{
        slug: "ai",
        label: "Artificial Intelligence",
        level: 2,
        evidence: [],
        confidence: 0.8,
        createdBy: "bootstrap",
        updatedAt: 1,
        batchId: "seed",
        children: [{
          slug: "transformer",
          label: "Transformer",
          level: 3,
          evidence: ["wiki/transformer.md"],
          confidence: 0.9,
          createdBy: "bootstrap",
          updatedAt: 1,
          batchId: "seed",
        }],
      }],
    })

    const report = buildTagTaxonomyPageReport(taxonomy, {
      relativePath: "wiki/transformer.md",
      title: "Transformer",
      type: "concept",
      tags: [],
      body: "A neural architecture.",
      candidateTags: ["transformer"],
    })

    expect(report.suggestions[0]).toMatchObject({
      label: "Artificial Intelligence",
      slug: "ai",
      path: "concept/ai",
      confidence: 0.75,
      band: "high",
    })
    expect(report.matchedSlugs).toEqual(["concept/ai"])
    expect(report.evidence).toEqual(expect.arrayContaining([
      "title:Transformer",
      "type:Concept",
    ]))
  })

  it("returns low-confidence bounded growth proposals without writing sidecars", () => {
    const taxonomy = defaultTagTaxonomy(1)
    taxonomy.tree.push({
      slug: "concept",
      label: "Concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [],
    })

    const report = buildTagTaxonomyPageReport(taxonomy, {
      relativePath: "wiki/quantum-pump.md",
      title: "Quantum Pump",
      type: "concept",
      tags: [],
      body: "Specialized notes.",
      candidateTags: ["quantum"],
    })

    expect(report.band).toBe("low")
    expect(report.suggestions).toEqual([])
    expect(report.growthProposal.nodes).toEqual([{
      slug: "quantum",
      label: "quantum",
      level: 2,
      parentPath: "concept",
      confidence: 0.35,
      evidence: ["title:Quantum Pump", "type:concept", "wiki/quantum-pump.md"],
    }])
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })
})

describe("tag taxonomy bootstrap and growth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.listDirectory.mockResolvedValue([])
    fsMocks.readFile.mockResolvedValue("")
  })

  it("previews bootstrap deterministically without writing", async () => {
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai", "[[B]]"),
      "/project/wiki/b.md": page("title: B\ntype: source\ntags: [ml, ai]"),
      "/project/wiki/plain.md": "# No frontmatter",
    })

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 100 })

    expect(report).toMatchObject({
      action: "bootstrap",
      dryRun: true,
      batchId: "taxonomy-bootstrap-100",
      added: 8,
      wrote: false,
      counts: { pagesScanned: 3, pagesWithFrontmatter: 2 },
    })
    expect(report.details.some((item) => item.code === "no_frontmatter")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("applies bootstrap idempotently and supports string/string[]/missing tags", async () => {
    const files = {
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai", "[[B]]"),
      "/project/wiki/b.md": page("title: B\ntype: concept\ntags: [ml, ai]"),
      "/project/wiki/c.md": page("title: C\ntype: concept"),
    }
    mockProject(files)

    const first = await applyTagTaxonomyBootstrap(projectPath, { now: () => 200 })
    expect(first.wrote).toBe(true)
    const written = lastWrittenTaxonomy()
    expect(written.updatedAt).toBe(200)
    expect(written.changeLog[0].batchId).toBe("taxonomy-bootstrap-200")
    expect(written.tree[0].slug).toBe("concept")
    expect(written.tree[0].children.map((node: { slug: string }) => node.slug)).toEqual(["ai", "ml", "untagged"])
    const ai = written.tree[0].children.find((node: { slug: string }) => node.slug === "ai")
    expect(ai.children.map((node: { slug: string }) => node.slug)).toEqual(["a", "b"])
    expect(ai.children[0]).toMatchObject({
      slug: "a",
      label: "A",
      level: 3,
      evidence: expect.arrayContaining(["wiki/a.md", "title:A", "type:concept", "wikilink:B"]),
    })
    expect(written.changeLog[0].addedNodeSlugs).toEqual(expect.arrayContaining([
      "concept",
      "concept/ai",
      "concept/ai/a",
    ]))

    mockProject(files, written)
    const second = await applyTagTaxonomyBootstrap(projectPath, { now: () => 201 })
    expect(second.added).toBe(0)
    expect(second.wrote).toBe(false)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("does not write when apply detects a stale taxonomy before save", async () => {
    const initial = defaultTagTaxonomy(1)
    const changed = defaultTagTaxonomy(2)
    let taxonomyReads = 0
    fsMocks.fileExists.mockImplementation(async (path: string) => path === taxonomyPath)
    fsMocks.listDirectory.mockResolvedValue(tree("/project/wiki/a.md"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === taxonomyPath) {
        taxonomyReads += 1
        return JSON.stringify(taxonomyReads === 1 ? initial : changed)
      }
      return page("title: A\ntype: concept\ntags: vector")
    })

    const report = await applyTagTaxonomyBootstrap(projectPath, { now: () => 250 })

    expect(report.wrote).toBe(false)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "stale_updated_at")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("honors caps and reports truncation", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxL1: 1,
        maxL2PerL1: 1,
        maxL3PerL2: 1,
        maxTotalNodes: 10,
        maxNewNodesPerRun: 10,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai"),
      "/project/wiki/b.md": page("title: B\ntype: concept\ntags: ai"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 300 })

    expect(report.added).toBe(3)
    expect(report.truncated).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "l3_cap")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("honors maxL1 independently", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxL1: 1,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai"),
      "/project/wiki/b.md": page("title: B\ntype: entity\ntags: ai"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 305 })

    expect(report.truncated).toBeGreaterThan(0)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "l1_cap")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("does not map explicit new L1 to existing uncategorized when maxL1 is reached", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxL1: 1,
      },
      tree: [{
        slug: "uncategorized",
        label: "Uncategorized",
        level: 1,
        evidence: [],
        confidence: 0.6,
        createdBy: "bootstrap",
        updatedAt: 1,
        batchId: "seed",
        children: [],
      }],
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: entity\ntags: vector"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 3051 })

    expect(report.added).toBe(0)
    expect(report.details.some((item) => item.code === "l1_cap")).toBe(true)
    expect(report.addedNodeSlugs).not.toContain("uncategorized/vector")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("does not map explicit growth L1 to existing uncategorized when maxL1 is reached", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxL1: 1,
        allowNewL1ByDefault: true,
      },
      tree: [{
        slug: "uncategorized",
        label: "Uncategorized",
        level: 1,
        evidence: [],
        confidence: 0.6,
        createdBy: "bootstrap",
        updatedAt: 1,
        batchId: "seed",
        children: [],
      }],
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: entity\ntags: vector"),
    }, capped)

    const report = await previewTagTaxonomyGrowth(projectPath, { now: () => 3052 })

    expect(report.added).toBe(0)
    expect(report.details.some((item) => item.code === "l1_cap")).toBe(true)
    expect(report.addedNodeSlugs).not.toContain("uncategorized/vector")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("honors maxL2PerL1 independently", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxL2PerL1: 1,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: [ai, ml]"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 306 })

    expect(report.truncated).toBeGreaterThan(0)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "l2_cap")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("honors maxTotalNodes independently", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxTotalNodes: 2,
        maxNewNodesPerRun: 10,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai"),
      "/project/wiki/b.md": page("title: B\ntype: concept\ntags: ai"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 310 })

    expect(report.added).toBe(2)
    expect(report.truncated).toBeGreaterThan(0)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "l3_cap")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("honors maxNewNodesPerRun independently", async () => {
    const capped = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        maxTotalNodes: 10,
        maxNewNodesPerRun: 1,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: ai"),
      "/project/wiki/b.md": page("title: B\ntype: concept\ntags: ai"),
    }, capped)

    const report = await previewTagTaxonomyBootstrap(projectPath, { now: () => 320 })

    expect(report.added).toBe(1)
    expect(report.addedNodeSlugs).toEqual(["concept"])
    expect(report.truncated).toBeGreaterThan(0)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "l2_cap")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("growth does not create new L1 by default", async () => {
    const existing = defaultTagTaxonomy(1)
    existing.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: ["wiki/old.md"],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [],
    })
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: entity\ntags: vector"),
    }, existing)

    const report = await previewTagTaxonomyGrowth(projectPath, { now: () => 400 })

    expect(report.added).toBe(0)
    expect(report.skipped).toBeGreaterThan(0)
    expect(report.details.some((item) => item.code === "new_l1_disabled")).toBe(true)
  })

  it("does not map explicit growth L1 to existing uncategorized when new L1 is disabled", async () => {
    const existing = defaultTagTaxonomy(1)
    existing.tree.push({
      slug: "uncategorized",
      label: "Uncategorized",
      level: 1,
      evidence: ["wiki/old.md"],
      confidence: 0.6,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [],
    })
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: entity\ntags: vector"),
    }, existing)

    const report = await applyTagTaxonomyGrowth(projectPath, { now: () => 405 })

    expect(report.added).toBe(0)
    expect(report.wrote).toBe(false)
    expect(report.addedNodeSlugs).not.toContain("uncategorized/vector/a")
    expect(report.details.some((item) => item.code === "new_l1_disabled")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("growth creates a new L1 when allowNewL1ByDefault is true", async () => {
    const existing = {
      ...defaultTagTaxonomy(1),
      safety: {
        ...DEFAULT_TAG_TAXONOMY_SAFETY,
        allowNewL1ByDefault: true,
      },
    }
    mockProject({
      "/project/wiki/a.md": page("title: Entity A\ntype: entity\ntags: vector"),
    }, existing)

    const report = await applyTagTaxonomyGrowth(projectPath, { now: () => 410 })

    expect(report.wrote).toBe(true)
    expect(report.addedNodeSlugs).toEqual(["entity", "entity/vector", "entity/vector/entity-a"])
    expect(lastWrittenTaxonomy().tree[0].slug).toBe("entity")
  })

  it("growth appends a missing L2 and L3 under an existing L1", async () => {
    const existing = defaultTagTaxonomy(1)
    existing.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [],
    })
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: vector"),
    }, existing)

    const report = await applyTagTaxonomyGrowth(projectPath, { now: () => 420 })

    expect(report.wrote).toBe(true)
    expect(report.addedNodeSlugs).toEqual(["concept/vector", "concept/vector/a"])
    const concept = lastWrittenTaxonomy().tree[0]
    expect(concept.children[0].slug).toBe("vector")
    expect(concept.children[0].children[0].slug).toBe("a")
  })

  it("does not write when growth detects a stale taxonomy before save", async () => {
    const initial = defaultTagTaxonomy(1)
    initial.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [],
    })
    const changed = { ...initial, updatedAt: 2 }
    let taxonomyReads = 0
    fsMocks.fileExists.mockImplementation(async (path: string) => path === taxonomyPath)
    fsMocks.listDirectory.mockResolvedValue(tree("/project/wiki/a.md"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path === taxonomyPath) {
        taxonomyReads += 1
        return JSON.stringify(taxonomyReads === 1 ? initial : changed)
      }
      return page("title: A\ntype: concept\ntags: vector")
    })

    const report = await applyTagTaxonomyGrowth(projectPath, { now: () => 430 })

    expect(report.wrote).toBe(false)
    expect(report.details.some((item) => item.code === "stale_updated_at")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("growth appends a missing L3 under an existing L1/L2", async () => {
    const existing = defaultTagTaxonomy(1)
    existing.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: [],
      confidence: 0.7,
      createdBy: "bootstrap",
      updatedAt: 1,
      batchId: "seed",
      children: [{
        slug: "vector",
        label: "vector",
        level: 2,
        evidence: [],
        confidence: 0.7,
        createdBy: "bootstrap",
        updatedAt: 1,
        batchId: "seed",
        children: [{
          slug: "existing",
          label: "Existing",
          level: 3,
          evidence: ["wiki/existing.md"],
          confidence: 0.75,
          createdBy: "bootstrap",
          updatedAt: 1,
          batchId: "seed",
        }],
      }],
    })
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: vector"),
    }, existing)

    const report = await applyTagTaxonomyGrowth(projectPath, { now: () => 500 })

    expect(report.added).toBe(1)
    expect(report.wrote).toBe(true)
    expect(report.addedNodeSlugs).toEqual(["concept/vector/a"])
    expect(lastWrittenTaxonomy().tree[0].children[0].children.map((node: { slug: string }) => node.slug)).toEqual(["a", "existing"])
  })

  it("rolls back only the latest bootstrap/growth batch and second rollback is a no-op", async () => {
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: vector"),
    })
    await applyTagTaxonomyBootstrap(projectPath, { now: () => 600 })
    const bootstrapped = lastWrittenTaxonomy()

    mockProject({}, bootstrapped)
    const rollback = await rollbackLastTagTaxonomyBatch(projectPath, { now: () => 601 })
    expect(rollback.removed).toBe(3)
    expect(rollback.wrote).toBe(true)
    const rolledBack = lastWrittenTaxonomy()
    expect(rolledBack.tree).toEqual([])
    expect(rolledBack.changeLog[rolledBack.changeLog.length - 1].action).toBe("rollback")

    mockProject({}, rolledBack)
    const second = await rollbackLastTagTaxonomyBatch(projectPath, { now: () => 602 })
    expect(second.removed).toBe(0)
    expect(second.wrote).toBe(false)
  })

  it("previews rollback without writing", async () => {
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: vector"),
    })
    await applyTagTaxonomyBootstrap(projectPath, { now: () => 650 })
    const bootstrapped = lastWrittenTaxonomy()
    fsMocks.writeFileAtomic.mockClear()

    mockProject({}, bootstrapped)
    const rollback = await rollbackLastTagTaxonomyBatch(projectPath, {
      dryRun: true,
      now: () => 651,
    })

    expect(rollback.dryRun).toBe(true)
    expect(rollback.removed).toBe(3)
    expect(rollback.wrote).toBe(false)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("does not write when rollback detects a stale taxonomy before save", async () => {
    const existing = defaultTagTaxonomy(10)
    existing.tree.push({
      slug: "concept",
      label: "concept",
      level: 1,
      evidence: ["wiki/a.md"],
      confidence: 0.6,
      createdBy: "bootstrap",
      updatedAt: 10,
      batchId: "taxonomy-bootstrap-10",
      children: [{
        slug: "vector",
        label: "vector",
        level: 2,
        evidence: ["wiki/a.md"],
        confidence: 0.7,
        createdBy: "bootstrap",
        updatedAt: 10,
        batchId: "taxonomy-bootstrap-10",
        children: [{
          slug: "a",
          label: "A",
          level: 3,
          evidence: ["wiki/a.md"],
          confidence: 0.75,
          createdBy: "bootstrap",
          updatedAt: 10,
          batchId: "taxonomy-bootstrap-10",
        }],
      }],
    })
    existing.changeLog.push({
      batchId: "taxonomy-bootstrap-10",
      action: "bootstrap",
      updatedAt: 10,
      addedNodeSlugs: ["concept", "concept/vector", "concept/vector/a"],
      truncated: false,
      summary: "seed",
    })
    const changed = { ...existing, updatedAt: 11 }
    let taxonomyReads = 0
    fsMocks.fileExists.mockImplementation(async (path: string) => path === taxonomyPath)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path !== taxonomyPath) return ""
      taxonomyReads += 1
      return JSON.stringify(taxonomyReads === 1 ? existing : changed)
    })

    const report = await rollbackLastTagTaxonomyBatch(projectPath, { now: () => 12 })

    expect(report.wrote).toBe(false)
    expect(report.removed).toBe(3)
    expect(report.details.some((item) => item.code === "stale_updated_at")).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("never writes wiki pages during apply or rollback", async () => {
    mockProject({
      "/project/wiki/a.md": page("title: A\ntype: concept\ntags: vector"),
    })

    await applyTagTaxonomyBootstrap(projectPath, { now: () => 700 })
    const written = lastWrittenTaxonomy()
    mockProject({}, written)
    await rollbackLastTagTaxonomyBatch(projectPath, { now: () => 701 })

    expect(fsMocks.writeFileAtomic.mock.calls.every(([path]) => path === taxonomyPath)).toBe(true)
  })
})
