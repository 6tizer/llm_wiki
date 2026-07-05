import { readFile } from "@/commands/fs"
import {
  runtimeModelCallForward,
  runtimeProfileStatus,
  type RuntimeProfileRecord,
} from "@/commands/runtime-db"
import {
  BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
  LONG_SOURCE_CHUNK_MAX,
  LONG_SOURCE_DIGEST_MAX,
  hashTextHex,
  planLongDocumentMapReduce,
  reduceLongDocumentMapResults,
  type BulkKnowledgePlannedSource,
  type BulkKnowledgePrepareArtifactCandidate,
  type LongDocumentMapResult,
  type LongDocumentReduceResult,
  type SourceChunk,
} from "@/core-runtime/parallel-knowledge"
import {
  getProviderConfig,
  type ChatMessage,
  type RequestOverrides,
} from "@/lib/llm-providers"
import { syntheticLlmConfig } from "@/lib/profile-llm-config"
import type {
  PrepareModelCallExecutor,
  PrepareModelCallOutcome,
  PrepareModelCallRequest,
} from "./prepare-worker-pool"

/**
 * Threshold (characters) above which a source is processed through
 * `long-document-map-reduce` instead of a single model call. Reuses the
 * existing map-reduce chunk-size ceiling rather than inventing a new
 * budget constant.
 */
const SOURCE_SINGLE_SHOT_BUDGET_CHARS = LONG_SOURCE_CHUNK_MAX

/**
 * Deterministic sampling: this is a structured-ingest rewrite, not a
 * creative task. Mirrors the temperature ingest.ts already uses for the
 * same reason (see llm-providers.ts adaptKimiBody/adaptXiaomiMimoBody
 * comments — several providers reject or special-case this value).
 */
const DETERMINISTIC_OVERRIDES: RequestOverrides = { temperature: 0.1 }

const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000

const SHORT_SOURCE_SYSTEM_PROMPT = [
  "You are a technical writer converting raw source material into a single wiki page.",
  "Rewrite the source content as clean, well-structured GitHub-flavored Markdown.",
  "Start with a level-1 heading naming the topic. Preserve every fact faithfully; never invent information that is not present in the source.",
  "Respond with only the final Markdown content: no commentary, no preamble, no surrounding code fence.",
].join(" ")

const MAP_REDUCE_CHUNK_SYSTEM_PROMPT = [
  "You are analyzing one chunk of a long source document as part of a map-reduce pipeline.",
  "Summarize this chunk's content faithfully and completely enough that a later step can merge it with other chunks into one wiki page.",
  "Preserve every fact faithfully; never invent information that is not present in the chunk.",
  "Respond with only the analysis text: no commentary, no preamble.",
].join(" ")

/** Thrown when the Rust forwarder reports a 429; must short-circuit the whole job. */
class ModelCallRateLimitedError extends Error {
  readonly retryAfterMs: number

  constructor(retryAfterMs: number, message: string) {
    super(message)
    this.name = "ModelCallRateLimitedError"
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Production `PrepareModelCallExecutor`: builds a secretless model-call
 * plan with the existing `llm-providers.ts` body builders, forwards it
 * through the Rust `runtime_model_call_forward` command (which injects the
 * secret and returns only the raw provider body), and parses the result
 * with the existing per-provider `parseStream` line parser. Never touches
 * the profile's secret directly — the executor only ever sees `claimId`
 * plus the non-secret profile fields returned by `runtimeProfileStatus`.
 */
export function createPrepareModelCallExecutor(): PrepareModelCallExecutor {
  return async (request) => {
    try {
      return await runPrepareModelCall(request)
    } catch (err) {
      if (err instanceof ModelCallRateLimitedError) {
        return {
          status: "rate-limited",
          retryAfterMs: err.retryAfterMs,
          jobRetryAfterMs: err.retryAfterMs,
          error: err.message,
        }
      }
      return { status: "error", error: errorMessage(err) }
    }
  }
}

async function runPrepareModelCall(
  request: PrepareModelCallRequest,
): Promise<PrepareModelCallOutcome> {
  const profile = await runtimeProfileStatus({ profileId: request.profileClaim.profileId })
  const artifacts: BulkKnowledgePrepareArtifactCandidate[] = []
  const mapReduceResults: LongDocumentReduceResult[] = []
  // Batch-scoped: target/artifact slugs must be unique across every source
  // in this single prepare call. Two sources whose paths normalize to the
  // same slug (e.g. `raw/sources/a.md` and `raw/sources/a.txt`) would
  // otherwise both resolve to `Wiki/a.md`, which `validatePrepareArtifacts`
  // rejects as a duplicate path and fails the whole job.
  const usedTargetSlugs = new Set<string>()

  for (const source of request.payload.sources) {
    const content = await readSourceContent(source.sourcePath)

    if (content.length <= SOURCE_SINGLE_SHOT_BUDGET_CHARS) {
      const markdown = await callShortSourceModel(request, profile, source, content)
      artifacts.push(buildArtifactCandidate(request.job.jobId, source, markdown, usedTargetSlugs))
      continue
    }

    const plan = planLongDocumentMapReduce({
      sourcePath: source.sourcePath,
      sourceIdentity: source.sourceIdentity,
      content,
      sourceBudget: SOURCE_SINGLE_SHOT_BUDGET_CHARS,
    })
    const chunkResults: LongDocumentMapResult[] = []
    for (const chunk of plan.chunks) {
      chunkResults.push(await callChunkModel(request, profile, chunk))
    }
    const reduceResult = reduceLongDocumentMapResults(plan, chunkResults, {
      jobId: request.job.jobId,
      sourceJobKind: request.job.kind,
    })
    mapReduceResults.push(reduceResult)
    if (reduceResult.status === "complete") {
      artifacts.push(
        buildArtifactCandidate(
          request.job.jobId,
          source,
          reduceResult.analysisMarkdown,
          usedTargetSlugs,
        ),
      )
    }
  }

  return {
    status: "success",
    artifacts,
    ...(mapReduceResults.length > 0 ? { mapReduceResults } : {}),
  }
}

async function readSourceContent(sourcePath: string): Promise<string> {
  try {
    return await readFile(sourcePath)
  } catch {
    // The path itself is not a secret (it is a project file path the user
    // already imported); the underlying OS error text is discarded rather
    // than interpolated, keeping this consistent with the "no raw
    // downstream error text in outcome.error" rule applied to the model
    // call path below.
    throw new Error(`prepare-source-read-failed: ${sourcePath}`)
  }
}

async function callShortSourceModel(
  request: PrepareModelCallRequest,
  profile: RuntimeProfileRecord,
  source: BulkKnowledgePlannedSource,
  content: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: SHORT_SOURCE_SYSTEM_PROMPT },
    { role: "user", content: `Source path: ${source.sourcePath}\n\n---\n\n${content}` },
  ]
  const markdown = (
    await callModel(request, profile, messages, DETERMINISTIC_OVERRIDES)
  ).trim()
  if (markdown.length === 0) {
    throw new Error("prepare-model-call-empty-response")
  }
  return markdown
}

async function callChunkModel(
  request: PrepareModelCallRequest,
  profile: RuntimeProfileRecord,
  chunk: SourceChunk,
): Promise<LongDocumentMapResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: MAP_REDUCE_CHUNK_SYSTEM_PROMPT },
    { role: "user", content: buildChunkUserPrompt(chunk) },
  ]
  try {
    const analysis = (
      await callModel(request, profile, messages, DETERMINISTIC_OVERRIDES)
    ).trim()
    return {
      chunkId: chunk.id,
      status: "success",
      analysis,
      digest: analysis.slice(0, LONG_SOURCE_DIGEST_MAX),
    }
  } catch (err) {
    // A rate-limited provider must back off the whole job (and the
    // profile-pool circuit breaker), not just this one chunk — propagate
    // it. Any other per-chunk failure becomes a repair job instead of
    // aborting the rest of the source's chunks.
    if (err instanceof ModelCallRateLimitedError) throw err
    return { chunkId: chunk.id, status: "failed", error: "provider-error" }
  }
}

async function callModel(
  request: PrepareModelCallRequest,
  profile: RuntimeProfileRecord,
  messages: ChatMessage[],
  overrides: RequestOverrides,
): Promise<string> {
  const config = syntheticLlmConfig(profile, SOURCE_SINGLE_SHOT_BUDGET_CHARS)
  const providerConfig = getProviderConfig(config)
  const body = providerConfig.buildBody(messages, overrides)

  let rawBody: string
  try {
    rawBody = await runtimeModelCallForward({
      claimId: request.profileClaim.claimId,
      provider: profile.providerId,
      apiMode: profile.apiMode,
      model: profile.modelId,
      body,
    })
  } catch (err) {
    // `runtime_model_call_forward` never returns a provider response body
    // or secret in its error string (see runtime_db.rs anti-leak
    // constraints) — this message is already safe to surface as-is.
    const message = errorMessage(err)
    const rateLimitedMatch = /^model-call-rate-limited: retryAfterMs=(\d+)/.exec(message)
    if (rateLimitedMatch) {
      const retryAfterMs = Number(rateLimitedMatch[1]) || DEFAULT_RATE_LIMIT_RETRY_MS
      throw new ModelCallRateLimitedError(retryAfterMs, message)
    }
    throw new Error(message)
  }

  return parseFullBody(rawBody, providerConfig.parseStream)
}

/**
 * `runtime_model_call_forward` always returns the complete buffered
 * provider response body (not a live stream), so replaying it through the
 * same per-provider `parseStream` line parser llm-client.ts uses for live
 * SSE reconstructs the full text deterministically.
 */
function parseFullBody(rawBody: string, parseStream: (line: string) => string | null): string {
  let text = ""
  for (const rawLine of rawBody.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const token = parseStream(line)
    if (token !== null) text += token
  }
  return text
}

function buildChunkUserPrompt(chunk: SourceChunk): string {
  const context = chunk.overlapBefore
    ? `Preceding context (for continuity only, do not repeat verbatim):\n${chunk.overlapBefore}\n\n---\n\n`
    : ""
  const heading = chunk.headingPath ? ` (heading: ${chunk.headingPath})` : ""
  return `${context}Chunk ${chunk.index}/${chunk.total}${heading}:\n\n${chunk.main}`
}

function buildArtifactCandidate(
  jobId: string,
  source: BulkKnowledgePlannedSource,
  markdown: string,
  usedTargetSlugs: Set<string>,
): BulkKnowledgePrepareArtifactCandidate {
  const baseSlug = slugifySourcePath(source.sourceIdentity)
  const slug = resolveUniqueSlug(baseSlug, source.sourcePath, usedTargetSlugs)
  usedTargetSlugs.add(slug)
  return {
    kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
    sourcePath: source.sourcePath,
    targetPath: `Wiki/${slug}.md`,
    artifactPath: `${jobId}/${slug}.md`,
    operationIntent: "create",
    sourceKind: "ingest",
    markdown,
    baseHash: null,
  }
}

/**
 * Derives a stable, unique-per-batch target slug from a source path.
 *
 * KNOWN PR1 BOUNDARY: this always produces `operationIntent: "create"`
 * with a path-derived slug — it does not look up whether a wiki page
 * already exists for this source (the interactive `ingest.ts` pipeline's
 * `findExistingPageByNormalizedSlug` dedupe/update flow is not ported
 * here). Every bulk-prepare run therefore creates new pages rather than
 * updating existing ones; wiring up dedupe is follow-up work.
 */
function slugifySourcePath(sourcePath: string): string {
  const afterSourcesRoot = sourcePath.split(/[/\\]raw[/\\]sources[/\\]/i).pop() ?? sourcePath
  const withoutExtension = afterSourcesRoot.replace(/\.[^./\\]+$/, "")
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
  return slug.length > 0 ? slug : hashTextHex(sourcePath)
}

/**
 * Resolves a slug collision within the current batch deterministically.
 *
 * Two sources can normalize to the same base slug when they differ only in
 * an extension `slugifySourcePath` strips (`a.md` vs `a.txt`) or otherwise
 * share a normalized path. Without resolution the second source's artifact
 * would silently overwrite the first's `targetPath`/`artifactPath`, and
 * `validatePrepareArtifacts` would reject the batch as containing duplicate
 * paths instead of producing an artifact per source.
 *
 * Resolution is purely a function of `(baseSlug, sourcePath, priorSlugsSeen
 * so far in this batch)` — same batch, same order in, same slugs out, so
 * reruns of an identical batch are reproducible. First preference is the
 * source's own file extension (readable, usually unique); the hash suffix
 * is only a fallback for the rare case where even that collides.
 */
function resolveUniqueSlug(
  baseSlug: string,
  sourcePath: string,
  usedTargetSlugs: ReadonlySet<string>,
): string {
  if (!usedTargetSlugs.has(baseSlug)) return baseSlug

  const extensionMatch = /\.([^./\\]+)$/.exec(sourcePath)
  const extensionSuffix = extensionMatch
    ? extensionMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "")
    : ""
  if (extensionSuffix) {
    const withExtension = `${baseSlug}-${extensionSuffix}`
    if (!usedTargetSlugs.has(withExtension)) return withExtension
  }

  const hashSuffix = hashTextHex(sourcePath).slice(0, 8)
  let candidate = `${baseSlug}-${hashSuffix}`
  let attempt = 1
  while (usedTargetSlugs.has(candidate)) {
    attempt += 1
    candidate = `${baseSlug}-${hashSuffix}-${attempt}`
  }
  return candidate
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err === null) return "null error thrown"
  if (err === undefined) return "undefined error thrown"
  return String(err)
}
