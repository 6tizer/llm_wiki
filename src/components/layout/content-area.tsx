import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { SourcesView } from "@/components/sources/sources-view"
import { ExploreView } from "@/components/explore/explore-view"
import { WikiHealthView } from "@/components/wiki-health/wiki-health-view"
import { ResearchPanel } from "./research-panel"

function assertNever(value: never): never {
  throw new Error(`Unhandled active view: ${String(value)}`)
}

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  switch (activeView) {
    case "wiki":
      return <ChatPanel />
    case "settings":
      return <SettingsView />
    case "sources":
      return <SourcesView />
    case "explore":
      return <ExploreView />
    case "wiki-health":
      return <WikiHealthView />
    case "research":
      return (
        <div className="h-full min-h-0">
          <ResearchPanel />
        </div>
      )
    default:
      return assertNever(activeView)
  }
}
