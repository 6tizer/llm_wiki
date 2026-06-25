import { normalizePath } from "@/lib/path-utils"
import {
  normalizeProjectWikiMarkdownPath,
  normalizeWikiMarkdownPath,
  wikiPathToLegacyStemId,
  wikiPathToVectorPageId,
} from "@/lib/wiki-page-identity"

export interface GraphPageIdentity {
  id: string
  wikiPath: string
  legacyStem: string
}

export interface GraphLinkIdentity {
  id: string
  wikiPath: string
  legacyStem: string
}

export interface GraphWikilinkResolver {
  resolve(raw: string): string | null
}

/** Convert a search-result path into the graph node id, preferring canonical path-aware identity. */
export function searchResultPathToGraphNodeId(projectPath: string, path: string): string {
  try {
    return wikiPathToVectorPageId(projectPath, path)
  } catch {
    return wikiPathToLegacyStemId(path)
  }
}

/** Build the canonical graph identity for a wiki markdown file path. */
export function graphPageIdentityForPath(projectPath: string, path: string): GraphPageIdentity {
  const wikiPath = normalizeProjectWikiMarkdownPath(projectPath, path)
  return {
    id: wikiPathToVectorPageId(projectPath, path),
    wikiPath,
    legacyStem: wikiPathToLegacyStemId(wikiPath),
  }
}

/** Create a resolver that prefers path-aware wikilinks and only falls back to unique legacy stems. */
export function createGraphWikilinkResolver(nodes: readonly GraphLinkIdentity[]): GraphWikilinkResolver {
  const ids = new Set(nodes.map((node) => node.id))
  const byPath = new Map<string, string[]>()
  const byPathSlug = new Map<string, string[]>()
  const byLegacyStem = new Map<string, string[]>()
  const byLegacySlug = new Map<string, string[]>()

  for (const node of nodes) {
    add(byPath, node.wikiPath.toLowerCase(), node.id)
    add(byPathSlug, graphRefKey(node.wikiPath), node.id)
    add(byLegacyStem, node.legacyStem.toLowerCase(), node.id)
    add(byLegacySlug, graphRefKey(node.legacyStem), node.id)
  }

  return {
    resolve(raw: string): string | null {
      if (ids.has(raw)) return raw

      const wikiPath = wikilinkToWikiPath(raw)
      if (wikiPath) {
        const exact = unique(byPath, wikiPath.toLowerCase())
        if (exact) return exact
        const slug = unique(byPathSlug, graphRefKey(wikiPath))
        if (slug) return slug
      }

      if (raw.includes("/") || raw.includes("\\")) return null

      const stem = raw.trim().replace(/\.md$/i, "")
      return unique(byLegacyStem, stem.toLowerCase()) ?? unique(byLegacySlug, graphRefKey(stem))
    },
  }
}

function add(map: Map<string, string[]>, key: string, id: string): void {
  const existing = map.get(key) ?? []
  existing.push(id)
  map.set(key, existing)
}

function unique(map: ReadonlyMap<string, readonly string[]>, key: string): string | null {
  const matches = map.get(key)
  return matches?.length === 1 ? matches[0] : null
}

function graphRefKey(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join("-")
}

function wikilinkToWikiPath(raw: string): string | null {
  let target = normalizePath(raw.trim())
  if (!target || target.startsWith("/") || /^[A-Za-z]:\//.test(target)) return null
  if (!target.startsWith("wiki/")) target = `wiki/${target}`
  if (!target.endsWith(".md")) target = `${target}.md`

  try {
    return normalizeWikiMarkdownPath(target)
  } catch {
    return null
  }
}
