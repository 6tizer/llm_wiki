// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ChatMessage } from "./chat-message"
import type { DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function assistantMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: "hello there",
    timestamp: 1,
    mode: "agent",
    ...overrides,
  } as DisplayMessage
}

function renderHovered(message: DisplayMessage): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ChatMessage message={message} />)
  })
  const bubble = container.querySelector("[data-message-id]") ?? container.firstElementChild
  act(() => {
    bubble?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    // React attaches enter/leave via mouseover/mouseout delegation.
    bubble?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
  })
  return { container, root }
}

describe("ChatMessage hover actions", () => {
  it("hides copy and save-to-wiki for agent error messages (content is empty by design)", () => {
    const { container, root } = renderHovered(
      assistantMessage({
        content: "",
        agentErrorKind: "model_not_found",
        agentErrorDetail: "raw CLI detail",
      }),
    )
    expect(container.textContent).not.toContain("Copy")
    expect(container.textContent).not.toContain("Save to Wiki")
    act(() => root.unmount())
  })

  it("keeps copy visible for normal agent messages on hover", () => {
    const { container, root } = renderHovered(assistantMessage())
    expect(container.textContent).toContain("Copy")
    act(() => root.unmount())
  })

  it("jumps to the newest matching agent-write review when a wiki change has no toolUseId", async () => {
    useWikiStore.setState({ activeView: "wiki", pendingWikiHealthTab: null })
    const originalRequestAnimationFrame = window.requestAnimationFrame
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)) as typeof window.requestAnimationFrame
    const older = document.createElement("div")
    older.dataset.agentWritePath = "wiki/page.md"
    older.dataset.agentWriteTimestamp = "1"
    older.scrollIntoView = vi.fn()
    const newer = document.createElement("div")
    newer.dataset.agentWritePath = "wiki/page.md"
    newer.dataset.agentWriteTimestamp = "3"
    newer.scrollIntoView = vi.fn()
    document.body.append(older, newer)

    const { container, root } = renderHovered(
      assistantMessage({
        wikiChanges: [{
          path: "wiki/page.md",
          operation: "update",
          timestamp: 2,
        }],
      }),
    )
    const reviewButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("审阅"),
    )
    if (!reviewButton) throw new Error("review button not found")

    await act(async () => {
      reviewButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(useWikiStore.getState().activeView).toBe("wiki-health")
    expect(useWikiStore.getState().pendingWikiHealthTab).toBe("review")
    expect(newer.scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    expect(older.scrollIntoView).not.toHaveBeenCalled()

    act(() => root.unmount())
    container.remove()
    older.remove()
    newer.remove()
    window.requestAnimationFrame = originalRequestAnimationFrame
  })
})
