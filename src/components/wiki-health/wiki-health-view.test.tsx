// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { WikiHealthView } from "./wiki-health-view"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@/components/settings/sections/derived-status-section", () => ({
  DerivedStatusSection: ({ onNavigate }: { onNavigate?: (target: "synthesis" | "index-overview") => void }) => (
    <div data-testid="derived-status-section">
      <button type="button" onClick={() => onNavigate?.("synthesis")}>go synthesis</button>
    </div>
  ),
}))
vi.mock("@/components/lint/lint-view", () => ({ LintView: () => <div data-testid="lint-view" /> }))
vi.mock("@/components/review/review-view", () => ({ ReviewView: () => <div data-testid="review-view" /> }))
vi.mock("@/components/settings/sections/tag-taxonomy-section", () => ({ TagTaxonomySection: () => <div data-testid="taxonomy-section" /> }))
vi.mock("@/components/settings/sections/synthesis-section", () => ({ SynthesisSection: () => <div data-testid="synthesis-section" /> }))
vi.mock("@/components/settings/sections/index-overview-section", () => ({ IndexOverviewSection: () => <div data-testid="index-overview-section" /> }))
vi.mock("@/components/settings/sections/maintenance-section", () => ({ MaintenanceSection: () => <div data-testid="maintenance-section" /> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderWikiHealthView(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<WikiHealthView />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  useWikiStore.setState({ project: { id: "p1", name: "Project", path: "/project" } })
})

afterEach(() => {
  useWikiStore.setState({ project: null })
  document.body.innerHTML = ""
})

describe("WikiHealthView", () => {
  it("renders overview, to-do, and action workbenches", () => {
    const { container, root } = renderWikiHealthView()

    for (const testId of [
      "wiki-health-view",
      "derived-status-section",
      "lint-view",
      "review-view",
      "taxonomy-section",
      "synthesis-section",
      "index-overview-section",
      "maintenance-section",
    ]) {
      expect(container.querySelector(`[data-testid='${testId}']`)).not.toBeNull()
    }

    unmount(root)
  })
})
