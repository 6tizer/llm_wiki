export type BootstrapBoundaryOwner =
  | "ui-shell"
  | "runtime-bootstrap"
  | "platform-adapter"
  | "agent-adapter"
  | "storage-boundary"

export type BootstrapTargetBoundary =
  | "ui-shell"
  | "runtime-bootstrap-service"
  | "platform-adapter"
  | "agent-adapter"
  | "storage-boundary"
  | "settings-status-family"
  | "project-family"
  | "job-runtime-family"
  | "file-platform-family"

export type BootstrapBoundaryCandidateId =
  | "mount-background-services"
  | "update-check-bootstrap"
  | "settings-hydration"
  | "last-project-open"
  | "project-open-runtime-handshake"
  | "project-queue-restore"
  | "project-periodic-work"
  | "project-shell-notify"
  | "project-file-tree-load"
  | "project-persisted-ui-state"
  | "project-agent-state"
  | "project-switch-cleanup"
  | "ui-shell-excluded-effects"

export type BootstrapBoundaryCandidate = {
  readonly id: BootstrapBoundaryCandidateId
  readonly currentSurface: "src/App.tsx"
  readonly owner: BootstrapBoundaryOwner
  readonly targetBoundary: BootstrapTargetBoundary
  readonly currentResponsibilities: readonly string[]
  readonly currentCallSites: readonly string[]
  readonly migrationNote: string
}

export type BootstrapBoundaryInvariant = {
  readonly id: string
  readonly description: string
  readonly beforeCandidateId: BootstrapBoundaryCandidateId
  readonly afterCandidateId: BootstrapBoundaryCandidateId
  readonly protectedCallSites: readonly string[]
}

export const APP_BOOTSTRAP_BOUNDARY_CANDIDATES: readonly BootstrapBoundaryCandidate[] = [
  {
    id: "mount-background-services",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "runtime-bootstrap-service",
    currentResponsibilities: ["Start global auto-save", "Start local clip watcher"],
    currentCallSites: ["setupAutoSave", "startClipWatcher"],
    migrationNote: "Keep mount-only startup semantics until runtime bootstrap extraction.",
  },
  {
    id: "update-check-bootstrap",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "settings-status-family",
    currentResponsibilities: [
      "Delay update checks after startup",
      "Hydrate persisted update-check state",
      "Fetch GitHub release metadata",
      "Persist update-check metadata",
      "Cancel delayed writes after unmount",
    ],
    currentCallSites: [
      "setTimeout",
      "cancelled",
      "loadUpdateCheckState",
      "saveUpdateCheckState",
      "checkForUpdates",
      "setChecking",
      "setResult",
    ],
    migrationNote: "Preserve the 1.5s delay and cancellation guard before extracting.",
  },
  {
    id: "settings-hydration",
    currentSurface: "src/App.tsx",
    owner: "storage-boundary",
    targetBoundary: "settings-status-family",
    currentResponsibilities: [
      "Hydrate provider and model settings",
      "Hydrate search, embedding, multimodal, MinerU, proxy, API, zoom, theme, and language preferences",
      "Re-resolve active preset defaults and write back corrected LLM config",
    ],
    currentCallSites: [
      "loadLlmConfig",
      "loadProviderConfigs",
      "loadActivePresetId",
      "saveLlmConfig",
      "loadSearchApiConfig",
      "loadEmbeddingConfig",
      "loadMultimodalConfig",
      "loadMineruConfig",
      "loadProxyConfig",
      "loadApiConfig",
      "loadZoomLevel",
      "loadTheme",
      "loadLanguage",
    ],
    migrationNote: "Do not drop the active-preset saveLlmConfig write-back side effect.",
  },
  {
    id: "last-project-open",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "project-family",
    currentResponsibilities: ["Read last project", "Open last project if still valid"],
    currentCallSites: ["getLastProject", "openProject", "handleProjectOpened"],
    migrationNote: "Opening the last project must remain best-effort and must not block loading forever.",
  },
  {
    id: "project-open-runtime-handshake",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "project-family",
    currentResponsibilities: [
      "Reset old project state",
      "Set active project",
      "Hydrate output language",
      "Set wiki view defaults",
      "Bump data version",
      "Persist last project",
    ],
    currentCallSites: [
      "resetProjectState",
      "setProject",
      "loadOutputLanguage",
      "setSelectedFile",
      "setActiveView",
      "bumpDataVersion",
      "saveLastProject",
    ],
    migrationNote: "resetProjectState must complete before any new project data populates stores.",
  },
  {
    id: "project-queue-restore",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "job-runtime-family",
    currentResponsibilities: ["Restore ingest queue", "Restore dedup queue"],
    currentCallSites: ["restoreQueue", "ingest-queue", "dedup-queue"],
    migrationNote: "Ingest queue restore must complete before project file sync can enqueue watcher tasks.",
  },
  {
    id: "project-periodic-work",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "job-runtime-family",
    currentResponsibilities: ["Hydrate scheduled import", "Start scheduled import", "Configure project file sync"],
    currentCallSites: [
      "loadScheduledImportConfig",
      "setScheduledImportConfig",
      "startScheduledImport",
      "loadSourceWatchConfig",
      "setSourceWatchConfig",
      "startProjectFileSync",
      "stopProjectFileSync",
    ],
    migrationNote: "Watcher startup must stay after queue restore to avoid project queue races.",
  },
  {
    id: "project-shell-notify",
    currentSurface: "src/App.tsx",
    owner: "platform-adapter",
    targetBoundary: "platform-adapter",
    currentResponsibilities: ["Notify clip server of current project", "Notify clip server of recent projects"],
    currentCallSites: [
      "CLIP_SERVER_BASE_URL}/project",
      "CLIP_SERVER_BASE_URL}/projects",
      "getRecentProjects",
    ],
    migrationNote: "Clip server notification is shell/platform integration, not core project truth.",
  },
  {
    id: "project-file-tree-load",
    currentSurface: "src/App.tsx",
    owner: "platform-adapter",
    targetBoundary: "file-platform-family",
    currentResponsibilities: ["Read project file tree", "Populate UI file tree"],
    currentCallSites: ["listDirectory", "setFileTree"],
    migrationNote: "listDirectory is a live platform file read and must not be categorized as persisted UI state.",
  },
  {
    id: "project-persisted-ui-state",
    currentSurface: "src/App.tsx",
    owner: "ui-shell",
    targetBoundary: "ui-shell",
    currentResponsibilities: ["Load persisted review items", "Load persisted lint items", "Load persisted chat history"],
    currentCallSites: ["loadReviewItems", "loadLintItems", "loadChatHistory", "setItems", "setConversations"],
    migrationNote: "These are current shell view-state restores until runtime ownership is split.",
  },
  {
    id: "project-agent-state",
    currentSurface: "src/App.tsx",
    owner: "agent-adapter",
    targetBoundary: "agent-adapter",
    currentResponsibilities: ["Hydrate agent resource config", "Clean expired agent sessions"],
    currentCallSites: ["loadAgentResourceConfig", "setResourceConfig", "cleanExpiredAgentSessions"],
    migrationNote:
      "Keep agent adapter state separate from generic project UI persisted state; resource config hydrate is near the project-open head, while expired session cleanup runs near the tail.",
  },
  {
    id: "project-switch-cleanup",
    currentSurface: "src/App.tsx",
    owner: "runtime-bootstrap",
    targetBoundary: "project-family",
    currentResponsibilities: [
      "Stop scheduled import",
      "Persist current scheduled import config",
      "Reset project state",
      "Clear active project and file UI state",
    ],
    currentCallSites: [
      "stopScheduledImport",
      "saveScheduledImportConfig",
      "resetProjectState",
      "setProject(null)",
      "setFileTree([])",
      "setSelectedFile(null)",
    ],
    migrationNote: "Reset must happen before returning the shell to no-project UI.",
  },
  {
    id: "ui-shell-excluded-effects",
    currentSurface: "src/App.tsx",
    owner: "ui-shell",
    targetBoundary: "ui-shell",
    currentResponsibilities: [
      "Apply DOM zoom",
      "Expose dev-only update banner helper",
      "Register dev-only QA fixture shell",
    ],
    currentCallSites: [
      "applyDocumentZoom",
      "__llmwiki_testUpdateBanner",
      "__llmwiki_fixtures.agent",
    ],
    migrationNote: "DOM font-size mutation and dev helper fixtures remain UI shell owned.",
  },
]

export const APP_BOOTSTRAP_BOUNDARY_INVARIANTS: readonly BootstrapBoundaryInvariant[] = [
  {
    id: "project-reset-before-queue-restore",
    description: "Project reset must complete before queues restore into the new project.",
    beforeCandidateId: "project-open-runtime-handshake",
    afterCandidateId: "project-queue-restore",
    protectedCallSites: ["resetProjectState", "restoreQueue"],
  },
  {
    id: "project-reset-before-periodic-work",
    description: "Project reset must complete before periodic project work starts.",
    beforeCandidateId: "project-open-runtime-handshake",
    afterCandidateId: "project-periodic-work",
    protectedCallSites: ["resetProjectState", "startProjectFileSync"],
  },
  {
    id: "project-reset-before-file-tree-load",
    description: "Project reset must complete before reading and populating the file tree.",
    beforeCandidateId: "project-open-runtime-handshake",
    afterCandidateId: "project-file-tree-load",
    protectedCallSites: ["resetProjectState", "listDirectory"],
  },
  {
    id: "project-reset-before-persisted-ui-state",
    description: "Project reset must complete before restoring persisted UI state.",
    beforeCandidateId: "project-open-runtime-handshake",
    afterCandidateId: "project-persisted-ui-state",
    protectedCallSites: ["resetProjectState", "loadReviewItems", "loadLintItems", "loadChatHistory"],
  },
  {
    id: "project-reset-before-agent-state",
    description: "Project reset must complete before restoring agent state.",
    beforeCandidateId: "project-open-runtime-handshake",
    afterCandidateId: "project-agent-state",
    protectedCallSites: ["resetProjectState", "loadAgentResourceConfig", "cleanExpiredAgentSessions"],
  },
  {
    id: "ingest-restore-before-file-sync",
    description: "Ingest queue restore must complete before file sync can enqueue watcher tasks.",
    beforeCandidateId: "project-queue-restore",
    afterCandidateId: "project-periodic-work",
    protectedCallSites: ["restoreQueue", "startProjectFileSync"],
  },
  {
    id: "switch-reset-before-welcome",
    description: "Project switch cleanup must reset runtime state before clearing the shell to no-project UI.",
    beforeCandidateId: "project-switch-cleanup",
    afterCandidateId: "project-switch-cleanup",
    protectedCallSites: ["stopScheduledImport", "saveScheduledImportConfig", "resetProjectState", "setProject(null)", "setFileTree([])"],
  },
  {
    id: "update-timer-cancel-before-write",
    description: "Update-check cancellation must protect delayed update-store writes after unmount.",
    beforeCandidateId: "update-check-bootstrap",
    afterCandidateId: "update-check-bootstrap",
    protectedCallSites: ["setTimeout", "cancelled", "setChecking", "setResult", "saveUpdateCheckState"],
  },
]
