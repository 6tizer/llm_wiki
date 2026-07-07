import { enqueueAgentStructuralLint } from "@/lib/agent/agent-lint-queue"
import { normalizePath } from "@/lib/path-utils"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"

const DEFAULT_NOTIFY_DEBOUNCE_MS = 500

let pendingProjectPath: string | null = null
let pendingPaths = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let activeSweepController: AbortController | null = null

function snapshotPaths(): string[] {
  return [...pendingPaths].sort()
}

function normalizeWikiNotificationPath(path: string): string {
  const normalized = normalizePath(path)
  return normalized.startsWith("wiki/") ? normalized.slice("wiki/".length) : normalized
}

function schedule(delayMs: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void drainQueue()
  }, delayMs)
}

async function drainQueue(): Promise<void> {
  if (running || !pendingProjectPath || pendingPaths.size === 0) return

  running = true
  const projectPath = pendingProjectPath
  const paths = snapshotPaths()
  pendingProjectPath = null
  pendingPaths = new Set()

  enqueueAgentStructuralLint(projectPath, paths)
  const controller = new AbortController()
  activeSweepController = controller
  try {
    await sweepResolvedReviews(projectPath, controller.signal)
  } catch (err) {
    console.warn("[wiki-change-notifier] failed to sweep review queue:", err)
  } finally {
    if (activeSweepController === controller) {
      activeSweepController = null
    }
    running = false
    // If a write arrived while this sweep was running, pendingProjectPath was
    // already normalized and old-project paths were cleared at enqueue time.
    // A zero-delay drain just starts that next batch without another 500ms wait.
    if (pendingProjectPath && pendingPaths.size > 0) schedule(0)
  }
}

/**
 * Notify wiki-derived queues after files are written.
 *
 * Review sweeping is debounced because it may call the LLM semantic judge.
 * Structural lint is queued from the same merged path batch and keeps its own
 * scan debounce / in-flight stale guards.
 */
export function notifyWikiPathsChanged(
  projectPath: string | undefined,
  paths: readonly string[],
  delayMs = DEFAULT_NOTIFY_DEBOUNCE_MS,
): void {
  if (!projectPath || paths.length === 0) return

  const normalizedProjectPath = normalizePath(projectPath)
  if (pendingProjectPath && pendingProjectPath !== normalizedProjectPath) {
    pendingPaths = new Set()
  }
  pendingProjectPath = normalizedProjectPath
  for (const path of paths) {
    const normalizedPath = normalizeWikiNotificationPath(path)
    if (normalizedPath) pendingPaths.add(normalizedPath)
  }
  schedule(delayMs)
}

/** Clear pending wiki-change notifications, primarily for test isolation. */
export function clearWikiChangeNotifications(): void {
  if (timer) clearTimeout(timer)
  activeSweepController?.abort()
  activeSweepController = null
  timer = null
  pendingProjectPath = null
  pendingPaths = new Set()
}
