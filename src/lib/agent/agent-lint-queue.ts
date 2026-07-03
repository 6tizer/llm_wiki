import { runStructuralLint } from "@/lib/lint"
import { normalizePath } from "@/lib/path-utils"
import { useLintStore } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"

let pendingProjectPath: string | null = null
let pendingPaths = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null
let running = false
// Set true by clearAgentStructuralLintQueue() while a scan is in flight, so
// drainQueue can discard that scan's results even if, for some reason, the
// project generation check below did not also change. The generation check
// is the primary guard (it also catches the same project path being closed
// and reopened); this flag is a second, independent line of defense.
let runningScanStale = false

function snapshotPaths(): string[] {
  return [...pendingPaths].sort()
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
  runningScanStale = false
  // Captured at scan start, not read again until the scan resolves — this
  // is what lets us tell whether a project switch happened while the scan
  // (a real async Rust call) was in flight.
  const scanGeneration = useWikiStore.getState().projectGeneration
  const projectPath = pendingProjectPath
  const paths = snapshotPaths()
  pendingPaths = new Set()
  useLintStore.getState().setAgentLintState({
    status: "running",
    paths,
    updatedAt: Date.now(),
  })

  try {
    const results = await runStructuralLint(normalizePath(projectPath))
    if (runningScanStale || useWikiStore.getState().projectGeneration !== scanGeneration) {
      // The active project changed while this scan was running. These
      // results describe a project that is no longer active — writing
      // them (via replaceAgentItems, which auto-save would then persist
      // under whatever project is active now) would silently corrupt
      // that project's lint data. Discard instead.
      console.debug(
        `[agent-lint-queue] discarding stale scan results for "${projectPath}" — project switched while the scan was in flight`
      )
      return
    }
    useLintStore.getState().replaceAgentItems(results)
    useLintStore.getState().setAgentLintState({
      status: "done",
      paths,
      updatedAt: Date.now(),
    })
  } catch (err) {
    if (runningScanStale || useWikiStore.getState().projectGeneration !== scanGeneration) return
    useLintStore.getState().setAgentLintState({
      status: "failed",
      paths,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: Date.now(),
    })
  } finally {
    running = false
    if (!runningScanStale && pendingPaths.size > 0) schedule(0)
  }
}

/** Enqueue a structural lint refresh after Agent writes wiki files. */
export function enqueueAgentStructuralLint(
  projectPath: string,
  paths: readonly string[],
  delayMs = 500,
): void {
  if (!projectPath || paths.length === 0) return
  pendingProjectPath = projectPath
  for (const path of paths) {
    if (path) pendingPaths.add(path)
  }
  useLintStore.getState().setAgentLintState({
    status: "queued",
    paths: snapshotPaths(),
    updatedAt: Date.now(),
  })
  schedule(delayMs)
}

export function clearAgentStructuralLintQueue(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pendingProjectPath = null
  pendingPaths = new Set()
  if (running) runningScanStale = true
  running = false
}
