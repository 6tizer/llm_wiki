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

const MAX_TURNS = 200
const MAX_FILES_CHANGED = 200
const MAX_WRITE_KIB = 10240

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
