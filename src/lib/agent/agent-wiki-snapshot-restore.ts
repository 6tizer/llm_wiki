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

function isMissingFileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /\bENOENT\b|not found|no such file|does not exist/i.test(message)
}

function changedAfterSnapshotFailure(path: string): WikiSnapshotRestoreFailure {
  return {
    path,
    error: "文件已被后续修改，请用 rewind 或手动处理",
  }
}

function restoredEarlierEntryForPath(args: {
  currentSha256: string
  entry: SnapshotManifestEntry
  entriesByPath: Map<string, SnapshotManifestEntry[]>
}): boolean {
  return (args.entriesByPath.get(args.entry.path) ?? []).some((candidate) =>
    candidate.seq <= args.entry.seq && candidate.beforeSha256 === args.currentSha256
  )
}

function pathRestoredByPriorCreate(args: {
  entry: SnapshotManifestEntry
  entriesByPath: Map<string, SnapshotManifestEntry[]>
}): boolean {
  return (args.entriesByPath.get(args.entry.path) ?? []).some((candidate) =>
    candidate.seq < args.entry.seq && !candidate.existedBefore
  )
}

function manifestEntryMatches(entry: SnapshotManifestEntry, args: {
  path: string
  toolUseId: string
}): boolean {
  return entry.path === args.path && entry.toolUseId === args.toolUseId
}

export interface ExpectedSnapshotChange {
  toolUseId: string
  path: string
}

function expectedSnapshotKey(change: ExpectedSnapshotChange): string {
  return `${change.toolUseId}\0${change.path}`
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
    if (entry.operation === "delete") {
      try {
        await readFile(destination)
        return {
          ok: false,
          restoredPaths: [],
          failures: [changedAfterSnapshotFailure(entry.path)],
        }
      } catch (err) {
        if (!isMissingFileError(err)) throw err
      }
      const before = await readFile(`${dir}/${entry.snapshotFile}`)
      await writeFile(destination, before)
      return { ok: true, restoredPaths: [entry.path], failures: [] }
    }
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
}): ExpectedSnapshotChange[] {
  const conversationMessages = args.messages
    .filter((m) => m.conversationId === args.target.conversationId)
    .sort((a, b) => a.timestamp - b.timestamp)
  const targetIndex = conversationMessages.findIndex(
    (m) => m.id === args.target.chatMessageId
  )
  if (targetIndex === -1) return []

  const changes = new Map<string, ExpectedSnapshotChange>()
  for (const message of conversationMessages.slice(targetIndex)) {
    for (const change of message.wikiChanges ?? []) {
      if (change.snapshotted === true && change.toolUseId && !change.reverted) {
        const item = { toolUseId: change.toolUseId, path: change.path }
        changes.set(expectedSnapshotKey(item), item)
      }
    }
  }
  return [...changes.values()]
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
  if (expectedToolUseIds.length === 0) {
    return { ok: true, restoredPaths: [], failures: [] }
  }
  const expectedByKey = new Map(expectedToolUseIds.map((item) => [expectedSnapshotKey(item), item]))
  if (!args.projectPath) {
    return {
      ok: false,
      restoredPaths: [],
      failures: expectedToolUseIds.map((item) => ({
        path: item.path,
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
      failures: expectedToolUseIds.map((item) => ({
        path: item.path,
        error: err instanceof Error ? err.message : String(err),
      })),
    }
  }

  const unmatched = new Map(expectedByKey)
  const entriesBySeq = new Map<number, SnapshotManifestEntry>()
  const failures: WikiSnapshotRestoreFailure[] = []

  try {
    for (const line of manifest.split(/\r?\n/)) {
      if (!line.trim()) continue
      const entry = parseManifestEntry(line)
      if (!entry.toolUseId) continue
      const key = expectedSnapshotKey({ toolUseId: entry.toolUseId, path: entry.path })
      if (!expectedByKey.has(key)) continue
      unmatched.delete(key)
      entriesBySeq.set(entry.seq, entry)
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

  for (const item of unmatched.values()) {
    failures.push({ path: item.path, error: "Missing snapshot manifest entry for toolUseId" })
  }

  const restoredPaths: string[] = []
  const restoredSet = new Set<string>()
  const entries = Array.from(entriesBySeq.values()).sort((a, b) => b.seq - a.seq)
  const entriesByPath = new Map<string, SnapshotManifestEntry[]>()
  for (const entry of entries) {
    entriesByPath.set(entry.path, [...(entriesByPath.get(entry.path) ?? []), entry])
  }
  for (const entry of entries) {
    const destination = fullPath(projectPath, entry.path)
    try {
      if (entry.operation === "delete") {
        try {
          await readFile(destination)
          failures.push(changedAfterSnapshotFailure(entry.path))
          continue
        } catch (err) {
          if (!isMissingFileError(err)) throw err
          if (pathRestoredByPriorCreate({ entry, entriesByPath })) continue
        }
        const before = await readFile(`${dir}/${entry.snapshotFile}`)
        await writeFile(destination, before)
        restoredSet.add(entry.path)
      } else if (!entry.existedBefore) {
        let current: string
        try {
          current = await readFile(destination)
        } catch (err) {
          if (isMissingFileError(err)) continue
          throw err
        }
        const currentSha256 = await sha256Text(current)
        if (currentSha256 !== entry.afterSha256) {
          failures.push(changedAfterSnapshotFailure(entry.path))
          continue
        }
        await deleteFile(destination)
        restoredSet.add(entry.path)
      } else {
        let current: string
        try {
          current = await readFile(destination)
        } catch (err) {
          if (isMissingFileError(err) && pathRestoredByPriorCreate({ entry, entriesByPath })) {
            continue
          }
          throw err
        }
        const currentSha256 = await sha256Text(current)
        if (restoredEarlierEntryForPath({ currentSha256, entry, entriesByPath })) continue
        if (currentSha256 !== entry.afterSha256) {
          failures.push(changedAfterSnapshotFailure(entry.path))
          continue
        }
        const before = await readFile(`${dir}/${entry.snapshotFile}`)
        await writeFile(destination, before)
        restoredSet.add(entry.path)
      }
    } catch (err) {
      failures.push({
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  restoredPaths.push(...Array.from(restoredSet).sort())

  return {
    ok: failures.length === 0,
    restoredPaths,
    failures,
  }
}
