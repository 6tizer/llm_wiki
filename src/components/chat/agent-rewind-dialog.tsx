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
import { rewindAgentFiles } from "@/lib/agent/agent-transport"
import { useChatStore } from "@/stores/chat-store"

export function AgentRewindDialogHost() {
  const { t } = useTranslation()
  const request = useChatStore((s) => s.activeAgentRewindRequest)
  const clearAgentRewindRequest = useChatStore((s) => s.clearAgentRewindRequest)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setError(null)
    setPending(false)
  }, [request])

  const confirm = useCallback(() => {
    if (!request || pending) return
    setPending(true)
    setError(null)
    void rewindAgentFiles(request.streamId, request.userMessageId)
      .then((payload) => {
        if (!payload.ok) {
          const message = payload.error ?? "Unknown rewind error"
          console.warn("[agent] rewind failed:", message)
          setError(message)
          return
        }
        clearAgentRewindRequest()
      })
      .catch((err: unknown) => {
        console.warn("[agent] rewind failed:", err)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setPending(false)
      })
  }, [clearAgentRewindRequest, pending, request])

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
            {t("agent.rewind.description")}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {t("agent.rewind.failed", { error })}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={clearAgentRewindRequest} disabled={pending}>
            {t("agent.rewind.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {t("agent.rewind.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
