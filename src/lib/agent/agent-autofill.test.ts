import { describe, expect, it, vi, beforeEach } from "vitest"
import { runAutofill } from "./agent-autofill"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as unknown[],
  fileExists: vi.fn(async (path: string) => path === "/project/.llm-wiki/tag-taxonomy.json" && fsMock.files.has(path)),
  writeFileAtomic: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content)
  }),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: fsMock.fileExists,
  readFile: vi.fn(async (path: string) => {
    const value = fsMock.files.get(path)
    if (value === undefined) throw new Error(`missing file: ${path}`)
    return value
  }),
  listDirectory: vi.fn(async () => fsMock.tree),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content)
  }),
  writeFileAtomic: fsMock.writeFileAtomic,
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return { frontmatter: null, body: content, rawBlock: "" }
    const yaml = match[1]
    const body = match[2]
    const frontmatter: Record<string, string | string[]> = {}
    for (const line of yaml.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) {
        const key = m[1]
        let val: string | string[] = m[2].trim()
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
        } else {
          val = val.replace(/^"|"$/g, "")
        }
        frontmatter[key] = val
      }
    }
    return { frontmatter, body, rawBlock: match[0] }
  }),
}))

describe("runAutofill", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    vi.clearAllMocks()
    fsMock.fileExists.mockImplementation(async (path: string) => path === "/project/.llm-wiki/tag-taxonomy.json" && fsMock.files.has(path))
  })

  it("returns empty result when wiki directory is empty", async () => {
    fsMock.tree = []
    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(0)
    expect(result.statusPromoted).toBe(0)
    expect(result.tagsAssigned).toBe(0)
  })

  it("promotes Draft to Under Review when created ≥7 days ago and content is complete", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "concept.md", path: "/project/wiki/concept.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: Transformer
created: ${eightDaysAgo}
tags: []
status: Draft
---

# Transformer

## Definition

A neural network architecture based on self-attention.

## Key Points

- Enables parallel processing
- Used in [[GPT]] and [[BERT]]

`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.statusPromoted).toBe(1)
    expect(result.details[0]).toEqual({
      path: "concept",
      relativePath: "wiki/concept.md",
      action: "status",
      from: "draft",
      to: "Under Review",
    })
  })

  it("promotes to Reviewed when referenced by ≥2 summaries", async () => {
    fsMock.tree = [
      { name: "wiki", path: "/project/wiki", is_dir: true, children: [
        { name: "concept.md", path: "/project/wiki/concept.md", is_dir: false },
        { name: "sources", path: "/project/wiki/sources", is_dir: true, children: [
          { name: "source-a.md", path: "/project/wiki/sources/source-a.md", is_dir: false },
          { name: "source-b.md", path: "/project/wiki/sources/source-b.md", is_dir: false },
        ]},
      ]},
    ]

    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: Attention
created: 2026-01-01
tags: [ml]
status: Draft
---

# Attention

## Definition

A mechanism for focusing on relevant parts of input.

## Key Points

- Core of [[Transformer]]
`)

    fsMock.files.set("/project/wiki/sources/source-a.md", `---
type: source
title: Source A
---

# Source A

See [[concept]] for details.
`)

    fsMock.files.set("/project/wiki/sources/source-b.md", `---
type: source
title: Source B
---

# Source B

Based on [[concept]] research.
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.statusPromoted).toBe(1)
    expect(result.details[0]).toEqual({
      path: "concept",
      relativePath: "wiki/concept.md",
      action: "status",
      from: "draft",
      to: "Reviewed",
    })
  })

  it("assigns tags when empty", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "entity.md", path: "/project/wiki/entity.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/entity.md", `---
type: entity
title: GPT-4
created: 2026-01-01
tags: []
---

# GPT-4

## Definition

A large language model by OpenAI.

## Key Points

- Multimodal capabilities
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.tagsAssigned).toBe(1)
    expect(result.details[0].action).toBe("tags")
    expect(result.details[0].from).toBe("(empty)")
  })

  it("skips pages with existing tags", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "concept.md", path: "/project/wiki/concept.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: RAG
created: 2026-01-01
tags: [ai, retrieval]
---

# RAG

## Definition

Retrieval-Augmented Generation.

## Key Points

- Combines retrieval with generation
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.tagsAssigned).toBe(0)
  })

  it("skips non-concept/non-entity pages", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "source.md", path: "/project/wiki/source.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/source.md", `---
type: source
title: Source
created: 2026-01-01
tags: []
---

# Source

Some content.
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(0)
  })

  it("previews taxonomy-aware high-confidence tags without writing on dry-run", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "transformer.md", path: "/project/wiki/transformer.md", is_dir: false }] }]
    const original = `---
type: concept
title: Transformer
tags: []
---

# Transformer
`
    fsMock.files.set("/project/wiki/transformer.md", original)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify(taxonomyFixture()))

    const result = await runAutofill("/project", {
      dryRun: true,
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.tagsAssigned).toBe(1)
    expect(result.details[0]).toMatchObject({
      relativePath: "wiki/transformer.md",
      action: "tags",
      to: "Artificial Intelligence",
    })
    expect(result.taxonomy?.reports[0]?.suggestions[0]?.band).toBe("high")
    expect(fsMock.files.get("/project/wiki/transformer.md")).toBe(original)
  })

  it("defaults direct taxonomy-aware runs to effective dry-run without auto-write", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "transformer.md", path: "/project/wiki/transformer.md", is_dir: false }] }]
    const original = `---
type: concept
title: Transformer
created: 2026-01-01
tags: []
status: Draft
---

# Transformer

## Definition

A neural architecture.

## Key Points

- Used by [[Attention]]
`
    fsMock.files.set("/project/wiki/transformer.md", original)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify(taxonomyFixture()))

    const result = await runAutofill("/project", { taxonomyAware: true })

    expect(result.taxonomy?.dryRun).toBe(true)
    expect(result.taxonomy?.reports[0]?.suggestions[0]?.label).toBe("Artificial Intelligence")
    expect(result.statusPromoted).toBe(1)
    expect(result.details[0]).toMatchObject({
      relativePath: "wiki/transformer.md",
      action: "status",
      to: "Under Review",
    })
    expect(fsMock.files.get("/project/wiki/transformer.md")).toBe(original)
  })

  it("auto-writes high-confidence taxonomy labels when explicitly enabled", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "transformer.md", path: "/project/wiki/transformer.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/transformer.md", `---
type: concept
title: Transformer
tags: []
---

# Transformer
`)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify(taxonomyFixture()))

    const result = await runAutofill("/project", {
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.tagsAssigned).toBe(1)
    expect(fsMock.files.get("/project/wiki/transformer.md")).toContain('tags: ["Artificial Intelligence"]')
  })

  it("dedupes taxonomy labels against existing original tag text by slug", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "transformer.md", path: "/project/wiki/transformer.md", is_dir: false }] }]
    const original = `---
type: concept
title: Transformer
tags: [ai]
---

# Transformer
`
    fsMock.files.set("/project/wiki/transformer.md", original)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify(taxonomyFixture()))

    const result = await runAutofill("/project", {
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.tagsAssigned).toBe(0)
    expect(fsMock.files.get("/project/wiki/transformer.md")).toBe(original)
  })

  it("does not duplicate taxonomy labels on repeated auto-write runs", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "transformer.md", path: "/project/wiki/transformer.md", is_dir: false }] }]
    const original = `---
type: concept
title: Transformer
tags: ["Artificial Intelligence"]
---

# Transformer
`
    fsMock.files.set("/project/wiki/transformer.md", original)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify(taxonomyFixture()))

    const result = await runAutofill("/project", {
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.tagsAssigned).toBe(0)
    const content = fsMock.files.get("/project/wiki/transformer.md") ?? ""
    expect(content).toBe(original)
    expect(content.match(/Artificial Intelligence/g)).toHaveLength(1)
  })

  it("keeps low-confidence taxonomy matches out of writes and returns a proposal", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "quantum-pump.md", path: "/project/wiki/quantum-pump.md", is_dir: false }] }]
    const original = `---
type: concept
title: Quantum Pump
tags: []
---

# Quantum Pump
`
    fsMock.files.set("/project/wiki/quantum-pump.md", original)
    fsMock.files.set("/project/.llm-wiki/tag-taxonomy.json", JSON.stringify({
      ...taxonomyFixture(),
      tree: [{ ...taxonomyFixture().tree[0], children: [] }],
    }))

    const result = await runAutofill("/project", {
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.tagsAssigned).toBe(0)
    expect(result.taxonomy?.reports[0]?.band).toBe("low")
    expect(result.taxonomy?.proposalCount).toBeGreaterThan(0)
    expect(fsMock.files.get("/project/wiki/quantum-pump.md")).toBe(original)
    expect(fsMock.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("falls back to heuristic tag writes when taxonomy is missing", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "entity.md", path: "/project/wiki/entity.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/entity.md", `---
type: entity
title: GPT-4
tags: []
---

# GPT-4

## Definition

Large model.
`)

    const result = await runAutofill("/project", {
      taxonomyAware: true,
      autoWriteHighConfidence: true,
    })

    expect(result.taxonomy?.fallback).toBe(true)
    expect(result.tagsAssigned).toBe(1)
    expect(fsMock.files.get("/project/wiki/entity.md")).toContain('tags: ["gpt"]')
  })

  it("keeps taxonomy-aware missing-taxonomy fallback dry-run unless auto-write is enabled", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "entity.md", path: "/project/wiki/entity.md", is_dir: false }] }]
    const original = `---
type: entity
title: GPT-4
tags: []
---

# GPT-4

## Definition

Large model.
`
    fsMock.files.set("/project/wiki/entity.md", original)

    const result = await runAutofill("/project", { taxonomyAware: true })

    expect(result.taxonomy?.fallback).toBe(true)
    expect(result.taxonomy?.dryRun).toBe(true)
    expect(result.tagsAssigned).toBe(1)
    expect(result.details[0]).toMatchObject({
      relativePath: "wiki/entity.md",
      action: "tags",
      to: "gpt",
    })
    expect(fsMock.files.get("/project/wiki/entity.md")).toBe(original)
  })
})

function taxonomyFixture() {
  return {
    schemaVersion: 1,
    updatedAt: 1,
    safety: {
      maxL1: 12,
      maxL2PerL1: 12,
      maxL3PerL2: 16,
      maxTotalNodes: 500,
      maxNewNodesPerRun: 60,
      allowNewL1ByDefault: false,
    },
    tree: [{
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
    }],
    changeLog: [],
  }
}
