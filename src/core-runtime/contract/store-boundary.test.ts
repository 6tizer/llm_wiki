import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { checkCoreRuntimeBoundary, collectModuleSpecifiers } from "./boundary-check"
import {
  PR1_ADR_MINIMUM_STORAGE_LOCK_KEYS,
  PR4_DISCOVERED_RUST_READ_APP_STATE_KEYS,
  STORE_BOUNDARY_ENTRIES,
  type StoreBoundaryEntryId,
} from "./store-boundary"

const POST_SPEC1_STORE_BOUNDARY_ENTRY_IDS = new Set<StoreBoundaryEntryId>([
  "ui-sidebar-collapsed",
])

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf-8")
}

function allCurrentKeys(): Set<string> {
  return new Set(STORE_BOUNDARY_ENTRIES.flatMap((entry) => entry.currentKeys))
}

function rustLockedKeys(): Set<string> {
  return new Set(
    STORE_BOUNDARY_ENTRIES
      .filter((entry) => entry.rustLocked || entry.crossLanguageReadByRust)
      .flatMap((entry) => entry.currentKeys),
  )
}

function sourceHasNestedGet(source: string, parentKey: string, nestedKey: string): boolean {
  return new RegExp(String.raw`\.get\("${parentKey}"\)[\s\S]{0,120}\.get\("${nestedKey}"\)`).test(source)
}

function sourceHasTopLevelGet(source: string, key: string): boolean {
  return new RegExp(String.raw`\.get\("${key}"\)`).test(source)
}

function functionBodiesCalling(source: string, callName: string): string[] {
  const bodies: string[] = []
  const functionPattern = /\n(?:pub\s+)?(?:async\s+)?fn\s+\w+[^{]*\{/g
  let match: RegExpExecArray | null

  while ((match = functionPattern.exec(source)) !== null) {
    let depth = 0
    for (let index = match.index; index < source.length; index += 1) {
      const char = source[index]
      if (char === "{") {
        depth += 1
      } else if (char === "}") {
        depth -= 1
        if (depth === 0) {
          const body = source.slice(match.index, index + 1)
          if (body.includes(callName)) {
            bodies.push(body)
          }
          break
        }
      }
    }
  }

  return bodies
}

function stringGetLiterals(source: string): string[] {
  return [...source.matchAll(/\.get\("([^"]+)"\)/g)].map((match) => match[1])
}

function hasStringConst(source: string, key: string): boolean {
  return new RegExp(String.raw`const\s+\w+\s*=\s*"${key}"`).test(source)
}

describe("SPEC-1 store boundary inventory", () => {
  it("keeps the inventory pure and outside the public contract index", () => {
    const sourceText = repoFile("src/core-runtime/contract/store-boundary.ts")

    expect(collectModuleSpecifiers(sourceText)).toEqual([])
    expect(
      checkCoreRuntimeBoundary([
        {
          filePath: "src/core-runtime/contract/store-boundary.ts",
          sourceText,
        },
      ]),
    ).toEqual([])
    expect(repoFile("src/core-runtime/contract/index.ts")).not.toContain("store-boundary")
  })

  it("covers PR1 minimum storage lock and PR4 discovered Rust readers", () => {
    const locked = rustLockedKeys()

    for (const key of PR1_ADR_MINIMUM_STORAGE_LOCK_KEYS) {
      expect(locked.has(key), key).toBe(true)
    }
    for (const key of PR4_DISCOVERED_RUST_READ_APP_STATE_KEYS) {
      expect(locked.has(key), key).toBe(true)
    }
  })

  it("guards Rust reader tokens instead of relying only on the ADR", () => {
    const apiServer = ["mod", "projects", "reviews", "graph"]
      .map((name) => repoFile(`src-tauri/src/api_server/${name}.rs`))
      .join("\n")
    const rustLib = repoFile("src-tauri/src/lib.rs")
    const proxy = repoFile("src-tauri/src/proxy.rs")

    const discoveredReaderKeys = new Set<string>()
    for (const nestedKey of ["enabled", "allowUnauthenticated", "token", "mcpEnabled"]) {
      if (sourceHasNestedGet(apiServer, "apiConfig", nestedKey)) {
        discoveredReaderKeys.add(`apiConfig.${nestedKey}`)
      }
    }
    for (const key of [
      "projectRegistry",
      "recentProjects",
      "embeddingConfig",
      "sourceWatchConfig",
      "projectFileSyncEnabled",
    ]) {
      if (sourceHasTopLevelGet(apiServer, key)) {
        discoveredReaderKeys.add(key)
      }
    }
    if (rustLib.includes('const LANGUAGE_KEY: &str = "language"') && rustLib.includes("parsed.get(LANGUAGE_KEY)")) {
      discoveredReaderKeys.add("language")
    }
    if (
      rustLib.includes('const CLOSE_BEHAVIOR_KEY: &str = "closeBehavior"') &&
      rustLib.includes("parsed.get(CLOSE_BEHAVIOR_KEY)")
    ) {
      discoveredReaderKeys.add("closeBehavior")
    }
    if (sourceHasTopLevelGet(proxy, "proxyConfig")) {
      discoveredReaderKeys.add("proxyConfig")
    }

    expect([...discoveredReaderKeys].sort()).toEqual([...PR4_DISCOVERED_RUST_READ_APP_STATE_KEYS].sort())
    expect(
      functionBodiesCalling(apiServer, "load_app_state").flatMap(stringGetLiterals).sort(),
    ).toEqual([
      "allowUnauthenticated",
      "apiConfig",
      "apiConfig",
      "apiConfig",
      "apiConfig",
      "apiConfig",
      "default",
      "default",
      "embeddingConfig",
      "enabled",
      "mcpEnabled",
      "name",
      "name",
      "path",
      "path",
      "projectFileSyncEnabled",
      "projectRegistry",
      "recentProjects",
      "sourceWatchConfig",
      "token",
      "token",
    ])
  })

  it("keeps TypeScript writer literals aligned with the store inventory", () => {
    const projectStore = repoFile("src/lib/project-store.ts")
    const projectIdentity = repoFile("src/lib/project-identity.ts")
    const source = `${projectStore}\n${projectIdentity}`
    const keys = [
      "language",
      "closeBehavior",
      "proxyConfig",
      "apiConfig",
      "llmConfig",
      "providerConfigs",
      "activePresetId",
      "searchApiConfig",
      "multimodalConfig",
      "mineruConfig",
      "recentProjects",
      "lastProject",
      "projectRegistry",
      "embeddingConfig",
      "sourceWatchConfig",
      "projectFileSyncEnabled",
      "scheduledImportConfig",
      "outputLanguage",
      "projectOutputLanguages",
      "updateCheckState",
      "zoomLevel",
      "theme",
    ]

    expect(source).toContain("app-state.json")
    for (const key of keys) {
      expect(hasStringConst(source, key), key).toBe(true)
      expect(allCurrentKeys().has(key) || allCurrentKeys().has(`${key}:<normalizedProjectPath>`), key).toBe(true)
    }
  })

  it("classifies Zustand state without making it canonical runtime truth", () => {
    const wikiStore = repoFile("src/stores/wiki-store.ts")
    const updateStore = repoFile("src/stores/update-store.ts")
    const uiView = STORE_BOUNDARY_ENTRIES.find((entry) => entry.id === "wiki-store-ui-view-state")
    const persistedMirror = STORE_BOUNDARY_ENTRIES.find(
      (entry) => entry.id === "wiki-store-persisted-setting-mirrors",
    )
    const projectMirror = STORE_BOUNDARY_ENTRIES.find(
      (entry) => entry.id === "wiki-store-project-session-mirrors",
    )
    const updatePersisted = STORE_BOUNDARY_ENTRIES.find(
      (entry) => entry.id === "update-check-persisted-state",
    )
    const updateSession = STORE_BOUNDARY_ENTRIES.find(
      (entry) => entry.id === "update-check-session-state",
    )
    const sidebarCollapsed = STORE_BOUNDARY_ENTRIES.find(
      (entry) => entry.id === "ui-sidebar-collapsed",
    )

    expect(uiView?.category).toBe("zustand-ui-view-state")
    expect(uiView?.currentKeys).toEqual(expect.arrayContaining(["pendingExploreTab", "pendingWikiHealthTab"]))
    expect(uiView?.currentKeys).not.toContain("sidebarCollapsed")
    expect(persistedMirror?.category).toBe("zustand-persisted-setting-mirror")
    expect(projectMirror?.category).toBe("zustand-project-session-mirror")
    expect(sidebarCollapsed).toMatchObject({
      currentSurface: "zustand+localStorage",
      currentKeys: ["sidebarCollapsed", "llmwiki.sidebarCollapsed"],
      category: "app-ui-preference",
      rustLocked: false,
      crossLanguageReadByRust: false,
      secretBearing: false,
      projectScoped: false,
    })
    expect(updatePersisted?.currentKeys).toEqual(["updateCheckState"])
    expect(updatePersisted?.nestedKeys).toEqual(["enabled", "lastCheckedAt", "dismissedVersion"])
    expect(updateSession?.currentKeys).toEqual(["checking", "lastResult"])

    for (const token of [
      ...(uiView?.currentKeys ?? []),
      ...(persistedMirror?.currentKeys ?? []),
      ...(projectMirror?.currentKeys ?? []),
    ]) {
      expect(wikiStore, token).toContain(token)
    }
    for (const token of ["checking", "lastResult", "enabled", "lastCheckedAt", "dismissedVersion"]) {
      expect(updateStore, token).toContain(token)
    }
  })

  it("marks runtime truth as SPEC-2 deferred and protects secret-bearing settings", () => {
    const runtimeEntry = STORE_BOUNDARY_ENTRIES.find((entry) => entry.id === "runtime-job-state-deferred")
    const secretEntries = STORE_BOUNDARY_ENTRIES.filter((entry) => entry.secretBearing)

    expect(runtimeEntry?.currentSurface).toBe("runtime-db-deferred")
    expect(runtimeEntry?.migrationRule).toContain("SPEC-2")
    expect(
      STORE_BOUNDARY_ENTRIES.filter((entry) =>
        entry.migrationRule.toLowerCase().includes("move to runtime db"),
      ),
    ).toEqual([])
    expect(secretEntries.map((entry) => entry.id).sort()).toEqual([
      "model-provider-config",
      "rust-api-config",
      "rust-api-config-token",
      "rust-embedding-config",
      "search-embedding-multimodal-mineru-config",
      "wiki-store-persisted-setting-mirrors",
    ])
  })

  it("keeps the plan aligned with the implemented inventory", () => {
    const plan = repoFile("docs/plans/SPEC-1/pr4-store-boundary-plan.md")

    for (const entry of STORE_BOUNDARY_ENTRIES.filter((entry) => !POST_SPEC1_STORE_BOUNDARY_ENTRY_IDS.has(entry.id))) {
      expect(plan, entry.id).toContain(entry.id)
    }
    for (const key of PR4_DISCOVERED_RUST_READ_APP_STATE_KEYS) {
      expect(plan, key).toContain(key)
    }
    expect(plan).toContain("ADR PR1 minimum")
    expect(plan).toContain("Rust reader tokens")
    expect(plan).toContain("secret-bearing")
  })
})
