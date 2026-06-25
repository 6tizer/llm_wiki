import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CloudUpload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { MINERU_DEFAULT_API_BASE, testMineruConnection } from "@/lib/mineru"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type TestState = "idle" | "running" | "success" | "failed"

export function MineruSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [testState, setTestState] = useState<TestState>("idle")
  const [testError, setTestError] = useState("")

  const handleTest = async () => {
    if (!draft.mineruToken.trim()) return
    setTestState("running")
    setTestError("")
    try {
      await testMineruConnection({
        enabled: true,
        token: draft.mineruToken.trim(),
        modelVersion: draft.mineruModelVersion,
        apiBaseUrl: draft.mineruApiBaseUrl.trim(),
      })
      setTestState("success")
    } catch (err) {
      setTestState("failed")
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.mineru.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.mineru.description")}
        </p>
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t("settings.sections.mineru.privacyNotice")}
        </p>
      </div>

      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          draft.mineruEnabled
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.mineru.enableLabel")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.mineru.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("mineruEnabled", !draft.mineruEnabled)}
          role="switch"
          aria-checked={draft.mineruEnabled}
          aria-label={t("settings.sections.mineru.enableLabel")}
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`text-xs font-semibold ${
              draft.mineruEnabled ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {draft.mineruEnabled
              ? t("settings.sections.mineru.stateOn")
              : t("settings.sections.mineru.stateOff")}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              draft.mineruEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                draft.mineruEnabled ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {draft.mineruEnabled && (
        <div className="space-y-4 rounded-md border p-3">
          <div className="space-y-2">
            <Label htmlFor="mineru-token">
              {t("settings.sections.mineru.token")}
            </Label>
            <Input
              id="mineru-token"
              type="password"
              value={draft.mineruToken}
              onChange={(e) => {
                setDraft("mineruToken", e.target.value)
                setTestState("idle")
              }}
              placeholder={t("settings.sections.mineru.tokenPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="mineru-model">
              {t("settings.sections.mineru.model")}
            </Label>
            <select
              id="mineru-model"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={draft.mineruModelVersion}
              onChange={(e) =>
                setDraft(
                  "mineruModelVersion",
                  e.target.value as SettingsDraft["mineruModelVersion"],
                )
              }
            >
              <option value="vlm">{t("settings.sections.mineru.modelVlm")}</option>
              <option value="pipeline">{t("settings.sections.mineru.modelPipeline")}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.mineru.modelHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="mineru-api-base">
              {t("settings.sections.mineru.apiBaseUrl")}
            </Label>
            <Input
              id="mineru-api-base"
              value={draft.mineruApiBaseUrl}
              onChange={(e) => setDraft("mineruApiBaseUrl", e.target.value)}
              placeholder={MINERU_DEFAULT_API_BASE}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.mineru.apiBaseUrlHint")}
            </p>
          </div>

          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t("settings.sections.mineru.testQuotaNotice")}
          </p>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={!draft.mineruToken.trim() || testState === "running"}
            >
              <CloudUpload className="mr-2 h-4 w-4" />
              {testState === "running"
                ? t("settings.sections.mineru.testing")
                : t("settings.sections.mineru.test")}
            </Button>
            {testState === "success" && (
              <span className="text-sm text-green-600">
                {t("settings.sections.mineru.testSuccess")}
              </span>
            )}
            {testState === "failed" && (
              <span className="text-sm text-red-600">
                {t("settings.sections.mineru.testFailed")}: {testError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
