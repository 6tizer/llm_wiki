import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  KNOWLEDGE_AGENT_IDS,
  defaultKnowledgeAgentsConfig,
  isKnowledgeAgentsConfigStale,
  knowledgeAgentsConfigPath,
  loadKnowledgeAgentsConfig,
  normalizeKnowledgeAgentsConfig,
  saveKnowledgeAgentsConfig,
} from "./knowledge-agents-config"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string) => false),
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

describe("knowledge agents config", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockResolvedValue("")
  })

  it("returns deterministic defaults when the config file is missing", async () => {
    await expect(loadKnowledgeAgentsConfig("/project")).resolves.toEqual({
      config: defaultKnowledgeAgentsConfig(),
      issues: [],
      conflict: false,
    })
  })

  it("builds config paths without duplicate separators after trailing slashes", () => {
    expect(knowledgeAgentsConfigPath("/project/")).toBe("/project/.llm-wiki/knowledge-agents.json")
    expect(knowledgeAgentsConfigPath("C:\\project\\")).toBe("C:/project/.llm-wiki/knowledge-agents.json")
  })

  it("falls back with an issue for bad JSON, array roots, and null roots", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValueOnce("{bad")
    expect((await loadKnowledgeAgentsConfig("/project")).issues[0]?.code).toBe("bad_json")

    expect(normalizeKnowledgeAgentsConfig([]).issues[0]?.code).toBe("invalid_root")
    expect(normalizeKnowledgeAgentsConfig(null).issues[0]?.code).toBe("invalid_root")
  })

  it("treats future schemaVersion as a conflict and save refuses to overwrite it", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: 2,
      updatedAt: 10,
      agents: {},
    }))

    const loaded = await loadKnowledgeAgentsConfig("/project")
    expect(loaded.conflict).toBe(true)
    expect(loaded.issues[0]?.code).toBe("future_schema_version")

    const saved = await saveKnowledgeAgentsConfig("/project", defaultKnowledgeAgentsConfig(), {
      now: () => 123,
    })
    expect(saved.saved).toBe(false)
    expect(saved.conflict).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("treats invalid non-future schemaVersion as a non-conflicting fallback", () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 0,
      updatedAt: 10,
      agents: {},
    })

    expect(normalized.conflict).toBe(false)
    expect(normalized.config).toEqual(defaultKnowledgeAgentsConfig())
    expect(normalized.issues).toEqual([
      expect.objectContaining({
        code: "invalid_schema_version",
        path: "schemaVersion",
      }),
    ])
  })

  it("falls back to deterministic updatedAt when updatedAt is invalid", () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 1,
      updatedAt: "now",
      agents: Object.fromEntries(KNOWLEDGE_AGENT_IDS.map((id) => [id, { enabled: true }])),
    })

    expect(normalized.config.updatedAt).toBe(0)
    expect(normalized.issues.some((item) => item.code === "invalid_updated_at")).toBe(true)
  })

  it("fills missing agent entries and keeps the frozen agent id set exact", () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 1,
      updatedAt: 1,
      agents: {
        compiler: { enabled: true, autoRun: true },
      },
    })

    expect(Object.keys(normalized.config.agents).sort()).toEqual([...KNOWLEDGE_AGENT_IDS].sort())
    expect(normalized.config.agents.compiler).toEqual({ enabled: true, autoRun: true })
    expect(normalized.config.agents.linter).toEqual({ enabled: false, autoRun: false })
    expect(normalized.issues.some((item) => item.code === "missing_agent")).toBe(true)
  })

  it("strictly validates enabled and autoRun booleans", () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 1,
      updatedAt: 1,
      agents: Object.fromEntries(KNOWLEDGE_AGENT_IDS.map((id) => [
        id,
        { enabled: "yes", autoRun: 1 },
      ])),
    })

    expect(normalized.config.agents.compiler).toEqual({ enabled: false, autoRun: false })
    expect(normalized.issues.some((item) => item.code === "invalid_enabled")).toBe(true)
    expect(normalized.issues.some((item) => item.code === "invalid_auto_run")).toBe(true)
  })

  it("requires enabled and autoRun booleans and defaults missing fields to false", () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 1,
      updatedAt: 1,
      agents: Object.fromEntries(KNOWLEDGE_AGENT_IDS.map((id) => [id, {}])),
    })

    expect(normalized.config.agents.compiler).toEqual({ enabled: false, autoRun: false })
    expect(normalized.issues.filter((item) => item.code === "invalid_enabled")).toHaveLength(KNOWLEDGE_AGENT_IDS.length)
    expect(normalized.issues.filter((item) => item.code === "invalid_auto_run")).toHaveLength(KNOWLEDGE_AGENT_IDS.length)
  })

  it("drops unknown agent ids and save does not preserve them", async () => {
    const normalized = normalizeKnowledgeAgentsConfig({
      schemaVersion: 1,
      updatedAt: 1,
      agents: {
        ...Object.fromEntries(KNOWLEDGE_AGENT_IDS.map((id) => [id, { enabled: false }])),
        rogue: { enabled: true },
      },
    })

    expect("rogue" in normalized.config.agents).toBe(false)
    expect(normalized.issues.some((item) => item.code === "unknown_agent")).toBe(true)

    await saveKnowledgeAgentsConfig("/project", {
      ...normalized.config,
      agents: {
        ...normalized.config.agents,
        rogue: { enabled: true, autoRun: true },
      } as never,
    }, { now: () => 456 })

    const content = fsMocks.writeFileAtomic.mock.calls[0]?.[1] ?? ""
    expect(content).not.toContain("rogue")
  })

  it("saves pretty atomic JSON with newline under .llm-wiki using injected now", async () => {
    const config = defaultKnowledgeAgentsConfig()
    config.agents.compiler.enabled = true

    const saved = await saveKnowledgeAgentsConfig("/project", config, { now: () => 123 })

    expect(saved.saved).toBe(true)
    expect(saved.config.updatedAt).toBe(123)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      knowledgeAgentsConfigPath("/project"),
      `${JSON.stringify(saved.config, null, 2)}\n`,
    )
  })

  it("saves without expectedUpdatedAt when the current config exists", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(defaultKnowledgeAgentsConfig(10)))
    const config = defaultKnowledgeAgentsConfig(1)
    config.agents.compiler.enabled = true

    const saved = await saveKnowledgeAgentsConfig("/project", config, { now: () => 321 })

    expect(saved.saved).toBe(true)
    expect(saved.conflict).toBe(false)
    expect(saved.config.updatedAt).toBe(321)
    expect(saved.config.agents.compiler.enabled).toBe(true)
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("dirty-check covers same, mismatch, missing, and invalid updatedAt values", () => {
    expect(isKnowledgeAgentsConfigStale(1, 1)).toBe(false)
    expect(isKnowledgeAgentsConfigStale(1, 2)).toBe(true)
    expect(isKnowledgeAgentsConfigStale(undefined, 1)).toBe(true)
    expect(isKnowledgeAgentsConfigStale(1, undefined)).toBe(true)
    expect(isKnowledgeAgentsConfigStale("1", 1)).toBe(true)
    expect(isKnowledgeAgentsConfigStale(1, Number.NaN)).toBe(true)
  })
})
