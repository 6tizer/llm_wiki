import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import {
  Bot, User, FileText, BookmarkPlus, ChevronDown, ChevronRight, RefreshCw, Copy, Check,
  Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, Layout, Globe,
  TrendingUp, Target, Image as ImageIcon, FileSearch, RotateCcw, AlertTriangle,
} from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, readFile } from "@/commands/fs"
import { lastQueryPages } from "@/components/chat/chat-panel"
import type { AgentWikiChangeRecord, DisplayMessage, MessageReference } from "@/stores/chat-store"
import type { AgentErrorKind } from "@/lib/agent/agent-run-state"
import type { FileNode } from "@/types/wiki"

import { convertLatexToUnicode } from "@/lib/latex-to-unicode"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { saveQueryPage } from "@/lib/save-query-page"
import { messageImageToDataUrl } from "@/lib/chat-image-utils"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { findRawSourceForImage, imageUrlToAbsolute } from "@/lib/raw-source-resolver"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { createMarkdownComponents } from "@/components/markdown/markdown-components"
import { inferWikiTypeFromPath } from "@/lib/wiki-page-types"
import { AgentBlockList } from "./agent-block-list"
import { AgentCostCard, hasAgentCostData } from "./agent-cost-card"
import { extractAgentTextContent } from "./agent-format"
import { AgentToolTimeline } from "./agent-tool-timeline"
import { isAgentAssistantMessage, isCompactOnlyAgentMessage } from "@/lib/agent/agent-summary"
import type { ChatAgentEvent, ChatAgentStep } from "@/lib/chat-agent"

// Module-level cache of source file names
let cachedSourceFiles: string[] = []

export function useSourceFiles() {
  const project = useWikiStore((s) => s.project)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => {
        cachedSourceFiles = flattenNames(tree)
      })
      .catch(() => {
        cachedSourceFiles = []
      })
  }, [project])

  return cachedSourceFiles
}

function flattenNames(nodes: FileNode[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      names.push(...flattenNames(node.children))
    } else if (!node.is_dir) {
      names.push(node.name)
    }
  }
  return names
}

interface ChatMessageProps {
  message: DisplayMessage
  isLastAssistant?: boolean
  onRegenerate?: () => void
  canRewind?: boolean
  onRewind?: (messageId: string) => void
}

function ChatMessageImpl({
  message,
  isLastAssistant,
  onRegenerate,
  canRewind = false,
  onRewind,
}: ChatMessageProps) {
  const { t } = useTranslation()
  const isUser = message.role === "user"
  const isSystem = message.role === "system"
  const isAssistant = message.role === "assistant"
  const isAgent = isAgentAssistantMessage(message)
  const isAgentError = isAgent && Boolean(message.agentErrorKind)
  const hasAgentBlocks = isAgent && (message.agentBlocks?.length ?? 0) > 0
  const content = message.content ?? ""
  const isSessionCompactOnly = isAgent && isCompactOnlyAgentMessage(message)
  const [hovered, setHovered] = useState(false)
  const agentTextContent = useMemo(
    () => isAgent ? extractAgentTextContent(message.agentBlocks) : "",
    [isAgent, message.agentBlocks],
  )
  const actionContent = content || agentTextContent
  const shouldRenderReferences = useMemo(() => {
    if (!isAssistant) return false
    if ((message.references?.length ?? 0) > 0) return true
    return extractCitedPages(actionContent).length > 0
  }, [actionContent, isAssistant, message.references])

  return (
    <div
      className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isSystem
            ? "bg-accent text-accent-foreground"
            : isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className="flex min-w-0 max-w-[80%] flex-col gap-1.5">
        {isUser && (message.images?.length ?? 0) > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.images?.map((image, index) => (
              <img
                key={`${image.mediaType}-${index}`}
                src={messageImageToDataUrl(image)}
                alt=""
                className="max-h-40 max-w-[180px] rounded-lg border border-border/40 object-contain"
                loading="lazy"
              />
            ))}
          </div>
        )}
        {isAgentError && message.agentErrorKind ? (
          <AgentErrorNotice
            kind={message.agentErrorKind}
            detail={message.agentErrorDetail}
          />
        ) : (!isUser || content) && (
          <div
            className={`min-w-0 rounded-lg max-w-full overflow-hidden px-3 py-2 text-sm ${isUser ? "self-end" : "self-start"} ${
              isUser
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground"
            }`}
          >
            {isUser ? (
              <p dir="auto" className="whitespace-pre-wrap wrap-anywhere">{content}</p>
            ) : isSessionCompactOnly ? (
              <AgentSessionCompactNotice />
            ) : hasAgentBlocks ? (
              <AgentBlockList
                blocks={message.agentBlocks ?? []}
                renderText={(text) => <MarkdownContent content={text} />}
              />
            ) : (
              <MarkdownContent content={content} />
            )}
          </div>
        )}
        {shouldRenderReferences && (
          <CitedReferencesPanel content={actionContent} savedReferences={message.references} />
        )}
        {!isAgent && message.agentSteps && message.agentSteps.length > 0 && (
          <ChatAgentSteps steps={message.agentSteps} />
        )}
        {!isSessionCompactOnly && (isAgent || (message.progressSummaries?.length ?? 0) > 0) && (
          <AgentToolTimeline
            toolCalls={message.toolCalls ?? []}
            progressSummaries={message.progressSummaries}
            permissionEvents={message.permissionEvents}
            rewindUnavailableReason={message.agentRewindUnavailableReason}
          />
        )}
        {isAgent && message.agentResourceLimit && (
          <AgentResourceLimitNotice limit={message.agentResourceLimit} />
        )}
        {!isSessionCompactOnly && isAgent && message.wikiChanges && message.wikiChanges.length > 0 && (
          <AgentWikiChangeList changes={message.wikiChanges} />
        )}
        {!isSessionCompactOnly && isAgent && hasAgentCostData(message) && (
          <AgentCostCard
            costUsd={message.costUsd}
            inputTokens={message.inputTokens}
            outputTokens={message.outputTokens}
            durationMs={message.durationMs}
            numTurns={message.numTurns}
          />
        )}
        {isAgentError && isLastAssistant && onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            title={t("agent.actions.retry")}
          >
            <RefreshCw className="h-3 w-3" /> {t("agent.actions.retry")}
          </button>
        )}
        {!isSessionCompactOnly && isAgent && canRewind && onRewind && (
          <button
            type="button"
            onClick={() => onRewind(message.id)}
            className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            title={t("agent.rewind.action")}
          >
            <RotateCcw className="h-3 w-3" /> {t("agent.rewind.action")}
          </button>
        )}
        {isAssistant && hovered && !isSessionCompactOnly && (
          <div className="flex items-center gap-1">
            {/* Error messages carry empty content (the notice owns rendering),
                so copy/save would silently act on an empty string. */}
            {!isAgentError && <CopyButton content={actionContent} />}
            {!isAgentError && <SaveToWikiButton content={actionContent} visible={true} />}
            {isLastAssistant && onRegenerate && !isAgentError && (
              <button
                type="button"
                onClick={onRegenerate}
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                title="Regenerate this response"
              >
                <RefreshCw className="h-3 w-3" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageImpl, (prev, next) =>
  prev.message === next.message
  && prev.isLastAssistant === next.isLastAssistant
  && prev.onRegenerate === next.onRegenerate
  && prev.canRewind === next.canRewind
  && prev.onRewind === next.onRewind
)

function formatBytes(bytes?: number): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 1024)} KiB`
}

function displayNumber(value?: number): number | string {
  return value !== undefined && Number.isFinite(value) ? value : "?"
}

function AgentResourceLimitNotice({
  limit,
}: {
  limit: NonNullable<DisplayMessage["agentResourceLimit"]>
}) {
  const { t } = useTranslation()
  const shownPaths = (limit.changedPaths ?? []).slice(0, 3)
  const extraPathCount = Math.max(0, (limit.changedPaths?.length ?? 0) - shownPaths.length)
  const bytes = formatBytes(limit.bytes)
  const title = t(`agent.resourceLimit.${limit.limitKind}.title`)
  const description = t(`agent.resourceLimit.${limit.limitKind}.description`, {
    limit: displayNumber(limit.limit),
    used: displayNumber(limit.used),
    attempted: displayNumber(limit.attempted),
    bytes: bytes ?? "?",
    path: limit.path,
  })
  const recovery = limit.limitKind === "max_write_bytes"
    ? t("agent.resourceLimit.recovery.maxWriteBytes")
    : limit.recovery === "split_task"
      ? t("agent.resourceLimit.recovery.splitTask")
      : t("agent.resourceLimit.recovery.settingsAgent")

  return (
    <div
      role="alert"
      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{title}</div>
          <div>{description}</div>
          {(limit.path || shownPaths.length > 0) && (
            <div className="break-words text-amber-900/80 dark:text-amber-100/80">
              {limit.path
                ? t("agent.resourceLimit.path", { path: limit.path })
                : t(
                    extraPathCount > 0
                      ? "agent.resourceLimit.changedPathsMore"
                      : "agent.resourceLimit.changedPaths",
                    {
                      paths: shownPaths.join(", "),
                      extra: extraPathCount,
                    },
                  )}
            </div>
          )}
          <div className="text-amber-900/80 dark:text-amber-100/80">{recovery}</div>
        </div>
      </div>
    </div>
  )
}

function AgentErrorNotice({
  kind,
  detail,
}: {
  kind: AgentErrorKind
  detail?: string
}) {
  const { t } = useTranslation()
  const title = t(`agent.errorNotice.${kind}.title`)
  const description = t(`agent.errorNotice.${kind}.description`)
  const action = t(`agent.errorNotice.${kind}.action`)

  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{title}</div>
          <div>{description}</div>
          <div className="text-destructive/80">{action}</div>
          {detail ? (
            <details className="pt-1 text-destructive/80">
              <summary className="cursor-pointer font-medium">
                {t("agent.errorNotice.details")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px]">
                {detail}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AgentSessionCompactNotice() {
  const { t } = useTranslation()

  return (
    <details className="min-w-0 rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
        {t("agent.session.contextSummarized")}
      </summary>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t("agent.session.contextSummarizedDetail")}
      </p>
    </details>
  )
}

function AgentWikiChangeList({ changes }: { changes: AgentWikiChangeRecord[] }) {
  const { t } = useTranslation()
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setPendingWikiHealthTab = useWikiStore((s) => s.setPendingWikiHealthTab)
  const handleReview = useCallback((change: AgentWikiChangeRecord) => {
    setPendingWikiHealthTab("review")
    setActiveView("wiki-health")
    const scheduleFrame = window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => window.setTimeout(cb, 0))
    scheduleFrame(() => scheduleFrame(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("[data-agent-write-path]")
      )
      const samePath = candidates.filter((candidate) =>
        candidate.dataset.agentWritePath === change.path
      )
      const target = change.toolUseId
        ? samePath.find((candidate) =>
            candidate.dataset.agentWriteToolUseId === change.toolUseId
          )
        // Some legacy/app-tool changes may not carry a toolUseId; same path
        // can appear multiple times, so jump to the newest matching review.
        : samePath.sort((a, b) =>
            Number(b.dataset.agentWriteTimestamp ?? 0) -
            Number(a.dataset.agentWriteTimestamp ?? 0)
          )[0]
      target?.scrollIntoView({ block: "center" })
    }))
  }, [setActiveView, setPendingWikiHealthTab])

  return (
    <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-xs">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground">
        <BookOpen className="h-3 w-3" />
        {t("agent.wikiChanged.title")}
      </div>
      <div className="space-y-1">
        {changes.map((change, index) => {
          const key =
            change.operation === "create"
              ? "agent.wikiChanged.created"
              : change.operation === "delete"
                ? "agent.wikiChanged.deleted"
                : "agent.wikiChanged.updated"
          return (
            <div
              key={`${change.path}-${change.timestamp}-${index}`}
              className="flex items-center justify-between gap-2 text-muted-foreground"
            >
              <span className="min-w-0 break-all">
                {t(key, { path: change.path })}
                {change.reverted ? "（已撤销）" : ""}
              </span>
              <button
                type="button"
                className="shrink-0 text-[11px] text-primary hover:underline"
                onClick={() => handleReview(change)}
              >
                审阅
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    // Strip HTML comments and thinking blocks before copying
    const clean = content
      .replace(/<!--.*?-->/gs, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
      .trim()

    await navigator.clipboard.writeText(clean)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [content])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied!" : "Copy"}
    </button>
  )
}

function SaveToWikiButton({ content, visible }: { content: string; visible: boolean }) {
  const project = useWikiStore((s) => s.project)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!project || saving) return
    setSaving(true)
    try {
      const llmConfig = useWikiStore.getState().llmConfig
      const result = await saveQueryPage({
        projectPath: project.path,
        content,
        autoIngest: true,
        llmConfig,
      })
      setFileTree(result.fileTree)
      useWikiStore.getState().bumpDataVersion()

      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error("Failed to save to wiki:", err)
    } finally {
      setSaving(false)
    }
  }, [project, content, saving, setFileTree])

  if (!visible && !saved) return null

  return (
    <button
      type="button"
      onClick={handleSave}
      disabled={saving}
      className="self-start inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
      title="Save to wiki"
    >
      <BookmarkPlus className="h-3 w-3" />
      {saved ? "Saved!" : saving ? "Saving..." : "Save to Wiki"}
    </button>
  )
}

type CitedPage = MessageReference

const REF_TYPE_CONFIG: Record<string, { icon: typeof FileText; color: string }> = {
  entity: { icon: Users, color: "text-blue-500" },
  concept: { icon: Lightbulb, color: "text-purple-500" },
  source: { icon: BookOpen, color: "text-orange-500" },
  query: { icon: HelpCircle, color: "text-green-500" },
  synthesis: { icon: GitMerge, color: "text-red-500" },
  comparison: { icon: BarChart3, color: "text-teal-500" },
  finding: { icon: TrendingUp, color: "text-purple-500" },
  thesis: { icon: Target, color: "text-rose-500" },
  methodology: { icon: BookOpen, color: "text-teal-500" },
  overview: { icon: Layout, color: "text-yellow-500" },
  clip: { icon: Globe, color: "text-blue-400" },
  external: { icon: Globe, color: "text-sky-500" },
  anytxt: { icon: FileSearch, color: "text-emerald-500" },
}

function getRefType(path: string, page?: CitedPage): string {
  if (page?.kind === "external") {
    return page.source?.toLowerCase() === "anytxt" ? "anytxt" : "external"
  }
  if (path.includes("raw/sources/")) return "clip"
  return inferWikiTypeFromPath(path) ?? "source"
}

function displayExternalPath(page: CitedPage): string {
  const raw = page.url || page.path
  if (!raw) return page.path
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw)
      const decoded = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1)
      if (url.hostname) return `//${url.hostname}${decoded}`
      return decoded
    } catch {
      return raw.replace(/^file:\/\//, "")
    }
  }
  return raw
}

function citedPageKey(page: CitedPage, index: number): string {
  return [
    page.kind ?? "wiki",
    page.source ?? "",
    page.path,
    page.url ?? "",
    page.title,
    index,
  ].join(":")
}

/**
 * Markdown image-reference regex used to count `![](url)` occurrences
 * in cited pages AND extract the first URL (so the image-badge
 * jump button knows where to send the user). Same shape as the
 * search/pipeline regex elsewhere (kept duplicated to avoid
 * coupling — this module never wants to pull caption-pipeline
 * imports for a 3-character count).
 *
 * Group 1 captures the URL (everything inside `(...)` of the
 * markdown image syntax, no whitespace).
 */
const CITED_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

interface CitedImageInfo {
  count: number
  /** First image URL on the page — used as the scroll target when
   *  the badge button opens the raw source. Null when count===0. */
  firstUrl: string | null
}

function CitedReferencesPanel({ content, savedReferences }: { content: string; savedReferences?: CitedPage[] }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setExternalPreview = useWikiStore((s) => s.setExternalPreview)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const [expanded, setExpanded] = useState(false)
  /**
   * Per-cited-page image info: count + first image URL. We can't
   * hang this off `CitedPage` directly because `extractCitedPages`
   * is sync and works on the AI's text response, never seeing the
   * underlying page. So we fetch the page contents lazily here.
   * Same path → same info, so a tiny in-component map keyed by
   * path is plenty.
   */
  const [imageInfos, setImageInfos] = useState<Record<string, CitedImageInfo>>({})

  // Use saved references first (persisted with message), fall back to dynamic extraction
  const citedPages = useMemo(() => {
    if (savedReferences && savedReferences.length > 0) return savedReferences
    return extractCitedPages(content)
  }, [content, savedReferences])

  // Async-fetch each cited page's content once and extract image
  // info: count + first URL. Done in parallel; failures are
  // silently treated as { count: 0, firstUrl: null } (page may
  // not exist on disk yet, e.g. a citation the LLM hallucinated).
  useEffect(() => {
    if (!project || citedPages.length === 0) return
    const pp = normalizePath(project.path)
    let cancelled = false
    Promise.all(
      citedPages.map(async (page) => {
        // Try the path verbatim first, then the same fallback set
        // the click-handler uses below — keeps "is the file on
        // disk" check consistent across the panel.
        if (page.kind === "external") {
          return [page.path, { count: 0, firstUrl: null }] as const
        }
        const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
        const candidates = [
          `${pp}/${page.path}`,
          `${pp}/wiki/entities/${id}.md`,
          `${pp}/wiki/concepts/${id}.md`,
          `${pp}/wiki/sources/${id}.md`,
          `${pp}/wiki/queries/${id}.md`,
          `${pp}/wiki/synthesis/${id}.md`,
          `${pp}/wiki/comparisons/${id}.md`,
          `${pp}/wiki/${id}.md`,
        ]
        for (const candidate of candidates) {
          try {
            const text = await readFile(candidate)
            // Reset stateful regex.lastIndex by `new RegExp(...)` —
            // module-level `g` regexes carry state across calls
            // and would skip matches on the second invocation.
            const re = new RegExp(CITED_IMAGE_RE.source, CITED_IMAGE_RE.flags)
            const matches = [...text.matchAll(re)]
            const info: CitedImageInfo = {
              count: matches.length,
              firstUrl: matches.length > 0 ? matches[0][1] : null,
            }
            return [page.path, info] as const
          } catch {
            // try next candidate
          }
        }
        return [page.path, { count: 0, firstUrl: null }] as const
      }),
    ).then((entries) => {
      if (cancelled) return
      const next: Record<string, CitedImageInfo> = {}
      for (const [path, info] of entries) next[path] = info
      setImageInfos(next)
    })
    return () => {
      cancelled = true
    }
  }, [project, citedPages])

  /**
   * Open the raw source file for a page's first image and stage a
   * scroll target so the markdown preview lands on that image.
   * Mirrors the lightbox "Jump to source document" path in
   * search-view — same `findRawSourceForImage` resolver, same
   * `pendingScrollImageSrc` store handoff, same fallback to
   * opening the wiki page when no raw source is found.
   */
  const handleJumpToImageSource = useCallback(
    async (firstUrl: string, fallbackPath: string) => {
      if (!project) return
      const pp = normalizePath(project.path)
      const rawPath = await findRawSourceForImage(firstUrl, pp)
      if (rawPath) {
        try {
          const content = await readFile(rawPath)
          setPendingScrollImageSrc(imageUrlToAbsolute(firstUrl, pp))
          setSelectedFile(rawPath)
          setFileContent(content)
          console.log(`[refs:image-jump] ${firstUrl} → raw source ${rawPath}`)
          return
        } catch (err) {
          console.warn(`[refs:image-jump] failed to read ${rawPath}:`, err)
        }
      }
      // Fallback: open the wiki summary itself with same scroll
      // target — at least the safety-net section will scroll into
      // view there.
      try {
        const content = await readFile(`${pp}/${fallbackPath}`)
        setPendingScrollImageSrc(firstUrl)
        setSelectedFile(`${pp}/${fallbackPath}`)
        setFileContent(content)
      } catch (err) {
        console.warn(`[refs:image-jump] fallback also failed:`, err)
      }
    },
    [project, setPendingScrollImageSrc, setSelectedFile, setFileContent],
  )

  if (citedPages.length === 0) return null

  const MAX_COLLAPSED = 3
  const visiblePages = expanded ? citedPages : citedPages.slice(0, MAX_COLLAPSED)
  const hasMore = citedPages.length > MAX_COLLAPSED

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-xs mb-1">
      <button
        type="button"
        onClick={() => hasMore && setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <FileText className="h-3 w-3 shrink-0" />
        <span className="font-medium">References ({citedPages.length})</span>
        {hasMore && (
          expanded
            ? <ChevronDown className="h-3 w-3 ml-auto" />
            : <ChevronRight className="h-3 w-3 ml-auto" />
        )}
      </button>
      <div className="px-2 pb-1.5">
        {visiblePages.map((page, i) => {
          const refType = getRefType(page.path, page)
          const config = REF_TYPE_CONFIG[refType] ?? REF_TYPE_CONFIG.source
          const Icon = config.icon
          const info = imageInfos[page.path]
          const hasImages = (info?.count ?? 0) > 0
          const openCitedPage = async () => {
            if (page.kind === "external") {
              const target = page.url || page.path
              if (page.source?.toLowerCase() === "anytxt") {
                const displayPath = displayExternalPath(page)
                const previewPath = `anytxt-preview://${encodeURIComponent(target || page.title)}`
                const previewContent = [
                  `# ${page.title}`,
                  "",
                  `**Source:** ${page.source ?? "AnyTXT"}`,
                  `**Path:** ${displayPath}`,
                  "",
                  "## Preview",
                  "",
                  page.snippet?.trim() || "(No fragment returned by AnyTXT.)",
                ].join("\n")
                setSelectedFile(previewPath)
                setFileContent(previewContent)
                setExternalPreview({
                  title: page.title,
                  path: previewPath,
                  source: page.source ?? "AnyTXT",
                  url: displayPath,
                  snippet: page.snippet ?? "",
                })
                return
              }
              if (target) {
                await openUrl(target).catch((err) => {
                  console.warn("[chat refs] failed to open external reference:", err)
                })
              }
              return
            }
            if (!project) return
            const pp = normalizePath(project.path)
            const id = getFileName(page.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
            const candidates = [
              `${pp}/${page.path}`,
              `${pp}/wiki/entities/${id}.md`,
              `${pp}/wiki/concepts/${id}.md`,
              `${pp}/wiki/sources/${id}.md`,
              `${pp}/wiki/queries/${id}.md`,
              `${pp}/wiki/synthesis/${id}.md`,
              `${pp}/wiki/comparisons/${id}.md`,
              `${pp}/wiki/${id}.md`,
            ]
            for (const candidate of candidates) {
              try {
                await readFile(candidate)
                setSelectedFile(candidate)
                return
              } catch {
                // try next
              }
            }
            setSelectedFile(`${pp}/${page.path}`)
          }
          return (
            // Outer is a div, NOT a button — we have two click
            // targets inside (image badge + main row) and nesting
            // a button inside a button is invalid HTML and breaks
            // event delegation. Hover effect shifts to the inner
            // buttons individually so each gives feedback.
            <div
              key={citedPageKey(page, i)}
              className="flex w-full items-center gap-1.5 rounded text-left"
              title={page.kind === "external" ? `${page.source ?? "External"}: ${page.url ?? page.path}` : page.path}
            >
              <span className="text-[10px] text-muted-foreground/60 w-4 shrink-0 text-right">[{i + 1}]</span>
              {/*
               * Image badge — clickable, separately from the page
               * row. Click → resolve the FIRST image's raw source
               * (`raw/sources/<slug>.<ext>`) and open the FULL
               * combined-extraction preview, scrolled to that
               * image. This mirrors the search-view lightbox
               * "Jump to source document" behavior so the two
               * surfaces feel consistent.
               *
               * Icon: lucide `Image` (picture-frame outline with
               * mountain + sun) — direct visual cue for "image",
               * NOT `Camera` which reads as "take a photo".
               */}
              {hasImages && info?.firstUrl && (
                <button
                  type="button"
                  onClick={() => handleJumpToImageSource(info.firstUrl!, page.path)}
                  className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100/40 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors"
                  title={`Open original document at first image (${info.count} image${info.count === 1 ? "" : "s"} on this page)`}
                >
                  <ImageIcon className="h-3 w-3" />
                  {info.count}
                </button>
              )}
              <button
                type="button"
                onClick={openCitedPage}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent/50 transition-colors"
              >
                <Icon className={`h-3 w-3 shrink-0 ${config.color}`} />
                <span className="min-w-0 flex-1 truncate text-foreground/80">
                  {page.title}
                  {page.kind === "external" && page.source?.toLowerCase() === "anytxt" && (
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/75">
                      {displayExternalPath(page)}
                    </span>
                  )}
                </span>
                {page.kind === "external" && page.source && (
                  <span className="shrink-0 rounded bg-background/80 px-1 py-0 text-[10px] text-muted-foreground">
                    {page.source}
                  </span>
                )}
              </button>
            </div>
          )
        })}
        {hasMore && !expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full text-center text-[10px] text-muted-foreground hover:text-primary pt-0.5"
          >
            +{citedPages.length - MAX_COLLAPSED} more...
          </button>
        )}
      </div>
    </div>
  )
}


/**
 * Extract cited wiki pages from the hidden <!-- cited: 1, 3, 5 --> comment.
 * Maps page numbers back to the pages that were sent to the LLM.
 */
function extractCitedPages(text: string): CitedPage[] {
  const citedMatch = text.match(/<!--\s*cited:\s*(.+?)\s*-->/)
  if (citedMatch && lastQueryPages.length > 0) {
    const numbers = citedMatch[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 1 && n <= lastQueryPages.length)

    const pages = numbers.map((n) => lastQueryPages[n - 1])
    if (pages.length > 0) return pages
  }

  // Fallback: if LLM used [1], [2] notation in text, try to match those
  if (lastQueryPages.length > 0) {
    const numberRefs = text.match(/\[(\d+)\]/g)
    if (numberRefs) {
      const numbers = [...new Set(numberRefs.map((r) => parseInt(r.slice(1, -1), 10)))]
        .filter((n) => n >= 1 && n <= lastQueryPages.length)
      if (numbers.length > 0) {
        return numbers.map((n) => lastQueryPages[n - 1])
      }
    }
  }

  // Fallback for persisted messages: extract [[wikilinks]] from the text
  // Try to resolve each wikilink to a real file path by checking common wiki subdirectories
  const wikilinks = text.match(/\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g)
  if (wikilinks) {
    const seen = new Set<string>()
    const pages: CitedPage[] = []
    const WIKI_DIRS = ["entities", "concepts", "sources", "queries", "synthesis", "comparisons"]

    for (const link of wikilinks) {
      const nameMatch = link.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/)
      if (nameMatch) {
        const id = nameMatch[1].trim()
        const display = nameMatch[2]?.trim() || id

        // Skip if id contains path separators (already a path like queries/xxx)
        if (seen.has(id)) continue
        seen.add(id)

        // Try to find the file in known wiki subdirectories
        let resolvedPath = ""
        if (id.includes("/")) {
          // Already has directory like "queries/my-query"
          resolvedPath = `wiki/${id}.md`
        } else {
          // Search in common directories
          for (const dir of WIKI_DIRS) {
            resolvedPath = `wiki/${dir}/${id}.md`
            // We can't do async file checking here, so try all known patterns
            // The click handler will try multiple paths
            break // Use first candidate, click handler resolves the rest
          }
          if (!resolvedPath) resolvedPath = `wiki/${id}.md`
        }

        pages.push({ title: display, path: resolvedPath })
      }
    }
    if (pages.length > 0) return pages
  }

  // No citations found
  return []
}

interface StreamingMessageProps {
  content: string
  agentEvents?: ChatAgentEvent[]
}

export function StreamingMessage({ content, agentEvents = [] }: StreamingMessageProps) {
  const { thinking, answer } = useMemo(() => separateThinking(content), [content])
  const isThinking = thinking !== null && answer.length === 0

  return (
    <div className="flex gap-2 flex-row">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-4 w-4" />
      </div>
      <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
        {isThinking ? (
          <StreamingThinkingBlock content={thinking} />
        ) : (
          <>
            {thinking && <ThinkingBlock content={thinking} />}
            {agentEvents.length > 0 && <ChatAgentEvents events={agentEvents} />}
            <MarkdownContent content={answer} />
            <span className="animate-pulse">▊</span>
          </>
        )}
      </div>
    </div>
  )
}

function ChatAgentSteps({ steps }: { steps: ChatAgentStep[] }) {
  const { t } = useTranslation()
  const visible = steps.filter((step) => step.type !== "understanding" || step.message)
  if (visible.length === 0) return null
  return (
    <div className="rounded-md border border-border/60 bg-background/70 px-2 py-1.5 text-xs">
      <div className="space-y-1">
        {visible.map((step) => (
          <div key={step.id} className="flex items-start gap-1.5 text-muted-foreground">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${chatAgentStatusClass(step.status)}`} />
            <span className="min-w-0 break-words">
              {chatAgentStepLabel(step, t)}
              {step.status ? <span className="opacity-70"> - {chatAgentStatusLabel(step.status, t)}</span> : null}
              {step.count !== undefined ? ` (${step.count})` : ""}
              {step.query ? <span className="opacity-70"> - {step.query}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ChatAgentEvents({ events }: { events: ChatAgentEvent[] }) {
  const { t } = useTranslation()
  const visible = events.filter((event) => event.message || event.stage)
  if (visible.length === 0) return null
  return (
    <div className="mb-2 rounded-md border border-border/60 bg-background/70 px-2 py-1.5 text-xs">
      <div className="space-y-1">
        {visible.map((event, index) => (
          <div key={`${event.stage}-${index}`} className="flex items-start gap-1.5 text-muted-foreground">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${chatAgentStatusClass(event.status)}`} />
            <span className="min-w-0 break-words">
              {chatAgentEventLabel(event, t)}
              {event.status ? <span className="opacity-70"> - {chatAgentStatusLabel(event.status, t)}</span> : null}
              {event.count !== undefined ? ` (${event.count})` : ""}
              {event.query ? <span className="opacity-70"> - {event.query}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function chatAgentStatusClass(status?: ChatAgentEvent["status"]): string {
  switch (status) {
    case "error":
      return "bg-destructive"
    case "success":
      return "bg-emerald-500"
    case "skipped":
      return "bg-muted-foreground/40"
    case "running":
    default:
      return "bg-primary animate-pulse"
  }
}

type ChatTranslation = ReturnType<typeof useTranslation>["t"]

function chatAgentStepLabel(step: ChatAgentStep, t: ChatTranslation): string {
  if (step.tool) return chatAgentToolLabel(step.tool, t)
  switch (step.type) {
    case "understanding":
      return chatAgentStageLabel("understanding", t)
    case "routing":
      return chatAgentStageLabel("routing", t)
    case "tool_call":
      return chatAgentStageLabel("tool_call", t)
    case "tool_result":
      return chatAgentStageLabel("tool_result", t)
    case "final":
      return t("chat.agentStages.final", "Final answer")
  }
}

function chatAgentEventLabel(event: ChatAgentEvent, t: ChatTranslation): string {
  if (event.tool) return chatAgentToolLabel(event.tool, t)
  return chatAgentStageLabel(event.stage, t)
}

function chatAgentStageLabel(stage: ChatAgentEvent["stage"], t: ChatTranslation): string {
  switch (stage) {
    case "understanding":
      return t("chat.agentStages.understanding", "Understanding")
    case "routing":
      return t("chat.agentStages.routing", "Routing")
    case "tool_call":
      return t("chat.agentStages.toolCall", "Tool call")
    case "tool_result":
      return t("chat.agentStages.toolResult", "Tool result")
    case "searching_wiki":
      return t("chat.agentStages.searchingWiki", "Searching wiki")
    case "searching_graph":
      return t("chat.agentStages.searchingGraph", "Searching graph")
    case "searching_web":
      return t("chat.agentStages.searchingWeb", "Searching web")
    case "searching_anytxt":
      return t("chat.agentStages.searchingAnytxt", "Searching AnyTXT")
    case "reading_context":
      return t("chat.agentStages.readingContext", "Reading context")
    case "writing":
      return t("chat.agentStages.writing", "Writing")
  }
}

function chatAgentToolLabel(tool: NonNullable<ChatAgentEvent["tool"]>, t: ChatTranslation): string {
  switch (tool) {
    case "project_files":
      return t("chat.agentTools.projectFiles", "Project files")
    case "project_file_read":
      return t("chat.agentTools.projectFileRead", "Project file read")
    case "wiki_search":
      return t("chat.agentTools.wikiSearch", "Wiki search")
    case "graph_search":
      return t("chat.agentTools.graphSearch", "Graph search")
    case "web_search":
      return t("chat.agentTools.webSearch", "Web search")
    case "anytxt_search":
      return t("chat.agentTools.anytxtSearch", "AnyTXT search")
  }
}

function chatAgentStatusLabel(status: NonNullable<ChatAgentEvent["status"]>, t: ChatTranslation): string {
  switch (status) {
    case "running":
      return t("chat.agentStatus.running", "Running")
    case "success":
      return t("chat.agentStatus.success", "Done")
    case "error":
      return t("chat.agentStatus.error", "Error")
    case "skipped":
      return t("chat.agentStatus.skipped", "Skipped")
  }
}

function MarkdownContent({ content }: { content: string }) {
  // Strip hidden comments
  const cleaned = content.replace(/<!--.*?-->/gs, "").trimEnd()

  // Project path for resolving wiki-relative image src in chat
  // replies (LLM may surface images that came in via retrieved
  // chunks, e.g. when the chat answer cites a diagram from a wiki
  // page). Same convention the file-preview uses.
  const projectPath = useWikiStore((s) => s.project?.path ?? null)

  // Separate thinking blocks from main content
  const { thinking, answer } = useMemo(() => separateThinking(cleaned), [cleaned])
  const processed = useMemo(() => processContent(answer), [answer])
  const renderLanguage = useMemo(() => detectLanguage(answer), [answer])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)

  return (
    <div>
      {thinking && <ThinkingBlock content={thinking} />}
      <div
        className="chat-markdown prose prose-sm min-w-0 max-w-none break-words dark:prose-invert prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none"
        dir={direction}
        lang={htmlLang}
        style={{ textAlign: "start" }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={createMarkdownComponents({
            preClassName: "max-w-full rounded bg-background/50 p-2 text-xs overflow-x-auto overscroll-x-contain",
            codeClassNameFallback: "break-words",
            overrides: {
            a: ({ href, children }) => {
              if (href?.startsWith("wikilink:")) {
                const pageName = href.slice("wikilink:".length)
                return <WikiLink pageName={pageName}>{children}</WikiLink>
              }
              return (
                <span className="text-primary underline cursor-default" title={href}>
                  {children}
                </span>
              )
            },
            img: ({ src, alt, ...props }) => (
              <img
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
                alt={alt ?? ""}
                className="my-2 max-w-full rounded border border-border/40"
                loading="lazy"
                {...props}
              />
            ),
            },
          })}
        >
          {processed}
        </ReactMarkdown>
      </div>
    </div>
  )
}

/**
 * Separate <think>...</think> blocks from the main answer.
 * Handles multiple think blocks and partial (unclosed) thinking during streaming.
 */
function separateThinking(text: string): { thinking: string | null; answer: string } {
  // Match complete <think>...</think> and <thinking>...</thinking> blocks
  const thinkRegex = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi
  const thinkParts: string[] = []
  let answer = text

  let match: RegExpExecArray | null
  while ((match = thinkRegex.exec(text)) !== null) {
    thinkParts.push(match[1].trim())
  }
  answer = answer.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim()

  // Handle unclosed <think> or <thinking> tag (streaming in progress)
  const unclosedMatch = answer.match(/<think(?:ing)?>([\s\S]*)$/i)
  if (unclosedMatch) {
    thinkParts.push(unclosedMatch[1].trim())
    answer = answer.replace(/<think(?:ing)?>[\s\S]*$/i, "").trim()
  }

  const thinking = thinkParts.length > 0 ? thinkParts.join("\n\n") : null
  return { thinking, answer }
}

/** Streaming thinking: shows latest ~5 lines rolling upward with animation */
function StreamingThinkingBlock({ content }: { content: string }) {
  const lines = content.split("\n").filter((l) => l.trim())
  const visibleLines = lines.slice(-5)

  return (
    <div className="rounded-md border border-dashed border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-sm animate-pulse">💭</span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Thinking...</span>
        <span className="text-[10px] text-amber-600/50 dark:text-amber-500/40">{lines.length} lines</span>
      </div>
      <div className="h-[5lh] overflow-hidden text-xs text-amber-800/70 dark:text-amber-300/60 font-mono leading-relaxed">
        {visibleLines.map((line, i) => (
          <div
            key={lines.length - 5 + i}
            className="truncate"
            style={{ opacity: 0.4 + (i / visibleLines.length) * 0.6 }}
          >
            {line}
          </div>
        ))}
        <span className="animate-pulse text-amber-500">▊</span>
      </div>
    </div>
  )
}

/** Completed thinking: collapsed by default, click to expand */
function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.split("\n").filter((l) => l.trim())

  return (
    <div className="mb-2 rounded-md border border-dashed border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-colors"
      >
        <span className="text-sm">💭</span>
        <span className="font-medium">Thought for {lines.length} lines</span>
        <span className="text-amber-600/60 dark:text-amber-500/60">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-amber-500/20 px-2.5 py-2 text-xs text-amber-800/80 dark:text-amber-300/70 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
          {content}
        </div>
      )}
    </div>
  )
}

/**
 * Process content to create clickable links:
 * - [[wikilinks]] → markdown links with wikilink: protocol
 */
function processContent(text: string): string {
  let result = text

  // Wrap bare \begin{...}...\end{...} blocks with $$ for remark-math
  result = result.replace(
    /(?<!\$\$\s*)(\\begin\{[^}]+\}[\s\S]*?\\end\{[^}]+\})(?!\s*\$\$)/g,
    (_match, block: string) => `$$\n${block}\n$$`,
  )

  // Only apply Unicode conversion to text outside of math delimiters
  // Split on $$...$$ and $...$ blocks, only convert non-math parts
  const parts = result.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$)/g)
  result = parts
    .map((part) => {
      if (part.startsWith("$")) return part // preserve math
      return convertLatexToUnicode(part)
    })
    .join("")

  // Fix malformed wikilinks like [[name] (missing closing bracket)
  result = result.replace(/\[\[([^\]]+)\](?!\])/g, "[[$1]]")

  // Convert [[wikilinks]] to markdown links
  result = result.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_match, pageName: string, displayText?: string) => {
      const display = displayText?.trim() || pageName.trim()
      return `[${display}](wikilink:${pageName.trim()})`
    }
  )

  return result
}

function WikiLink({ pageName, children }: { pageName: string; children: React.ReactNode }) {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const [exists, setExists] = useState<boolean | null>(null)
  const resolvedPath = useRef<string | null>(null)

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/entities/${pageName}.md`,
      `${pp}/wiki/concepts/${pageName}.md`,
      `${pp}/wiki/sources/${pageName}.md`,
      `${pp}/wiki/queries/${pageName}.md`,
      `${pp}/wiki/comparisons/${pageName}.md`,
      `${pp}/wiki/synthesis/${pageName}.md`,
      `${pp}/wiki/${pageName}.md`,
    ]

    let cancelled = false
    async function check() {
      for (const path of candidates) {
        try {
          await readFile(path)
          if (!cancelled) {
            resolvedPath.current = path
            setExists(true)
          }
          return
        } catch {
          // try next
        }
      }
      if (!cancelled) setExists(false)
    }
    check()
    return () => { cancelled = true }
  }, [project, pageName])

  const handleClick = useCallback(async () => {
    if (!resolvedPath.current) return
    try {
      const content = await readFile(resolvedPath.current)
      setSelectedFile(resolvedPath.current)
      setFileContent(content)
      setActiveView("wiki")
    } catch {
      // ignore
    }
  }, [setSelectedFile, setFileContent, setActiveView])

  if (exists === false) {
    return (
      <span className="inline text-muted-foreground" title={`Page not found: ${pageName}`}>
        {children}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-primary underline decoration-primary/30 hover:bg-primary/10 hover:decoration-primary"
      title={`Open wiki page: ${pageName}`}
    >
      <FileText className="inline h-3 w-3" />
      {children}
    </button>
  )
}
