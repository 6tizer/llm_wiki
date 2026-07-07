// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { HTMLAttributes, ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    ...props
  }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { AgentPermissionDialog } from "./agent-permission-dialog"
import type { AgentPermissionRequestRecord } from "@/stores/chat-store"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function permissionRequest(
  overrides: Partial<AgentPermissionRequestRecord> = {},
): AgentPermissionRequestRecord {
  return {
    requestId: "permission-1",
    toolName: "Bash",
    description: "Claude wants to run a shell command.",
    inputPreview: { command: "pwd" },
    toolUseID: "tool-1",
    receivedAt: 0,
    expiresAt: Date.now() + 60_000,
    timeoutMs: 60_000,
    ...overrides,
  }
}

function renderDialog(request: AgentPermissionRequestRecord | null): void {
  act(() => {
    root.render(
      <AgentPermissionDialog
        request={request}
        onDecision={vi.fn()}
      />,
    )
  })
}

describe("AgentPermissionDialog countdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("freezes while paused, resumes ticking, and resets across request changes", async () => {
    renderDialog(permissionRequest({
      expiresAt: Date.now() + 60_000,
      pausedRemainingMs: 60_000,
    }))
    expect(container.textContent).toContain("60")

    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(container.textContent).toContain("60")

    renderDialog(permissionRequest({ expiresAt: Date.now() + 55_000 }))
    expect(container.textContent).toContain("55")

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(container.textContent).toContain("54")

    renderDialog(null)
    expect(container.textContent).not.toContain("Agent needs permission")

    renderDialog(permissionRequest({ requestId: "permission-2", expiresAt: Date.now() + 30_000 }))
    expect(container.textContent).toContain("30")
  })
})
