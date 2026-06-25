import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { ChatPanel, shouldPromptForQaBeforeConversationDelete } from "./chat-panel"
import { ChatMessage, StreamingMessage } from "./chat-message"
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

describe("normal Chat Router progress rendering", () => {
  it("localizes streaming tool progress labels with status and counts", async () => {
    await i18n.changeLanguage("zh")
    const html = renderToStaticMarkup(
      <StreamingMessage
        content="回答"
        agentEvents={[
          {
            stage: "searching_wiki",
            tool: "wiki_search",
            status: "running",
            query: "router",
          },
          {
            stage: "tool_result",
            tool: "web_search",
            status: "success",
            count: 2,
            query: "docs",
          },
          {
            stage: "tool_result",
            tool: "anytxt_search",
            status: "error",
            count: 0,
            query: "local files",
          },
        ]}
      />,
    )

    expect(html).toContain("Wiki 搜索")
    expect(html).toContain("网页搜索")
    expect(html).toContain("AnyTXT 搜索")
    expect(html).toContain("进行中")
    expect(html).toContain("完成")
    expect(html).toContain("出错")
    expect(html).toContain("(2)")
    expect(html).toContain("(0)")
    expect(html).not.toContain("Searching wiki")
    await i18n.changeLanguage("en")
  })

  it("localizes persisted Chat Agent steps", async () => {
    await i18n.changeLanguage("zh")
    const message: DisplayMessage = {
      id: "assistant-1",
      conversationId: "conv-1",
      role: "assistant",
      content: "完成",
      timestamp: 1,
      agentSteps: [
        {
          id: "step-1",
          type: "tool_call",
          tool: "project_files",
          status: "running",
          query: "wiki",
        },
        {
          id: "step-2",
          type: "tool_result",
          tool: "graph_search",
          status: "success",
          count: 3,
          query: "links",
        },
        {
          id: "step-3",
          type: "final",
          status: "success",
          count: 2,
        },
      ],
    }

    const html = renderToStaticMarkup(<ChatMessage message={message} />)

    expect(html).toContain("项目文件")
    expect(html).toContain("图谱搜索")
    expect(html).toContain("最终回答")
    expect(html).toContain("进行中")
    expect(html).toContain("完成")
    expect(html).toContain("(3)")
    expect(html).toContain("(2)")
    expect(html).not.toContain("Project files")
    await i18n.changeLanguage("en")
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

  it("does not prompt for pending Agent cleanup-only conversations", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [
          msg("user", "cleanup stale references for the deleted page"),
          msg("assistant", "Cleaned up stale references and found no changes left to apply. ".repeat(3), "agent"),
        ],
        { hasProject: true, isPending: true },
      ),
    ).toBe(false)
  })

  it("still prompts for Agent cleanup conversations with new knowledge", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [
          msg("user", "cleanup the QA hook and explain the root cause"),
          msg("assistant", "Cleanup is complete. The root cause was that operation-only deletion messages were treated as reusable knowledge. ".repeat(2), "agent"),
        ],
        { hasProject: true, isPending: false },
      ),
    ).toBe(true)
  })
})
