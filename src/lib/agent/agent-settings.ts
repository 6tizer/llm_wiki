import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import type { AgentPermissionPolicy } from "./agent-types"
import { normalizePath } from "@/lib/path-utils"

export interface AgentResourceConfig {
  maxTurns: number
  maxFilesChanged: number
  /**
   * Opt-in flag for stricter app-tool file-count budget enforcement.
   *
   * STATUS (2026-06): PLUMBING ONLY — no production code path reads this
   * flag yet. It is threaded through all 4 config layers (settings →
   * transport → agent.rs → sidecar core/wiki-tools/app-tool-bridge) so a
   * follow-up can wire the fan-out app tools (wiki_synthesis,
   * run_lint_and_report, caption_source_images) to a true path-enumerating
   * preflight when set. Today the fan-out tools' preflight
   * (`preflightUnknownWriteBudget`) is unchanged regardless of this flag,
   * because those tools cannot enumerate their target paths before
   * running. The settings save path preserves the current value so a
   * hand-edited `true` isn't silently reset.
   *
   * Default false → historical behavior (post-write enforcement + weak
   * preflight). See #119 P0-3.
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
