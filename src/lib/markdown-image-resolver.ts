/**
 * Resolve markdown image `src` attributes so they actually load in
 * the Tauri webview.
 *
 * The problem: ingest writes images to `<project>/wiki/media/<slug>/`
 * and embeds them in generated wiki pages as
 * `![](media/<slug>/img-1.png)`. A markdown renderer interprets that
 * relative to the rendering page's URL — but in Tauri there IS no
 * URL context for arbitrary file paths, AND the wiki page may be
 * located deeper than `wiki/concepts/foo.md` so naive `../media/...`
 * fixups don't generalize.
 *
 * Convention we settle on:
 *
 *   - Any src starting with `http://`, `https://`, `data:`, `blob:`,
 *     `file:`, `tauri://` is passed through unchanged.
 *   - Any src starting with `/` (absolute) is wrapped with
 *     `convertFileSrc` only when it remains inside the project.
 *   - A relative src is resolved against the rendering markdown
 *     file's own directory when that directory is known
 *     (`currentFileDir`).
 *   - Without a file context, relative srcs fall back to the project's
 *     `wiki/` root. Generated content uses this form
 *     (`media/foo/img-1.png`).
 *
 * The resolver returns a string that React's <img src=...> can load:
 * the appropriate `convertFileSrc(...)` URL or the original src
 * verbatim.
 */
import { convertFileSrc } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"

const PASSTHROUGH_RE = /^(https?:|data:|blob:|file:|tauri:)/i

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "")
}

function comparePath(path: string): string {
  return /^[a-zA-Z]:/.test(path) ? path.toLowerCase() : path
}

function isInsideProject(path: string, projectPath: string): boolean {
  const root = comparePath(trimTrailingSlash(normalizePath(projectPath)))
  const candidate = comparePath(trimTrailingSlash(normalizePath(path)))
  return candidate === root || candidate.startsWith(`${root}/`)
}

function decodePathSrc(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

function collapsePath(p: string): string {
  const isAbsolute = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!isAbsolute) out.push("..")
    } else {
      out.push(seg)
    }
  }
  return (isAbsolute ? "/" : "") + out.join("/")
}

/**
 * `projectPath` is the wiki project's root directory. When null
 * (no project loaded), the resolver passes srcs through unchanged
 * so it remains safe to call before a project is open.
 */
export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
  currentFileDir?: string | null,
): string {
  if (!rawSrc) return rawSrc
  if (PASSTHROUGH_RE.test(rawSrc)) return rawSrc

  if (!projectPath) return rawSrc

  const pp = normalizePath(projectPath)
  const isAbsolute =
    rawSrc.startsWith("/") || /^[a-zA-Z]:/.test(rawSrc) || rawSrc.startsWith("\\\\")

  if (isAbsolute) {
    const absolute = collapsePath(normalizePath(decodePathSrc(rawSrc)))
    return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
  }

  // Strip a leading `./` for cleanliness; treat `media/foo.png` and
  // `./media/foo.png` identically.
  const stripped = rawSrc.replace(/^\.\//, "")
  const cleaned = decodePathSrc(stripped)

  const isGeneratedMediaRef =
    cleaned.startsWith("media/") || cleaned.startsWith("../media/")
  const wikiRootMediaPath = cleaned.startsWith("../media/")
    ? cleaned.slice("../".length)
    : cleaned

  if (currentFileDir && !isGeneratedMediaRef) {
    const dir = normalizePath(currentFileDir)
    const dirIsAbsolute =
      dir.startsWith("/") || /^[a-zA-Z]:/.test(dir) || dir.startsWith("\\\\")
    const baseDir = dirIsAbsolute ? dir : `${pp}/${dir}`
    const absolute = collapsePath(`${baseDir.replace(/\/+$/, "")}/${cleaned}`)
    return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
  }

  const absolute = collapsePath(`${pp}/wiki/${wikiRootMediaPath}`)
  return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
}
