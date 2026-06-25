import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { Minus, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, ZOOM_STEP, clampZoomLevel, roundZoomLevel } from "@/stores/zoom-store"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const UI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
]

const THEMES = [
  { value: "system", labelKey: "settings.sections.interface.themeSystem" },
  { value: "light", labelKey: "settings.sections.interface.themeLight" },
  { value: "dark", labelKey: "settings.sections.interface.themeDark" },
] as const

/** Parse a zoom percent input and fall back to the current level when invalid. */
export function parseZoomPercentInput(
  inputText: string,
  fallbackLevel: number,
): number {
  const raw = inputText.replace(/[^0-9.]/g, "")
  const parsed = Number.parseFloat(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    return clampZoomLevel(parsed / 100)
  }
  return fallbackLevel
}

export function InterfaceSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const level = draft.zoomLevel
  const [inputText, setInputText] = useState(String(Math.round(level * 100)))

  useEffect(() => {
    setInputText(String(Math.round(level * 100)))
  }, [level])

  const handleZoom = (next: number) => {
    setDraft("zoomLevel", clampZoomLevel(roundZoomLevel(next)))
  }

  const commitInput = () => {
    const nextLevel = parseZoomPercentInput(inputText, level)
    if (nextLevel !== level) {
      setDraft("zoomLevel", nextLevel)
      return
    }
    setInputText(String(Math.round(level * 100)))
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.interface.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.interface.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.uiLanguage")}</Label>
        <div className="flex flex-wrap gap-2">
          {UI_LANGUAGES.map((l) => {
            const active = draft.uiLanguage === l.value
            return (
              <button
                key={l.value}
                type="button"
                aria-pressed={active}
                onClick={() => setDraft("uiLanguage", l.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {l.label}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.uiLanguageHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.theme")}</Label>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((theme) => {
            const active = draft.theme === theme.value
            return (
              <button
                key={theme.value}
                type="button"
                aria-pressed={active}
                onClick={() => setDraft("theme", theme.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {t(theme.labelKey)}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.themeHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.interface.zoom")}</Label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleZoom(level - ZOOM_STEP)}
            disabled={level <= MIN_ZOOM_LEVEL}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
            aria-label={t("settings.sections.interface.zoomOut")}
          >
            <Minus className="size-3.5" />
          </button>
          <div className="relative max-w-[70px] flex-1">
            <input
              type="text"
              inputMode="decimal"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onBlur={commitInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitInput()
              }}
              className="w-full rounded-md bg-muted py-1 pl-1 pr-3 text-center text-sm font-semibold tabular-nums text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              %
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleZoom(level + ZOOM_STEP)}
            disabled={level >= MAX_ZOOM_LEVEL}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30"
            aria-label={t("settings.sections.interface.zoomIn")}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.interface.zoomHint")}
        </p>
      </div>
    </div>
  )
}
