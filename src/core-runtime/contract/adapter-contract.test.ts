import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  createAdapterCoordinationMatrix,
  createMockAgentAdapterContract,
  createMockPlatformAdapterContract,
  createMockShellAdapter,
  createMockStorageBoundaryContract,
} from "./adapter-contract"
import { checkCoreRuntimeBoundary, collectModuleSpecifiers } from "./boundary-check"
import {
  JOB_RUNTIME_COMMAND_NAMES,
  JOB_RUNTIME_EVENT_NAMES,
  RUNTIME_CONTRACT_FAMILIES,
  createMockCoreRuntimeContract,
  type RuntimeContractFamily,
  type RuntimeDirection,
} from "./index"
import * as publicContract from "./index"

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf-8")
}

function directionsFor(
  family: RuntimeContractFamily,
  driven: readonly { family: RuntimeContractFamily; direction: RuntimeDirection }[],
): readonly RuntimeDirection[] {
  return driven.filter((message) => message.family === family).map((message) => message.direction).sort()
}

describe("SPEC-1 adapter contract tests", () => {
  it("keeps adapter helpers pure and outside the public frozen index", () => {
    const sourceText = repoFile("src/core-runtime/contract/adapter-contract.ts")

    expect(collectModuleSpecifiers(sourceText)).toEqual(["./index", "./store-boundary"])
    expect(
      checkCoreRuntimeBoundary([
        {
          filePath: "src/core-runtime/contract/adapter-contract.ts",
          sourceText,
        },
      ]),
    ).toEqual([])
    expect(repoFile("src/core-runtime/contract/index.ts")).not.toContain("adapter-contract")
    expect(publicContract).not.toHaveProperty("createMockShellAdapter")
    expect(publicContract).not.toHaveProperty("createMockPlatformAdapterContract")
    expect(publicContract).not.toHaveProperty("createMockStorageBoundaryContract")
    expect(publicContract).not.toHaveProperty("createMockAgentAdapterContract")
  })

  it("drives every core family and direction through a mock shell without exact placeholder names", async () => {
    const shell = createMockShellAdapter(createMockCoreRuntimeContract())
    const driven = await shell.driveFamilyDirections()
    const jobRuntimeMessages = createMockCoreRuntimeContract()
      .listMessages()
      .filter((message) => message.family === "job-runtime")

    expect(shell.allowedFamilies).toEqual(RUNTIME_CONTRACT_FAMILIES)
    expect(driven).toHaveLength(RUNTIME_CONTRACT_FAMILIES.length * 2)
    for (const family of RUNTIME_CONTRACT_FAMILIES) {
      expect(directionsFor(family, driven), family).toEqual(["command", "event"])
    }
    expect(driven.map((message) => message.action).sort()).toEqual([
      ...Array.from({ length: RUNTIME_CONTRACT_FAMILIES.length }, () => "collected-event"),
      ...Array.from({ length: RUNTIME_CONTRACT_FAMILIES.length }, () => "invoked-command"),
    ].sort())
    expect(jobRuntimeMessages.filter((message) => message.direction === "command").map((message) => message.name)).toEqual(
      JOB_RUNTIME_COMMAND_NAMES,
    )
    expect(jobRuntimeMessages.filter((message) => message.direction === "event").map((message) => message.name)).toEqual(
      JOB_RUNTIME_EVENT_NAMES,
    )
    expect(jobRuntimeMessages.map((message) => message.name)).not.toContain("job-runtime:placeholder-command")
    expect(jobRuntimeMessages.map((message) => message.name)).not.toContain("job-runtime:placeholder-event")
  })

  it("keeps adapter role family ownership explicit", () => {
    const platform = createMockPlatformAdapterContract()
    const agent = createMockAgentAdapterContract()
    const storage = createMockStorageBoundaryContract()

    expect(platform.allowedFamilies).toEqual(["file-platform", "process-cli"])
    expect(platform.forbiddenFamilies).toContain("settings-status")
    expect(platform.forbiddenDependencies).toContain("@tauri-apps/*")
    expect(agent.allowedFamilies).toEqual(["agent-run"])
    expect(agent.forbiddenFamilies).toContain("process-cli")
    expect(agent.forbiddenDependencies).toContain("@/stores/*")
    expect(storage.allowedFamilies).toEqual(["project", "job-runtime", "settings-status"])
    expect(storage.allowedFamilies).not.toContain("project-family")
    expect(storage.allowedFamilies).not.toContain("job-runtime-family")
    expect(storage.forbiddenDependencies).toContain("@/lib/runtime.db")
  })

  it("uses PR4 storage metadata without making app-state runtime truth", () => {
    const storage = createMockStorageBoundaryContract()

    expect(storage.storeEntries.length).toBeGreaterThan(0)
    expect(storage.runtimeDeferredEntries.length).toBeGreaterThan(0)
    for (const entry of storage.runtimeDeferredEntries) {
      expect(entry.category).toBe("runtime-state-deferred")
      expect(entry.currentSurface).toBe("runtime-db-deferred")
      expect(entry.migrationRule).toContain("SPEC-2")
    }
    expect(storage.storeEntries.filter((entry) => entry.secretBearing).length).toBeGreaterThan(0)
  })

  it("models agent process needs as core-mediated coordination, not agent ownership", () => {
    const coordination = createAdapterCoordinationMatrix()
    const agent = createMockAgentAdapterContract()

    expect(coordination).toEqual([
      {
        sourceRole: "agent-adapter",
        sourceFamily: "agent-run",
        targetRole: "platform-adapter",
        targetFamily: "process-cli",
        mediatedBy: "core-runtime",
      },
    ])
    expect(agent.allowedFamilies).not.toContain("process-cli")
    expect(agent.forbiddenFamilies).toContain("process-cli")
  })

  it("keeps the PR5 plan aligned with adapter contract evidence", () => {
    const plan = repoFile("docs/plans/SPEC-1/pr5-adapter-contract-tests-plan.md")

    for (const token of [
      "PR5-specific evidence",
      "must not be re-exported",
      "Platform Adapter mock must not include `settings-status`",
      "Agent Adapter mock must not include `process-cli`",
      "family/direction",
      "STORE_BOUNDARY_ENTRIES",
    ]) {
      expect(plan, token).toContain(token)
    }
  })
})
