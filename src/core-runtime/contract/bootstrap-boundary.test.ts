import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { checkCoreRuntimeBoundary, collectModuleSpecifiers } from "./boundary-check"
import {
  APP_BOOTSTRAP_BOUNDARY_CANDIDATES,
  APP_BOOTSTRAP_BOUNDARY_INVARIANTS,
} from "./bootstrap-boundary"

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf-8")
}

function allCandidateCallSites(): Set<string> {
  return new Set(APP_BOOTSTRAP_BOUNDARY_CANDIDATES.flatMap((candidate) => candidate.currentCallSites))
}

function sourceBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken)
  const end = source.indexOf(endToken, start)

  expect(start, startToken).toBeGreaterThanOrEqual(0)
  expect(end, endToken).toBeGreaterThan(start)
  return source.slice(start, end)
}

function expectTokenBefore(source: string, beforeToken: string, afterToken: string): void {
  const before = source.indexOf(beforeToken)
  const after = source.indexOf(afterToken)

  expect(before, beforeToken).toBeGreaterThanOrEqual(0)
  expect(after, afterToken).toBeGreaterThanOrEqual(0)
  expect(before, `${beforeToken} before ${afterToken}`).toBeLessThan(after)
}

describe("SPEC-1 bootstrap boundary inventory", () => {
  it("keeps the inventory pure and outside the public contract index", () => {
    const sourceText = repoFile("src/core-runtime/contract/bootstrap-boundary.ts")

    expect(collectModuleSpecifiers(sourceText)).toEqual([])
    expect(
      checkCoreRuntimeBoundary([
        {
          filePath: "src/core-runtime/contract/bootstrap-boundary.ts",
          sourceText,
        },
      ]),
    ).toEqual([])
    expect(repoFile("src/core-runtime/contract/index.ts")).not.toContain("bootstrap-boundary")
  })

  it("covers the current App bootstrap call sites without relying on candidate ids alone", () => {
    const appSource = repoFile("src/App.tsx")
    const inventoryCallSites = allCandidateCallSites()
    const requiredCallSites = [
      "setupAutoSave",
      "startClipWatcher",
      "loadUpdateCheckState",
      "saveUpdateCheckState",
      "loadLlmConfig",
      "saveLlmConfig",
      "loadAgentResourceConfig",
      "cleanExpiredAgentSessions",
      "restoreQueue",
      "startProjectFileSync",
      'fetch("http://127.0.0.1:19827/project"',
      'fetch("http://127.0.0.1:19827/projects"',
      "listDirectory",
      "loadReviewItems",
      "loadLintItems",
      "loadChatHistory",
      "stopScheduledImport",
      "saveScheduledImportConfig",
      "resetProjectState",
      "setProject(null)",
      "setFileTree([])",
      "setSelectedFile(null)",
      "applyDocumentZoom",
      "__llmwiki_testUpdateBanner",
      "__llmwiki_fixtures.agent",
    ]
    const invariantCallSites = APP_BOOTSTRAP_BOUNDARY_INVARIANTS.flatMap(
      (invariant) => invariant.protectedCallSites,
    )

    for (const callSite of [...requiredCallSites, ...invariantCallSites]) {
      expect(appSource, callSite).toContain(callSite)
      expect(inventoryCallSites.has(callSite), callSite).toBe(true)
    }
    for (const callSite of inventoryCallSites) {
      expect(appSource, callSite).toContain(callSite)
    }
  })

  it("keeps bootstrap invariants linked to known candidates and call sites", () => {
    const candidateIds = new Set(APP_BOOTSTRAP_BOUNDARY_CANDIDATES.map((candidate) => candidate.id))
    const inventoryCallSites = allCandidateCallSites()

    expect(APP_BOOTSTRAP_BOUNDARY_INVARIANTS).toHaveLength(8)
    for (const invariant of APP_BOOTSTRAP_BOUNDARY_INVARIANTS) {
      expect(candidateIds.has(invariant.beforeCandidateId), invariant.id).toBe(true)
      expect(candidateIds.has(invariant.afterCandidateId), invariant.id).toBe(true)
      expect(invariant.protectedCallSites.length, invariant.id).toBeGreaterThan(0)
      for (const callSite of invariant.protectedCallSites) {
        expect(inventoryCallSites.has(callSite), `${invariant.id}:${callSite}`).toBe(true)
      }
    }
  })

  it("protects the current App bootstrap ordering invariants", () => {
    const appSource = repoFile("src/App.tsx")
    const projectOpenSource = sourceBetween(
      appSource,
      "async function handleProjectOpened",
      "async function handleSelectRecent",
    )
    const projectSwitchSource = sourceBetween(
      appSource,
      "async function handleSwitchProject",
      "if (loading)",
    )
    const updateCheckSource = sourceBetween(
      appSource,
      "Background update check",
      "Auto-open last project on startup",
    )

    for (const token of [
      "loadAgentResourceConfig",
      "setProject(proj)",
      "restoreQueue",
      "startProjectFileSync",
      "listDirectory",
      "loadReviewItems",
      "loadLintItems",
      "loadChatHistory",
      "cleanExpiredAgentSessions",
    ]) {
      expectTokenBefore(projectOpenSource, "resetProjectState", token)
    }
    expectTokenBefore(projectOpenSource, "restoreQueue", "startProjectFileSync")
    expectTokenBefore(projectSwitchSource, "resetProjectState", "setProject(null)")
    expectTokenBefore(projectSwitchSource, "resetProjectState", "setFileTree([])")
    expectTokenBefore(projectSwitchSource, "resetProjectState", "setSelectedFile(null)")
    expectTokenBefore(updateCheckSource, "if (cancelled) return", "setChecking")

    const afterFetchUpdateSource = updateCheckSource.slice(
      updateCheckSource.indexOf("checkForUpdates"),
    )
    expectTokenBefore(afterFetchUpdateSource, "if (cancelled) return", "setResult")
    expectTokenBefore(afterFetchUpdateSource, "if (cancelled) return", "saveUpdateCheckState")
    expectTokenBefore(updateCheckSource, "return () =>", "clearTimeout(timer)")
  })

  it("records the expected ownership split for future extraction", () => {
    expect(
      APP_BOOTSTRAP_BOUNDARY_CANDIDATES.map((candidate) => [
        candidate.id,
        candidate.owner,
        candidate.targetBoundary,
      ]),
    ).toEqual([
      ["mount-background-services", "runtime-bootstrap", "runtime-bootstrap-service"],
      ["update-check-bootstrap", "runtime-bootstrap", "settings-status-family"],
      ["settings-hydration", "storage-boundary", "settings-status-family"],
      ["last-project-open", "runtime-bootstrap", "project-family"],
      ["project-open-runtime-handshake", "runtime-bootstrap", "project-family"],
      ["project-queue-restore", "runtime-bootstrap", "job-runtime-family"],
      ["project-periodic-work", "runtime-bootstrap", "job-runtime-family"],
      ["project-shell-notify", "platform-adapter", "platform-adapter"],
      ["project-file-tree-load", "platform-adapter", "file-platform-family"],
      ["project-persisted-ui-state", "ui-shell", "ui-shell"],
      ["project-agent-state", "agent-adapter", "agent-adapter"],
      ["project-switch-cleanup", "runtime-bootstrap", "project-family"],
      ["ui-shell-excluded-effects", "ui-shell", "ui-shell"],
    ])
  })

  it("keeps the plan aligned with the implemented inventory", () => {
    const plan = repoFile("docs/plans/SPEC-1/pr3-bootstrap-boundary-plan.md")

    for (const candidate of APP_BOOTSTRAP_BOUNDARY_CANDIDATES) {
      expect(plan, candidate.id).toContain(candidate.id)
    }
    for (const invariant of APP_BOOTSTRAP_BOUNDARY_INVARIANTS) {
      expect(plan, invariant.id).toContain(invariant.id)
    }
    expect(plan).toContain("PR3 不完成 SPEC-1 strangler Priority-1")
    expect(plan).toContain("deferred 到 SPEC-2/runtime bootstrap extraction PR")
  })
})
