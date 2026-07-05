// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { AgentSection } from "./agent-section"
import type { SettingsDraft } from "../settings-types"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const draft = {
  agentMaxTurns: 25,
  agentMaxFilesChanged: 20,
  agentMaxWriteKiB: 256,
  agentDefaultPermissionPolicy: "default",
} as SettingsDraft

function renderAgentSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <AgentSection
        draft={draft}
        setDraft={vi.fn()}
        projectReady
      />,
    )
  })

  return { container, root }
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("AgentSection permission defaults", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en")
  })

  it("renders the three policy choices using the chat policy copy", () => {
    const { container, root } = renderAgentSection()

    expect(container.querySelectorAll("[data-testid^='agent-policy-']")).toHaveLength(3)
    expect(container.textContent).toContain(i18n.t("chat.agentRouting.policyOptions.default.label"))
    expect(container.textContent).toContain(i18n.t("chat.agentRouting.policyOptions.restricted.label"))
    expect(container.textContent).toContain(i18n.t("chat.agentRouting.policyOptions.bypassPermissions.label"))
    expect(container.textContent).toContain("Conversations can temporarily override this.")

    unmount(root)
  })

  it("shows the explicit bypass permission risk copy", () => {
    const { container, root } = renderAgentSection()
    const bypassCopy = i18n.t("chat.agentRouting.policyOptions.bypassPermissions.description")

    expect(container.textContent).toContain(bypassCopy)
    expect(bypassCopy).toContain("shell commands")
    expect(bypassCopy).toContain("any files")

    unmount(root)
  })
})
