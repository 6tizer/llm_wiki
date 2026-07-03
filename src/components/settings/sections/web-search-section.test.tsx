// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { saveSearchApiConfig } from "@/lib/project-store"
import { WebSearchSection } from "./web-search-section"

vi.mock("@/lib/project-store", () => ({
  saveSearchApiConfig: vi.fn(async () => undefined),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<WebSearchSection />)
  })

  return { container, root }
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

// The AnyTXT card renders its own "Activate"/"Deactivate" toggle above
// the web-provider list and shares the exact same aria-label, so a bare
// `button[aria-label="Activate"]` query would grab that one instead.
// Scope the lookup to the provider row identified by its visible label.
function findProviderToggle(container: HTMLDivElement, label: string): Element {
  const labelSpan = Array.from(container.querySelectorAll("span")).find(
    (el) => el.textContent === label,
  )
  const row = labelSpan?.closest(".rounded-lg")
  const toggle = row?.querySelector('button[aria-label="Activate"], button[aria-label="Deactivate"]')
  if (!toggle) throw new Error(`toggle button for provider "${label}" not found`)
  return toggle
}

const defaultSearchApiConfig = {
  provider: "none" as const,
  apiKey: "",
  serpApiEngine: "google",
  searXngUrl: "",
  searXngCategories: ["general"],
  providerConfigs: {},
  deepResearchSource: "web" as const,
}

describe("WebSearchSection", () => {
  beforeEach(() => {
    useWikiStore.setState({
      searchApiConfig: { ...defaultSearchApiConfig } as never,
    })
    vi.mocked(saveSearchApiConfig).mockReset().mockResolvedValue(undefined)
  })

  it("shows a save-failed badge and reverts the provider toggle when persisting fails", async () => {
    vi.mocked(saveSearchApiConfig).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    const toggle = findProviderToggle(container, "Ollama")

    await click(toggle)

    expect(useWikiStore.getState().searchApiConfig.provider).toBe("none")
    expect(container.textContent).toContain("Save failed")

    unmount(root)
  })

  it("keeps the provider toggle applied when persisting succeeds", async () => {
    const { container, root } = renderSection()
    const toggle = findProviderToggle(container, "Ollama")

    await click(toggle)

    expect(useWikiStore.getState().searchApiConfig.provider).toBe("ollama")
    expect(container.textContent).not.toContain("Save failed")

    unmount(root)
  })
})
