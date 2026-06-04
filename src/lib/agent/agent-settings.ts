import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

export interface AgentResourceConfig {
  maxTurns: number
  maxFilesChanged: number
  maxWriteBytes: number
}

// Keep these defaults in sync with the sidecar defaults in core.ts and wiki-tools.ts.
export const DEFAULT_AGENT_RESOURCE_CONFIG: AgentResourceConfig = {
  maxTurns: 30,
  maxFilesChanged: 10,
  maxWriteBytes: 256 * 1024,
}

const AGENT_SETTINGS_REL_PATH = ".llm-wiki/agent-settings.json"

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = finiteNumber(value)
  if (numeric === undefined) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
}

export function normalizeAgentResourceConfig(
  config?: Partial<AgentResourceConfig> | null,
): AgentResourceConfig {
  return {
    maxTurns: clampInteger(
      config?.maxTurns,
      DEFAULT_AGENT_RESOURCE_CONFIG.maxTurns,
      1,
      200,
    ),
    maxFilesChanged: clampInteger(
      config?.maxFilesChanged,
      DEFAULT_AGENT_RESOURCE_CONFIG.maxFilesChanged,
      1,
      200,
    ),
    maxWriteBytes: clampInteger(
      config?.maxWriteBytes,
      DEFAULT_AGENT_RESOURCE_CONFIG.maxWriteBytes,
      1024,
      10 * 1024 * 1024,
    ),
  }
}

export function agentSettingsPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${AGENT_SETTINGS_REL_PATH}`
}

export async function loadAgentResourceConfig(
  projectPath: string,
): Promise<AgentResourceConfig> {
  const settingsPath = agentSettingsPath(projectPath)
  try {
    if (!(await fileExists(settingsPath))) {
      return DEFAULT_AGENT_RESOURCE_CONFIG
    }
    const parsed = JSON.parse(await readFile(settingsPath)) as unknown
    return normalizeAgentResourceConfig(
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Partial<AgentResourceConfig>)
        : undefined,
    )
  } catch {
    return DEFAULT_AGENT_RESOURCE_CONFIG
  }
}

export async function saveAgentResourceConfig(
  projectPath: string,
  config: Partial<AgentResourceConfig>,
): Promise<AgentResourceConfig> {
  const normalized = normalizeAgentResourceConfig(config)
  const projectRoot = normalizePath(projectPath)
  await createDirectory(`${projectRoot}/.llm-wiki`)
  await writeFileAtomic(
    agentSettingsPath(projectRoot),
    `${JSON.stringify(normalized, null, 2)}\n`,
  )
  return normalized
}
