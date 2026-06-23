import { normalizePath } from "@/lib/path-utils"

const VECTOR_PAGE_ID_PREFIX = "wp_"
const ROOT_STRUCTURAL_WIKI_MARKDOWN_PATHS = new Set([
  "wiki/index.md",
  "wiki/log.md",
  "wiki/overview.md",
  "wiki/purpose.md",
  "wiki/schema.md",
])

/**
 * Normalize a wiki-relative markdown path to `wiki/.../*.md`.
 *
 * The returned value always uses `/` separators and keeps the original
 * filename bytes intact for deterministic vector page identity.
 */
export function normalizeWikiMarkdownPath(path: string): string {
  const wikiPath = normalizePath(path.trim()).replace(/^\.\//, "")

  if (wikiPath.startsWith("/") || /^[A-Za-z]:\//.test(wikiPath) || !wikiPath.startsWith("wiki/")) {
    throw new Error(`Wiki page path must be project-relative and start with wiki/: ${path}`)
  }
  if (!wikiPath.endsWith(".md")) {
    throw new Error(`Wiki page path must end with .md: ${path}`)
  }
  if (
    wikiPath === "wiki/.md" ||
    wikiPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid wiki page path: ${path}`)
  }
  return wikiPath
}

/**
 * Normalize an absolute project file path or wiki-relative path to
 * `wiki/.../*.md` using the active project root as the only authority.
 */
export function normalizeProjectWikiMarkdownPath(projectPath: string, path: string): string {
  const projectRoot = normalizePath(projectPath.trim()).replace(/\/+$/, "")
  const normalized = normalizePath(path.trim())

  if (!projectRoot) {
    throw new Error("Project path is required for wiki page identity")
  }
  if (!normalized) {
    throw new Error("Wiki page path is required")
  }
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    return normalizeWikiMarkdownPath(normalized)
  }

  const rel = normalized === projectRoot
    ? ""
    : normalized.startsWith(`${projectRoot}/`)
      ? normalized.slice(projectRoot.length + 1)
      : null

  if (rel === null) {
    throw new Error(`Wiki page path must be inside the active project: ${path}`)
  }
  return normalizeWikiMarkdownPath(rel)
}

/**
 * Stable vector page id for a wiki markdown path.
 *
 * Format: `wp_` + base64url(UTF-8 bytes of `wiki/...` without `.md`),
 * with no padding. This prevents same-stem pages in different folders
 * from sharing vector rows while keeping the id deterministic.
 */
function vectorPageIdFromWikiPath(wikiPath: string): string {
  const withoutExtension = wikiPath.replace(/\.md$/, "")
  const bytes = new TextEncoder().encode(withoutExtension)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${VECTOR_PAGE_ID_PREFIX}${btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`
}

export function wikiRelativePathToVectorPageId(path: string): string {
  return vectorPageIdFromWikiPath(normalizeWikiMarkdownPath(path))
}

export function wikiPathToVectorPageId(projectPath: string, path: string): string {
  return vectorPageIdFromWikiPath(normalizeProjectWikiMarkdownPath(projectPath, path))
}

export function isRootStructuralWikiPagePath(projectPath: string, path: string): boolean {
  return ROOT_STRUCTURAL_WIKI_MARKDOWN_PATHS.has(normalizeProjectWikiMarkdownPath(projectPath, path))
}

/**
 * Legacy vector id used before path-aware page identity: basename
 * without the final `.md` extension.
 */
export function wikiPathToLegacyStemId(path: string): string {
  const wikiPath = normalizePath(path.trim())
  const fileName = wikiPath.split("/").pop() ?? ""
  return fileName.replace(/\.md$/, "")
}
