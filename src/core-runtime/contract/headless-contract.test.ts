import { readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
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

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf-8")
}

function contractSourceFiles(): string[] {
  const dir = resolve(process.cwd(), "src/core-runtime/contract")
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .map((name) => join(dir, name))
}

function moduleSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []

  function addModuleSpecifier(node: { moduleSpecifier?: ts.Expression }): void {
    if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addModuleSpecifier(node)
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return specifiers
}

function isForbiddenSpecifier(specifier: string): boolean {
  return (
    specifier === "react" ||
    specifier.startsWith("react/") ||
    specifier === "zustand" ||
    specifier.startsWith("zustand/") ||
    specifier.startsWith("@tauri-apps/") ||
    specifier.startsWith("@/stores/") ||
    specifier === "@tauri-apps/plugin-store" ||
    specifier === "@/lib/runtime.db"
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

    expect(contract.maturity).toBe("frozen")
    expect(RUNTIME_CONTRACT_FAMILIES).toEqual(EXPECTED_FAMILIES)
    expect(messages).toHaveLength(EXPECTED_FAMILIES.length * 2)

    for (const family of EXPECTED_FAMILIES) {
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
    for (const file of contractSourceFiles()) {
      const specifiers = moduleSpecifiers(readFileSync(file, "utf-8"))
      expect(specifiers.filter(isForbiddenSpecifier), basename(file)).toEqual([])
    }
  })

  it("extracts multiline, side-effect, export, and dynamic module specifiers", () => {
    const source = `
      import {
        create
      } from "zustand"
      import "@tauri-apps/plugin-store"
      export { thing } from "@/stores/wiki-store"
      import legacy = require("@/lib/runtime.db")
      type ReactNode = import("react/jsx-runtime").JSX.Element
      type Store = import("zustand/vanilla").StoreApi<unknown>
      async function load() {
        return import("react")
      }
    `

    expect(moduleSpecifiers(source)).toEqual([
      "zustand",
      "@tauri-apps/plugin-store",
      "@/stores/wiki-store",
      "@/lib/runtime.db",
      "react/jsx-runtime",
      "zustand/vanilla",
      "react",
    ])
  })

  it("keeps the ADR inventory aligned with the frozen skeleton", () => {
    const adr = repoFile("docs/plans/SPEC-1/adr-shell-core-boundary.md")

    expect(adrInventoryFamilies(adr)).toEqual(
      EXPECTED_FAMILIES.map((family) => ADR_FAMILY_LABELS[family]),
    )
    expect(adrAppStateKeys(adr)).toEqual(APP_STATE_LOCK_KEYS)
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
