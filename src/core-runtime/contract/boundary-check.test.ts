import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  type BoundarySourceFile,
  checkCoreRuntimeBoundary,
  collectModuleSpecifiers,
  isForbiddenCoreImport,
} from "./boundary-check"

const CORE_RUNTIME_DIR = resolve(process.cwd(), "src/core-runtime")

function isBoundaryCheckedSource(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") &&
    !filePath.endsWith(".test.ts") &&
    !filePath.endsWith(".spec.ts") &&
    !filePath.endsWith(".d.ts") &&
    !filePath.split(/[\\/]/).includes("__fixtures__")
  )
}

function coreRuntimeSourceFiles(dir = CORE_RUNTIME_DIR): BoundarySourceFile[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return coreRuntimeSourceFiles(entryPath)
    }
    if (!entry.isFile() || !isBoundaryCheckedSource(entryPath)) {
      return []
    }

    return [
      {
        filePath: relative(process.cwd(), entryPath),
        sourceText: readFileSync(entryPath, "utf-8"),
      },
    ]
  })
}

describe("Core Runtime boundary checker", () => {
  it("extracts module specifiers across TypeScript import forms", () => {
    const source = `
      import {
        create
      } from "zustand"
      import type { FC } from "react"
      import "@tauri-apps/plugin-store"
      export { thing } from "@/stores/wiki-store"
      export * from "@/components/button"
      import legacy = require("@/lib/runtime.db")
      type ReactNode = import("react/jsx-runtime").JSX.Element
      type Store = import("zustand/vanilla").StoreApi<unknown>
      async function load() {
        const react = await import("react", { with: { type: "json" } })
        return react
      }
    `

    expect(collectModuleSpecifiers(source)).toEqual([
      "zustand",
      "react",
      "@tauri-apps/plugin-store",
      "@/stores/wiki-store",
      "@/components/button",
      "@/lib/runtime.db",
      "react/jsx-runtime",
      "zustand/vanilla",
      "react",
    ])
  })

  it.each([
    ["react"],
    ["react/jsx-runtime"],
    ["zustand"],
    ["zustand/vanilla"],
    ["@/stores/wiki-store"],
    ["@/components/settings/settings-view"],
    ["@/commands/fs"],
    ["@/lib/project-identity"],
    ["@tauri-apps/api/core"],
    ["@tauri-apps/plugin-store"],
    ["@/lib/runtime.db"],
  ])("blocks forbidden core import %s", (specifier) => {
    expect(isForbiddenCoreImport(specifier)).toBe(true)
  })

  it.each([
    ["./index"],
    ["../contract/index"],
    ["typescript"],
    ["node:fs"],
    ["@/core-runtime/stable-hash"],
  ])("allows non-shell import %s", (specifier) => {
    expect(isForbiddenCoreImport(specifier)).toBe(false)
  })

  it("reports structured violations for forbidden imports", () => {
    const violations = checkCoreRuntimeBoundary([
      {
        filePath: "src/core-runtime/example.ts",
        sourceText: `
          import React from "react"
          import { open } from "@/commands/fs"
          import { projectIdentity } from "@/lib/project-identity"
          import { useWikiStore } from "@/stores/wiki-store"
        `,
      },
    ])

    expect(violations).toEqual([
      {
        filePath: "src/core-runtime/example.ts",
        specifier: "react",
        reason: "Core Runtime must not import React shell APIs",
      },
      {
        filePath: "src/core-runtime/example.ts",
        specifier: "@/commands/fs",
        reason: "Core Runtime must not import shell command wrappers",
      },
      {
        filePath: "src/core-runtime/example.ts",
        specifier: "@/lib/project-identity",
        reason: "Core Runtime must not import shell library modules",
      },
      {
        filePath: "src/core-runtime/example.ts",
        specifier: "@/stores/wiki-store",
        reason: "Core Runtime must not import UI shell stores",
      },
    ])
  })

  it("keeps all Core Runtime source files independent from shell/runtime imports", () => {
    expect(checkCoreRuntimeBoundary(coreRuntimeSourceFiles())).toEqual([])
  })
})
