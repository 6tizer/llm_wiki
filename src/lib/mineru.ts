import JSZip from "jszip"
import type { MineruConfig } from "@/stores/wiki-store"
import { createDirectory, getFileSize, readFileAsBase64, writeFileBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  clampMineruPollIntervalMs,
  clampMineruPollTimeoutMs,
  MINERU_DEFAULT_POLL_INTERVAL_MS,
  MINERU_DEFAULT_POLL_TIMEOUT_MS,
} from "@/lib/mineru-config"

export const MINERU_DEFAULT_API_BASE = "https://mineru.net/api/v4"
const MAX_ACCURATE_PARSE_BYTES = 200 * 1024 * 1024
const MINERU_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "tif",
  "tiff",
])

interface TaskResponse {
  code: number | string
  data: { task_id: string }
  msg: string
}

type MineruTaskState = "pending" | "running" | "converting" | "done" | "failed" | "waiting-file"

interface TaskStatus {
  code: number | string
  data: {
    task_id: string
    state: MineruTaskState
    full_zip_url?: string
    err_msg?: string
  }
  msg: string
}

interface BatchStatus {
  code: number | string
  data: {
    batch_id: string
    extract_result: Array<{
      file_name: string
      state: MineruTaskState
      full_zip_url?: string
      err_msg?: string
    }>
  }
  msg: string
}

interface UploadUrlResponse {
  code: number | string
  data: {
    batch_id: string
    file_urls: string[]
  }
  msg: string
}

export interface MineruAssetOptions {
  projectPath: string
  sourceSummarySlug: string
}

interface MineruPollingOptions {
  intervalMs: number
  timeoutMs: number
}

const MINERU_DEFAULT_POLLING_OPTIONS: MineruPollingOptions = {
  intervalMs: MINERU_DEFAULT_POLL_INTERVAL_MS,
  timeoutMs: MINERU_DEFAULT_POLL_TIMEOUT_MS,
}

function normalizeMineruPollingOptions(
  options?: Partial<MineruPollingOptions>,
): MineruPollingOptions {
  return {
    intervalMs: Math.max(1, options?.intervalMs ?? MINERU_DEFAULT_POLLING_OPTIONS.intervalMs),
    timeoutMs: Math.max(1, options?.timeoutMs ?? MINERU_DEFAULT_POLLING_OPTIONS.timeoutMs),
  }
}

function mineruPollingOptionsFromConfig(config: MineruConfig): MineruPollingOptions {
  return {
    intervalMs: clampMineruPollIntervalMs(config.pollIntervalMs),
    timeoutMs: clampMineruPollTimeoutMs(config.pollTimeoutMs),
  }
}

function mineruPollingTimeoutLabel(timeoutMs: number): string {
  return timeoutMs === MINERU_DEFAULT_POLLING_OPTIONS.timeoutMs ? "5 minutes" : `${timeoutMs} ms`
}

function mineruApiBase(config?: Pick<MineruConfig, "apiBaseUrl">): string {
  const trimmed = config?.apiBaseUrl?.trim()
  return (trimmed || MINERU_DEFAULT_API_BASE).replace(/\/+$/, "")
}

function mineruHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function redactMineruSensitiveText(text: string, token?: string): string {
  let redacted = text.replace(/\bBearer\s+[^"',\s;})\]]+/gi, "Bearer REDACTED")
  const trimmedToken = token?.trim()
  if (trimmedToken && trimmedToken.length >= 6) {
    redacted = redacted.replace(new RegExp(escapeRegExp(trimmedToken), "g"), "REDACTED")
  }
  return redacted
}

async function mineruHttpErrorMessage(
  prefix: string,
  res: Response,
  token?: string,
): Promise<string> {
  const text = await res.text().catch(() => "")
  const safeText = redactMineruSensitiveText(text, token).trim()
  return safeText ? `${prefix}: HTTP ${res.status}: ${safeText}` : `${prefix}: HTTP ${res.status}`
}

function mineruApiErrorMessage(code: number | string | undefined, msg?: string, token?: string): string {
  const key = String(code ?? "")
  const safeMsg = msg ? redactMineruSensitiveText(msg, token) : undefined
  const known: Record<string, string> = {
    A0202: "MinerU token is invalid. Check the API token in Settings.",
    A0211: "MinerU token has expired. Create a new API token and update Settings.",
    "-60005": "MinerU rejected the file because it is larger than 200 MB.",
    "-60006": "MinerU rejected the file because it exceeds the 200 page limit.",
    "-60018": "MinerU daily parsing quota has been reached.",
  }
  const knownMessage = known[key]
  if (knownMessage) return safeMsg ? `${knownMessage} (${safeMsg})` : knownMessage
  return safeMsg ? `MinerU API error ${key || "unknown"}: ${safeMsg}` : `MinerU API error ${key || "unknown"}`
}

function assertMineruSuccess(json: { code: number | string; msg?: string }, token?: string): void {
  if (json.code !== 0 && json.code !== "0") {
    throw new Error(mineruApiErrorMessage(json.code, json.msg, token))
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("MinerU parsing cancelled")
  }
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is not available in this runtime")
  }
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

function bytesToUploadBody(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function safeMineruAssetSegment(segment: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })()
  const cleaned = decoded
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/^\.+$/, "_")
    .replace(/[. ]+$/g, "_")
  if (!cleaned) return "asset"
  if (cleaned.length <= 80) return cleaned

  const dot = cleaned.lastIndexOf(".")
  if (dot > 0 && dot < cleaned.length - 1) {
    const ext = cleaned.slice(dot).slice(0, 16)
    return `${cleaned.slice(0, Math.max(1, 80 - ext.length))}${ext}`
  }
  return cleaned.slice(0, 80)
}

function normalizeMineruZipPath(path: string): string {
  return normalizePath(path)
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
}

function decodeMineruPath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

function isMineruImagePath(path: string): boolean {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  return MINERU_IMAGE_EXTS.has(ext)
}

function mineruAssetRelPath(sourceSummarySlug: string, zipPath: string): string {
  const safeParts = normalizeMineruZipPath(zipPath)
    .split("/")
    .map(safeMineruAssetSegment)
    .filter(Boolean)
  const safePath = safeParts.length > 0 ? safeParts.join("/") : "image.png"
  return `media/${sourceSummarySlug}/mineru/${safePath}`
}

function isExternalOrDataUrl(url: string): boolean {
  return /^(https?:|data:|blob:|file:|tauri:|asset:)/i.test(url)
}

function decodeHtmlEntities(text: string): string {
  const safeCodePoint = (raw: string, radix: 10 | 16): string => {
    const n = Number.parseInt(raw, radix)
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return radix === 16 ? `&#x${raw};` : `&#${raw};`
    try {
      return String.fromCodePoint(n)
    } catch {
      return radix === 16 ? `&#x${raw};` : `&#${raw};`
    }
  }

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(code, 16))
}

function htmlImgTagsToMarkdown(html: string): string {
  return html.replace(/<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi, (full, _quote: string, src: string) => {
    const alt = full.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? ""
    return `![${alt}](${src})`
  })
}

function htmlCellToMarkdown(cell: string): string {
  return decodeHtmlEntities(
    htmlImgTagsToMarkdown(cell)
      .replace(/<br\s*\/?>/gi, "<br>")
      .replace(/<\/p\s*>/gi, "<br>")
      .replace(/<[^>]+>/g, "")
      .replace(/\s*<br>\s*/gi, "<br>")
      .replace(/\s+/g, " ")
      .trim(),
  ).replace(/\|/g, "\\|")
}

function convertHtmlTablesInSegment(segment: string): string {
  return segment.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[][] = []
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rowMatch[1] ?? ""
      const cells: string[] = []
      for (const cellMatch of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(htmlCellToMarkdown(cellMatch[1] ?? ""))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length === 0) return tableHtml

    const width = Math.max(...rows.map((row) => row.length))
    const padded = rows.map((row) => {
      const out = [...row]
      while (out.length < width) out.push("")
      return out
    })
    const header = padded[0]
    const separator = Array.from({ length: width }, () => "---")
    const body = padded.slice(1)
    return [
      "",
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
      "",
    ].join("\n")
  })
}

function convertHtmlTablesToMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((segment) =>
      segment.startsWith("```") || segment.startsWith("~~~")
        ? segment
        : convertHtmlTablesInSegment(segment),
    )
    .join("")
}

function encodeMarkdownImageUrl(relPath: string): string {
  return relPath
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/")
}

function rewriteMineruMarkdownImages(markdown: string, pathMap: Map<string, string>): string {
  const lookup = (rawUrl: string): string | null => {
    if (!rawUrl || isExternalOrDataUrl(rawUrl)) return null
    const cleaned = normalizeMineruZipPath(rawUrl.split("#")[0])
    if (!cleaned) return null
    const decoded = decodeMineruPath(cleaned)
    return pathMap.get(cleaned) ?? pathMap.get(decoded) ?? pathMap.get(getFileName(decoded)) ?? null
  }

  const withMarkdownImages = markdown.replace(
    /!\[([^\]]*)]\(((?:[^()]|\([^()]*\))*)\)/g,
    (full, alt: string, target: string) => {
      const trimmed = target.trim()
      const candidates: Array<{ url: string; suffix: string }> = []
      if (trimmed.startsWith("<") && trimmed.includes(">")) {
        const end = trimmed.indexOf(">")
        candidates.push({ url: trimmed.slice(1, end), suffix: trimmed.slice(end + 1) })
      } else {
        const titleMatch = trimmed.match(/^([\s\S]+?)(\s+["'][^"']*["']\s*)$/)
        if (titleMatch) candidates.push({ url: titleMatch[1].trim(), suffix: titleMatch[2] })
        candidates.push({ url: trimmed, suffix: "" })
        const tokenMatch = trimmed.match(/^(\S+)([\s\S]*)$/)
        if (tokenMatch) candidates.push({ url: tokenMatch[1], suffix: tokenMatch[2] })
      }

      for (const candidate of candidates) {
        const rel = lookup(candidate.url)
        if (!rel) continue
        return `![${alt}](${encodeMarkdownImageUrl(rel)}${candidate.suffix})`
      }
      return full
    },
  )

  return withMarkdownImages.replace(
    /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi,
    (full, _quote: string, src: string) => {
      const rel = lookup(src)
      if (!rel) return full
      const alt = full.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? ""
      return `![${alt}](${encodeMarkdownImageUrl(rel)})`
    },
  )
}

async function submitUrlTask(
  config: MineruConfig,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  throwIfAborted(signal)
  const res = await httpFetch(`${mineruApiBase(config)}/extract/task`, {
    method: "POST",
    headers: mineruHeaders(config.token),
    signal,
    body: JSON.stringify({ url, model_version: config.modelVersion }),
  })
  if (!res.ok) throw new Error(await mineruHttpErrorMessage("MinerU submit failed", res, config.token))
  const json: TaskResponse = await res.json()
  assertMineruSuccess(json, config.token)
  return json.data.task_id
}

async function uploadFileForTask(
  config: MineruConfig,
  fileName: string,
  fileBase64: string,
  signal?: AbortSignal,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  throwIfAborted(signal)
  const res = await httpFetch(`${mineruApiBase(config)}/file-urls/batch`, {
    method: "POST",
    headers: mineruHeaders(config.token),
    signal,
    body: JSON.stringify({
      files: [{ name: fileName, data_id: fileName }],
      model_version: config.modelVersion,
    }),
  })
  if (!res.ok) throw new Error(await mineruHttpErrorMessage("MinerU batch submit failed", res, config.token))
  const json: UploadUrlResponse = await res.json()
  assertMineruSuccess(json, config.token)

  const batchId = json.data.batch_id
  const uploadUrl = json.data.file_urls[0]
  if (!batchId || !uploadUrl) {
    throw new Error("MinerU did not return a file upload URL")
  }

  const bytes = decodeBase64ToBytes(fileBase64)
  throwIfAborted(signal)
  const uploadRes = await httpFetch(uploadUrl, {
    method: "PUT",
    signal,
    body: bytesToUploadBody(bytes),
  })
  if (!uploadRes.ok) {
    throw new Error(`MinerU file upload failed: HTTP ${uploadRes.status}`)
  }

  return batchId
}

function waitForPollInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, intervalMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new Error("MinerU parsing cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function pollTask(
  config: MineruConfig,
  taskId: string,
  signal?: AbortSignal,
  pollingOptions?: Partial<MineruPollingOptions>,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const polling = normalizeMineruPollingOptions(pollingOptions)
  const start = Date.now()

  while (Date.now() - start < polling.timeoutMs) {
    throwIfAborted(signal)
    const res = await httpFetch(`${mineruApiBase(config)}/extract/task/${taskId}`, {
      headers: mineruHeaders(config.token),
      signal,
    })
    if (!res.ok) throw new Error(await mineruHttpErrorMessage("MinerU poll failed", res, config.token))
    const json: TaskStatus = await res.json()
    assertMineruSuccess(json, config.token)

    if (json.data.state === "done" && json.data.full_zip_url) return json.data.full_zip_url
    if (json.data.state === "failed") {
      throw new Error(`MinerU parsing failed: ${redactMineruSensitiveText(json.data.err_msg ?? "unknown error", config.token)}`)
    }

    await waitForPollInterval(polling.intervalMs, signal)
  }

  throw new Error(`MinerU parsing timed out after ${mineruPollingTimeoutLabel(polling.timeoutMs)}`)
}

async function pollBatchTask(
  config: MineruConfig,
  batchId: string,
  signal?: AbortSignal,
  pollingOptions?: Partial<MineruPollingOptions>,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const polling = normalizeMineruPollingOptions(pollingOptions)
  const start = Date.now()

  while (Date.now() - start < polling.timeoutMs) {
    throwIfAborted(signal)
    const res = await httpFetch(`${mineruApiBase(config)}/extract-results/batch/${batchId}`, {
      headers: mineruHeaders(config.token),
      signal,
    })
    if (!res.ok) throw new Error(await mineruHttpErrorMessage("MinerU batch poll failed", res, config.token))
    const json: BatchStatus = await res.json()
    assertMineruSuccess(json, config.token)

    const result = json.data.extract_result[0]
    if (result?.state === "done" && result.full_zip_url) return result.full_zip_url
    if (result?.state === "failed") {
      throw new Error(`MinerU parsing failed: ${redactMineruSensitiveText(result.err_msg ?? "unknown error", config.token)}`)
    }

    await waitForPollInterval(polling.intervalMs, signal)
  }

  throw new Error(`MinerU parsing timed out after ${mineruPollingTimeoutLabel(polling.timeoutMs)}`)
}

async function saveMineruZipImages(
  zip: JSZip,
  options: MineruAssetOptions,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const pp = normalizePath(options.projectPath)
  const rootDir = `${pp}/wiki/media/${options.sourceSummarySlug}/mineru`
  const pathMap = new Map<string, string>()
  const imageEntries: Array<[string, JSZip.JSZipObject]> = []
  const basenameCounts = new Map<string, number>()

  zip.forEach((relativePath, file) => {
    const normalized = normalizeMineruZipPath(relativePath)
    if (!file.dir && normalized && isMineruImagePath(normalized)) {
      imageEntries.push([normalized, file])
      const basename = getFileName(normalized)
      basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1)
    }
  })

  if (imageEntries.length === 0) return pathMap

  await createDirectory(rootDir)
  for (const [zipPath, file] of imageEntries) {
    throwIfAborted(signal)
    const relPath = mineruAssetRelPath(options.sourceSummarySlug, zipPath)
    const absPath = `${pp}/wiki/${relPath}`
    const bytes = await file.async("uint8array")
    await writeFileBase64(absPath, bytesToBase64(bytes))
    pathMap.set(zipPath, relPath)
    pathMap.set(decodeMineruPath(zipPath), relPath)
    const basename = getFileName(zipPath)
    if (basenameCounts.get(basename) === 1) {
      pathMap.set(basename, relPath)
      pathMap.set(decodeMineruPath(basename), relPath)
    }
  }

  return pathMap
}

async function downloadAndExtractMarkdown(
  zipUrl: string,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  throwIfAborted(signal)
  const res = await httpFetch(zipUrl, { signal })
  if (!res.ok) throw new Error(`MinerU zip download failed: HTTP ${res.status}`)

  const buffer = await res.arrayBuffer()
  const zip = await JSZip.loadAsync(buffer)
  const mdEntries: [string, JSZip.JSZipObject][] = []
  zip.forEach((relativePath, file) => {
    if (!file.dir && relativePath.endsWith(".md")) {
      mdEntries.push([relativePath, file])
    }
  })

  if (mdEntries.length === 0) {
    throw new Error("No Markdown file found in MinerU result zip")
  }

  const fullMd = mdEntries.find(([relativePath]) =>
    relativePath.split("/").pop()?.toLowerCase() === "full.md"
  )
  const markdown = await (fullMd ?? mdEntries[0])[1].async("string")
  const markdownWithTables = convertHtmlTablesToMarkdown(markdown)
  if (!assetOptions) return markdownWithTables

  try {
    const pathMap = await saveMineruZipImages(zip, assetOptions, signal)
    return pathMap.size > 0
      ? rewriteMineruMarkdownImages(markdownWithTables, pathMap)
      : markdownWithTables
  } catch (err) {
    if (signal?.aborted) throw err
    console.warn(
      "[MinerU] failed to save extracted images; keeping parsed Markdown text:",
      err instanceof Error ? err.message : err,
    )
    return markdownWithTables
  }
}

/**
 * Parse a PDF file using the MinerU cloud API.
 */
export async function parseWithMineru(
  config: MineruConfig,
  sourcePath: string,
  sourceUrl?: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  assetOptions?: MineruAssetOptions,
  pollingOptions?: Partial<MineruPollingOptions>,
): Promise<string> {
  throwIfAborted(signal)
  if (!config.token.trim()) throw new Error("MinerU API token not configured")
  if (config.modelVersion !== "pipeline" && config.modelVersion !== "vlm") {
    throw new Error("MinerU PDF parsing supports only pipeline or vlm model versions")
  }
  const effectivePollingOptions = pollingOptions ?? mineruPollingOptionsFromConfig(config)

  const zipUrl = await (async () => {
    if (sourceUrl) {
      onProgress?.("Submitting URL to MinerU...")
      const taskId = await submitUrlTask(config, sourceUrl, signal)
      onProgress?.("Waiting for MinerU to finish...")
      return pollTask(config, taskId, signal, effectivePollingOptions)
    }

    onProgress?.("Uploading file to MinerU...")
    const fileSize = await getFileSize(sourcePath)
    if (fileSize > MAX_ACCURATE_PARSE_BYTES) {
      throw new Error("MinerU accurate parsing supports files up to 200 MB")
    }

    const fileName = sourcePath.split("/").pop() ?? "document.pdf"
    throwIfAborted(signal)
    const { base64 } = await readFileAsBase64(sourcePath)
    const batchId = await uploadFileForTask(config, fileName, base64, signal)
    onProgress?.("Waiting for MinerU to finish...")
    return pollBatchTask(config, batchId, signal, effectivePollingOptions)
  })()

  onProgress?.("Downloading parsed result...")
  const markdown = await downloadAndExtractMarkdown(zipUrl, signal, assetOptions)
  onProgress?.("Done")
  return markdown
}

/**
 * Test MinerU API connectivity by submitting a small public demo PDF task.
 */
export async function testMineruConnection(config: MineruConfig): Promise<void> {
  if (!config.token.trim()) throw new Error("MinerU API token not configured")
  const httpFetch = await getHttpFetch()
  const res = await httpFetch(`${mineruApiBase(config)}/extract/task`, {
    method: "POST",
    headers: mineruHeaders(config.token),
    body: JSON.stringify({
      url: "https://cdn-mineru.openxlab.org.cn/demo/example.pdf",
      model_version: config.modelVersion,
    }),
  })

  if (!res.ok) {
    throw new Error(await mineruHttpErrorMessage("MinerU connection test failed", res, config.token))
  }

  const json: TaskResponse = await res.json()
  assertMineruSuccess(json, config.token)
}

export const __mineruTest = {
  downloadAndExtractMarkdown,
  mineruApiErrorMessage,
  redactMineruSensitiveText,
  decodeBase64ToBytes,
  rewriteMineruMarkdownImages,
  convertHtmlTablesToMarkdown,
  normalizeMineruPollingOptions,
  pollBatchTask,
  mineruPollingOptionsFromConfig,
  MAX_ACCURATE_PARSE_BYTES,
  MINERU_DEFAULT_POLLING_OPTIONS,
}
