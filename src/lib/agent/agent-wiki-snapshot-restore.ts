import { deleteFile, readFile, writeFile } from "@/commands/fs"
import type { AgentRewindRequestRecord, DisplayMessage } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

export interface WikiSnapshotRestoreFailure {
  path: string
  error: string
}

export interface WikiSnapshotRestoreResult {
  ok: boolean
  restoredPaths: string[]
  failures: WikiSnapshotRestoreFailure[]
}

export interface SnapshotManifestEntry {
  seq: number
  path: string
  operation: "update" | "create" | "delete"
  existedBefore: boolean
  beforeSha256?: string
  afterSha256: string
  toolUseId?: string
  timestamp: number
  snapshotFile: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseManifestEntry(line: string): SnapshotManifestEntry {
  const parsed = JSON.parse(line) as unknown
  if (!isRecord(parsed)) throw new Error("manifest entry is not an object")
  if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) {
    throw new Error("manifest entry missing seq")
  }
  if (typeof parsed.path !== "string" || parsed.path.length === 0) {
    throw new Error("manifest entry missing path")
  }
  if (
    parsed.path.startsWith("/") ||
    parsed.path.includes("\\") ||
    parsed.path.split("/").includes("..")
  ) {
    throw new Error("manifest entry has unsafe path")
  }
  if (
    parsed.operation !== "update" &&
    parsed.operation !== "create" &&
    parsed.operation !== "delete"
  ) {
    throw new Error("manifest entry has invalid operation")
  }
  if (typeof parsed.existedBefore !== "boolean") {
    throw new Error("manifest entry missing existedBefore")
  }
  if (typeof parsed.afterSha256 !== "string" || parsed.afterSha256.length === 0) {
    throw new Error("manifest entry missing afterSha256")
  }
  if (typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) {
    throw new Error("manifest entry missing timestamp")
  }
  if (typeof parsed.snapshotFile !== "string" || parsed.snapshotFile.length === 0) {
    throw new Error("manifest entry missing snapshotFile")
  }
  if (parsed.snapshotFile.includes("/") || parsed.snapshotFile.includes("\\") || parsed.snapshotFile.includes("..")) {
    throw new Error("manifest entry has unsafe snapshotFile")
  }
  return {
    seq: parsed.seq,
    path: parsed.path,
    operation: parsed.operation,
    existedBefore: parsed.existedBefore,
    beforeSha256: typeof parsed.beforeSha256 === "string" ? parsed.beforeSha256 : undefined,
    afterSha256: parsed.afterSha256,
    toolUseId: typeof parsed.toolUseId === "string" ? parsed.toolUseId : undefined,
    timestamp: parsed.timestamp,
    snapshotFile: parsed.snapshotFile,
  }
}

function fullPath(projectPath: string, relativePath: string): string {
  return `${projectPath}/${relativePath.replace(/^\/+/, "")}`
}

function snapshotDir(projectPath: string, streamId: string): string {
  return `${projectPath}/.llm-wiki/rewind-snapshots/${streamId}`
}

async function sha256Text(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

function manifestEntryMatches(entry: SnapshotManifestEntry, args: {
  path: string
  toolUseId: string
}): boolean {
  return entry.path === args.path && entry.toolUseId === args.toolUseId
}

export async function restoreSingleAgentWikiSnapshot(args: {
  projectPath: string | undefined
  streamId: string
  path: string
  toolUseId?: string
}): Promise<WikiSnapshotRestoreResult> {
  if (!args.projectPath) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{ path: args.path, error: "No active project path for wiki snapshot restore" }],
    }
  }
  if (!args.toolUseId) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{ path: args.path, error: "Missing toolUseId for wiki snapshot restore" }],
    }
  }

  const projectPath = normalizePath(args.projectPath)
  const dir = snapshotDir(projectPath, args.streamId)
  let manifest: string
  try {
    manifest = await readFile(`${dir}/manifest.jsonl`)
  } catch (err) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{
        path: args.path,
        error: err instanceof Error ? err.message : String(err),
      }],
    }
  }

  let entry: SnapshotManifestEntry | undefined
  try {
    for (const line of manifest.split(/\r?\n/)) {
      if (!line.trim()) continue
      const candidate = parseManifestEntry(line)
      if (manifestEntryMatches(candidate, {
        path: args.path,
        toolUseId: args.toolUseId,
      })) {
        entry = candidate
        break
      }
    }
  } catch (err) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{
        path: `${dir}/manifest.jsonl`,
        error: err instanceof Error ? err.message : String(err),
      }],
    }
  }

  if (!entry) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{ path: args.path, error: "Missing snapshot manifest entry for toolUseId" }],
    }
  }

  const destination = fullPath(projectPath, entry.path)
  try {
    const current = await readFile(destination)
    const currentSha256 = await sha256Text(current)
    // This naturally enforces same-run reverse order for repeated writes:
    // older entries have an afterSha256 that no longer matches the current
    // file until newer writes have been undone first.
    if (currentSha256 !== entry.afterSha256) {
      return {
        ok: false,
        restoredPaths: [],
        failures: [{
          path: entry.path,
          error: "文件已被后续修改，请用 rewind 或手动处理",
        }],
      }
    }
    if (!entry.existedBefore) {
      await deleteFile(destination)
    } else {
      const before = await readFile(`${dir}/${entry.snapshotFile}`)
      await writeFile(destination, before)
    }
    return { ok: true, restoredPaths: [entry.path], failures: [] }
  } catch (err) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      }],
    }
  }
}

export function collectWikiSnapshotToolUseIds(args: {
  target: AgentRewindRequestRecord
  messages: DisplayMessage[]
}): Map<string, string> {
  const conversationMessages = args.messages
    .filter((m) => m.conversationId === args.target.conversationId)
    .sort((a, b) => a.timestamp - b.timestamp)
  const targetIndex = conversationMessages.findIndex(
    (m) => m.id === args.target.chatMessageId
  )
  if (targetIndex === -1) return new Map()

  const ids = new Map<string, string>()
  for (const message of conversationMessages.slice(targetIndex)) {
    for (const change of message.wikiChanges ?? []) {
      if (change.snapshotted === true && change.toolUseId && !change.reverted) {
        ids.set(change.toolUseId, change.path)
      }
    }
  }
  return ids
}

export async function restoreAgentWikiSnapshots(args: {
  projectPath: string | undefined
  target: AgentRewindRequestRecord
  messages: DisplayMessage[]
}): Promise<WikiSnapshotRestoreResult> {
  const expectedToolUseIds = collectWikiSnapshotToolUseIds({
    target: args.target,
    messages: args.messages,
  })
  if (expectedToolUseIds.size === 0) {
    return { ok: true, restoredPaths: [], failures: [] }
  }
  if (!args.projectPath) {
    return {
      ok: false,
      restoredPaths: [],
      failures: Array.from(expectedToolUseIds.values()).map((path) => ({
        path,
        error: "No active project path for wiki snapshot restore",
      })),
    }
  }

  const projectPath = normalizePath(args.projectPath)
  const dir = snapshotDir(projectPath, args.target.streamId)
  let manifest: string
  try {
    manifest = await readFile(`${dir}/manifest.jsonl`)
  } catch (err) {
    return {
      ok: false,
      restoredPaths: [],
      failures: Array.from(expectedToolUseIds.values()).map((path) => ({
        path,
        error: err instanceof Error ? err.message : String(err),
      })),
    }
  }

  const unmatched = new Map(expectedToolUseIds)
  const firstByPath = new Map<string, SnapshotManifestEntry>()
  const failures: WikiSnapshotRestoreFailure[] = []

  try {
    for (const line of manifest.split(/\r?\n/)) {
      if (!line.trim()) continue
      const entry = parseManifestEntry(line)
      if (!entry.toolUseId || !expectedToolUseIds.has(entry.toolUseId)) continue
      unmatched.delete(entry.toolUseId)
      const existing = firstByPath.get(entry.path)
      if (!existing || entry.seq < existing.seq) {
        firstByPath.set(entry.path, entry)
      }
    }
  } catch (err) {
    return {
      ok: false,
      restoredPaths: [],
      failures: [{
        path: `${dir}/manifest.jsonl`,
        error: err instanceof Error ? err.message : String(err),
      }],
    }
  }

  for (const path of unmatched.values()) {
    failures.push({ path, error: "Missing snapshot manifest entry for toolUseId" })
  }

  const restoredPaths: string[] = []
  const entries = Array.from(firstByPath.values()).sort((a, b) => a.seq - b.seq)
  for (const entry of entries) {
    try {
      if (!entry.existedBefore) {
        await deleteFile(fullPath(projectPath, entry.path))
      } else {
        const before = await readFile(`${dir}/${entry.snapshotFile}`)
        await writeFile(fullPath(projectPath, entry.path), before)
      }
      restoredPaths.push(entry.path)
    } catch (err) {
      failures.push({
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ok: failures.length === 0,
    restoredPaths,
    failures,
  }
}
