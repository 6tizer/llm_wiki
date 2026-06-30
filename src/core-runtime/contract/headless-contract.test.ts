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
  DERIVED_STALE_MARKER_LAYERS,
  DERIVED_STALE_MARKER_REASONS,
  MARKDOWN_COMMIT_ARTIFACT_FIELDS,
  MARKDOWN_COMMIT_AUDIT_FIELDS,
  MARKDOWN_COMMIT_BASE_HASH_CASES,
  MARKDOWN_COMMIT_COMMAND_NAMES,
  MARKDOWN_COMMIT_EVENT_NAMES,
  MARKDOWN_COMMIT_OPERATION_INTENTS,
  MARKDOWN_COMMIT_RESULTS,
  RUNTIME_CONTRACT_FAMILIES,
  RUNTIME_CONTRACT_MESSAGES,
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
const SPEC_3_ADR = "docs/plans/SPEC-3/adr-markdown-commit-layer.md"

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
    .filter((value) => !["Family", "Name", "State", "Operation", "Setting", "Intent", "Result", "Field", "Need"].includes(value))
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
    .filter((row) => !["Field", "Intent", "Setting"].includes(row[0] ?? ""))
}

function markdownCommitBaseHashRows(adr: string): typeof MARKDOWN_COMMIT_BASE_HASH_CASES {
  return tableRows(sectionBetween(adr, "## Base Hash Matrix", "Any state not listed")).map(
    ([intent, currentState, requiredOutcome]) => ({
      intent,
      currentState,
      requiredOutcome,
    }),
  ) as unknown as typeof MARKDOWN_COMMIT_BASE_HASH_CASES
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
    const expectedMessageCount = RUNTIME_CONTRACT_FAMILIES.reduce((total, family) => {
      const inventory = RUNTIME_CONTRACT_MESSAGES[family]
      return total + inventory.commandNames.length + inventory.eventNames.length
    }, 0)

    expect(contract.maturity).toBe("frozen")
    expect(RUNTIME_CONTRACT_FAMILIES).toEqual(EXPECTED_FAMILIES)
    expect(messages).toHaveLength(expectedMessageCount)

    for (const family of RUNTIME_CONTRACT_FAMILIES) {
      const inventory = RUNTIME_CONTRACT_MESSAGES[family]
      for (const name of inventory.commandNames) {
        expect(messages).toContainEqual({
          family,
          direction: "command",
          name,
          payloadShape: "placeholder",
        })
      }
      for (const name of inventory.eventNames) {
        expect(messages).toContainEqual({
          family,
          direction: "event",
          name,
          payloadShape: "placeholder",
        })
      }
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

  it("keeps SPEC-3 markdown-commit operations and events aligned with the ADR", () => {
    const adr = repoFile(SPEC_3_ADR)
    const contract = createMockCoreRuntimeContract()
    const markdownMessages = contract.listMessages().filter((message) => message.family === "markdown-commit")

    expect(markdownMessages.filter((message) => message.direction === "command").map((message) => message.name)).toEqual(
      MARKDOWN_COMMIT_COMMAND_NAMES,
    )
    expect(markdownMessages.filter((message) => message.direction === "event").map((message) => message.name)).toEqual(
      MARKDOWN_COMMIT_EVENT_NAMES,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Commands:", "Events:"))).toEqual(MARKDOWN_COMMIT_COMMAND_NAMES)
    expect(tableFirstColumn(sectionBetween(adr, "Events:", "These Core Runtime contract events"))).toEqual(
      MARKDOWN_COMMIT_EVENT_NAMES,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Operation intents:", "Large LLM output"))).toEqual(
      MARKDOWN_COMMIT_OPERATION_INTENTS,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Commit results:", "Each commit result"))).toEqual(
      MARKDOWN_COMMIT_RESULTS,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Staged artifact metadata contains:", "Operation intents:"))).toEqual(
      MARKDOWN_COMMIT_ARTIFACT_FIELDS,
    )
    expect(tableFirstColumn(sectionBetween(adr, "Required audit fields:", "Content rollback"))).toEqual(
      MARKDOWN_COMMIT_AUDIT_FIELDS,
    )
    expect(markdownCommitBaseHashRows(adr)).toEqual(MARKDOWN_COMMIT_BASE_HASH_CASES)
    expect(markdownMessages.every((message) => message.payloadShape === "placeholder")).toBe(true)
    expect(markdownMessages.map((message) => message.name)).not.toContain("markdown-commit:placeholder-command")
    expect(markdownMessages.map((message) => message.name)).not.toContain("markdown-commit:placeholder-event")
  })

  it("keeps SPEC-3 commit ownership boundaries explicit", () => {
    const adr = repoFile(SPEC_3_ADR)
    const dependencySection = sectionBetween(adr, "## SPEC-2 Dependencies", "## Durable Audit Payload")

    for (const token of [
      "resource-budgets",
      "events-progress",
      "staging-artifacts",
      "derived-stale-markers",
      "no SPEC-3-local limiter",
      "no SPEC-3 commit-events table",
      "runtime_commit_events",
      "No new artifact schema family",
      "no new schema family",
      "no migration",
      "No new runtime write operations",
      "no alternate commit queue",
    ]) {
      expect(dependencySection).toContain(token)
    }
    expect(adr).toContain("Durable audit facts are appended through SPEC-2 `events-progress`")
    expect(adr).toContain("SPEC-3 must not create a separate commit-events table")
    expect(adr).toContain("There is no silent overwrite")
    expect(adr).not.toContain("CREATE TABLE")
  })

  it("keeps SPEC-3 derived marker logical fields aligned with the contract metadata", () => {
    const adr = repoFile(SPEC_3_ADR)
    const markerSection = sectionBetween(adr, "## Derived Stale Marker Boundary", "## Index / Overview Boundary")

    for (const layer of DERIVED_STALE_MARKER_LAYERS) {
      expect(markerSection).toContain(`\`${layer}\``)
    }
    for (const reason of DERIVED_STALE_MARKER_REASONS) {
      expect(markerSection).toContain(`\`${reason}\``)
    }
    for (const token of [
      "SPEC-3 PR1 freezes the logical marker field set",
      "SPEC-2 owns the physical schema and write operation",
      "SPEC-6 owns rebuild scheduling",
    ]) {
      expect(markerSection).toContain(token)
    }
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
