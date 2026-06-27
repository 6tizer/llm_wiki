import type { MineruConfig } from "@/stores/wiki-store"

export const MINERU_DEFAULT_POLL_INTERVAL_MS = 3_000
export const MINERU_DEFAULT_POLL_TIMEOUT_MS = 300_000
export const MINERU_MIN_POLL_INTERVAL_MS = 500
export const MINERU_MAX_POLL_INTERVAL_MS = 30_000
export const MINERU_MIN_POLL_TIMEOUT_MS = 60_000
export const MINERU_MAX_POLL_TIMEOUT_MS = 1_800_000

export function clampMineruPollIntervalMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return MINERU_DEFAULT_POLL_INTERVAL_MS
  return Math.max(
    MINERU_MIN_POLL_INTERVAL_MS,
    Math.min(MINERU_MAX_POLL_INTERVAL_MS, Math.round(parsed)),
  )
}

export function clampMineruPollTimeoutMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return MINERU_DEFAULT_POLL_TIMEOUT_MS
  return Math.max(
    MINERU_MIN_POLL_TIMEOUT_MS,
    Math.min(MINERU_MAX_POLL_TIMEOUT_MS, Math.round(parsed)),
  )
}

export function normalizeMineruConfig(config: Partial<MineruConfig> | null | undefined): MineruConfig {
  return {
    enabled: config?.enabled === true,
    token: typeof config?.token === "string" ? config.token : "",
    modelVersion: config?.modelVersion === "pipeline" ? "pipeline" : "vlm",
    apiBaseUrl: typeof config?.apiBaseUrl === "string" ? config.apiBaseUrl : "",
    pollIntervalMs: clampMineruPollIntervalMs(config?.pollIntervalMs),
    pollTimeoutMs: clampMineruPollTimeoutMs(config?.pollTimeoutMs),
  }
}
