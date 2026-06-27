import type { ReviewItem } from "@/stores/review-store"
import type { WikiSchemaRouting } from "@/lib/wiki-schema"

export type ReviewPageType = "entity" | "concept" | "comparison" | "synthesis" | "query"

/** Draft metadata for a wiki page created from a review item. */
export interface ReviewPageDraft {
  title: string
  pageType: ReviewPageType
  dir: string
}

interface MissingPageCandidate {
  title: string
  pageTypeHint?: ReviewPageType
}

const ACTION_PREFIX_RE = /^(Create|Save|Add|Missing page|Missing pages|缺失页面|缺少页面|创建|保存|新增)[:：\s-]*/i
const ENTITY_RE = /\b(entity|entities)\b|实体/i
const CONCEPT_RE = /\b(concept|concepts)\b|概念/i
const COMPARISON_RE = /\b(comparison|compare)\b|比较/i
const SYNTHESIS_RE = /\bsynthesis\b|综合/i
const QUERY_RE = /\bquery\b|查询/i
const TYPE_PREFIX_RE = /^(entity|entities|concept|concepts|comparison|compare|synthesis|query|实体|概念|比较|综合|查询)\s*(?:page|pages|页面|页)?\s*[:：]\s*/i
const TYPE_LABEL_RE = /(entity|entities|concept|concepts|comparison|compare|synthesis|query|实体|概念|比较|综合|查询)\s*(?:page|pages|页面|页)?\s*[:：]/gi

/** Build one or more page drafts from a review item without writing files. */
export function createReviewPageDrafts(item: ReviewItem, action: string): ReviewPageDraft[] {
  const text = `${item.title}\n${item.description}`
  const fallbackPageType = detectPageType(action, item.type, text)
  const candidates = item.type === "missing-page"
    ? extractMissingPageCandidates(text)
    : [{ title: cleanCandidateTitle(item.title) || "Untitled" }]

  return candidates.map((candidate) => {
    const pageType = candidate.pageTypeHint ?? fallbackPageType
    return {
      title: candidate.title,
      pageType,
      dir: dirForPageType(pageType),
    }
  })
}

/** Resolve a review-created page draft to a schema-routed wiki directory. */
export function reviewPageDestinationDir(
  draft: ReviewPageDraft,
  routing: WikiSchemaRouting | null | undefined,
): string {
  const routed = routing?.typeDirs[draft.pageType]
  return wikiSchemaDirToReviewDir(routed) ?? draft.dir
}

function wikiSchemaDirToReviewDir(dir: string | undefined): string | null {
  if (!dir) return null
  const normalized = dir
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  if (normalized === "wiki") return ""
  if (!normalized.startsWith("wiki/")) return null
  const relative = normalized.slice("wiki/".length)
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    return null
  }
  return relative
}

function cleanCandidateTitle(value: string): string {
  return value
    .replace(ACTION_PREFIX_RE, "")
    .replace(/^(missing|缺失|缺少)\s*/i, "")
    .replace(/\s*(page|pages|页面|页)\s*$/i, "")
    .replace(/\s*(entity|entities|concept|concepts|实体|概念)\s*(page|pages|页面|页)?\s*$/i, "")
    .replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）:：.。]+$/g, "")
    .trim()
}

function splitCandidateList(value: string, pageTypeHint?: ReviewPageType): MissingPageCandidate[] {
  return value
    .replace(/\band\b/gi, ",")
    .replace(/\s+和\s+/g, ",")
    .split(/[,，、;；\n]+/)
    .map((rawTitle) => candidateFromText(rawTitle, pageTypeHint))
    .filter((candidate): candidate is MissingPageCandidate => candidate !== null)
}

function extractMissingPageCandidates(text: string): MissingPageCandidate[] {
  const candidates: MissingPageCandidate[] = []
  const segments = text
    .split(/[\n。]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  for (const segment of segments) {
    const segmentHint = explicitPageTypeHint(segment) ?? undefined
    const typedCandidates = extractTypedCandidates(segment, segmentHint)
    if (typedCandidates.length > 0) {
      candidates.push(...typedCandidates)
      continue
    }

    const colonTail = segment.match(/[:：]\s*(.+)$/)?.[1]
    if (colonTail) candidates.push(...splitCandidateList(colonTail, segmentHint))

    const chineseMissing = segment.match(/(?:缺少|缺失|未创建|没有)\s*([^；;]+?)(?:等)?\s*(?:实体|概念)?\s*(?:页面|页)(?:缺失|不存在|未创建)?/i)
    if (chineseMissing?.[1]) candidates.push(...splitCandidateList(chineseMissing[1], segmentHint))

    const englishMissing = segment.match(/missing\s+(?:(?:entities|entity|concepts|concept|pages|page)\s+)?([^.;:]+?)(?:\s+(?:pages|page|entities|entity|concepts|concept))?$/i)
    if (englishMissing?.[1]) candidates.push(...splitCandidateList(englishMissing[1], segmentHint))
  }

  if (candidates.length === 0) {
    const title = cleanCandidateTitle(segments[0] ?? "") || "Untitled"
    candidates.push({ title, pageTypeHint: explicitPageTypeHint(segments[0] ?? "") ?? undefined })
  }

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    if (seen.has(candidate.title)) return false
    seen.add(candidate.title)
    return true
  })
}

function extractTypedCandidates(segment: string, segmentHint?: ReviewPageType): MissingPageCandidate[] {
  const matches = [...segment.matchAll(TYPE_LABEL_RE)]
  return matches.flatMap((match, index) => {
    const hint = explicitPageTypeHint(match[1]) ?? segmentHint
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? segment.length
    return splitCandidateList(segment.slice(start, end), hint)
  })
}

function candidateFromText(rawTitle: string, pageTypeHint?: ReviewPageType): MissingPageCandidate | null {
  const candidateHint = explicitPageTypeHint(rawTitle) ?? pageTypeHint
  const title = cleanCandidateTitle(rawTitle.replace(TYPE_PREFIX_RE, ""))
  if (!title) return null
  return {
    title,
    pageTypeHint: candidateHint,
  }
}

function detectPageType(action: string, reviewType: ReviewItem["type"], text: string): ReviewPageType {
  const combined = `${action}\n${text}`
  const explicit = explicitPageTypeHint(combined)
  if (explicit) return explicit
  if (reviewType === "missing-page") return "concept"
  if (reviewType === "contradiction") return "query"
  if (reviewType === "suggestion") return "query"
  return "query"
}

function explicitPageTypeHint(value: string): ReviewPageType | null {
  if (ENTITY_RE.test(value)) return "entity"
  if (CONCEPT_RE.test(value)) return "concept"
  if (COMPARISON_RE.test(value)) return "comparison"
  if (SYNTHESIS_RE.test(value)) return "synthesis"
  if (QUERY_RE.test(value)) return "query"
  return null
}

function dirForPageType(pageType: ReviewPageType): string {
  switch (pageType) {
    case "entity":
      return "entities"
    case "concept":
      return "concepts"
    case "comparison":
      return "comparisons"
    case "synthesis":
      return "synthesis"
    case "query":
    default:
      return "queries"
  }
}
