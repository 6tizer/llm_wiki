// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useWikiStore, type WikiState } from "@/stores/wiki-store"
import { ContentArea } from "./content-area"

vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => <div data-testid="view-wiki" /> }))
vi.mock("@/components/sources/sources-view", () => ({ SourcesView: () => <div data-testid="view-sources" /> }))
vi.mock("@/components/settings/settings-view", () => ({ SettingsView: () => <div data-testid="view-settings" /> }))
vi.mock("@/components/explore/explore-view", () => ({ ExploreView: () => <div data-testid="view-explore" /> }))
vi.mock("@/components/wiki-health/wiki-health-view", () => ({ WikiHealthView: () => <div data-testid="view-wiki-health" /> }))
vi.mock("./research-panel", () => ({ ResearchPanel: () => <div data-testid="view-research" /> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderContentArea(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ContentArea />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

afterEach(() => {
  useWikiStore.setState({ activeView: "wiki" })
  document.body.innerHTML = ""
})

describe("ContentArea", () => {
  it.each([
    ["wiki", "view-wiki"],
    ["sources", "view-sources"],
    ["explore", "view-explore"],
    ["wiki-health", "view-wiki-health"],
    ["research", "view-research"],
    ["settings", "view-settings"],
  ] as Array<[WikiState["activeView"], string]>)("renders %s explicitly", (activeView, testId) => {
    useWikiStore.setState({ activeView })

    const { container, root } = renderContentArea()

    expect(container.querySelector(`[data-testid='${testId}']`)).not.toBeNull()
    unmount(root)
  })
})
