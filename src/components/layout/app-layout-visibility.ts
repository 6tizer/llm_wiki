import type { WikiState } from "@/stores/wiki-store"

function isStandaloneView(view: WikiState["activeView"]): boolean {
  return view === "settings"
}

/** Compute which layout panels should be visible for the current app state. */
export function getAppLayoutVisibility(
  activeView: WikiState["activeView"],
  selectedFile: string | null,
): { showLeftPanel: boolean; hasRightPanel: boolean } {
  const standalone = isStandaloneView(activeView)
  return {
    showLeftPanel: !standalone,
    hasRightPanel: !standalone && selectedFile !== null,
  }
}
