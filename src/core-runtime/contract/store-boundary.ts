export type StoreBoundaryOwner =
  | "ui-shell"
  | "platform-adapter"
  | "storage-boundary"
  | "profiles"
  | "project-family"
  | "job-runtime-family"
  | "settings-status-family"
  | "derived-family"

export type StoreBoundaryCategory =
  | "rust-locked-app-setting"
  | "rust-locked-nested-setting"
  | "rust-locked-project-setting"
  | "app-ui-preference"
  | "profile-or-provider-setting"
  | "secret-bearing-setting"
  | "project-identity"
  | "project-scoped-setting"
  | "legacy-compatibility-key"
  | "zustand-ui-view-state"
  | "zustand-persisted-setting-mirror"
  | "zustand-project-session-mirror"
  | "zustand-update-session-state"
  | "runtime-state-deferred"

export type StoreBoundarySurface =
  | "app-state.json"
  | "zustand"
  | "zustand+localStorage"
  | "project-path-key"
  | "project-identity-file"
  | "runtime-db-deferred"

export type StoreBoundaryEntryId =
  | "rust-language"
  | "rust-close-behavior"
  | "rust-proxy-config"
  | "rust-api-config"
  | "rust-api-config-enabled"
  | "rust-api-config-allow-unauthenticated"
  | "rust-api-config-token"
  | "rust-api-config-mcp-enabled"
  | "rust-project-registry"
  | "rust-recent-projects"
  | "rust-embedding-config"
  | "rust-source-watch-config"
  | "rust-project-file-sync-enabled"
  | "ui-theme"
  | "ui-zoom-level"
  | "ui-sidebar-collapsed"
  | "update-check-persisted-state"
  | "update-check-session-state"
  | "model-provider-config"
  | "search-embedding-multimodal-mineru-config"
  | "project-recents-last-project"
  | "project-registry"
  | "project-output-language"
  | "project-file-sync-source-watch"
  | "scheduled-import-project-config"
  | "scheduled-import-legacy-global-key"
  | "wiki-store-ui-view-state"
  | "wiki-store-persisted-setting-mirrors"
  | "wiki-store-project-session-mirrors"
  | "runtime-job-state-deferred"

export type StoreBoundaryEntry = {
  readonly id: StoreBoundaryEntryId
  readonly currentSurface: StoreBoundarySurface
  readonly currentKeys: readonly string[]
  readonly nestedKeys?: readonly string[]
  readonly owner: StoreBoundaryOwner
  readonly category: StoreBoundaryCategory
  readonly rustLocked: boolean
  readonly crossLanguageReadByRust: boolean
  readonly secretBearing: boolean
  readonly projectScoped: boolean
  readonly migrationRule: string
  readonly compatibilityNote: string
}

export const PR1_ADR_MINIMUM_STORAGE_LOCK_KEYS = [
  "language",
  "closeBehavior",
  "proxyConfig",
  "apiConfig",
  "apiConfig.mcpEnabled",
] as const

export const PR4_DISCOVERED_RUST_READ_APP_STATE_KEYS = [
  "apiConfig.enabled",
  "apiConfig.allowUnauthenticated",
  "apiConfig.token",
  "apiConfig.mcpEnabled",
  "projectRegistry",
  "recentProjects",
  "embeddingConfig",
  "sourceWatchConfig",
  "projectFileSyncEnabled",
  "proxyConfig",
  "language",
  "closeBehavior",
] as const

export const STORE_BOUNDARY_ENTRIES: readonly StoreBoundaryEntry[] = [
  {
    id: "rust-language",
    currentSurface: "app-state.json",
    currentKeys: ["language"],
    owner: "platform-adapter",
    category: "rust-locked-app-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve app-state key until a Rust compatibility adapter ships",
    compatibilityNote: "Rust reads language for tray labels.",
  },
  {
    id: "rust-close-behavior",
    currentSurface: "app-state.json",
    currentKeys: ["closeBehavior"],
    owner: "platform-adapter",
    category: "rust-locked-app-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve app-state key until a Rust compatibility adapter ships",
    compatibilityNote: "Rust reads closeBehavior for titlebar close handling.",
  },
  {
    id: "rust-proxy-config",
    currentSurface: "app-state.json",
    currentKeys: ["proxyConfig"],
    owner: "platform-adapter",
    category: "rust-locked-app-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve app-state key until a Rust compatibility adapter ships",
    compatibilityNote: "Rust setup reads proxyConfig to apply HTTP proxy environment.",
  },
  {
    id: "rust-api-config",
    currentSurface: "app-state.json",
    currentKeys: ["apiConfig"],
    nestedKeys: ["enabled", "allowUnauthenticated", "token", "mcpEnabled"],
    owner: "platform-adapter",
    category: "rust-locked-app-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "preserve app-state object shape until a Rust compatibility adapter ships",
    compatibilityNote: "Rust local API reads nested apiConfig fields on auth/status paths.",
  },
  {
    id: "rust-api-config-enabled",
    currentSurface: "app-state.json",
    currentKeys: ["apiConfig.enabled"],
    nestedKeys: ["enabled"],
    owner: "platform-adapter",
    category: "rust-locked-nested-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve nested field under apiConfig",
    compatibilityNote: "Rust uses enabled as the local API kill switch.",
  },
  {
    id: "rust-api-config-allow-unauthenticated",
    currentSurface: "app-state.json",
    currentKeys: ["apiConfig.allowUnauthenticated"],
    nestedKeys: ["allowUnauthenticated"],
    owner: "platform-adapter",
    category: "rust-locked-nested-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve nested field under apiConfig",
    compatibilityNote: "Rust uses allowUnauthenticated to bypass local API auth.",
  },
  {
    id: "rust-api-config-token",
    currentSurface: "app-state.json",
    currentKeys: ["apiConfig.token"],
    nestedKeys: ["token"],
    owner: "platform-adapter",
    category: "rust-locked-nested-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "preserve nested field or add Rust secret compatibility adapter first",
    compatibilityNote: "Rust reads token for local API bearer authentication.",
  },
  {
    id: "rust-api-config-mcp-enabled",
    currentSurface: "app-state.json",
    currentKeys: ["apiConfig.mcpEnabled"],
    nestedKeys: ["mcpEnabled"],
    owner: "platform-adapter",
    category: "rust-locked-nested-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve nested field under apiConfig",
    compatibilityNote: "Rust exposes MCP capability metadata from apiConfig.mcpEnabled.",
  },
  {
    id: "rust-project-registry",
    currentSurface: "app-state.json",
    currentKeys: ["projectRegistry"],
    owner: "project-family",
    category: "project-identity",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve registry or add Rust project identity compatibility adapter first",
    compatibilityNote: "Rust local API reads projectRegistry for project listing.",
  },
  {
    id: "rust-recent-projects",
    currentSurface: "app-state.json",
    currentKeys: ["recentProjects"],
    owner: "project-family",
    category: "project-identity",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve recentProjects or add Rust project listing compatibility adapter first",
    compatibilityNote: "Rust local API falls back to recentProjects when building project list.",
  },
  {
    id: "rust-embedding-config",
    currentSurface: "app-state.json",
    currentKeys: ["embeddingConfig"],
    owner: "derived-family",
    category: "rust-locked-app-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "preserve app-state key until search API can resolve config through a stable adapter",
    compatibilityNote: "Rust local API reads embeddingConfig for backend search; embeddingConfig can contain an apiKey.",
  },
  {
    id: "rust-source-watch-config",
    currentSurface: "app-state.json",
    currentKeys: ["sourceWatchConfig"],
    owner: "platform-adapter",
    category: "rust-locked-project-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "preserve projectId/default keyed map until Rust file-sync compatibility exists",
    compatibilityNote: "Rust local API reads sourceWatchConfig by project id or default.",
  },
  {
    id: "rust-project-file-sync-enabled",
    currentSurface: "app-state.json",
    currentKeys: ["projectFileSyncEnabled"],
    owner: "platform-adapter",
    category: "rust-locked-project-setting",
    rustLocked: true,
    crossLanguageReadByRust: true,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "preserve legacy projectId/default keyed map until sourceWatchConfig migration is complete",
    compatibilityNote: "Rust local API reads projectFileSyncEnabled as legacy source-watch fallback.",
  },
  {
    id: "ui-theme",
    currentSurface: "app-state.json",
    currentKeys: ["theme"],
    owner: "ui-shell",
    category: "app-ui-preference",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "keep as UI shell preference unless native shell adapter owns it later",
    compatibilityNote: "Current TypeScript shell applies theme locally.",
  },
  {
    id: "ui-zoom-level",
    currentSurface: "app-state.json",
    currentKeys: ["zoomLevel"],
    owner: "ui-shell",
    category: "app-ui-preference",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "keep as UI shell preference",
    compatibilityNote: "DOM zoom remains UI shell state.",
  },
  {
    id: "ui-sidebar-collapsed",
    currentSurface: "zustand+localStorage",
    currentKeys: ["sidebarCollapsed", "llmwiki.sidebarCollapsed"],
    owner: "ui-shell",
    category: "app-ui-preference",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "keep as browser-local UI shell preference unless native shell adapter owns it later",
    compatibilityNote: "Zustand field sidebarCollapsed mirrors localStorage key llmwiki.sidebarCollapsed for the cross-restart right sidebar layout preference.",
  },
  {
    id: "update-check-persisted-state",
    currentSurface: "app-state.json",
    currentKeys: ["updateCheckState"],
    nestedKeys: ["enabled", "lastCheckedAt", "dismissedVersion"],
    owner: "settings-status-family",
    category: "app-ui-preference",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "persist only user preference, last checked timestamp, and dismissed version",
    compatibilityNote: "checking and lastResult are session-only update-store state.",
  },
  {
    id: "update-check-session-state",
    currentSurface: "zustand",
    currentKeys: ["checking", "lastResult"],
    owner: "ui-shell",
    category: "zustand-update-session-state",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "never persist as app-state runtime truth",
    compatibilityNote: "Session-only UI state mirrors update request progress/result.",
  },
  {
    id: "model-provider-config",
    currentSurface: "app-state.json",
    currentKeys: ["llmConfig", "providerConfigs", "activePresetId"],
    owner: "profiles",
    category: "profile-or-provider-setting",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "future profile boundary must preserve secret handling and not log values",
    compatibilityNote: "Provider configs can contain API keys/endpoints.",
  },
  {
    id: "search-embedding-multimodal-mineru-config",
    currentSurface: "app-state.json",
    currentKeys: ["searchApiConfig", "embeddingConfig", "multimodalConfig", "mineruConfig"],
    owner: "profiles",
    category: "profile-or-provider-setting",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "split profile settings from Rust-read embeddingConfig compatibility before moving",
    compatibilityNote: "searchApiConfig and mineruConfig can carry secrets; embeddingConfig is also Rust-read.",
  },
  {
    id: "project-recents-last-project",
    currentSurface: "app-state.json",
    currentKeys: ["recentProjects", "lastProject"],
    owner: "project-family",
    category: "project-identity",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve recents and last-project semantics until project family API owns them",
    compatibilityNote: "recentProjects is also Rust-read and separately locked by rust-recent-projects.",
  },
  {
    id: "project-registry",
    currentSurface: "app-state.json",
    currentKeys: ["projectRegistry"],
    owner: "project-family",
    category: "project-identity",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "preserve registry as project identity map until cross-language adapter exists",
    compatibilityNote: "Written by TypeScript project identity and read by Rust local API.",
  },
  {
    id: "project-output-language",
    currentSurface: "app-state.json",
    currentKeys: ["outputLanguage", "projectOutputLanguages"],
    owner: "project-family",
    category: "project-scoped-setting",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "keep projectId keyed output language separate from runtime/job truth",
    compatibilityNote: "Project output language is user preference, not runtime ledger state.",
  },
  {
    id: "project-file-sync-source-watch",
    currentSurface: "app-state.json",
    currentKeys: ["projectFileSyncEnabled", "sourceWatchConfig"],
    owner: "platform-adapter",
    category: "project-scoped-setting",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "preserve projectId/default keyed maps until file-watch adapter owns them",
    compatibilityNote: "Both keys are also Rust-read and separately locked.",
  },
  {
    id: "scheduled-import-project-config",
    currentSurface: "project-path-key",
    currentKeys: ["scheduledImportConfig:<normalizedProjectPath>"],
    owner: "job-runtime-family",
    category: "project-scoped-setting",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "defer runtime scheduling truth to SPEC-2; preserve current project-path key meanwhile",
    compatibilityNote: "Uses normalized project path, not projectId.",
  },
  {
    id: "scheduled-import-legacy-global-key",
    currentSurface: "app-state.json",
    currentKeys: ["scheduledImportConfig"],
    owner: "storage-boundary",
    category: "legacy-compatibility-key",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "read once and migrate to project path key; do not reuse as runtime truth",
    compatibilityNote: "Legacy global scheduled import config must remain recognized.",
  },
  {
    id: "wiki-store-ui-view-state",
    currentSurface: "zustand",
    currentKeys: [
      "selectedFile",
      "fileContent",
      "externalPreview",
      "pendingScrollImageSrc",
      "chatExpanded",
      "pendingExploreTab",
      "pendingWikiHealthTab",
      "pendingSettingsCategory",
      "activeView",
    ],
    owner: "ui-shell",
    category: "zustand-ui-view-state",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: false,
    migrationRule: "keep as UI shell state",
    compatibilityNote: "This state is not persisted app settings or runtime truth.",
  },
  {
    id: "wiki-store-persisted-setting-mirrors",
    currentSurface: "zustand",
    currentKeys: [
      "llmConfig",
      "providerConfigs",
      "activePresetId",
      "searchApiConfig",
      "embeddingConfig",
      "multimodalConfig",
      "outputLanguage",
      "proxyConfig",
      "scheduledImportConfig",
      "sourceWatchConfig",
      "mineruConfig",
      "apiConfig",
    ],
    owner: "ui-shell",
    category: "zustand-persisted-setting-mirror",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: true,
    projectScoped: false,
    migrationRule: "treat as shell mirror of persisted settings, not canonical runtime truth",
    compatibilityNote: "Several mirrored settings are also Rust-read or secret-bearing in app-state.",
  },
  {
    id: "wiki-store-project-session-mirrors",
    currentSurface: "zustand",
    currentKeys: ["project", "fileTree", "dataVersion"],
    owner: "ui-shell",
    category: "zustand-project-session-mirror",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "keep as active shell session mirror until project API supplies state events",
    compatibilityNote: "Active project/file tree/session data is not plugin-store runtime ledger truth.",
  },
  {
    id: "runtime-job-state-deferred",
    currentSurface: "runtime-db-deferred",
    currentKeys: ["runtime.db.jobs", "runtime.db.leases", "runtime.db.events"],
    owner: "job-runtime-family",
    category: "runtime-state-deferred",
    rustLocked: false,
    crossLanguageReadByRust: false,
    secretBearing: false,
    projectScoped: true,
    migrationRule: "SPEC-2 owns runtime DB truth; never model job state as plugin-store app-state truth",
    compatibilityNote: "Plugin-store queue/settings keys are not runtime ledger rows.",
  },
]
