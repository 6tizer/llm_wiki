import type { FrontmatterValue } from "@/lib/frontmatter"

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
