// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { LlmProviderSection } from "./llm-provider-section"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<LlmProviderSection />)
  })

  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("LlmProviderSection", () => {
  beforeEach(() => {
    useWikiStore.setState({
      providerConfigs: {},
      activePresetId: null,
    })
  })

  it("does not render the runtime model profiles entry inside the LLM settings section", () => {
    const { container, root } = renderSection()

    expect(container.textContent).toContain("LLM Models")
    expect(container.textContent).not.toContain("New profile")
    expect(container.textContent).not.toContain("Display name")

    unmount(root)
  })
})
