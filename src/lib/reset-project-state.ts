/**
 * Centralized reset of all per-project state.
 * MUST be called (and AWAITED) both when leaving a project and when opening a
 * new one, to prevent cross-project data contamination.
 *
 * Returns once every store/cache has actually been cleared — the caller can
 * trust that downstream project-opening steps will not race with lingering
 * cleanup.
 */

import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useResearchStore } from "@/stores/research-store"
import { useLintStore } from "@/stores/lint-store"
import { useWikiStore } from "@/stores/wiki-store"
import { flushAutoSave, cancelAutoSaveTimers } from "@/lib/auto-save"

export async function resetProjectState(): Promise<void> {
  // Bump the project generation token first, before anything else runs.
  // This marks every async write queued under the old generation (auto-save
  // debounce timers, in-flight agent lint scans) as stale from this point
  // on, so it can be dropped on arrival instead of landing on whatever
  // project happens to be active — including the case where the same
  // project path is closed and reopened, which a naive path comparison
  // alone would not catch.
  useWikiStore.getState().bumpProjectGeneration()

  // Capture the outgoing project's path before anything below flips
  // useWikiStore.project. auto-save's subscribers key their debounce
  // timers by this path, so it is what flushAutoSave/cancelAutoSaveTimers
  // need to target the right entries.
  const outgoingPath = useWikiStore.getState().project?.path

  // Flush any pending debounced save for the outgoing project BEFORE
  // clearing the stores below — otherwise the most recent real edit
  // (still sitting in a setTimeout) would never be written: the store it
  // reads from is about to be reset to empty.
  if (outgoingPath) {
    await flushAutoSave(outgoingPath)
  }

  // Zustand stores — clear all per-project data (synchronous)
  useChatStore.getState().clearAgentPermissionRequests()
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    ingestSource: null,
    activeRunModelByConversation: {},
    isStreaming: false,
    streamingConversationId: null,
    streamingAgentMessageId: null,
    streamingContent: "",
    activeAgentPermissionRequest: null,
    queuedAgentPermissionRequests: [],
    agentPermissionRequestsByConversation: {},
    agentRewindTargets: {},
    activeAgentRewindRequest: null,
    agentRewindRequestsByConversation: {},
    agentRewindLocks: {},
  })

  useReviewStore.getState().setItems([])

  useActivityStore.setState({
    items: [],
  })

  useResearchStore.setState({
    tasks: [],
    panelOpen: false,
  })

  useLintStore.getState().clearItems()

  // The clears above look like real edits to auto-save's subscribers,
  // which would otherwise re-queue an empty-array write for the outgoing
  // project a few seconds from now and clobber its real data on disk.
  // Cancel those before they can fire.
  if (outgoingPath) {
    cancelAutoSaveTimers(outgoingPath)
  }

  // Module-level caches — load in parallel and clear each, surfacing any
  // failure instead of swallowing it.
  const [queueMod, dedupQueueMod, graphMod, fileSyncMod, scheduledImportMod, agentLintQueueMod, embeddingConsumerMod, taxonomyConsumerMod] = await Promise.allSettled([
    import("@/lib/ingest-queue"),
    import("@/lib/dedup-queue"),
    import("@/lib/graph-relevance"),
    import("@/lib/project-file-sync"),
    import("@/lib/scheduled-import"),
    import("@/lib/agent/agent-lint-queue"),
    import("@/lib/derived-rebuild/embedding-consumer"),
    import("@/lib/derived-rebuild/taxonomy-consumer"),
  ])

  if (scheduledImportMod.status === "fulfilled") {
    try {
      scheduledImportMod.value.stopScheduledImport()
    } catch (err) {
      console.warn("[Reset Project State] stopScheduledImport failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load scheduled-import:", scheduledImportMod.reason)
  }

  // SPEC-6 PR2: stop the embedding-consumer derived-rebuild job poller
  // BEFORE the new project's own start call (App.tsx) can run — same
  // start/stop + generation-counter lifecycle contract as scheduled import
  // (SPEC-11 PR8b/S8 teaches this must be in the centralized cleanup list,
  // not left to whichever caller remembers).
  if (embeddingConsumerMod.status === "fulfilled") {
    try {
      embeddingConsumerMod.value.stopEmbeddingConsumer()
    } catch (err) {
      console.warn("[Reset Project State] stopEmbeddingConsumer failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load embedding-consumer:", embeddingConsumerMod.reason)
  }

  // SPEC-6 PR3+4: stop the taxonomy-consumer derived-rebuild job poller —
  // same lifecycle contract as the embedding consumer above.
  if (taxonomyConsumerMod.status === "fulfilled") {
    try {
      taxonomyConsumerMod.value.stopTaxonomyConsumer()
    } catch (err) {
      console.warn("[Reset Project State] stopTaxonomyConsumer failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load taxonomy-consumer:", taxonomyConsumerMod.reason)
  }

  if (queueMod.status === "fulfilled") {
    try {
      // pauseQueue flushes the active project's state to disk (reverting
      // any processing task to pending) before clearing in-memory state.
      // Awaiting is required — the disk write must complete before the
      // new project's restoreQueue reads its own file.
      await queueMod.value.pauseQueue()
    } catch (err) {
      console.warn("[Reset Project State] pauseQueue failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load ingest-queue:", queueMod.reason)
  }

  if (dedupQueueMod.status === "fulfilled") {
    try {
      await dedupQueueMod.value.pauseQueue()
    } catch (err) {
      console.warn("[Reset Project State] dedup pauseQueue failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load dedup-queue:", dedupQueueMod.reason)
  }

  if (graphMod.status === "fulfilled") {
    try {
      graphMod.value.clearGraphCache()
    } catch (err) {
      console.warn("[Reset Project State] clearGraphCache failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load graph-relevance:", graphMod.reason)
  }

  if (fileSyncMod.status === "fulfilled") {
    try {
      await fileSyncMod.value.stopProjectFileSync()
    } catch (err) {
      console.warn("[Reset Project State] stopProjectFileSync failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load project-file-sync:", fileSyncMod.reason)
  }

  if (agentLintQueueMod.status === "fulfilled") {
    try {
      agentLintQueueMod.value.clearAgentStructuralLintQueue()
    } catch (err) {
      console.warn("[Reset Project State] clearAgentStructuralLintQueue failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load agent-lint-queue:", agentLintQueueMod.reason)
  }

}
