import { fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { clampAgentGuidance } from "@/lib/agent/prompt-registry"
import { normalizePath } from "@/lib/path-utils"

export const KNOWLEDGE_AGENTS_SCHEMA_VERSION = 2

export const KNOWLEDGE_AGENT_IDS = [
  "compiler",
  "linter",
  "fixer",
  "synthesizer",
  "tagger",
  "qa-saver",
] as const

export type KnowledgeAgentId = typeof KNOWLEDGE_AGENT_IDS[number]

export interface KnowledgeAgentSettings {
  enabled: boolean
  autoRun: boolean
  guidance: string
}

export type KnowledgeAgentsById = Record<KnowledgeAgentId, KnowledgeAgentSettings>

export interface KnowledgeAgentsConfig {
  schemaVersion: typeof KNOWLEDGE_AGENTS_SCHEMA_VERSION
  updatedAt: number
  agents: KnowledgeAgentsById
}

export interface KnowledgeAgentsConfigIssue {
  code:
    | "bad_json"
    | "invalid_root"
    | "invalid_schema_version"
    | "future_schema_version"
    | "invalid_updated_at"
    | "invalid_agents"
    | "missing_agent"
    | "invalid_agent"
    | "invalid_enabled"
    | "invalid_auto_run"
    | "invalid_guidance"
    | "unknown_agent"
    | "stale_updated_at"
  path?: string
  message: string
}

export interface LoadKnowledgeAgentsConfigResult {
  config: KnowledgeAgentsConfig
  issues: KnowledgeAgentsConfigIssue[]
  conflict: boolean
}

export interface SaveKnowledgeAgentsConfigOptions {
  expectedUpdatedAt?: unknown
  now?: () => number
}

export interface SaveKnowledgeAgentsConfigResult extends LoadKnowledgeAgentsConfigResult {
  saved: boolean
}

const KNOWLEDGE_AGENTS_REL_PATH = ".llm-wiki/knowledge-agents.json"
const DEFAULT_UPDATED_AT = 0

function projectRelativePath(projectPath: string, relativePath: string): string {
  const normalized = normalizePath(projectPath).replace(/\/+$/, "")
  return normalized ? `${normalized}/${relativePath}` : `/${relativePath}`
}

function issue(
  code: KnowledgeAgentsConfigIssue["code"],
  message: string,
  path?: string,
): KnowledgeAgentsConfigIssue {
  return { code, message, path }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isValidUpdatedAt(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    Math.trunc(value) === value
}

function defaultAgentSettings(): KnowledgeAgentSettings {
  return { enabled: false, autoRun: false, guidance: "" }
}

/** Returns the frozen default Knowledge Agents config for a project. */
export function defaultKnowledgeAgentsConfig(
  updatedAt = DEFAULT_UPDATED_AT,
): KnowledgeAgentsConfig {
  return {
    schemaVersion: KNOWLEDGE_AGENTS_SCHEMA_VERSION,
    updatedAt,
    agents: Object.fromEntries(
      KNOWLEDGE_AGENT_IDS.map((id) => [id, defaultAgentSettings()]),
    ) as KnowledgeAgentsById,
  }
}

/** Returns the project-relative Knowledge Agents config path. */
export function knowledgeAgentsConfigPath(projectPath: string): string {
  return projectRelativePath(projectPath, KNOWLEDGE_AGENTS_REL_PATH)
}

/** Checks whether an inline-edit save should be rejected for stale data. */
export function isKnowledgeAgentsConfigStale(
  expectedUpdatedAt: unknown,
  currentUpdatedAt: unknown,
): boolean {
  return !isValidUpdatedAt(expectedUpdatedAt) ||
    !isValidUpdatedAt(currentUpdatedAt) ||
    expectedUpdatedAt !== currentUpdatedAt
}

/** Normalizes persisted Knowledge Agents config without preserving unknown agents. */
export function normalizeKnowledgeAgentsConfig(
  raw: unknown,
): LoadKnowledgeAgentsConfigResult {
  const issues: KnowledgeAgentsConfigIssue[] = []
  const fallback = defaultKnowledgeAgentsConfig()

  if (!isPlainObject(raw)) {
    return {
      config: fallback,
      issues: [issue("invalid_root", "Knowledge Agents config must be an object.")],
      conflict: false,
    }
  }

  const schemaVersion = raw.schemaVersion
  if (typeof schemaVersion === "number" && schemaVersion > KNOWLEDGE_AGENTS_SCHEMA_VERSION) {
    return {
      config: fallback,
      issues: [
        issue(
          "future_schema_version",
          `Knowledge Agents config schemaVersion ${schemaVersion} is newer than this app supports.`,
          "schemaVersion",
        ),
      ],
      conflict: true,
    }
  }

  const canMigrateV1 = schemaVersion === 1
  if (schemaVersion !== KNOWLEDGE_AGENTS_SCHEMA_VERSION && !canMigrateV1) {
    issues.push(issue("invalid_schema_version", "Knowledge Agents config schemaVersion must be 2.", "schemaVersion"))
    return { config: fallback, issues, conflict: false }
  }

  const updatedAt = isValidUpdatedAt(raw.updatedAt)
    ? raw.updatedAt
    : DEFAULT_UPDATED_AT
  if (!isValidUpdatedAt(raw.updatedAt)) {
    issues.push(issue("invalid_updated_at", "Knowledge Agents config updatedAt must be an epoch-ms number.", "updatedAt"))
  }

  const agentsRaw = raw.agents
  const agentsContainer = isPlainObject(agentsRaw) ? agentsRaw : {}
  if (!isPlainObject(agentsRaw)) {
    issues.push(issue("invalid_agents", "Knowledge Agents config agents must be an object.", "agents"))
  }

  const allowedIds = new Set<string>(KNOWLEDGE_AGENT_IDS)
  for (const id of Object.keys(agentsContainer)) {
    if (!allowedIds.has(id)) {
      issues.push(issue("unknown_agent", `Unknown Knowledge Agent id "${id}" was ignored.`, `agents.${id}`))
    }
  }

  const agents = { ...fallback.agents }
  for (const id of KNOWLEDGE_AGENT_IDS) {
    if (!(id in agentsContainer)) {
      issues.push(issue("missing_agent", `Knowledge Agent "${id}" is missing and was defaulted.`, `agents.${id}`))
      continue
    }

    const agentRaw = agentsContainer[id]
    if (!isPlainObject(agentRaw)) {
      issues.push(issue("invalid_agent", `Knowledge Agent "${id}" must be an object.`, `agents.${id}`))
      continue
    }

    let enabled = defaultAgentSettings().enabled
    if (agentRaw.enabled === true || agentRaw.enabled === false) {
      enabled = agentRaw.enabled
    } else {
      issues.push(issue("invalid_enabled", `Knowledge Agent "${id}" enabled must be boolean.`, `agents.${id}.enabled`))
    }

    let autoRun = defaultAgentSettings().autoRun
    if (agentRaw.autoRun === true || agentRaw.autoRun === false) {
      autoRun = agentRaw.autoRun
    } else {
      issues.push(issue("invalid_auto_run", `Knowledge Agent "${id}" autoRun must be boolean.`, `agents.${id}.autoRun`))
    }

    let guidance = ""
    if (typeof agentRaw.guidance === "string") {
      guidance = clampAgentGuidance(agentRaw.guidance)
    } else if (!canMigrateV1) {
      issues.push(issue("invalid_guidance", `Knowledge Agent "${id}" guidance must be a string.`, `agents.${id}.guidance`))
    }

    agents[id] = { enabled, autoRun, guidance }
  }

  return {
    config: {
      schemaVersion: KNOWLEDGE_AGENTS_SCHEMA_VERSION,
      updatedAt,
      agents,
    },
    issues,
    conflict: false,
  }
}

/** Loads project Knowledge Agents config, falling back safely on missing or invalid files. */
export async function loadKnowledgeAgentsConfig(
  projectPath: string,
): Promise<LoadKnowledgeAgentsConfigResult> {
  const configPath = knowledgeAgentsConfigPath(projectPath)
  try {
    if (!(await fileExists(configPath))) {
      return {
        config: defaultKnowledgeAgentsConfig(),
        issues: [],
        conflict: false,
      }
    }

    return normalizeKnowledgeAgentsConfig(JSON.parse(await readFile(configPath)) as unknown)
  } catch {
    return {
      config: defaultKnowledgeAgentsConfig(),
      issues: [issue("bad_json", "Knowledge Agents config could not be parsed.")],
      conflict: false,
    }
  }
}

/** Saves Knowledge Agents config with optional updatedAt conflict protection. */
export async function saveKnowledgeAgentsConfig(
  projectPath: string,
  config: KnowledgeAgentsConfig,
  options: SaveKnowledgeAgentsConfigOptions = {},
): Promise<SaveKnowledgeAgentsConfigResult> {
  const current = await loadKnowledgeAgentsConfig(projectPath)
  if (current.conflict) {
    return { ...current, saved: false }
  }

  if (
    options.expectedUpdatedAt !== undefined &&
    isKnowledgeAgentsConfigStale(options.expectedUpdatedAt, current.config.updatedAt)
  ) {
    return {
      config: current.config,
      issues: [
        ...current.issues,
        issue("stale_updated_at", "Knowledge Agents config changed on disk.", "updatedAt"),
      ],
      conflict: true,
      saved: false,
    }
  }

  const normalized = normalizeKnowledgeAgentsConfig({
    schemaVersion: KNOWLEDGE_AGENTS_SCHEMA_VERSION,
    updatedAt: options.now?.() ?? Date.now(),
    agents: config.agents,
  })

  await writeFileAtomic(
    knowledgeAgentsConfigPath(projectPath),
    `${JSON.stringify(normalized.config, null, 2)}\n`,
  )

  return {
    config: normalized.config,
    issues: normalized.issues,
    conflict: false,
    saved: true,
  }
}
