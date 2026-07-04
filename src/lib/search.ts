import { invoke } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

export interface ImageRef {
  url: string
  alt: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  vectorScore?: number
  images: ImageRef[]
}

export type SearchRetrievalMode = "keyword" | "vector" | "hybrid"

interface BackendSearchResponse {
  mode: SearchRetrievalMode
  results: SearchResult[]
  tokenHits: number
  vectorHits: number
}

/**
 * SPEC-6 PR6 decision 7: `search_project` already returns `mode`/
 * `vectorHits` (which retrieval path actually served this query, and how
 * many vector hits it found), but the WebView previously discarded both.
 * Passing them through lets `search-view.tsx` tell the user when a search
 * silently fell back to keyword-only — e.g. because the `embedding` layer
 * is `dirty`/`building` and vector search had nothing (or a stale index)
 * to search — instead of the fallback being invisible.
 */
export interface SearchWikiResponse {
  results: SearchResult[]
  mode: SearchRetrievalMode
  vectorHits: number
}

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCJK && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) tokens.push(ch)
      }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchWikiResponse> {
  if (!query.trim()) return { results: [], mode: "keyword", vectorHits: 0 }
  const pp = normalizePath(projectPath)
  const embCfg = useWikiStore.getState().embeddingConfig

  const response = await invoke<BackendSearchResponse>("search_project", {
    projectPath: pp,
    query,
    topK: 20,
    includeContent: false,
    queryEmbedding: null,
    embeddingConfig: embCfg,
  })

  return {
    results: response.results.map((result) => ({
      ...result,
      path: `${pp}/${normalizePath(result.path).replace(/^\/+/, "")}`,
    })),
    mode: response.mode,
    vectorHits: response.vectorHits,
  }
}
