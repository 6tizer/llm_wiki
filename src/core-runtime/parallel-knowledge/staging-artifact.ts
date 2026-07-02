import {
  MARKDOWN_COMMIT_OPERATION_INTENTS,
  type MarkdownCommitOperationIntent,
} from "../contract"
import { fnv1a64Hex } from "../stable-hash"

export const BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND = "bulk-knowledge-prepare-output"
export const BULK_KNOWLEDGE_ARTIFACT_REPAIR_JOB_KIND =
  "bulk-knowledge-artifact-repair"
export const MAX_PREPARE_ARTIFACT_MARKDOWN_BYTES = 2_000_000
export const MAX_PREPARE_ARTIFACT_DIAGNOSTICS_BYTES = 4096
export const MAX_PREPARE_ARTIFACT_PATH_BYTES = 1024
export const MAX_PREPARE_ARTIFACT_SOURCE_KIND_BYTES = 128
export const MAX_PREPARE_ARTIFACT_HASH_BYTES = 128

const ENCODER = new TextEncoder()

export interface BulkKnowledgePrepareArtifactCandidate {
  readonly kind: typeof BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND
  readonly sourcePath: string
  readonly targetPath: string
  readonly artifactPath: string
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly sourceKind: string
  readonly markdown: string
  readonly baseHash: string | null
  readonly diagnostics?: Record<string, unknown>
}

export interface ValidatedPrepareArtifact {
  readonly artifactId: string
  readonly sourcePath: string
  readonly targetPath: string
  readonly targetResourceKey: string
  readonly artifactPath: string
  readonly operationIntent: MarkdownCommitOperationIntent
  readonly sourceKind: string
  readonly markdown: string
  readonly baseHash: string | null
  readonly diagnostics?: Record<string, unknown>
}

export interface ValidatePrepareArtifactsOptions {
  readonly jobId: string
}

export function validatePrepareArtifacts(
  rawArtifacts: readonly unknown[],
  options: ValidatePrepareArtifactsOptions,
): ValidatedPrepareArtifact[] {
  if (!Array.isArray(rawArtifacts)) {
    throw new Error("prepare-artifacts-invalid: artifacts must be an array")
  }

  const normalizedJobId = requireNonEmptyString(options.jobId, "jobId")
  const seenTargetResources = new Set<string>()
  const seenArtifactPaths = new Set<string>()
  return rawArtifacts.map((rawArtifact, index) => {
    const candidate = parseCandidate(rawArtifact, index)
    const target = normalizeCommitTargetPath(candidate.targetPath)
    if (seenTargetResources.has(target.resourceKey)) {
      throw new Error(
        `prepare-artifact-target-duplicate: targetPath '${target.displayKey}' appears more than once`,
      )
    }
    seenTargetResources.add(target.resourceKey)

    const artifactPath = normalizeStagingArtifactPath(candidate.artifactPath)
    assertArtifactPathScopedToJob(artifactPath, normalizedJobId)
    const artifactPathKey = normalizePathResourceKey(artifactPath)
    if (seenArtifactPaths.has(artifactPathKey)) {
      throw new Error(
        `prepare-artifact-path-duplicate: artifactPath '${artifactPath}' appears more than once`,
      )
    }
    seenArtifactPaths.add(artifactPathKey)
    return {
      ...candidate,
      targetPath: target.displayKey,
      targetResourceKey: target.resourceKey,
      artifactPath,
      artifactId: derivePrepareArtifactId(normalizedJobId, target.resourceKey),
    }
  })
}

export function derivePrepareArtifactId(jobId: string, targetResourceKey: string): string {
  const normalizedJobId = requireNonEmptyString(jobId, "jobId")
  const normalizedTarget = requireNonEmptyString(targetResourceKey, "targetResourceKey")
  return `bulk-artifact-${stableHash128(`${normalizedJobId}\n${normalizedTarget}`)}`
}

export function normalizeCommitTargetPath(
  raw: string,
): { displayKey: string; resourceKey: string } {
  // Keep this mirror aligned with Rust normalize_affected_path in runtime_db.rs.
  const normalized = normalizeRelativePath(raw, "targetPath", {
    maxBytes: MAX_PREPARE_ARTIFACT_PATH_BYTES,
  })
  const leaf = normalized.split("/").slice(-1)[0] ?? ""
  const leafLower = leaf.toLowerCase()
  if (leafLower === ".md" || !leafLower.endsWith(".md")) {
    throw new Error("prepare-artifact-target-invalid: targetPath must point to Markdown")
  }
  return {
    displayKey: normalized,
    resourceKey: normalizePathResourceKey(normalized),
  }
}

export function normalizeStagingArtifactPath(raw: string): string {
  return normalizeRelativePath(raw, "artifactPath", {
    maxBytes: MAX_PREPARE_ARTIFACT_PATH_BYTES,
  })
}

function parseCandidate(
  rawArtifact: unknown,
  index: number,
): BulkKnowledgePrepareArtifactCandidate {
  if (!isRecord(rawArtifact)) {
    throw new Error(`prepare-artifact-invalid: artifact[${index}] must be an object`)
  }
  if ("artifactId" in rawArtifact) {
    throw new Error("prepare-artifact-id-forbidden: artifactId is worker-derived")
  }
  if (rawArtifact.kind !== BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND) {
    throw new Error("prepare-artifact-kind-invalid")
  }

  const operationIntent = parseOperationIntent(rawArtifact.operationIntent)
  const baseHash = parseBaseHash(rawArtifact.baseHash)
  validateBaseHash(operationIntent, baseHash)

  const markdown = requireNonEmptyString(rawArtifact.markdown, "markdown")
  requireMaxBytes(markdown, "markdown", MAX_PREPARE_ARTIFACT_MARKDOWN_BYTES)
  const sourceKind = requireNonEmptyString(rawArtifact.sourceKind, "sourceKind")
  requireMaxBytes(sourceKind, "sourceKind", MAX_PREPARE_ARTIFACT_SOURCE_KIND_BYTES)
  const diagnostics = parseDiagnostics(rawArtifact.diagnostics)

  return {
    kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
    sourcePath: requireLimitedString(
      rawArtifact.sourcePath,
      "sourcePath",
      MAX_PREPARE_ARTIFACT_PATH_BYTES,
    ),
    targetPath: requireNonEmptyString(rawArtifact.targetPath, "targetPath"),
    artifactPath: requireNonEmptyString(rawArtifact.artifactPath, "artifactPath"),
    operationIntent,
    sourceKind,
    markdown,
    baseHash,
    ...(diagnostics ? { diagnostics } : {}),
  }
}

function parseOperationIntent(raw: unknown): MarkdownCommitOperationIntent {
  if (typeof raw !== "string") {
    throw new Error("prepare-artifact-operation-invalid")
  }
  if (!MARKDOWN_COMMIT_OPERATION_INTENTS.includes(raw as MarkdownCommitOperationIntent)) {
    throw new Error(`prepare-artifact-operation-invalid: ${raw}`)
  }
  return raw as MarkdownCommitOperationIntent
}

function validateBaseHash(
  operationIntent: MarkdownCommitOperationIntent,
  baseHash: string | null,
): void {
  if (operationIntent === "create" && baseHash !== null) {
    throw new Error("prepare-artifact-base-hash-invalid: create requires null baseHash")
  }
  if ((operationIntent === "update" || operationIntent === "delete") && baseHash === null) {
    throw new Error(
      `prepare-artifact-base-hash-invalid: ${operationIntent} requires baseHash`,
    )
  }
}

function parseBaseHash(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = requireNonEmptyString(raw, "baseHash")
  requireMaxBytes(value, "baseHash", MAX_PREPARE_ARTIFACT_HASH_BYTES)
  return value
}

function parseDiagnostics(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined) return undefined
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new Error("prepare-artifact-diagnostics-invalid")
  }
  const serialized = JSON.stringify(raw)
  requireMaxBytes(serialized, "diagnostics", MAX_PREPARE_ARTIFACT_DIAGNOSTICS_BYTES)
  return raw
}

function normalizeRelativePath(
  raw: string,
  field: string,
  options: { maxBytes: number },
): string {
  const trimmed = requireNonEmptyString(raw, field).trim().replace(/\\/g, "/")
  requireMaxBytes(trimmed, field, options.maxBytes)
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`prepare-artifact-${field}-invalid: drive paths are not allowed`)
  }
  if (trimmed.startsWith("/")) {
    throw new Error(`prepare-artifact-${field}-invalid: absolute paths are not allowed`)
  }
  if (trimmed.endsWith("/")) {
    throw new Error(`prepare-artifact-${field}-invalid: directory paths are not allowed`)
  }

  const segments = trimmed.split("/")
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`prepare-artifact-${field}-invalid: unsafe path segment`)
    }
  }
  return segments.join("/")
}

function normalizePathResourceKey(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/")
}

function assertArtifactPathScopedToJob(artifactPath: string, jobId: string): void {
  const [scope] = artifactPath.split("/")
  if (scope !== jobId) {
    throw new Error("prepare-artifact-artifactPath-invalid: artifactPath must start with jobId")
  }
}

function requireNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`prepare-artifact-${field}-invalid: ${field} must not be empty`)
  }
  return raw
}

function requireMaxBytes(value: string, field: string, maxBytes: number): void {
  if (ENCODER.encode(value).length > maxBytes) {
    throw new Error(`prepare-artifact-${field}-too-large`)
  }
}

function requireLimitedString(raw: unknown, field: string, maxBytes: number): string {
  const value = requireNonEmptyString(raw, field)
  requireMaxBytes(value, field, maxBytes)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stableHash128(value: string): string {
  // Two seeded FNV-1a64 passes provide a compact stable key, not security.
  return `${fnv1a64Hex(value, 0xcbf29ce484222325n)}${fnv1a64Hex(
    value,
    0x6c62272e07bb0142n,
  )}`
}
