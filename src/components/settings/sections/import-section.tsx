import { useState } from "react"
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

type ImportTab = "sourceWatch" | "scheduledImport" | "mineru"

const IMPORT_TABS: Array<{ id: ImportTab; labelKey: string }> = [
  { id: "sourceWatch", labelKey: "settings.sections.import.sourceWatch" },
  { id: "scheduledImport", labelKey: "settings.sections.import.scheduledImport" },
  { id: "mineru", labelKey: "settings.sections.import.mineru" },
]

export function ImportSection({ draft, setDraft, projectReady }: Props) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ImportTab>("sourceWatch")

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.import.title")}
        </h2>
      </div>

      <nav aria-label={t("settings.sections.import.tabs.navLabel")} className="flex flex-wrap gap-1 border-b">
        {IMPORT_TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            aria-current={activeTab === id ? "page" : undefined}
            onClick={() => setActiveTab(id)}
            className={`inline-flex h-9 items-center rounded-t-md px-3 text-sm transition-colors ${
              activeTab === id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
            data-testid={`import-tab-${id}`}
          >
            {t(labelKey)}
          </button>
        ))}
      </nav>

      {activeTab === "sourceWatch" && (
        <section className="space-y-4" aria-labelledby="settings-import-source-watch">
          <h3 id="settings-import-source-watch" className="text-sm font-semibold text-muted-foreground">
            {t("settings.sections.import.sourceWatch")}
          </h3>
          <SourceWatchSection draft={draft} setDraft={setDraft} projectReady={projectReady} />
        </section>
      )}

      {activeTab === "scheduledImport" && (
        <section className="space-y-4" aria-labelledby="settings-import-scheduled-import">
          <h3 id="settings-import-scheduled-import" className="text-sm font-semibold text-muted-foreground">
            {t("settings.sections.import.scheduledImport")}
          </h3>
          <ScheduledImportSection draft={draft} setDraft={setDraft} />
        </section>
      )}

      {activeTab === "mineru" && (
        <section className="space-y-4" aria-labelledby="settings-import-mineru">
          <h3 id="settings-import-mineru" className="text-sm font-semibold text-muted-foreground">
            {t("settings.sections.import.mineru")}
          </h3>
          <MineruSection draft={draft} setDraft={setDraft} />
        </section>
      )}
    </div>
  )
}
