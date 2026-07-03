import { describe, it, expect } from "vitest"
import { generateLintReport, type LintResult } from "./lint"

/**
 * SPEC-11 D6 bug1: classifyFixability() previously routed orphan results
 * into autoFixItems, which fixLintReport (the report-driven auto-fix path
 * used by both the agent tool and runLintAndReport's autoFix flag) then
 * fed straight to fixLintResult -> fixOrphan with zero confirmation --
 * cascade-deleting the page. fixAllLintResults (the UI "Fix All" button)
 * already filtered orphan out by hand; this test locks in that the report
 * classification agrees, so every auto-fix entry point treats orphan the
 * same way.
 */
describe("generateLintReport — orphan classification (SPEC-11 D6 bug1)", () => {
  const orphan: LintResult = {
    type: "orphan",
    severity: "info",
    page: "concepts/lonely.md",
    detail: "No other pages link to this page.",
  }

  it("routes orphan results to humanItems, not autoFixItems", () => {
    const report = generateLintReport([orphan], 5)
    expect(report.autoFixItems).toEqual([])
    expect(report.humanItems).toEqual([orphan])
  })

  it("still auto-fixes broken-link and no-outlinks results", () => {
    const brokenLink: LintResult = {
      type: "broken-link",
      severity: "warning",
      page: "concepts/a.md",
      detail: "Broken link: [[missing]] — target page not found.",
    }
    const noOutlinks: LintResult = {
      type: "no-outlinks",
      severity: "info",
      page: "concepts/b.md",
      detail: "This page has no [[wikilink]] references to other pages.",
    }
    const report = generateLintReport([orphan, brokenLink, noOutlinks], 5)
    expect(report.autoFixItems).toEqual([brokenLink, noOutlinks])
    expect(report.humanItems).toEqual([orphan])
  })

  it("still routes semantic [suggestion] items to humanItems alongside orphans", () => {
    const suggestion: LintResult = {
      type: "semantic",
      severity: "info",
      page: "Add a page on X",
      detail: "[suggestion] Consider adding a page about X.",
    }
    const report = generateLintReport([orphan, suggestion], 5)
    expect(report.autoFixItems).toEqual([])
    expect(report.humanItems).toEqual([orphan, suggestion])
  })
})
