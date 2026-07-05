// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import "@/i18n"
import { ResearchPanel } from "./research-panel"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderResearchPanel(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ResearchPanel />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  useResearchStore.setState({ tasks: [], maxConcurrent: 3 })
  useWikiStore.setState({ project: { id: "p1", name: "Project", path: "/project" } })
})

afterEach(() => {
  useResearchStore.setState({ tasks: [] })
  useWikiStore.setState({ project: null })
  document.body.innerHTML = ""
})

describe("ResearchPanel", () => {
  it("does not render a close button in the main research view", () => {
    const { container, root } = renderResearchPanel()

    const buttons = Array.from(container.querySelectorAll("button"))
    expect(buttons).toHaveLength(1)
    expect(buttons[0].getAttribute("disabled")).not.toBeNull()

    unmount(root)
  })
})
