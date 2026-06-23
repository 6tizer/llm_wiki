import { normalizePath } from "@/lib/path-utils"

const VECTOR_PAGE_ID_PREFIX = "wp_"

/**
 * Normalize an absolute or wiki-relative markdown path to `wiki/.../*.md`.
 *
 * The returned value always uses `/` separators and keeps the original
 * filename bytes intact for deterministic vector page identity.
 */
export function normalizeWikiMarkdownPath(path: string): string {
  const normalized = normalizePath(path.trim()).replace(/^\/+/, "")
  const parts = normalized.split("/")
  const wikiIndex = parts.lastIndexOf("wiki")
  const wikiPath = wikiIndex >= 0
    ? parts.slice(wikiIndex).join("/")
    : normalized.startsWith("wiki/")
      ? normalized
      : `wiki/${normalized}`

  if (!wikiPath.endsWith(".md")) {
    throw new Error(`Wiki page path must end with .md: ${path}`)
  }
  if (wikiPath === "wiki/.md" || wikiPath.includes("/../") || wikiPath.includes("/./")) {
    throw new Error(`Invalid wiki page path: ${path}`)
  }
  return wikiPath
}

/**
 * Stable vector page id for a wiki markdown path.
 *
 * Format: `wp_` + base64url(UTF-8 bytes of `wiki/...` without `.md`),
 * with no padding. This prevents same-stem pages in different folders
 * from sharing vector rows while keeping the id deterministic.
 */
export function wikiPathToVectorPageId(path: string): string {
  const withoutExtension = normalizeWikiMarkdownPath(path).replace(/\.md$/, "")
  const bytes = new TextEncoder().encode(withoutExtension)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${VECTOR_PAGE_ID_PREFIX}${btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`
}

/**
 * Legacy vector id used before path-aware page identity: basename
 * without the final `.md` extension.
 */
export function wikiPathToLegacyStemId(path: string): string {
  const wikiPath = normalizeWikiMarkdownPath(path)
  const fileName = wikiPath.split("/").pop() ?? ""
  return fileName.replace(/\.md$/, "")
}
