import type { WikiState } from "@/stores/wiki-store"

/** Return whether a view should occupy the work area without side panels. */
export function isStandaloneView(view: WikiState["activeView"]): boolean {
  return view === "settings"
}

/** Return whether the research panel should be rendered for the current view. */
export function isResearchPanelVisible(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): boolean {
  return researchPanelOpen && !isStandaloneView(activeView)
}

/** Compute the next nav state when the user clicks the research panel button. */
export function nextResearchPanelNavState(
  activeView: WikiState["activeView"],
  researchPanelOpen: boolean,
): { activeView: WikiState["activeView"]; researchPanelOpen: boolean } {
  if (isStandaloneView(activeView)) {
    return { activeView: "wiki", researchPanelOpen: true }
  }
  return { activeView, researchPanelOpen: !researchPanelOpen }
}
