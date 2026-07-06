/**
 * Structural parity check for the translation bundles.
 *
 * If en.json grows a key that zh.json doesn't have (or vice-versa),
 * the app either falls back to the raw key at runtime (ugly) or
 * silently shows the English string to Chinese users. Both are
 * regressions we want to catch at test time.
 *
 * This test is deliberately string-based rather than going through
 * i18next's runtime — it should fail on the FILE contents before
 * anyone notices in the UI.
 */
import { describe, it, expect } from "vitest"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as ts from "typescript"
import en from "./en.json"
import zh from "./zh.json"

/** Flattens a nested translation object to "a.b.c" dot-path keys. */
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return []
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === "object") {
      out.push(...flattenKeys(v, path))
    } else {
      out.push(path)
    }
  }
  return out
}

interface TranslationReference {
  key: string
  file: string
  line: number
}

interface DynamicTranslationReference {
  expression: string
  prefix: string
  file: string
  line: number
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])

function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if ([...SOURCE_EXTENSIONS].some((extension) => path.endsWith(extension))) {
      out.push(path)
    }
  }
  return out
}

function translationCallArg(node: ts.CallExpression): ts.Expression | undefined {
  if (ts.isIdentifier(node.expression) && node.expression.text === "t") return node.arguments[0]
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "t") {
    return node.arguments[0]
  }
  return undefined
}

function sourceFileKind(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function lineNumberForNode(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function collectStaticTranslationReferences(srcDir: string): TranslationReference[] {
  const refs: TranslationReference[] = []
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8")
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, sourceFileKind(file))
    const visit = (node: ts.Node) => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit)
        return
      }
      const arg = translationCallArg(node)
      if (arg && ts.isStringLiteral(arg)) {
        refs.push({
          key: arg.text,
          file,
          line: lineNumberForNode(sourceFile, node),
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return refs
}

function collectDynamicTranslationReferences(srcDir: string): DynamicTranslationReference[] {
  const refs: DynamicTranslationReference[] = []
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8")
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, sourceFileKind(file))
    const visit = (node: ts.Node) => {
      if (!ts.isCallExpression(node)) {
        ts.forEachChild(node, visit)
        return
      }
      const arg = translationCallArg(node)
      if (!arg || !ts.isTemplateExpression(arg)) {
        ts.forEachChild(node, visit)
        return
      }
      const prefix = arg.head.text.replace(/\.+$/, "")
      if (!prefix) {
        ts.forEachChild(node, visit)
        return
      }
      refs.push({
        expression: arg.getText(sourceFile),
        prefix,
        file,
        line: lineNumberForNode(sourceFile, node),
      })
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return refs
}

function formatReferences(refs: TranslationReference[]): string {
  return refs
    .map((ref) => `${ref.key} (${ref.file}:${ref.line})`)
    .sort()
    .join("\n  ")
}

function formatDynamicReferences(refs: DynamicTranslationReference[]): string {
  return refs
    .map((ref) => `${ref.expression} -> ${ref.prefix}.* (${ref.file}:${ref.line})`)
    .sort()
    .join("\n  ")
}

describe("i18n bundle parity (en.json ↔ zh.json)", () => {
  const i18nDir = dirname(fileURLToPath(import.meta.url))
  const srcDir = join(i18nDir, "..")
  const enKeys = new Set(flattenKeys(en))
  const zhKeys = new Set(flattenKeys(zh))

  it("does not contain duplicate top-level JSON keys", () => {
    const findDuplicates = (fileName: string) => {
      const text = readFileSync(join(i18nDir, fileName), "utf8")
      const seen = new Set<string>()
      const duplicates = new Set<string>()
      for (const match of text.matchAll(/^  "([^"]+)":/gm)) {
        const key = match[1]
        if (seen.has(key)) duplicates.add(key)
        seen.add(key)
      }
      return [...duplicates].sort()
    }

    expect(findDuplicates("en.json"), "duplicate top-level keys in en.json").toEqual([])
    expect(findDuplicates("zh.json"), "duplicate top-level keys in zh.json").toEqual([])
  })

  it("every en.json key is also in zh.json", () => {
    const missing = [...enKeys].filter((k) => !zhKeys.has(k)).sort()
    expect(
      missing,
      `Keys in en.json but missing from zh.json — add Chinese translations for:\n  ${missing.join("\n  ")}`,
    ).toEqual([])
  })

  it("every zh.json key is also in en.json (no orphaned zh-only strings)", () => {
    const orphaned = [...zhKeys].filter((k) => !enKeys.has(k)).sort()
    expect(
      orphaned,
      `Keys in zh.json but missing from en.json — either add English translations or remove the stale zh-only keys:\n  ${orphaned.join("\n  ")}`,
    ).toEqual([])
  })

  it("every leaf value is a non-empty string (no null / empty / placeholder slips)", () => {
    const check = (bundle: unknown, label: string) => {
      const keys = flattenKeys(bundle)
      for (const path of keys) {
        // Walk back to pull the value.
        let ref: unknown = bundle
        for (const part of path.split(".")) {
          ref = (ref as Record<string, unknown>)[part]
        }
        expect(typeof ref, `${label}: ${path} is not a string`).toBe("string")
        expect((ref as string).length, `${label}: ${path} is empty`).toBeGreaterThan(0)
      }
    }
    check(en, "en.json")
    check(zh, "zh.json")
  })

  it("pluralization keys come in pairs: every foo_plural has a matching foo", () => {
    // i18next plural convention — a `foo_plural` without `foo` means
    // the singular form will fall back to the raw key at runtime.
    const check = (bundle: unknown, label: string) => {
      const keys = new Set(flattenKeys(bundle))
      for (const k of keys) {
        if (k.endsWith("_plural")) {
          const singular = k.slice(0, -"_plural".length)
          expect(
            keys.has(singular),
            `${label}: found ${k} but no matching ${singular} (i18next will fall back to the raw key for count=1)`,
          ).toBe(true)
        }
      }
    }
    check(en, "en.json")
    check(zh, "zh.json")
  })

  it("every static t(\"...\") key referenced from src exists in both bundles", () => {
    const refs = collectStaticTranslationReferences(srcDir)
    const missingInEn = refs.filter((ref) => !enKeys.has(ref.key))
    const missingInZh = refs.filter((ref) => !zhKeys.has(ref.key))

    expect(
      missingInEn,
      `Static translation keys referenced from src but missing in en.json:\n  ${formatReferences(missingInEn)}`,
    ).toEqual([])
    expect(
      missingInZh,
      `Static translation keys referenced from src but missing in zh.json:\n  ${formatReferences(missingInZh)}`,
    ).toEqual([])
  })

  it("dynamic template translation keys referenced from src have bundle prefixes", () => {
    const refs = collectDynamicTranslationReferences(srcDir)
    const enPrefixes = refs.filter((ref) => ![...enKeys].some((key) => key.startsWith(`${ref.prefix}.`)))
    const zhPrefixes = refs.filter((ref) => ![...zhKeys].some((key) => key.startsWith(`${ref.prefix}.`)))

    expect(
      enPrefixes,
      `Dynamic translation key prefixes referenced from src but missing in en.json:\n  ${formatDynamicReferences(enPrefixes)}`,
    ).toEqual([])
    expect(
      zhPrefixes,
      `Dynamic translation key prefixes referenced from src but missing in zh.json:\n  ${formatDynamicReferences(zhPrefixes)}`,
    ).toEqual([])
  })
})
