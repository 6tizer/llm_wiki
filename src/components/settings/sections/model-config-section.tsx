import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { ModelProfilesSection } from "./model-profiles-section"
import { FallbackPolicySection } from "./fallback-policy-section"
import { ProviderMigrationBanner } from "./provider-migration-banner"
import { TaskMatrixSection } from "./task-matrix-section"
import { WebSearchSection } from "./web-search-section"

type ModelConfigTab = "sources" | "profiles" | "taskMatrix" | "fallback"

const MODEL_CONFIG_TABS: Array<{ id: ModelConfigTab; labelKey: string }> = [
  { id: "sources", labelKey: "settings.sections.modelConfig.tabs.sources" },
  { id: "profiles", labelKey: "settings.sections.modelConfig.tabs.profiles" },
  { id: "taskMatrix", labelKey: "settings.sections.modelConfig.tabs.taskMatrix" },
  { id: "fallback", labelKey: "settings.sections.modelConfig.tabs.fallback" },
]

export function ModelConfigSection() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ModelConfigTab>("profiles")
  const [profilesRefreshToken, setProfilesRefreshToken] = useState(0)
  const bumpProfilesRefreshToken = useCallback(() => {
    setProfilesRefreshToken((current) => current + 1)
  }, [])

  return (
    <div className="space-y-8" data-testid="model-config-section">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.modelConfig.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.modelConfig.description")}
        </p>
      </div>

      <ProviderMigrationBanner onMigrated={bumpProfilesRefreshToken} />

      <div className="space-y-6">
        <nav aria-label={t("settings.sections.modelConfig.tabs.navLabel")} className="flex flex-wrap gap-1 border-b">
          {MODEL_CONFIG_TABS.map(({ id, labelKey }) => (
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
              data-testid={`model-config-tab-${id}`}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>

        {activeTab === "sources" && <WebSearchSection />}

        {activeTab === "profiles" && (
          <ModelProfilesSection
            refreshToken={profilesRefreshToken}
            onProfilesChanged={bumpProfilesRefreshToken}
          />
        )}

        {activeTab === "taskMatrix" && (
          <TaskMatrixSection
            refreshToken={profilesRefreshToken}
            onProfilesChanged={bumpProfilesRefreshToken}
          />
        )}

        {activeTab === "fallback" && (
          <FallbackPolicySection refreshToken={profilesRefreshToken} />
        )}
      </div>
    </div>
  )
}
