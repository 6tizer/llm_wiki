import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { checkCoreRuntimeBoundary } from "./boundary-check"
import {
  JOB_RUNTIME_COMMAND_NAMES,
  JOB_RUNTIME_DEFAULTS,
  JOB_RUNTIME_EVENT_NAMES,
  JOB_RUNTIME_SCHEMA_FAMILIES,
  JOB_RUNTIME_SINGLE_WRITER_OPERATIONS,
  JOB_RUNTIME_STATES,
  JOB_RUNTIME_TRANSITIONS,
  RUNTIME_CONTRACT_FAMILIES,
  type RuntimeContractFamily,
  createMockCoreRuntimeContract,
} from "./index"

const EXPECTED_FAMILIES = [
  "project",
  "job-runtime",
  "markdown-commit",
  "profiles",
  "derived",
  "search-vector",
  "file-platform",
  "process-cli",
  "agent-run",
  "settings-status",
] as const satisfies readonly RuntimeContractFamily[]

const ADR_FAMILY_LABELS: Record<(typeof EXPECTED_FAMILIES)[number], string> = {
  project: "Project",
  "job-runtime": "Job runtime",
  "markdown-commit": "Markdown commit",
  profiles: "Profiles",
  derived: "Derived",
  "search-vector": "Search/vector",
  "file-platform": "File/platform",
  "process-cli": "Process/CLI",
  "agent-run": "Agent run",
  "settings-status": "Settings/status",
}

const APP_STATE_LOCK_KEYS = [
  "language",
  "closeBehavior",
  "proxyConfig",
  "apiConfig",
  "apiConfig.mcpEnabled",
] as const

const SPEC_2_ADR = "docs/plans/SPEC-2/adr-work-runtime.md"

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf-8")
}

function sectionBetween(source: string, start: string, end: string): string {
  const afterStart = source.split(start)[1] ?? ""
  if (!end) {
    return afterStart
  }
  return afterStart.split(end)[0] ?? ""
}

function tableFirstColumn(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| "))
    .filter((line) => !line.startsWith("| ---"))
    .map((line) => line.split("|")[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => !["Family", "Name", "State", "Operation", "Setting"].includes(value))
    .map((value) => value.replace(/^`|`$/g, ""))
}

function tableRows(section: string): string[][] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| "))
    .filter((line) => !line.startsWith("| ---"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((value) => value.trim().replace(/`/g, "")),
    )
    .filter((row) => row[0] !== "Setting")
}

function adrTransitionRows(adr: string): string[] {
  return sectionBetween(adr, "Transition table:", "Any state or transition")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| `"))
    .map((line) =>
      line
        .split("|")
        .slice(1, 4)
        .map((value) => value.trim().replace(/^`|`$/g, ""))
        .join(":"),
    )
}

function adrInventoryFamilies(adr: string): string[] {
  const section = adr.split("## Runtime Command/Event Inventory")[1]?.split("## Enforcement Hooks")[0] ?? ""
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| "))
    .filter((line) => !line.startsWith("| Family ") && !line.startsWith("| ---"))
    .map((line) => line.split("|")[1]?.trim())
    .filter((value): value is string => Boolean(value))
}

function adrAppStateKeys(adr: string): string[] {
  const section = adr.split("Locked keys for current boundary work:")[1]?.split("PR4 may design")[0] ?? ""
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- `"))
    .map((line) => line.match(/^- `([^`]+)`/)?.[1])
    .filter((value): value is string => Boolean(value))
}

describe("Core Runtime headless contract skeleton", () => {
  it("can be exercised without React, Tauri, Zustand, or persistence", async () => {
    const contract = createMockCoreRuntimeContract()
    const messages = contract.listMessages()
    const expectedMessageCount =
      (EXPECTED_FAMILIES.length - 1) * 2 + JOB_RUNTIME_COMMAND_NAMES.length + JOB_RUNTIME_EVENT_NAMES.length

    expect(contract.maturity).toBe("frozen")
    expect(RUNTIME_CONTRACT_FAMILIES).toEqual(EXPECTED_FAMILIES)
    expect(messages).toHaveLength(expectedMessageCount)

    for (const family of EXPECTED_FAMILIES) {
      if (family === "job-runtime") {
        continue
      }
      expect(messages).toContainEqual({
        family,
        direction: "command",
        name: `${family}:placeholder-command`,
        payloadShape: "placeholder",
      })
      expect(messages).toContainEqual({
        family,
        direction: "event",
        name: `${family}:placeholder-event`,
        payloadShape: "placeholder",
      })
    }

    await expect(contract.invokePlaceholder(messages[0])).resolves.toEqual({ ok: true })
  })

  it("keeps all contract modules independent from shell/runtime imports", () => {
    expect(
      checkCoreRuntimeBoundary([
        {
          filePath: "src/core-runtime/contract/index.ts",
          sourceText: repoFile("src/core-runtime/contract/index.ts"),
        },
      ]),
    ).toEqual([])
  })

  it("keeps the ADR inventory aligned with the frozen skeleton", () => {
    const adr = repoFile("docs/plans/SPEC-1/adr-shell-core-boundary.md")

    expect(adrInventoryFamilies(adr)).toEqual(
      EXPECTED_FAMILIES.map((family) => ADR_FAMILY_LABELS[family]),
    )
    expect(adrAppStateKeys(adr)).toEqual(APP_STATE_LOCK_KEYS)
  })

  it("keeps SPEC-2 job-runtime operations and events aligned with the ADR", () => {
    const adr = repoFile(SPEC_2_ADR)
    const contract = createMockCoreRuntimeContract()
    const jobMessages = contract.listMessages().filter((message) => message.family === "job-runtime")

    expect(jobMessages.filter((message) => message.direction === "command").map((message) => message.name)).toEqual(
      JOB_RUNTIME_COMMAND_NAMES,
    )
    expect(jobMessages.filter((message) => message.direction === "event").map((message) => message.name)).toEqual(
      JOB_RUNTIME_EVENT_NAMES,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Commands:", "Events:"))).toEqual(JOB_RUNTIME_COMMAND_NAMES)
    expect(tableFirstColumn(sectionBetween(adr, "Events:", "Payload details"))).toEqual(JOB_RUNTIME_EVENT_NAMES)
    expect(jobMessages.every((message) => message.payloadShape === "placeholder")).toBe(true)
    expect(adr).toContain("Payload details remain ADR/contract metadata")
    expect(adr).not.toContain("CREATE TABLE")
  })

  it("keeps SPEC-2 schema families, states, and transitions aligned with the ADR", () => {
    const adr = repoFile(SPEC_2_ADR)
    const transitionIds = JOB_RUNTIME_TRANSITIONS.map(
      (transition) => `${transition.operation}:${transition.from}:${transition.to}`,
    )

    expect(tableFirstColumn(sectionBetween(adr, "Schema family inventory:", "Migrations are"))).toEqual(
      JOB_RUNTIME_SCHEMA_FAMILIES,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Closed-world states:", "Transition table:"))).toEqual(
      JOB_RUNTIME_STATES,
    )
    expect(adrTransitionRows(adr)).toEqual(transitionIds)
    expect(transitionIds).toContain("cancel:paused:cancelled")
    expect(transitionIds).toContain("cancel:retry-wait:cancelled")
    expect(transitionIds).not.toContain("cancel:failed:cancelled")
  })

  it("keeps SPEC-2 single-writer and portable SQLite guard explicit", () => {
    const adr = repoFile(SPEC_2_ADR)

    expect(tableFirstColumn(sectionBetween(adr, "Single-writer operation set:", "`job-runtime:list`"))).toEqual(
      JOB_RUNTIME_SINGLE_WRITER_OPERATIONS,
    )
    expect(JOB_RUNTIME_SINGLE_WRITER_OPERATIONS).not.toContain("job-runtime:list")
    for (const token of [
      "standard SQLite storage classes",
      "JSON operators",
      "Postgres",
      "DuckDB",
      "platform collation",
      "custom extension types",
    ]) {
      expect(adr).toContain(token)
    }
  })

  it("keeps SPEC-3 and SPEC-4 runtime gates locked in the ADR", () => {
    const adr = repoFile(SPEC_2_ADR)
    const gateSection = sectionBetween(adr, "## SPEC-3 And SPEC-4 Gates", "Cross-SPEC gate:")
    const crossSpecGate = sectionBetween(adr, "Cross-SPEC gate:", "")

    for (const token of [
      "derived-stale-markers",
      "resource-budgets",
      "staging-artifacts",
      "profile-usage",
      "profile-status",
    ]) {
      expect(gateSection).toContain(token)
    }
    expect(gateSection).toContain("SPEC-3 must not own runtime state, create an alternate commit queue")
    expect(gateSection).toContain("SPEC-4 must not own runtime state or define an alternate model-call ledger")
    for (const token of [
      "SPEC-3",
      "SPEC-4",
      "runtime schema names",
      "persisted runtime state",
      "runtime write operations",
      "job state transitions",
      "must wait for the corresponding SPEC-2 implementation PR",
    ]) {
      expect(crossSpecGate).toContain(token)
    }
  })

  it("keeps SPEC-2 runtime defaults aligned with the ADR", () => {
    const adr = repoFile(SPEC_2_ADR)
    const defaults = Object.fromEntries(
      tableRows(sectionBetween(adr, "The following defaults are normative", "Heartbeat renewals")).map(
        ([setting, value]) => [setting, value],
      ),
    )

    expect(defaults).toEqual({
      "retry max": `${JOB_RUNTIME_DEFAULTS.retryMax} attempts per job`,
      "lease TTL": `${JOB_RUNTIME_DEFAULTS.leaseTtlMs} ms`,
      "heartbeat min interval": `${JOB_RUNTIME_DEFAULTS.heartbeatMinIntervalMs} ms`,
      "progress min interval": `${JOB_RUNTIME_DEFAULTS.progressMinIntervalMs} ms`,
      "writer actor queue size": `${JOB_RUNTIME_DEFAULTS.writerMaxQueueEntries} entries`,
    })
  })

  it("returns a placeholder error for unknown families", async () => {
    const contract = createMockCoreRuntimeContract()
    const result = await contract.invokePlaceholder({
      family: "unknown" as RuntimeContractFamily,
      direction: "command",
      name: "unknown:placeholder-command",
      payloadShape: "placeholder",
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNKNOWN_FAMILY",
        message: "Unknown runtime contract family: unknown",
        retryable: false,
      },
    })
  })
})
