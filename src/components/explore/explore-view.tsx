import { useEffect, useState } from "react"
import { Globe, Network, Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"
import { ResearchPanel } from "@/components/layout/research-panel"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ExploreTab } from "@/stores/wiki-store"

const TABS: Array<{ id: ExploreTab; labelKey: string; icon: typeof Search }> = [
  { id: "graph", labelKey: "explore.tabs.graph", icon: Network },
  { id: "search", labelKey: "explore.tabs.search", icon: Search },
  { id: "research", labelKey: "explore.tabs.research", icon: Globe },
]

export function ExploreView() {
  const { t } = useTranslation()
  const projectPath = useWikiStore((s) => s.project?.path)
  const pendingExploreTab = useWikiStore((s) => s.pendingExploreTab)
  const setPendingExploreTab = useWikiStore((s) => s.setPendingExploreTab)
  // Primitive selector result; O(tasks) per store tick is acceptable for current queue sizes.
  const researchActiveCount = useResearchStore((s) =>
    projectPath ? s.getActiveResearchCount(projectPath) : 0
  )
  const [activeTab, setActiveTab] = useState<ExploreTab>("graph")

  useEffect(() => {
    if (!pendingExploreTab) return
    setActiveTab(pendingExploreTab)
    setPendingExploreTab(null)
  }, [pendingExploreTab, setPendingExploreTab])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="explore-view">
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-2">
        <nav aria-label={t("explore.navLabel")} className="flex gap-1">
          {TABS.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={t(labelKey)}
              aria-current={activeTab === id ? "page" : undefined}
              onClick={() => setActiveTab(id)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm transition-colors ${
                activeTab === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
              data-testid={`explore-tab-${id}`}
            >
              <Icon className="h-4 w-4" />
              <span>{t(labelKey)}</span>
              {id === "research" && researchActiveCount > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                  {researchActiveCount > 99 ? "99+" : researchActiveCount}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "search" && <SearchView />}
        {activeTab === "graph" && <GraphView />}
        {activeTab === "research" && <ResearchPanel />}
      </div>
    </div>
  )
}
