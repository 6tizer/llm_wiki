// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { SidebarPanel } from "./sidebar-panel"

vi.mock("./knowledge-tree", () => ({
  KnowledgeTree: () => <div data-testid="knowledge-tree" />,
}))
vi.mock("./file-tree", () => ({
  FileTree: () => <div data-testid="file-tree" />,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSidebarPanel(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<SidebarPanel />)
  })
  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text)
  if (!button) throw new Error(`button not found: ${text}`)
  return button
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("SidebarPanel", () => {
  it("switches between knowledge and file tabs", () => {
    const { container, root } = renderSidebarPanel()
    const knowledgeButton = buttonByText(container, "Knowledge")
    const filesButton = buttonByText(container, "Files")

    expect(container.querySelector("[data-testid='knowledge-tree']")).not.toBeNull()
    expect(container.querySelector("[data-testid='file-tree']")).toBeNull()
    expect(knowledgeButton.className).toContain("border-b-2")
    expect(filesButton.className).not.toContain("border-b-2")

    act(() => {
      filesButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector("[data-testid='knowledge-tree']")).toBeNull()
    expect(container.querySelector("[data-testid='file-tree']")).not.toBeNull()
    expect(knowledgeButton.className).not.toContain("border-b-2")
    expect(filesButton.className).toContain("border-b-2")

    act(() => {
      knowledgeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    expect(container.querySelector("[data-testid='knowledge-tree']")).not.toBeNull()
    expect(container.querySelector("[data-testid='file-tree']")).toBeNull()
    expect(knowledgeButton.className).toContain("border-b-2")
    expect(filesButton.className).not.toContain("border-b-2")

    unmount(root)
  })
})
