import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import type { CategoryId } from "../settings-view"
import { LlmProviderSection } from "./llm-provider-section"
import { ModelProfilesSection } from "./model-profiles-section"
import { TaskMatrixSection } from "./task-matrix-section"
import { WebSearchSection } from "./web-search-section"

interface Props {
  onNavigateToCategory?: (category: CategoryId) => void
}

export function ModelConfigSection({ onNavigateToCategory }: Props) {
  const { t } = useTranslation()
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

      <section className="space-y-4" aria-labelledby="settings-model-config-connections">
        <h3 id="settings-model-config-connections" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.modelConfig.connections")}
        </h3>
        <LlmProviderSection onMigrated={bumpProfilesRefreshToken} />
        <WebSearchSection />
      </section>

      <section className="space-y-4 border-t pt-8" aria-labelledby="settings-model-config-profiles">
        <h3 id="settings-model-config-profiles" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.modelConfig.profiles")}
        </h3>
        <ModelProfilesSection
          refreshToken={profilesRefreshToken}
          onProfilesChanged={bumpProfilesRefreshToken}
        />
      </section>

      <section className="space-y-4 border-t pt-8" aria-labelledby="settings-model-config-task-matrix">
        <h3 id="settings-model-config-task-matrix" className="text-sm font-semibold text-muted-foreground">
          {t("settings.sections.modelConfig.taskMatrixHeading")}
        </h3>
        {/* Scope note: this matrix edits profile taskFamilies only. Runtime
            task routing is handled here; permission-default UI lives in
            AgentSection's application group. Dedicated embedding/multimodal
            pages remain separate surfaces. */}
        <TaskMatrixSection
          onNavigateToCategory={onNavigateToCategory}
          refreshToken={profilesRefreshToken}
          onProfilesChanged={bumpProfilesRefreshToken}
        />
      </section>
    </div>
  )
}
