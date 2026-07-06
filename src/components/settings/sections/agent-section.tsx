import { Bot, Check } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { AgentPermissionPolicy } from "@/lib/agent/agent-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  projectReady: boolean
}

const MAX_TURNS = 200
const MAX_FILES_CHANGED = 200
const MAX_WRITE_KIB = 10240
const AGENT_PERMISSION_POLICIES: AgentPermissionPolicy[] = [
  "default",
  "restricted",
  "bypassPermissions",
]

function parseBoundedInteger(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function AgentSection({ draft, setDraft, projectReady }: Props) {
  const { t } = useTranslation()
  const disabled = !projectReady

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.agent.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.agent.description")}
        </p>
      </div>

      {!projectReady && (
        <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Bot className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("settings.sections.agent.noProject")}</span>
        </div>
      )}

      <div className="grid gap-4">
        <div className="space-y-2">
          <Label>{t("settings.sections.agent.defaultPermissionPolicy")}</Label>
          <div
            role="radiogroup"
            aria-label={t("settings.sections.agent.defaultPermissionPolicy")}
            className="grid gap-2 sm:grid-cols-3"
          >
            {AGENT_PERMISSION_POLICIES.map((policy) => {
              const selected = draft.agentDefaultPermissionPolicy === policy
              return (
                <Button
                  key={policy}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  role="radio"
                  aria-checked={selected}
                  data-testid={`agent-policy-${policy}`}
                  className="h-auto min-h-20 items-start justify-between whitespace-normal px-3 py-2 text-left"
                  onClick={() => setDraft("agentDefaultPermissionPolicy", policy)}
                  disabled={disabled}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {t(`chat.agentRouting.policyOptions.${policy}.label`)}
                    </span>
                    <span className="mt-1 block text-xs font-normal leading-5 opacity-80">
                      {t(`chat.agentRouting.policyOptions.${policy}.description`)}
                    </span>
                  </span>
                  {selected && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
                </Button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agent.defaultPermissionPolicyHint")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="agent-max-turns">
            {t("settings.sections.agent.maxTurns")}
          </Label>
          <Input
            id="agent-max-turns"
            type="number"
            min={1}
            max={MAX_TURNS}
            value={draft.agentMaxTurns}
            onChange={(event) =>
              setDraft(
                "agentMaxTurns",
                parseBoundedInteger(event.target.value, draft.agentMaxTurns, 1, MAX_TURNS),
              )
            }
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agent.maxTurnsHint")}
          </p>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
						data-testid="agent-max-files-changed-enabled"
              checked={draft.agentMaxFilesChangedEnabled}
              onChange={(event) => setDraft("agentMaxFilesChangedEnabled", event.target.checked)}
              className="h-3.5 w-3.5"
              disabled={disabled}
            />
            {t("settings.sections.agent.maxFilesChangedEnabled")}
          </label>
          <Label htmlFor="agent-max-files-changed">
            {t("settings.sections.agent.maxFilesChanged")}
          </Label>
          <Input
            id="agent-max-files-changed"
            type="number"
            min={1}
            max={MAX_FILES_CHANGED}
            value={draft.agentMaxFilesChanged}
            onChange={(event) =>
              setDraft(
                "agentMaxFilesChanged",
                parseBoundedInteger(
                  event.target.value,
                  draft.agentMaxFilesChanged,
                  1,
                  MAX_FILES_CHANGED,
                ),
              )
            }
            disabled={disabled || !draft.agentMaxFilesChangedEnabled}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agent.maxFilesChangedHint")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="agent-max-write-kib">
            {t("settings.sections.agent.maxWriteKiB")}
          </Label>
          <Input
            id="agent-max-write-kib"
            type="number"
            min={1}
            max={MAX_WRITE_KIB}
            value={draft.agentMaxWriteKiB}
            onChange={(event) =>
              setDraft(
                "agentMaxWriteKiB",
                parseBoundedInteger(event.target.value, draft.agentMaxWriteKiB, 1, MAX_WRITE_KIB),
              )
            }
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agent.maxWriteKiBHint")}
          </p>
        </div>
      </div>
    </div>
  )
}
