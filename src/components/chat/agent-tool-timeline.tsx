import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  ShieldCheck,
  ShieldX,
  Wrench,
  XCircle,
} from "lucide-react"
import type {
  AgentPermissionEventDecision,
  AgentPermissionEventRecord,
  AgentProgressSummaryRecord,
  AgentToolCallRecord,
  DisplayMessage,
} from "@/stores/chat-store"
import { formatDurationMs, getAgentToolStatus, safeStringify, type AgentToolStatus } from "./agent-format"

interface AgentToolTimelineProps {
  toolCalls: AgentToolCallRecord[]
  progressSummaries?: AgentProgressSummaryRecord[]
  permissionEvents?: AgentPermissionEventRecord[]
  rewindUnavailableReason?: DisplayMessage["agentRewindUnavailableReason"]
  defaultCollapsed?: boolean
}

const STATUS_CLASS: Record<AgentToolStatus, string> = {
  pending: "text-muted-foreground bg-muted",
  running: "text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/40",
  done: "text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/40",
  failed: "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-950/40",
}

function StatusIcon({ status }: { status: AgentToolStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" />
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5" />
  if (status === "failed") return <XCircle className="h-3.5 w-3.5" />
  return <Wrench className="h-3.5 w-3.5" />
}

function formatTimelineTime(timestamp?: number): string {
  if (timestamp === undefined) return ""
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function isAllowDecision(decision: AgentPermissionEventDecision): boolean {
  return decision === "allow_temporary" || decision === "allow_permanent"
}

function shouldShowPermissionPolicy(
  policy: AgentPermissionEventRecord["permissionPolicy"],
): policy is Exclude<AgentPermissionEventRecord["permissionPolicy"], "default" | undefined> {
  return policy !== undefined && policy !== "default"
}

export function AgentToolTimeline({
  toolCalls,
  progressSummaries = [],
  permissionEvents = [],
  rewindUnavailableReason,
  defaultCollapsed = true,
}: AgentToolTimelineProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const hasStatusRows =
    progressSummaries.length > 0 ||
    permissionEvents.length > 0 ||
    Boolean(rewindUnavailableReason)
  if (toolCalls.length === 0 && !hasStatusRows) return null

  const failed = toolCalls.filter((call) => getAgentToolStatus(call) === "failed").length
  const running = toolCalls.filter((call) => getAgentToolStatus(call) === "running").length
  const totalEvents = toolCalls.length + progressSummaries.length + permissionEvents.length + (rewindUnavailableReason ? 1 : 0)

  return (
    <div className="rounded-md border border-border/60 bg-background/70 text-xs">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? t("agent.actions.expand") : t("agent.actions.collapse")}
        aria-label={collapsed ? t("agent.actions.expand") : t("agent.actions.collapse")}
        className="flex w-full min-w-0 flex-wrap items-center gap-1.5 px-2.5 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <Wrench className="h-3.5 w-3.5" />
        <span className="min-w-0 font-medium">{t("agent.timeline.title")}</span>
        <span className="ml-auto min-w-0 text-right text-[10px]">
          {totalEvents}
          {running > 0 ? ` / ${t("agent.status.running")}: ${running}` : ""}
          {failed > 0 ? ` / ${t("agent.status.failed")}: ${failed}` : ""}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-1.5 px-2.5 pb-2">
          {toolCalls.map((call, index) => {
            const status = getAgentToolStatus(call)
            const hasDetails = call.inputPreview !== undefined || call.error
            return (
              <div key={`${call.toolUseId ?? call.toolName}-${index}`} className="min-w-0 rounded border border-border/50 bg-muted/20 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[status]}`}>
                    <StatusIcon status={status} />
                    {t(`agent.status.${status}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{call.toolName}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatDurationMs(call.durationMs)}</span>
                </div>
                {hasDetails && (
                  <details className="mt-1.5" open={status === "running" || status === "failed"}>
                    <summary className="cursor-pointer text-[10px] text-muted-foreground">
                      {status === "failed" ? t("agent.timeline.error") : t("agent.timeline.input")}
                    </summary>
                    {call.error && (
                      <pre className="mt-1 max-h-28 max-w-full overflow-auto rounded bg-red-950/5 p-2 text-[10px] text-red-700 dark:text-red-300">
                        {call.error}
                      </pre>
                    )}
                    {call.inputPreview !== undefined && (
                      <pre className="mt-1 max-h-36 max-w-full overflow-auto rounded bg-background/80 p-2 text-[10px] text-muted-foreground">
                        {safeStringify(call.inputPreview)}
                      </pre>
                    )}
                  </details>
                )}
              </div>
            )
          })}
          {progressSummaries.map((summary, index) => (
            <div key={`progress-${summary.timestamp}-${index}`} className="flex min-w-0 items-start gap-2 rounded border border-border/40 bg-muted/10 p-2 text-muted-foreground">
              <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <div className="min-w-0 flex-1">
                <div className="break-words text-foreground">{summary.text}</div>
                <div className="mt-0.5 text-[10px]">{t("agent.timeline.progress")}</div>
              </div>
              <span className="shrink-0 text-[10px]">{formatTimelineTime(summary.timestamp)}</span>
            </div>
          ))}
          {permissionEvents.map((event, index) => {
            const allowed = isAllowDecision(event.decision)
            const Icon = allowed ? ShieldCheck : ShieldX
            return (
              <div key={`permission-${event.timestamp}-${event.toolName}-${index}`} className="flex min-w-0 items-center gap-2 rounded border border-border/40 bg-muted/10 p-2 text-muted-foreground">
                <Icon className={`h-3.5 w-3.5 shrink-0 ${allowed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`} />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {t(`agent.timeline.permission.${event.decision}`, { toolName: event.toolName })}
                </span>
                {shouldShowPermissionPolicy(event.permissionPolicy) && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`chat.agentRouting.policyOptions.${event.permissionPolicy}.label`)}
                  </span>
                )}
                <span className="shrink-0 text-[10px]">{formatTimelineTime(event.timestamp)}</span>
              </div>
            )
          })}
          {rewindUnavailableReason && (
            <div className="flex min-w-0 items-start gap-2 rounded border border-border/40 bg-muted/10 p-2 text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words text-foreground">
                {t(`agent.timeline.rewindUnavailable.${rewindUnavailableReason}`)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
