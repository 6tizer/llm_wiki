import { useState } from "react"
import { Network, Search } from "lucide-react"
import { useTranslation } from "react-i18next"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"

type ExploreTab = "search" | "graph"

const TABS: Array<{ id: ExploreTab; labelKey: string; icon: typeof Search }> = [
  { id: "search", labelKey: "explore.tabs.search", icon: Search },
  { id: "graph", labelKey: "explore.tabs.graph", icon: Network },
]

export function ExploreView() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<ExploreTab>("search")

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
            </button>
          ))}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "search" ? <SearchView /> : <GraphView />}
      </div>
    </div>
  )
}
