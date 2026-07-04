// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { ChatPanel, shouldPromptForQaBeforeConversationDelete } from "./chat-panel"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { type DisplayMessage, useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"

const saveQaForConversationMock = vi.hoisted(() => vi.fn())
const cleanupLegacyPendingQaStorageMock = vi.hoisted(() => vi.fn())
const buildChatAgentMessagesMock = vi.hoisted(() => vi.fn())
const streamChatMock = vi.hoisted(() => vi.fn())
const streamAgentMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/agent/agent-qa-hook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/agent-qa-hook")>()
  return {
    ...actual,
    cleanupLegacyPendingQaStorage: cleanupLegacyPendingQaStorageMock,
    saveQaForConversation: saveQaForConversationMock,
  }
})

vi.mock("@/lib/chat-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-agent")>()
  return {
    ...actual,
    buildChatAgentMessages: buildChatAgentMessagesMock,
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: streamChatMock,
  }
})

vi.mock("@/lib/agent/agent-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/agent-transport")>()
  return {
    ...actual,
    streamAgent: streamAgentMock,
  }
})

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    deleteFile: deleteFileMock,
  }
})

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderChatPanel(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<ChatPanel />)
  })

  return { container, root }
}

async function typeText(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector("textarea")
  if (!textarea) throw new Error("textarea not found")
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set
  setter?.call(textarea, text)
  textarea.selectionStart = text.length
  textarea.selectionEnd = text.length
  await act(async () => {
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function pressEnter(container: HTMLElement): Promise<void> {
  const textarea = container.querySelector("textarea")
  if (!textarea) throw new Error("textarea not found")
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    )
    await Promise.resolve()
  })
}

function setupActiveProjectConversation(
  options: {
    storeMode?: "chat" | "agent" | "ingest"
    assistantMode?: DisplayMessage["mode"]
    agentSessionId?: string
  } = {},
): void {
  useWikiStore.setState({
    project: { id: "project-1", name: "Project", path: "/project" },
  })
  useChatStore.setState({
    conversations: [
      {
        id: "conv-1",
        title: "Research chat",
        createdAt: 1,
        updatedAt: 1,
        ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
      },
    ],
    activeConversationId: "conv-1",
    messages: [
      {
        id: "m1",
        conversationId: "conv-1",
        role: "user",
        content: "What is RAG?",
        timestamp: 1,
      },
      {
        id: "m2",
        conversationId: "conv-1",
        role: "assistant",
        content: "RAG combines retrieval with generation. ".repeat(6),
        timestamp: 2,
        ...(options.assistantMode ? { mode: options.assistantMode } : {}),
        ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
      },
    ],
    mode: options.storeMode ?? "chat",
  })
}

function findSaveQaButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes("Save QA"),
  )
  if (!button) throw new Error("Save QA button not found")
  return button
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  )
  if (!button) {
    const labels = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .map((candidate) => candidate.textContent?.trim() || "[icon]")
      .join(", ")
    throw new Error(`button not found: ${text}; buttons: ${labels}`)
  }
  return button
}

async function openDeleteQaDialog(container: HTMLElement): Promise<void> {
  const title = [...container.querySelectorAll<HTMLElement>("span")].find(
    (candidate) => candidate.textContent === "Research chat",
  )
  const conversationItem = title?.closest<HTMLElement>(".group")
  if (!conversationItem) throw new Error("conversation item not found")

  await act(async () => {
    conversationItem.dispatchEvent(
      new MouseEvent("mouseenter", { bubbles: false, relatedTarget: document.body }),
    )
    conversationItem.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    await Promise.resolve()
  })

  const deleteButton = conversationItem.querySelector<HTMLButtonElement>("button")
  if (!deleteButton) throw new Error("delete conversation button not found")
  await act(async () => {
    deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

describe("ChatPanel agent mode rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveQaForConversationMock.mockResolvedValue({ ok: true, saved: true })
    streamAgentMock.mockResolvedValue(undefined)
    deleteFileMock.mockResolvedValue(undefined)
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      isStreaming: false,
      streamingContent: "",
      mode: "chat",
    })
    useWikiStore.setState({ project: null })
  })

  it("renders the mode switch in the default chat panel", () => {
    const html = renderToStaticMarkup(<ChatPanel />)

    expect(html).toContain("Chat")
    expect(html).toContain("Agent")
    expect(html).toContain("Ingest")
    expect(html).toContain("Type a message")
    expect(html).toContain("max-w-full flex-wrap")
  })

  it("renders explicit Save QA when a project conversation is active", () => {
    setupActiveProjectConversation()

    const { container, root } = renderChatPanel()

    expect(container.textContent).toContain("Save QA")

    act(() => root.unmount())
    container.remove()
  })

  it("handles /save-qa locally without sending it to the chat LLM", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await typeText(container, "/save-qa")
    await pressEnter(container)

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(saveQaForConversationMock).toHaveBeenCalledWith(
      "/project",
      expect.any(Object),
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({ id: "m1" }),
        expect.objectContaining({ id: "m2" }),
      ]),
      { trigger: "manual" },
    )
    expect(buildChatAgentMessagesMock).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages.map((message) => message.content)).not.toContain(
      "/save-qa",
    )

    act(() => root.unmount())
    container.remove()
  })

  it("handles /save-qa locally in Agent mode without starting the agent stream", async () => {
    setupActiveProjectConversation({
      storeMode: "agent",
      assistantMode: "agent",
      agentSessionId: "agent-session-1",
    })
    const { container, root } = renderChatPanel()

    await typeText(container, "/save-qa")
    await pressEnter(container)

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(saveQaForConversationMock).toHaveBeenCalledWith(
      "/project",
      expect.any(Object),
      expect.any(Object),
      expect.arrayContaining([
        expect.objectContaining({ id: "m1" }),
        expect.objectContaining({ id: "m2" }),
      ]),
      { trigger: "manual" },
    )
    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().messages.map((message) => message.content)).not.toContain(
      "/save-qa",
    )

    act(() => root.unmount())
    container.remove()
  })

  it("starts the Agent stream with an empty legacy API key so runtime profiles can claim", async () => {
    setupActiveProjectConversation({ storeMode: "agent" })
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    expect(streamAgentMock).toHaveBeenCalledWith(
      "run the agent",
      expect.objectContaining({
        apiKey: undefined,
        projectPath: "/project",
      }),
      expect.any(Object),
      expect.any(AbortSignal),
    )
    expect(container.textContent).not.toContain("API key")

    act(() => root.unmount())
    container.remove()
  })

  it("merges a batch tool event into existing toolCalls instead of overwriting them (SPEC-7 PR2 matrix A16)", async () => {
    setupActiveProjectConversation({ storeMode: "agent" })
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onToolEvent: (event: Record<string, unknown>) => void
    }
    const assistantMessageId = useChatStore
      .getState()
      .messages.find((m) => m.mode === "agent" && m.role === "assistant")?.id
    expect(assistantMessageId).toBeTruthy()

    act(() => {
      // An earlier individual tool call (e.g. a wiki write) lands first.
      callbacks.onToolEvent({
        phase: "post",
        toolName: "mcp__llm_wiki__update_page",
        toolUseId: "tool-1",
        ok: true,
      })
    })
    act(() => {
      // A later batch event (e.g. a parallel tool-call announcement) must
      // not wipe out the earlier write call — the rewind fail-closed gate
      // depends on seeing every recorded wiki tool call, not just the
      // latest batch.
      callbacks.onToolEvent({
        phase: "batch",
        toolCalls: [
          { toolName: "mcp__llm_wiki__read_page", toolUseId: "tool-2" },
        ],
      })
    })

    const toolCalls = useChatStore
      .getState()
      .messages.find((m) => m.id === assistantMessageId)?.toolCalls
    expect(toolCalls?.map((call) => call.toolName)).toEqual(
      expect.arrayContaining([
        "mcp__llm_wiki__update_page",
        "mcp__llm_wiki__read_page",
      ]),
    )

    act(() => root.unmount())
    container.remove()
  })

  it("does not start duplicate explicit QA saves while one is in flight", async () => {
    setupActiveProjectConversation()
    let resolveSave: (value: { ok: boolean; saved: boolean }) => void = () => undefined
    saveQaForConversationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const { container, root } = renderChatPanel()
    const button = findSaveQaButton(container)

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("QA save is already in progress.")

    await act(async () => {
      resolveSave({ ok: true, saved: true })
      await Promise.resolve()
    })

    act(() => root.unmount())
    container.remove()
  })

  it("does not start duplicate QA saves from /save-qa while one is in flight", async () => {
    setupActiveProjectConversation()
    let resolveSave: (value: { ok: boolean; saved: boolean }) => void = () => undefined
    saveQaForConversationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const { container, root } = renderChatPanel()
    const button = findSaveQaButton(container)

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    await typeText(container, "/save-qa")
    await pressEnter(container)

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("QA save is already in progress.")

    await act(async () => {
      resolveSave({ ok: true, saved: true })
      await Promise.resolve()
    })

    act(() => root.unmount())
    container.remove()
  })

  it("does not extract and delete while explicit Save QA is in flight", async () => {
    setupActiveProjectConversation({ assistantMode: "agent" })
    const resolveSaves: Array<(value: { ok: boolean; saved: boolean }) => void> = []
    saveQaForConversationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSaves.push(resolve)
        }),
    )
    const { container, root } = renderChatPanel()
    const saveButton = findSaveQaButton(container)

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)

    await openDeleteQaDialog(container)
    const extractAndDeleteButton = findButtonByText(document.body, "Extract QA and Delete")

    await act(async () => {
      extractAndDeleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().conversations).toHaveLength(1)
    expect(deleteFileMock).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("QA save is already in progress.")

    await act(async () => {
      resolveSaves[0]?.({ ok: true, saved: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      extractAndDeleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().conversations).toHaveLength(1)

    await act(async () => {
      resolveSaves[1]?.({ ok: true, saved: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations).toHaveLength(0)
    expect(deleteFileMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
  })

  it("does not duplicate Extract & Delete when clicked repeatedly", async () => {
    setupActiveProjectConversation({ assistantMode: "agent" })
    let resolveSave: (value: { ok: boolean; saved: boolean }) => void = () => undefined
    saveQaForConversationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const { container, root } = renderChatPanel()

    await openDeleteQaDialog(container)
    const extractAndDeleteButton = findButtonByText(document.body, "Extract QA and Delete")

    await act(async () => {
      extractAndDeleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      extractAndDeleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(saveQaForConversationMock).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().conversations).toHaveLength(1)

    await act(async () => {
      resolveSave({ ok: true, saved: true })
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations).toHaveLength(0)
    expect(deleteFileMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
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
        { hasProject: true },
      ),
    ).toBe(true)
  })

  it("does not prompt for ordinary chat conversations", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant)],
        { hasProject: true },
      ),
    ).toBe(false)
  })

  it("does not prompt for non-Agent conversations now that QA save is explicit", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant)],
        { hasProject: true },
      ),
    ).toBe(false)
  })

  it("does not prompt without a project or without extractable content", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "hello"), msg("assistant", longAssistant, "agent")],
        { hasProject: true },
      ),
    ).toBe(false)
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [msg("user", "How should I structure the wiki QA workflow?"), msg("assistant", longAssistant, "agent")],
        { hasProject: false },
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
        { hasProject: true },
      ),
    ).toBe(false)
  })

  it("does not prompt for Agent cleanup-only conversations", () => {
    expect(
      shouldPromptForQaBeforeConversationDelete(
        [
          msg("user", "cleanup stale references for the deleted page"),
          msg("assistant", "Cleaned up stale references and found no changes left to apply. ".repeat(3), "agent"),
        ],
        { hasProject: true },
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
        { hasProject: true },
      ),
    ).toBe(true)
  })
})
