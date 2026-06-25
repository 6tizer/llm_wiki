import type { WikiState } from "@/stores/wiki-store"
import { isResearchPanelVisible, isStandaloneView } from "./research-panel-nav"

/** Compute which layout panels should be visible for the current app state. */
export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
  selectedFile: string | null,
  researchPanelOpen: boolean,
): { showLeftPanel: boolean; hasRightPanel: boolean } {
  const standalone = isStandaloneView(activeView)
  return {
    showLeftPanel: !standalone,
    hasRightPanel:
      !standalone &&
      (selectedFile !== null || isResearchPanelVisible(activeView, researchPanelOpen)),
  }
}
