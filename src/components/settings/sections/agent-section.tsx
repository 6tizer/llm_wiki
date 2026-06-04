import { Bot } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  projectReady: boolean
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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
          <Label htmlFor="agent-max-turns">
            {t("settings.sections.agent.maxTurns")}
          </Label>
          <Input
            id="agent-max-turns"
            type="number"
            min={1}
            max={200}
            value={draft.agentMaxTurns}
            onChange={(event) =>
              setDraft(
                "agentMaxTurns",
                parsePositiveInteger(event.target.value, draft.agentMaxTurns),
              )
            }
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.sections.agent.maxTurnsHint")}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="agent-max-files-changed">
            {t("settings.sections.agent.maxFilesChanged")}
          </Label>
          <Input
            id="agent-max-files-changed"
            type="number"
            min={1}
            max={200}
            value={draft.agentMaxFilesChanged}
            onChange={(event) =>
              setDraft(
                "agentMaxFilesChanged",
                parsePositiveInteger(
                  event.target.value,
                  draft.agentMaxFilesChanged,
                ),
              )
            }
            disabled={disabled}
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
            max={10240}
            value={draft.agentMaxWriteKiB}
            onChange={(event) =>
              setDraft(
                "agentMaxWriteKiB",
                parsePositiveInteger(event.target.value, draft.agentMaxWriteKiB),
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
