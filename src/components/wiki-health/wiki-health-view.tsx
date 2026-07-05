import { Activity, ClipboardCheck, Wrench } from "lucide-react"
import { useTranslation } from "react-i18next"
import { DerivedStatusSection } from "@/components/settings/sections/derived-status-section"
import { IndexOverviewSection } from "@/components/settings/sections/index-overview-section"
import { MaintenanceSection } from "@/components/settings/sections/maintenance-section"
import { SynthesisSection } from "@/components/settings/sections/synthesis-section"
import { TagTaxonomySection } from "@/components/settings/sections/tag-taxonomy-section"
import { LintView } from "@/components/lint/lint-view"
import { ReviewView } from "@/components/review/review-view"
import { useWikiStore } from "@/stores/wiki-store"

export function WikiHealthView() {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const navigateToAction = (target: "synthesis" | "index-overview") => {
    document.getElementById(`wiki-health-action-${target}`)?.scrollIntoView({ block: "start" })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="wiki-health-view">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-5">
        <section className="space-y-4" aria-labelledby="wiki-health-overview">
          <SectionHeading
            id="wiki-health-overview"
            icon={Activity}
            title={t("wikiHealth.sections.overview")}
          />
          <DerivedStatusSection project={project} onNavigate={navigateToAction} />
        </section>

        <section className="space-y-4" aria-labelledby="wiki-health-todo">
          <SectionHeading
            id="wiki-health-todo"
            icon={ClipboardCheck}
            title={t("wikiHealth.sections.todo")}
          />
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="min-h-[480px] overflow-hidden rounded-md border border-border/70">
              <LintView />
            </div>
            <div className="min-h-[480px] overflow-hidden rounded-md border border-border/70">
              <ReviewView />
            </div>
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="wiki-health-actions">
          <SectionHeading
            id="wiki-health-actions"
            icon={Wrench}
            title={t("wikiHealth.sections.actions")}
          />
          <div className="space-y-8">
            <TagTaxonomySection project={project} />
            <div id="wiki-health-action-synthesis" className="scroll-mt-4">
              <SynthesisSection project={project} />
            </div>
            <div id="wiki-health-action-index-overview" className="scroll-mt-4">
              <IndexOverviewSection project={project} />
            </div>
            <MaintenanceSection />
          </div>
        </section>
      </div>
    </div>
  )
}

function SectionHeading({
  id,
  icon: Icon,
  title,
}: {
  id: string
  icon: typeof Activity
  title: string
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
    </div>
  )
}
