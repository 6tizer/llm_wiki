import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { AgentPermissionPolicy } from "./agent-types"
import { normalizePath } from "@/lib/path-utils"

export interface AgentResourceConfig {
  maxTurns: number
  maxFilesChanged: number
  /**
   * Opt-in flag for stricter app-tool file-count budget enforcement.
   *
   * Default false means maxFilesChanged is advisory configuration only:
   * app-tool writes still track changed paths, but do not emit a
   * max_files_changed resource_limit. When true, both frontend app tools
   * and the sidecar enforce maxFilesChanged before/after writes.
   */
  maxFilesChangedEnabled: boolean
  maxWriteBytes: number
  defaultPermissionPolicy: AgentPermissionPolicy
}

// Keep these defaults in sync with the sidecar defaults in core.ts and wiki-tools.ts.
export const DEFAULT_AGENT_RESOURCE_CONFIG: AgentResourceConfig = {
  maxTurns: 30,
  maxFilesChanged: 10,
  maxFilesChangedEnabled: false,
  maxWriteBytes: 256 * 1024,
  defaultPermissionPolicy: "default",
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

const AGENT_PERMISSION_POLICIES = new Set<AgentPermissionPolicy>([
  "default",
  "restricted",
  "bypassPermissions",
])

function normalizeAgentPermissionPolicy(value: unknown): AgentPermissionPolicy {
  return typeof value === "string" &&
    AGENT_PERMISSION_POLICIES.has(value as AgentPermissionPolicy)
    ? (value as AgentPermissionPolicy)
    : DEFAULT_AGENT_RESOURCE_CONFIG.defaultPermissionPolicy
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
    maxFilesChangedEnabled:
      config?.maxFilesChangedEnabled === true,
    maxWriteBytes: clampInteger(
      config?.maxWriteBytes,
      DEFAULT_AGENT_RESOURCE_CONFIG.maxWriteBytes,
      1024,
      10 * 1024 * 1024,
    ),
    defaultPermissionPolicy: normalizeAgentPermissionPolicy(
      config?.defaultPermissionPolicy,
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
