import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ChatPanel, shouldPromptForQaBeforeConversationDelete } from "./chat-panel"
import type { DisplayMessage } from "@/stores/chat-store"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

describe("ChatPanel agent mode rendering", () => {
  it("renders the mode switch in the default chat panel", () => {
    const html = renderToStaticMarkup(<ChatPanel />)

    expect(html).toContain("Chat")
    expect(html).toContain("Agent")
    expect(html).toContain("Ingest")
    expect(html).toContain("Type a message")
    expect(html).toContain("max-w-full flex-wrap")
  })
})

describe("shouldPromptForQaBeforeConversationDelete", () => {
  const longAssistant =
    "This answer is long enough to contain useful knowledge for QA extraction. ".repeat(3)

  function msg(role: DisplayMessage["role"], content: string, mode?: DisplayMessage["mode"]): DisplayMessage {
    return {
      id: `${role}-${mode || "chat"}`,
      conversationId: "conv-1",
      role,
      content,
      timestamp: 1,
      ...(mode ? { mode } : {}),
    }
  }

  it("prompts for extractable Agent conversations", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant, "agent")],
        { hasProject: true, isPending: false },
      ),
    ).toBe(true)
  })

  it("does not prompt for ordinary non-pending chat conversations", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant)],
        { hasProject: true, isPending: false },
      ),
    ).toBe(false)
  })

  it("prompts for pending extractable conversations even when they are not Agent messages", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant)],
        { hasProject: true, isPending: true },
      ),
    ).toBe(true)
  })

  it("does not prompt without a project or without extractable content", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "hello"), msg("assistant", longAssistant, "agent")],
        { hasProject: true, isPending: false },
      ),
    ).toBe(false)
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant, "agent")],
        { hasProject: false, isPending: false },
      ),
    ).toBe(false)
  })

  it("does not prompt for delete-only conversations without new knowledge", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [
          msg("user", "删除 wiki/entities/old-page.md"),
          msg("assistant", "已删除 wiki/entities/old-page.md，并清理了对应引用。".repeat(8), "agent"),
        ],
        { hasProject: true, isPending: true },
      ),
    ).toBe(false)
  })
})
