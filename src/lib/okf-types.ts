import type { FrontmatterValue } from "@/lib/frontmatter"
import type { WikiWriteChangeCallback } from "@/lib/wiki-write-events"

export type OkfValidationSeverity = "error" | "warn"

export type OkfValidationIssueCode =
  | "wiki_missing"
  | "read_failed"
  | "missing_type"
  | "missing_title"
  | "schema_routing"
  | "malformed_wikilink"
  | "unresolved_wikilink"

export interface OkfValidationIssue {
  severity: OkfValidationSeverity
  code: OkfValidationIssueCode
  path: string
  message: string
}

export interface OkfValidatedPage {
  relativePath: string
  absolutePath: string
  title: string | null
  localType: string | null
  okfType: string | null
  body: string
  frontmatter: Record<string, FrontmatterValue> | null
  rawFrontmatterBlock: string
}

export interface OkfValidationResult {
  ok: boolean
  errors: OkfValidationIssue[]
  warnings: OkfValidationIssue[]
  pages: OkfValidatedPage[]
}

export interface OkfExportedFile {
  relativePath: string
  content: string
  frontmatter: Record<string, FrontmatterValue> | null
  rawFrontmatterBlock: string
  body: string
  localType: string | null
  okfType: string | null
}

export interface OkfTypeReport {
  localType: string
  okfType: string
  strategy: "mapped" | "passthrough"
  count: number
  paths: string[]
}

export interface OkfExportReport {
  validation: OkfValidationResult
  typeMappings: OkfTypeReport[]
}

export interface OkfExportBundle {
  files: OkfExportedFile[]
  report: OkfExportReport
}

export type OkfImportIssueCode =
  | "source_wiki_missing"
  | "invalid_source_path"
  | "invalid_target_path"
  | "read_failed"
  | "missing_type"
  | "missing_title"

export interface OkfImportIssue {
  severity: OkfValidationSeverity
  code: OkfImportIssueCode
  path: string
  message: string
}

export type OkfImportRoutingStrategy = "schema" | "default" | "root"

export type OkfImportPlanAction = "write" | "skip"

export interface OkfImportPlanPage {
  sourceRelativePath: string
  targetRelativePath: string
  targetDirectory: string
  title: string | null
  okfType: string
  localType: string
  content: string
  action: OkfImportPlanAction
  routingStrategy: OkfImportRoutingStrategy
  renamed: boolean
  conflict: boolean
  reason?: "identical"
}

export interface OkfImportSummary {
  totalPages: number
  writeCount: number
  skippedCount: number
  issueCount: number
}

export interface OkfImportPlan {
  applied: boolean
  pages: OkfImportPlanPage[]
  issues: OkfImportIssue[]
  summary: OkfImportSummary
}

export interface OkfImportOptions {
  apply?: boolean
  onWikiChanged?: WikiWriteChangeCallback
}
