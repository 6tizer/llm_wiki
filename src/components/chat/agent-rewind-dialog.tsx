import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAgentSettingsStore } from "@/stores/agent-settings-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import {
  computeAgentRewindGateDecision,
  type AgentRewindGateDecision,
} from "@/lib/agent/agent-rewind-gate"
import {
  retryAgentRewindPersistence,
  runAgentRewind,
} from "@/lib/agent/agent-rewind-orchestration"
import { buildAgentTransportOptionsFromState } from "./agent-transport-options"

/** Same getState()-based builder pattern chat-panel.tsx uses (not imported
 * from there directly — chat-panel.tsx imports this dialog, so importing
 * back would be circular). */
function buildRewindTransportOptions() {
  const wikiState = useWikiStore.getState()
  const chatState = useChatStore.getState()
  const agentSettings = useAgentSettingsStore.getState()
  return buildAgentTransportOptionsFromState({
    project: wikiState.project,
    llmConfig: wikiState.llmConfig,
    apiConfig: wikiState.apiConfig,
    conversations: chatState.conversations,
    activeConversationId: chatState.activeConversationId,
    resourceConfig: agentSettings.resourceConfig,
  })
}

function gateBlockedI18nKey(reason: Exclude<AgentRewindGateDecision, { allowed: true }>["reason"]): string {
  if (reason === "wiki_write_after_target") return "agent.rewind.blockedWikiWrite"
  if (reason === "cross_fork") return "agent.rewind.blockedCrossFork"
  return "agent.rewind.blockedLocked"
}

export function AgentRewindDialogHost() {
  const { t } = useTranslation()
  const request = useChatStore((s) => s.activeAgentRewindRequest)
  const clearAgentRewindRequest = useChatStore((s) => s.clearAgentRewindRequest)
  const clearAgentMessageRewindable = useChatStore((s) => s.clearAgentMessageRewindable)
  const conversations = useChatStore((s) => s.conversations)
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const agentRewindLocks = useChatStore((s) => s.agentRewindLocks)
  const project = useWikiStore((s) => s.project)
  const [error, setError] = useState<string | null>(null)
  const [persistError, setPersistError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    setError(null)
    setPersistError(null)
    setPending(false)
    setRetrying(false)
  }, [request])

  const gate: AgentRewindGateDecision | null = request
    ? computeAgentRewindGateDecision({
        target: request,
        conversation: conversations.find((c) => c.id === request.conversationId),
        messages,
        isStreaming,
        rewindLocked: Boolean(agentRewindLocks[request.conversationId]),
      })
    : null

  const confirm = useCallback(() => {
    if (!request || pending) return
    setPending(true)
    setError(null)
    setPersistError(null)
    void runAgentRewind({
      target: request,
      projectPath: project?.path,
      buildOptions: buildRewindTransportOptions,
    })
      .then((outcome) => {
        if (outcome.status === "success") {
          clearAgentRewindRequest()
          return
        }
        if (outcome.status === "gate_blocked") {
          if (outcome.gate && !outcome.gate.allowed) {
            setError(t(gateBlockedI18nKey(outcome.gate.reason)))
          }
          return
        }
        if (outcome.status === "persist_failed") {
          setPersistError(outcome.persistError ?? "Unknown save error")
          return
        }
        if (outcome.status === "state_mismatch") {
          // Files WERE reverted on disk (payload.ok), but the target
          // message no longer exists in this conversation, so there is
          // nothing left to truncate/fork from — this must never be
          // silently reported as a plain success (review-round P2).
          console.warn("[agent] rewind state mismatch:", outcome.payload)
          clearAgentMessageRewindable(request.chatMessageId, {
            keepActiveRequest: true,
          })
          setError(t("agent.rewind.stateMismatch"))
          return
        }
        // status === "rewind_failed"
        const message = outcome.payload?.error ?? "Unknown rewind error"
        console.warn("[agent] rewind failed:", message)
        if (outcome.payload?.unavailableReason) {
          clearAgentMessageRewindable(request.chatMessageId, {
            keepActiveRequest: true,
          })
        }
        setError(message)
      })
      .catch((err: unknown) => {
        console.warn("[agent] rewind failed:", err)
        // A7 (pre-existing bug, now fixed): an unexpected throw (e.g. the
        // sidecar is already dead) must clear the target too, or the
        // button stays clickable and keeps failing forever.
        clearAgentMessageRewindable(request.chatMessageId, {
          keepActiveRequest: true,
        })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setPending(false)
      })
  }, [clearAgentMessageRewindable, clearAgentRewindRequest, pending, project?.path, request])

  const retryPersist = useCallback(() => {
    if (!project?.path || retrying) return
    setRetrying(true)
    void retryAgentRewindPersistence(project.path)
      .then((outcome) => {
        if (outcome.ok) {
          setPersistError(null)
          clearAgentRewindRequest()
          return
        }
        setPersistError(outcome.error ?? "Unknown save error")
      })
      .finally(() => {
        setRetrying(false)
      })
  }, [clearAgentRewindRequest, project?.path, retrying])

  const blocked = gate !== null && !gate.allowed

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => {
      if (!open) clearAgentRewindRequest()
    }}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-amber-500" />
            {t("agent.rewind.title")}
          </DialogTitle>
          <DialogDescription>
            {blocked && gate && !gate.allowed
              ? t(gateBlockedI18nKey(gate.reason))
              : t("agent.rewind.description")}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {t("agent.rewind.failed", { error })}
          </div>
        ) : null}
        {persistError ? (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <span>{t("agent.rewind.persistWarning", { error: persistError })}</span>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={retryPersist}
              disabled={retrying}
            >
              {t("agent.rewind.retryPersist")}
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={clearAgentRewindRequest} disabled={pending}>
            {t("agent.rewind.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={pending || blocked || Boolean(persistError)}
          >
            {t("agent.rewind.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
