import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_AGENT_RESOURCE_CONFIG,
  agentSettingsPath,
  loadAgentResourceConfig,
  normalizeAgentResourceConfig,
  saveAgentResourceConfig,
} from "./agent-settings"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => undefined),
  fileExists: vi.fn(async () => false),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

describe("agent resource settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockResolvedValue("")
  })

  it("returns defaults when settings file is missing", async () => {
    await expect(loadAgentResourceConfig("/project")).resolves.toEqual(
      DEFAULT_AGENT_RESOURCE_CONFIG,
    )
  })

  it("returns defaults when settings file is corrupt", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("{not json")

    await expect(loadAgentResourceConfig("/project")).resolves.toEqual(
      DEFAULT_AGENT_RESOURCE_CONFIG,
    )
  })

  it("normalizes invalid and missing fields", () => {
    expect(
      normalizeAgentResourceConfig({
        maxTurns: 0,
        maxFilesChanged: 9999,
        maxWriteBytes: Number.NaN,
      }),
    ).toEqual({
      maxTurns: 1,
      maxFilesChanged: 200,
      maxWriteBytes: DEFAULT_AGENT_RESOURCE_CONFIG.maxWriteBytes,
    })
  })

  it("saves normalized settings under .llm-wiki/agent-settings.json", async () => {
    const saved = await saveAgentResourceConfig("/project", {
      maxTurns: 40,
      maxFilesChanged: 12,
      maxWriteBytes: 512 * 1024,
    })

    expect(saved).toEqual({
      maxTurns: 40,
      maxFilesChanged: 12,
      maxWriteBytes: 512 * 1024,
    })
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/.llm-wiki")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      agentSettingsPath("/project"),
      `${JSON.stringify(saved, null, 2)}\n`,
    )
  })
})
