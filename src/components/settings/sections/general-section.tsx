import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const CLOSE_BEHAVIORS = [
  { value: "hide", labelKey: "settings.sections.general.closeBehaviorHide" },
  { value: "quit", labelKey: "settings.sections.general.closeBehaviorQuit" },
] as const

export function GeneralSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.general.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.general.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.general.closeBehavior")}</Label>
        <div className="flex flex-wrap gap-2">
          {CLOSE_BEHAVIORS.map((behavior) => {
            const active = draft.closeBehavior === behavior.value
            return (
              <button
                key={behavior.value}
                type="button"
                onClick={() => setDraft("closeBehavior", behavior.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {t(behavior.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.general.closeBehaviorHint")}
        </p>
      </div>
    </div>
  )
}
