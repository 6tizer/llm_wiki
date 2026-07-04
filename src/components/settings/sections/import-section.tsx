import { useTranslation } from "react-i18next"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import { MineruSection } from "./mineru-section"
import { ScheduledImportSection } from "./scheduled-import-section"
import { SourceWatchSection } from "./source-watch-section"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
  projectReady: boolean
}

export function ImportSection({ draft, setDraft, projectReady }: Props) {
  const { t } = useTranslation()

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.import.title")}
        </h2>
      </div>

      <section className="space-y-4" aria-labelledby="settings-import-source-watch">
        <h3 id="settings-import-source-watch" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.import.sourceWatch")}
        </h3>
        <SourceWatchSection draft={draft} setDraft={setDraft} projectReady={projectReady} />
      </section>

      <section className="space-y-4 border-t pt-8" aria-labelledby="settings-import-scheduled-import">
        <h3 id="settings-import-scheduled-import" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.import.scheduledImport")}
        </h3>
        <ScheduledImportSection draft={draft} setDraft={setDraft} />
      </section>

      <section className="space-y-4 border-t pt-8" aria-labelledby="settings-import-mineru">
        <h3 id="settings-import-mineru" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.import.mineru")}
        </h3>
        <MineruSection draft={draft} setDraft={setDraft} />
      </section>
    </div>
  )
}
