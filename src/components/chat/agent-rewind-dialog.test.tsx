// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

const runAgentRewindMock = vi.hoisted(() => vi.fn())
const retryAgentRewindPersistenceMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/agent/agent-rewind-orchestration", () => ({
  runAgentRewind: runAgentRewindMock,
  retryAgentRewindPersistence: retryAgentRewindPersistenceMock,
}))

import { AgentRewindDialogHost } from "./agent-rewind-dialog"
import { useChatStore, type AgentRewindRequestRecord, type DisplayMessage } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function makeTarget(): AgentRewindRequestRecord {
  return {
    chatMessageId: "m1",
    conversationId: "conv-1",
    streamId: "stream-1",
    agentSessionId: "session-1",
    userMessageId: "user-uuid-1",
    assistantMessageId: "assistant-uuid-1",
    requestedAt: Date.now(),
  }
}

function makeAssistantMessage(): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "working",
    timestamp: 1,
    conversationId: "conv-1",
    mode: "agent",
  }
}

function setupStore(): void {
  useWikiStore.setState({
    project: { id: "project-1", name: "Wiki", path: "/wiki" },
  })
  useChatStore.setState({
    conversations: [
      { id: "conv-1", title: "Agent", createdAt: 1, updatedAt: 1, agentSessionId: "session-1" },
    ],
    messages: [makeAssistantMessage()],
    activeConversationId: "conv-1",
    isStreaming: false,
    agentRewindLocks: {},
    agentRewindTargets: { m1: makeTarget() },
    activeAgentRewindRequest: makeTarget(),
  })
}

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    isStreaming: false,
    agentRewindLocks: {},
    agentRewindTargets: {},
    activeAgentRewindRequest: null,
  })
  useWikiStore.setState({ project: null })
}

function renderDialog(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<AgentRewindDialogHost />)
  })
  return { container, root }
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  )
  if (!button) throw new Error(`button "${text}" not found`)
  return button
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("AgentRewindDialogHost", () => {
  beforeEach(() => {
    runAgentRewindMock.mockReset()
    retryAgentRewindPersistenceMock.mockReset()
    setupStore()
  })

  afterEach(() => {
    resetStore()
  })

  it("clears the rewind target and discloses the error when runAgentRewind unexpectedly throws (SPEC-7 PR2 matrix A7)", async () => {
    // Regression test for the pre-existing bug this PR fixes: an
    // unexpected throw (e.g. invoke() rejecting because the sidecar is
    // already dead) used to leave agentRewindTargets untouched, so the
    // Rewind button stayed clickable and kept failing forever.
    runAgentRewindMock.mockRejectedValue(new Error("sidecar already dead"))
    const { container, root } = renderDialog()

    const confirmButton = findButtonByText(container, i18n.t("agent.rewind.confirm"))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushMicrotasks()

    expect(useChatStore.getState().agentRewindTargets.m1).toBeUndefined()
    expect(container.textContent).toContain("sidecar already dead")
    expect(useChatStore.getState().activeAgentRewindRequest).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it("clears the rewind target's active request when it belongs to the same message as the throw", async () => {
    // clearAgentMessageRewindable is called with keepActiveRequest — the
    // dialog stays open showing the error (so the user sees the
    // disclosure) rather than silently closing.
    runAgentRewindMock.mockRejectedValue(new Error("boom"))
    const { container, root } = renderDialog()

    const confirmButton = findButtonByText(container, i18n.t("agent.rewind.confirm"))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushMicrotasks()

    expect(useChatStore.getState().agentRewindTargets).toEqual({})
    expect(container.textContent).toContain(i18n.t("agent.rewind.title"))

    act(() => root.unmount())
    container.remove()
  })

  it("discloses the stale-target half-state instead of silently closing (review-round P2)", async () => {
    // Files were reverted (payload.ok) but the orchestration could not
    // apply the in-memory truncation/fork — must be disclosed, not treated
    // as success.
    runAgentRewindMock.mockResolvedValue({
      status: "state_mismatch",
      payload: { ok: true, result: { canRewind: true } },
    })
    const { container, root } = renderDialog()

    const confirmButton = findButtonByText(container, i18n.t("agent.rewind.confirm"))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushMicrotasks()

    expect(container.textContent).toContain(i18n.t("agent.rewind.stateMismatch"))
    expect(useChatStore.getState().agentRewindTargets.m1).toBeUndefined()
    // Dialog stays open (keepActiveRequest) so the disclosure is visible.
    expect(useChatStore.getState().activeAgentRewindRequest).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it("discloses persist_failed with a retry entry point instead of silently closing", async () => {
    runAgentRewindMock.mockResolvedValue({
      status: "persist_failed",
      payload: { ok: true, result: { canRewind: true } },
      persistError: "disk full",
    })
    const { container, root } = renderDialog()

    const confirmButton = findButtonByText(container, i18n.t("agent.rewind.confirm"))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushMicrotasks()

    expect(container.textContent).toContain("disk full")
    expect(container.textContent).toContain(i18n.t("agent.rewind.retryPersist"))
    // Dialog should not have closed.
    expect(useChatStore.getState().activeAgentRewindRequest).not.toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it("closes the dialog on a plain success", async () => {
    runAgentRewindMock.mockResolvedValue({
      status: "success",
      payload: { ok: true, result: { canRewind: true } },
    })
    const { container, root } = renderDialog()

    const confirmButton = findButtonByText(container, i18n.t("agent.rewind.confirm"))
    await act(async () => {
      confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await flushMicrotasks()

    expect(useChatStore.getState().activeAgentRewindRequest).toBeNull()

    act(() => root.unmount())
    container.remove()
  })
})
