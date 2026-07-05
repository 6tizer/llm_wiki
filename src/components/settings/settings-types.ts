import type { MineruModelVersion, SourceWatchConfig } from "@/stores/wiki-store"
import type { AppTheme } from "@/lib/theme"
import type { CloseBehavior } from "@/lib/project-store"
import type { AgentPermissionPolicy } from "@/lib/agent/agent-types"

/**
 * Shape of the draft state each section reads from and writes into.
 * The parent (SettingsView) owns one instance and hands it to every
 * section; the Save button at the bottom flushes the whole draft to
 * stores + disk in one commit.
 */
export interface SettingsDraft {
  // Output preferences
  outputLanguage: string
  maxHistoryMessages: number

  // Network — global outbound HTTP proxy. Persisted to app-state.json
  // and read by the Rust setup hook on app launch (changes apply
  // after restart). See src/lib/proxy-config.ts.
  proxyEnabled: boolean
  proxyUrl: string
  proxyBypassLocal: boolean

  // Scheduled Import
  scheduledImportEnabled: boolean
  scheduledImportPath: string
  scheduledImportInterval: number // minutes

  // UI
  uiLanguage: string
  zoomLevel: number
  theme: AppTheme

  // General app behavior
  closeBehavior: CloseBehavior

  // Source folder auto watch
  sourceWatchConfig: SourceWatchConfig

  // MinerU PDF parsing
  mineruEnabled: boolean
  mineruToken: string
  mineruModelVersion: MineruModelVersion
  mineruApiBaseUrl: string
  mineruPollIntervalSeconds: number
  mineruPollTimeoutMinutes: number

  // Local HTTP API server
  apiEnabled: boolean
  apiAllowUnauthenticated: boolean
  apiMcpEnabled: boolean
  apiToken: string

  // Per-project Agent resource limits
  agentMaxTurns: number
  agentMaxFilesChanged: number
  agentMaxWriteKiB: number
  agentDefaultPermissionPolicy: AgentPermissionPolicy
}

export type DraftSetter = <K extends keyof SettingsDraft>(
  key: K,
  value: SettingsDraft[K],
) => void
