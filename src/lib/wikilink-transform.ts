/**
 * Convert Obsidian-style `[[target]]` and `[[target|alias]]` wiki
 * links inside a markdown body to standard markdown links so a
 * commonmark renderer (Milkdown / ReactMarkdown) styles them as
 * links instead of dumping the bracket syntax as raw text.
 *
 * Output format: `[label](#target)` — using a fragment href so
 * Tauri's webview doesn't try to navigate externally on click.
 * In-app navigation can be wired up later via a click intercept
 * on `<a href="#…">` elements; for now the goal is just to stop
 * the wikilinks from looking like "raw code".
 *
 * Skips content inside fenced code blocks (```…```) and inline
 * code spans (`…`) so wikilinks shown as code examples in
 * documentation don't get mangled.
 */
export function transformWikilinks(body: string): string {
  if (!body.includes("[[")) return body

  return splitMarkdownCodeAware(body)
    .map((part) => (part.kind === "code" ? part.text : replaceWikilinks(part.text)))
    .join("")
}

/** Shared parser for well-formed Obsidian-style `[[target]]` and `[[target|alias]]` links. */
export const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g

export interface MarkdownCodeAwareSegment {
  kind: "text" | "code"
  text: string
  start: number
  end: number
}

/**
 * Split markdown with the same code-skipping semantics used by `transformWikilinks`.
 */
export function splitMarkdownCodeAware(body: string): MarkdownCodeAwareSegment[] {
  const segments: MarkdownCodeAwareSegment[] = []
  const fenceRe = /```[\s\S]*?```/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = fenceRe.exec(body)) !== null) {
    pushInlineCodeAwareSegments(body.slice(cursor, match.index), cursor, segments)
    pushSegment("code", match[0], match.index, segments)
    cursor = match.index + match[0].length
  }

  pushInlineCodeAwareSegments(body.slice(cursor), cursor, segments)
  return segments
}

function pushInlineCodeAwareSegments(
  text: string,
  start: number,
  segments: MarkdownCodeAwareSegment[],
): void {
  const inlineRe = /`[^`\n]+`/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = inlineRe.exec(text)) !== null) {
    pushSegment("text", text.slice(cursor, match.index), start + cursor, segments)
    pushSegment("code", match[0], start + match.index, segments)
    cursor = match.index + match[0].length
  }

  pushSegment("text", text.slice(cursor), start + cursor, segments)
}

function pushSegment(
  kind: MarkdownCodeAwareSegment["kind"],
  text: string,
  start: number,
  segments: MarkdownCodeAwareSegment[],
): void {
  if (!text) return
  segments.push({ kind, text, start, end: start + text.length })
}

function replaceWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, (_match, rawTarget: string, rawAlias?: string) => {
    const target = rawTarget.trim()
    const alias = rawAlias?.trim() ?? ""
    const label = alias.length > 0 ? alias : target
    // Encode the target so spaces / parens / hashes don't break the
    // markdown link parser. encodeURIComponent is overkill for a
    // fragment but it's the safe default.
    const href = `#${encodeURIComponent(target)}`
    // Escape any closing brackets in the label that would otherwise
    // terminate the markdown link text.
    const escapedLabel = label.replace(/\[/g, "\\[").replace(/\]/g, "\\]")
    return `[${escapedLabel}](${href})`
  })
}
