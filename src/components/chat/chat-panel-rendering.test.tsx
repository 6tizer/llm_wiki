// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/i18n"
import { ChatPanel, shouldPromptForQaBeforeConversationDelete } from "./chat-panel"
import { ChatMessage, StreamingMessage } from "./chat-message"
import { type DisplayMessage, useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useAgentSettingsStore } from "@/stores/agent-settings-store"
import { getChatAgentTools } from "@/lib/chat-agent"

const saveQaForConversationMock = vi.hoisted(() => vi.fn())
const cleanupLegacyPendingQaStorageMock = vi.hoisted(() => vi.fn())
const buildChatAgentMessagesMock = vi.hoisted(() => vi.fn())
const streamChatMock = vi.hoisted(() => vi.fn())
const streamAgentMock = vi.hoisted(() => vi.fn())
const deleteFileMock = vi.hoisted(() => vi.fn())
const runtimeProfileListMock = vi.hoisted(() => vi.fn())
const runtimeJobCreateMock = vi.hoisted(() => vi.fn())
const runtimeJobClaimByKindMock = vi.hoisted(() => vi.fn())
const runtimeJobHeartbeatMock = vi.hoisted(() => vi.fn())
const runtimeJobCompleteMock = vi.hoisted(() => vi.fn())
const runtimeJobFailMock = vi.hoisted(() => vi.fn())
const runtimeJobCancelMock = vi.hoisted(() => vi.fn())
const startIngestMock = vi.hoisted(() => vi.fn())
const executeIngestWritesMock = vi.hoisted(() => vi.fn())
const dialogOpenMock = vi.hoisted(() => vi.fn())
const notifyWikiPathsChangedMock = vi.hoisted(() => vi.fn())

const PNG_BASE64 = "iVBORw0KGgo="

class MockFileReader {
  result: string | ArrayBuffer | null = null
  onerror: (() => void) | null = null
  onload: (() => void) | null = null

  readAsDataURL(file: Blob): void {
    this.result = `data:${file.type || "image/png"};base64,${PNG_BASE64}`
    this.onload?.()
  }
}

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

vi.mock("@/lib/ingest", () => ({
  startIngest: startIngestMock,
  executeIngestWrites: executeIngestWritesMock,
}))

vi.mock("@/lib/wiki-change-notifier", () => ({
  notifyWikiPathsChanged: notifyWikiPathsChangedMock,
}))

vi.mock("@/commands/runtime-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/runtime-db")>()
  return {
    ...actual,
    runtimeProfileList: runtimeProfileListMock,
    runtimeJobCreate: runtimeJobCreateMock,
    runtimeJobClaimByKind: runtimeJobClaimByKindMock,
    runtimeJobHeartbeat: runtimeJobHeartbeatMock,
    runtimeJobComplete: runtimeJobCompleteMock,
    runtimeJobFail: runtimeJobFailMock,
    runtimeJobCancel: runtimeJobCancelMock,
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
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

async function chooseImage(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("file input not found")
  Object.defineProperty(input, "files", {
    value: [
      new File([new Uint8Array([137, 80, 78, 71])], "tiny.png", {
        type: "image/png",
      }),
    ],
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
  })
}

function mockModelCallSuccess(content = "model answer"): void {
  buildChatAgentMessagesMock.mockResolvedValue({
    messages: [{ role: "user", content: "prompt" }],
    references: [],
    queryPages: [],
    steps: [],
  })
  streamChatMock.mockImplementation(async (
    _config: unknown,
    _messages: unknown,
    callbacks: { onToken: (token: string) => void; onDone: () => void },
  ) => {
    callbacks.onToken(content)
    callbacks.onDone()
  })
}

function agentRunProfileRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileId: "agent-profile",
    displayName: "Agent",
    providerId: "openai",
    endpoint: "https://api.openai.com/v1",
    secretRef: "llm-wiki-profile-secret:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    enabled: true,
    kind: "agent-run",
    taskFamilies: ["agent"],
    capabilityVersion: "profile-probe.v1",
    capabilityStatus: "supported",
    capabilityJson: JSON.stringify({ agentRunSupported: true }),
    ...overrides,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setupActiveProjectConversation(
  options: {
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

function findElementByText(root: ParentNode, text: string): HTMLElement {
  const element = [...root.querySelectorAll<HTMLElement>("*")].find(
    (candidate) => candidate.textContent === text,
  )
  if (!element) throw new Error(`element not found: ${text}`)
  return element
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
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
    saveQaForConversationMock.mockResolvedValue({ ok: true, saved: true })
    streamAgentMock.mockResolvedValue(undefined)
    deleteFileMock.mockResolvedValue(undefined)
    runtimeJobCreateMock.mockResolvedValue({
      jobId: "agent-job-1",
      kind: "agent-chat-run",
      payload: "{}",
      state: "queued",
      attempt: 1,
      maxAttempts: 1,
      priority: 0,
      createdAtMs: 0,
      updatedAtMs: 0,
    })
    runtimeJobClaimByKindMock.mockResolvedValue({
      job: { jobId: "agent-job-1" },
      lease: { leaseId: "agent-lease-1" },
    })
    runtimeJobHeartbeatMock.mockResolvedValue({})
    runtimeJobCompleteMock.mockResolvedValue({})
    runtimeJobFailMock.mockResolvedValue({})
    runtimeJobCancelMock.mockResolvedValue({})
    executeIngestWritesMock.mockResolvedValue([])
    startIngestMock.mockImplementation(async (_projectPath, sourcePath) => {
      const store = useChatStore.getState()
      const id = store.createConversation()
      store.addMessage("user", `discussion:${sourcePath}`)
      store.finalizeStream("analysis", undefined, id)
      store.renameConversation(id, String(sourcePath).split("/").pop() || "source")
    })
    dialogOpenMock.mockResolvedValue(null)
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    useChatStore.setState({
      conversations: [],
      activeConversationId: null,
      messages: [],
      isStreaming: false,
      streamingConversationId: null,
      streamingAgentMessageId: null,
      streamingContent: "",
      ingestSource: null,
      activeRunModelByConversation: {},
      activeRunProfileByConversation: {},
      activeAgentPermissionRequest: null,
      queuedAgentPermissionRequests: [],
      agentPermissionRequestsByConversation: {},
      agentRewindTargets: {},
      activeAgentRewindRequest: null,
      agentRewindRequestsByConversation: {},
      agentRewindLocks: {},
    })
    useReviewStore.setState({ items: [] })
    useAgentSettingsStore.getState().resetResourceConfig()
    useWikiStore.setState((state) => ({
      project: null,
      llmConfig: {
        ...state.llmConfig,
        provider: "custom",
        apiKey: "",
        model: "test-model",
        customEndpoint: "http://127.0.0.1:9999/v1/chat/completions",
      },
    }))
  })

  it("renders the unified composer without mode switch buttons", () => {
    const html = renderToStaticMarkup(<ChatPanel />)

    expect(html).not.toContain("Ingest")
    expect(html).toContain("Type a message")
    expect(html).toContain("Sources")
    expect(html).toContain("Model routing")
  })

  it("keeps the message list from becoming an implicit horizontal scroller", () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    const scrollContainer = container.querySelector<HTMLElement>(
      ".flex-1.overflow-x-hidden.overflow-y-auto",
    )

    expect(scrollContainer?.className).toContain("overflow-x-hidden")
    expect(scrollContainer?.className).toContain("overflow-y-auto")

    act(() => root.unmount())
    container.remove()
  })

  it("shows Auto in the footer when no resolved Agent profile or SDK model exists", async () => {
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Auto")
    expect(container.textContent).not.toContain("test-model")

    act(() => root.unmount())
    container.remove()
  })

  it("shows Auto when an Agent-run profile candidate exists", async () => {
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord()],
    })
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain("Auto")

    act(() => root.unmount())
    container.remove()
  })

  it("clears a dangling conversation agent profile override after candidates load successfully", async () => {
    setupActiveProjectConversation()
    useChatStore.getState().setConversationAgentProfileOverride("conv-1", "missing-profile")
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord({ profileId: "available-profile" })],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations[0].agentProfileIdOverride).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      "[chat] clearing missing agent profile override: missing-profile",
    )
    expect(container.textContent).toContain("Auto")

    warn.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it("clears a dangling override when candidates load successfully but are empty", async () => {
    setupActiveProjectConversation()
    useChatStore.getState().setConversationAgentProfileOverride("conv-1", "missing-profile")
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations[0].agentProfileIdOverride).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      "[chat] clearing missing agent profile override: missing-profile",
    )
    expect(container.textContent).toContain("Auto")

    warn.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it("does not clear a profile override when candidate loading fails", async () => {
    setupActiveProjectConversation()
    useChatStore.getState().setConversationAgentProfileOverride("conv-1", "missing-profile")
    runtimeProfileListMock.mockRejectedValue(new Error("runtime unavailable"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations[0].agentProfileIdOverride).toBe("missing-profile")
    expect(warn).not.toHaveBeenCalledWith(
      "[chat] clearing missing agent profile override: missing-profile",
    )

    warn.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it("keeps an existing profile override when candidates still contain it", async () => {
    setupActiveProjectConversation()
    useChatStore.getState().setConversationAgentProfileOverride("conv-1", "agent-profile")
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord()],
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useChatStore.getState().conversations[0].agentProfileIdOverride).toBe("agent-profile")
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("clearing missing agent profile override"),
    )

    warn.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it("does not show a collapsed policy badge for the default policy", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain("Restricted")
    expect(container.textContent).not.toContain("Skip confirmation")

    act(() => root.unmount())
    container.remove()
  })

  it("shows a neutral collapsed policy badge for restricted policy", async () => {
    setupActiveProjectConversation()
    useChatStore
      .getState()
      .setConversationAgentPermissionPolicyOverride("conv-1", "restricted")
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })

    const badge = findElementByText(container, "Restricted")
    expect(badge.className).toContain("bg-muted")
    expect(badge.className).not.toContain("text-destructive")

    act(() => root.unmount())
    container.remove()
  })

  it("shows a warning collapsed policy badge for bypass policy", async () => {
    setupActiveProjectConversation()
    useChatStore
      .getState()
      .setConversationAgentPermissionPolicyOverride("conv-1", "bypassPermissions")
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })

    const badge = findElementByText(container, "Skip confirmation")
    expect(badge.className).toContain("text-destructive")

    act(() => root.unmount())
    container.remove()
  })

  it("keeps permission policy copy explicit about restricted and bypass scope", () => {
    expect(i18n.t("chat.agentRouting.profile", { lng: "en" })).toBe("Connection")
    expect(i18n.t("chat.agentRouting.profile", { lng: "zh" })).toBe("连接")
    expect(i18n.t("chat.agentRouting.policyScopeHint", { lng: "en" })).toBe(
      "Applies to this conversation only",
    )
    expect(i18n.t("chat.agentRouting.policyScopeHint", { lng: "zh" })).toBe(
      "仅作用于本对话",
    )
    expect(
      i18n.t("chat.agentRouting.policyOptions.restricted.description", { lng: "en" }),
    ).toBe("Disables built-in tools, including Bash and file reads.")
    expect(
      i18n.t("chat.agentRouting.policyOptions.bypassPermissions.description", {
        lng: "en",
      }),
    ).toBe(
      "Runs commands and edits any files without asking — including shell commands.",
    )
    expect(
      i18n.t("chat.agentRouting.policyOptions.restricted.description", { lng: "zh" }),
    ).toBe("禁用全部内置工具，包括 Bash 和读取文件。")
    expect(
      i18n.t("chat.agentRouting.policyOptions.bypassPermissions.description", {
        lng: "zh",
      }),
    ).toBe("不再询问直接执行——包括 shell 命令与任意文件修改。")
  })

  it("renders explicit Save QA when a project conversation is active", () => {
    setupActiveProjectConversation()

    const { container, root } = renderChatPanel()

    expect(container.textContent).toContain("Save QA")

    act(() => root.unmount())
    container.remove()
  })

  it("renders task suggestions for an empty active conversation and sends through normal routing", async () => {
    useWikiStore.setState({
      project: { id: "project-1", name: "Project", path: "/project" },
    })
    useChatStore.setState({
      conversations: [
        { id: "conv-1", title: "Empty", createdAt: 1, updatedAt: 1 },
      ],
      activeConversationId: "conv-1",
      messages: [],
    })
    const { container, root } = renderChatPanel()

    expect(container.textContent).toContain("Check the wiki for broken links")

    await act(async () => {
      findButtonByText(container, "Check the wiki for broken links").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })

    expect(streamAgentMock).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().messages.find((m) => m.role === "user")?.content).toBe(
      "Check the wiki for broken links",
    )

    act(() => root.unmount())
    container.remove()
  })

  it("falls back to model-call when an empty-state suggestion is clicked without Agent preflight", async () => {
    useChatStore.setState({
      conversations: [
        { id: "conv-1", title: "Empty", createdAt: 1, updatedAt: 1 },
      ],
      activeConversationId: "conv-1",
      messages: [],
    })
    mockModelCallSuccess("fallback suggestion")
    const { container, root } = renderChatPanel()

    await act(async () => {
      findButtonByText(container, "Check the wiki for broken links").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).toHaveBeenCalledTimes(1)

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

  it("routes image messages to the model-call stream path even when Agent is available", async () => {
    setupActiveProjectConversation()
    mockModelCallSuccess("vision answer")
    const { container, root } = renderChatPanel()

    await typeText(container, "describe this")
    await chooseImage(container)
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().messages.find((m) => m.content === "describe this")?.images).toHaveLength(1)

    act(() => root.unmount())
    container.remove()
  })

  it("routes ingest discussion text to model-call and keeps Write to Wiki available", async () => {
    setupActiveProjectConversation()
    useChatStore.setState({ ingestSource: "/project/raw/sources/doc.md" })
    mockModelCallSuccess("ingest answer")
    const { container, root } = renderChatPanel()

    expect(container.textContent).toContain("Write to Wiki")

    await typeText(container, "discuss this source")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain("Write to Wiki")

    act(() => root.unmount())
    container.remove()
  })

  it("routes ingest discussion images to model-call", async () => {
    setupActiveProjectConversation()
    useChatStore.setState({ ingestSource: "/project/raw/sources/doc.md" })
    mockModelCallSuccess("ingest image answer")
    const { container, root } = renderChatPanel()

    await typeText(container, "look at this")
    await chooseImage(container)
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
  })

  it("starts picked document discussion in a new conversation without clearing the current one", async () => {
    setupActiveProjectConversation()
    dialogOpenMock.mockResolvedValue("/external/docs/report.md")
    const oldMessageCount = useChatStore.getState().messages.filter((message) => (
      message.conversationId === "conv-1"
    )).length
    const { container, root } = renderChatPanel()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Add attachment"]')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButtonByText(container, "Document").dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(startIngestMock).toHaveBeenCalledWith(
      "/project",
      "/external/docs/report.md",
      expect.any(Object),
      expect.any(AbortSignal),
    )
    const chatState = useChatStore.getState()
    const activeConversationId = chatState.activeConversationId
    expect(chatState.messages.filter((message) => message.conversationId === "conv-1")).toHaveLength(oldMessageCount)
    expect(activeConversationId).not.toBe("conv-1")
    expect(chatState.messages.some((message) => (
      message.conversationId === activeConversationId &&
      message.content === "analysis"
    ))).toBe(true)

    act(() => root.unmount())
    container.remove()
  })

  it("routes text messages to Agent when project preflight passes", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    expect(streamAgentMock).toHaveBeenCalledTimes(1)
    expect(streamAgentMock.mock.calls[0]?.[1]).toMatchObject({
      disallowedTools: ["WebSearch", "WebFetch"],
    })
    expect(buildChatAgentMessagesMock).not.toHaveBeenCalled()
    expect(streamChatMock).not.toHaveBeenCalled()

    act(() => root.unmount())
    container.remove()
  })

  it("keeps the Agent message flow completing when job ledger calls reject", async () => {
    setupActiveProjectConversation()
    runtimeJobCreateMock.mockRejectedValueOnce(new Error("job create failed"))
    streamAgentMock.mockImplementation(async (
      _text: string,
      _options: unknown,
      callbacks: {
        onStreamStart?: (streamId: string) => void
        onToken?: (token: string) => void
        onDone?: (result: { result: string } | null) => void
      },
    ) => {
      callbacks.onStreamStart?.("stream-1")
      callbacks.onToken?.("agent answer")
      callbacks.onDone?.({ result: "agent answer" })
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtimeJobCreateMock).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      "[agent-chat-run-job] create/claim failed:",
      expect.any(Error),
    )
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().messages.some((message) => (
      message.role === "assistant" && message.content === "agent answer"
    ))).toBe(true)

    warn.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it("uses the locally captured job when an older Agent stream finishes after a newer one starts", async () => {
    setupActiveProjectConversation()
    let createCount = 0
    runtimeJobCreateMock.mockImplementation(async () => {
      createCount += 1
      return {
        jobId: `job-${createCount}`,
        kind: "agent-chat-run",
        payload: "{}",
        state: "queued",
        attempt: 1,
        maxAttempts: 1,
        priority: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      }
    })
    runtimeJobClaimByKindMock.mockImplementation(async (request: { jobId?: string | null }) => ({
      job: { jobId: request.jobId },
      lease: { leaseId: `${request.jobId}-lease` },
    }))
    const callbacksByRun: Array<{
      onStreamStart?: (streamId: string) => void
      onDone?: (result: { result: string } | null) => void
    }> = []
    streamAgentMock.mockImplementation(async (
      _text: string,
      _options: unknown,
      callbacks: {
        onStreamStart?: (streamId: string) => void
        onDone?: (result: { result: string } | null) => void
      },
    ) => {
      callbacksByRun.push(callbacks)
      callbacks.onStreamStart?.(`stream-${callbacksByRun.length}`)
    })
    const { container, root } = renderChatPanel()

    await typeText(container, "first run")
    await pressEnter(container)
    await act(async () => {
      useChatStore.setState({
        isStreaming: false,
        streamingConversationId: null,
        streamingAgentMessageId: null,
      })
      await Promise.resolve()
    })
    await typeText(container, "second run")
    await pressEnter(container)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(callbacksByRun).toHaveLength(2)
    callbacksByRun[0].onDone?.({ result: "late first result" })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtimeJobCompleteMock).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseId: "job-1-lease",
    })
    expect(runtimeJobCompleteMock).not.toHaveBeenCalledWith({
      jobId: "job-2",
      leaseId: "job-2-lease",
    })

    act(() => root.unmount())
    container.remove()
  })

  it("falls back to model-call chat when Agent preflight fails", async () => {
    useChatStore.setState({
      conversations: [
        { id: "conv-1", title: "No project", createdAt: 1, updatedAt: 1 },
      ],
      activeConversationId: "conv-1",
      messages: [],
    })
    mockModelCallSuccess("fallback answer")
    const { container, root } = renderChatPanel()

    await typeText(container, "plain question")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(buildChatAgentMessagesMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
  })

  it("keeps web_search out of normal Chat Router tools when the web source is off", async () => {
    useChatStore.setState({
      conversations: [
        { id: "conv-1", title: "No project", createdAt: 1, updatedAt: 1 },
      ],
      activeConversationId: "conv-1",
      messages: [],
    })
    mockModelCallSuccess("fallback answer")
    const { container, root } = renderChatPanel()

    await typeText(container, "plain question")
    await pressEnter(container)

    const input = buildChatAgentMessagesMock.mock.calls[0]?.[0] as {
      project: unknown
      options: { useWebSearch: boolean; useAnyTxtSearch: boolean }
    }
    expect(input.options.useWebSearch).toBe(false)
    expect(
      getChatAgentTools({
        hasProject: Boolean(input.project),
        webSearchEnabled: input.options.useWebSearch,
        anyTxtSearchEnabled: input.options.useAnyTxtSearch,
      }).map((tool) => tool.name),
    ).not.toContain("web_search")

    act(() => root.unmount())
    container.remove()
  })

  it("stops the streaming conversation's pending permissions after switching conversations", async () => {
    useWikiStore.setState({
      project: { id: "project-1", name: "Project", path: "/project" },
    })
    useChatStore.setState({
      conversations: [
        { id: "conv-a", title: "A", createdAt: 1, updatedAt: 1 },
        { id: "conv-b", title: "B", createdAt: 2, updatedAt: 2 },
      ],
      activeConversationId: "conv-b",
      messages: [
        { id: "a-user", conversationId: "conv-a", role: "user", content: "A", timestamp: 1 },
        { id: "b-user", conversationId: "conv-b", role: "user", content: "B", timestamp: 2 },
      ],
      isStreaming: true,
      streamingConversationId: "conv-a",
      streamingAgentMessageId: "a-assistant",
      streamingContent: "",
    })
    const permissionA = useChatStore.getState().requestAgentPermission({
      requestId: "permission-a",
      conversationId: "conv-a",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-a",
    })
    const permissionB = useChatStore.getState().requestAgentPermission({
      requestId: "permission-b",
      conversationId: "conv-b",
      toolName: "Read",
      inputPreview: {},
      toolUseID: "tool-b",
    })

    const { container, root } = renderChatPanel()
    const stopButton = findButtonByText(container, i18n.t("chat.stopGeneration"))
    await act(async () => {
      stopButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    await expect(permissionA).resolves.toMatchObject({
      behavior: "deny",
      interrupt: true,
    })
    useChatStore.getState().setActiveConversation("conv-b")
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-b")
    useChatStore.getState().resolveAgentPermission("permission-b", { behavior: "allow" })
    await expect(permissionB).resolves.toMatchObject({ behavior: "allow" })

    act(() => root.unmount())
    container.remove()
  })

  it("handles /save-qa locally for legacy Agent conversations without starting the agent stream", async () => {
    setupActiveProjectConversation({
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
    setupActiveProjectConversation()
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord()],
    })
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    const { container, root } = renderChatPanel()
    await act(async () => {
      await Promise.resolve()
    })

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

  it("uses on-demand runtime profile lookup for an immediate send before the mount effect resolves", async () => {
    setupActiveProjectConversation()
    const effectLookup = deferred<unknown>()
    runtimeProfileListMock
      .mockReturnValueOnce(effectLookup.promise)
      .mockResolvedValueOnce({
        enabled: true,
        status: "healthy",
        profiles: [agentRunProfileRecord()],
      })
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    const { container, root } = renderChatPanel()

    await typeText(container, "run immediately")
    await pressEnter(container)

    expect(streamAgentMock).toHaveBeenCalledTimes(1)
    expect(streamChatMock).not.toHaveBeenCalled()

    effectLookup.resolve({ enabled: true, status: "healthy", profiles: [] })
    act(() => root.unmount())
    container.remove()
  })

  it("falls back to model-call when on-demand runtime profile lookup rejects", async () => {
    setupActiveProjectConversation()
    runtimeProfileListMock.mockRejectedValue(new Error("runtime disabled"))
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    mockModelCallSuccess("fallback")
    const { container, root } = renderChatPanel()

    await typeText(container, "plain fallback")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
  })

  it("falls back to model-call when runtime profiles are disabled or unhealthy", async () => {
    setupActiveProjectConversation()
    runtimeProfileListMock.mockResolvedValue({
      enabled: false,
      status: "disabled",
      profiles: [agentRunProfileRecord()],
    })
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    mockModelCallSuccess("fallback")
    const { container, root } = renderChatPanel()

    await typeText(container, "disabled fallback")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(streamChatMock).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    container.remove()
  })

  it("caches a negative on-demand runtime profile result", async () => {
    setupActiveProjectConversation()
    const effectLookup = deferred<unknown>()
    runtimeProfileListMock
      .mockReturnValueOnce(effectLookup.promise)
      .mockResolvedValueOnce({
        enabled: false,
        status: "disabled",
        profiles: [agentRunProfileRecord()],
      })
    useWikiStore.setState((state) => ({
      llmConfig: {
        ...state.llmConfig,
        provider: "anthropic",
        apiKey: "",
      },
    }))
    mockModelCallSuccess("fallback")
    const { container, root } = renderChatPanel()

    await typeText(container, "first fallback")
    await pressEnter(container)
    await typeText(container, "second fallback")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()
    expect(streamChatMock).toHaveBeenCalledTimes(2)
    expect(runtimeProfileListMock).toHaveBeenCalledTimes(2)

    effectLookup.resolve({ enabled: false, status: "disabled", profiles: [] })
    act(() => root.unmount())
    container.remove()
  })

  it("records the active run model from SDK assistant messages only", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onMessage: (message: Record<string, unknown>) => void
    }

    act(() => {
      callbacks.onMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
        },
      })
    })
    expect(useChatStore.getState().activeRunModelByConversation["conv-1"]).toBeNull()

    act(() => {
      callbacks.onMessage({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          model: "claude-runtime",
        },
      })
    })
    expect(useChatStore.getState().activeRunModelByConversation["conv-1"]).toBe("claude-runtime")

    act(() => root.unmount())
    container.remove()
  })

  it("creates one review item for each snapshotted agent wiki change", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onStreamStart: (streamId: string) => void
      onWikiChanged: (payload: {
        path: string
        operation: "update" | "create" | "delete"
        toolUseId?: string
        snapshotted?: boolean
      }) => void
    }

    act(() => {
      callbacks.onStreamStart("stream-1")
      callbacks.onWikiChanged({
        path: "wiki/page.md",
        operation: "update",
        toolUseId: "tool-1",
        snapshotted: true,
      })
    })

    const item = useReviewStore.getState().items[0]
    expect(item).toMatchObject({
      type: "agent-write",
      title: "更新 wiki/page.md",
      sourcePath: "wiki/page.md",
      agentWrite: {
        path: "wiki/page.md",
        operation: "update",
        conversationId: "conv-1",
        streamId: "stream-1",
        toolUseId: "tool-1",
        snapshotted: true,
      },
    })
    expect(item?.options.map((option) => option.label)).toEqual([
      "查看页面",
      "撤销此写入",
      "接受",
    ])
    expect(notifyWikiPathsChangedMock).toHaveBeenCalledWith("/project", ["wiki/page.md"])

    act(() => root.unmount())
    container.remove()
  })

  it("records the resolved runtime profile and shows the cached display name in the footer", async () => {
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord()],
    })
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })
    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onProfileResolved: (payload: Record<string, unknown>) => void
    }

    act(() => {
      callbacks.onProfileResolved({
        streamId: "stream-1",
        profileId: "agent-profile",
        claimId: "claim-agent",
        agentSdkModelId: "claude-runtime",
        authStyle: "x-api-key",
      })
    })

    expect(useChatStore.getState().activeRunProfileByConversation["conv-1"]).toMatchObject({
      profileId: "agent-profile",
      agentSdkModelId: "claude-runtime",
    })
    expect(container.textContent).toContain("Agent")

    act(() => root.unmount())
    container.remove()
  })

  it("renders a timeline status row when the requested runtime profile is replaced", async () => {
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [agentRunProfileRecord()],
    })
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })
    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onProfileResolved: (payload: Record<string, unknown>) => void
    }

    await act(async () => {
      callbacks.onProfileResolved({
        streamId: "stream-1",
        requestedProfileId: "missing-profile",
        profileId: "agent-profile",
        claimId: "claim-agent",
        agentSdkModelId: "claude-runtime",
        authStyle: "x-api-key",
      })
      await Promise.resolve()
    })

    const timelineButton = findButtonByText(container, "Activity timeline")
    await act(async () => {
      timelineButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain(
      "Selected profile is unavailable; using agent-profile for this run.",
    )

    act(() => root.unmount())
    container.remove()
  })

  it("refreshes runtime profile candidates when the routing dropdown opens", async () => {
    const longEndpoint = "https://api.openai.com/v1/projects/agent-runtime/very/long/endpoint"
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        agentRunProfileRecord({
          profileId: "agent-profile-b",
          displayName: "Agent B",
          endpoint: longEndpoint,
        }),
        agentRunProfileRecord({
          profileId: "agent-profile-a",
          displayName: "Agent A",
          endpoint: longEndpoint,
        }),
      ],
    })
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })
    expect(runtimeProfileListMock).toHaveBeenCalledTimes(1)

    const routeButton = container.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("chat.modelIndicator")}"]`,
    )
    if (!routeButton) throw new Error("route button not found")
    await act(async () => {
      routeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })

    expect(runtimeProfileListMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Connection")
    expect(container.textContent).toContain("Auto (recommended)")
    expect(container.textContent).toContain("OpenAI (GPT) · 2 profiles")
    expect(container.textContent).toContain(longEndpoint)
    const endpointLabel = [...container.querySelectorAll<HTMLElement>("div")]
      .find((node) => node.textContent === longEndpoint)
    expect(endpointLabel?.className).toContain("truncate")
    expect(endpointLabel?.getAttribute("title")).toBe(longEndpoint)
    expect(container.textContent).toContain("Applies to this conversation only")

    act(() => root.unmount())
    container.remove()
  })

  it("updates the routing button label immediately when a profile override is selected", async () => {
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        agentRunProfileRecord({
          profileId: "agent-profile-a",
          displayName: "Agent Alpha",
        }),
      ],
    })
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })
    const routeButton = container.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("chat.modelIndicator")}"]`,
    )
    if (!routeButton) throw new Error("route button not found")
    await act(async () => {
      routeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      findButtonByText(container, "Agent Alpha").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      )
      await Promise.resolve()
    })

    expect(routeButton.textContent).toContain("Agent Alpha")
    expect(streamAgentMock).not.toHaveBeenCalled()

    act(() => root.unmount())
    container.remove()
  })

  it("shows selected profile and conversation policy together", async () => {
    runtimeProfileListMock.mockResolvedValue({
      enabled: true,
      status: "healthy",
      profiles: [
        agentRunProfileRecord({
          profileId: "agent-profile-b",
          displayName: "Agent Beta",
        }),
      ],
    })
    setupActiveProjectConversation()
    useChatStore
      .getState()
      .setConversationAgentProfileOverride("conv-1", "agent-profile-b")
    useChatStore
      .getState()
      .setConversationAgentPermissionPolicyOverride("conv-1", "restricted")
    const { container, root } = renderChatPanel()

    await act(async () => {
      await Promise.resolve()
    })
    const routeButton = container.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("chat.modelIndicator")}"]`,
    )
    if (!routeButton) throw new Error("route button not found")

    expect(routeButton.textContent).toContain("Agent Beta")
    expect(routeButton.textContent).toContain("Restricted")

    act(() => root.unmount())
    container.remove()
  })

  it("merges a batch tool event into existing toolCalls instead of overwriting them (SPEC-7 PR2 matrix A16)", async () => {
    setupActiveProjectConversation()
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    const callbacks = streamAgentMock.mock.calls[0]?.[2] as {
      onToolEvent: (event: Record<string, unknown>) => void
    }
    const assistantMessageId = useChatStore
      .getState()
      .streamingAgentMessageId
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

  it("blocks sending while a rewind is in progress for the active conversation (SPEC-7 PR2 matrix A6)", async () => {
    setupActiveProjectConversation()
    useChatStore.setState({ agentRewindLocks: { "conv-1": true } })
    const { container, root } = renderChatPanel()

    await typeText(container, "run the agent")
    await pressEnter(container)

    expect(streamAgentMock).not.toHaveBeenCalled()

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

  it("keeps chat message markdown and code blocks constrained for long content", () => {
    const message: DisplayMessage = {
      id: "assistant-long",
      conversationId: "conv-1",
      role: "assistant",
      content: "`averyveryveryveryveryverylonginlineidentifier`\n\n```txt\naveryveryveryveryveryverylongcodeidentifier\n```",
      timestamp: 1,
    }

    const html = renderToStaticMarkup(<ChatMessage message={message} />)

    expect(html).toContain("min-w-0 rounded-lg")
    expect(html).toContain("chat-markdown prose prose-sm min-w-0")
    expect(html).toContain("break-words")
    expect(html).toContain("max-w-full rounded")
    expect(html).toContain("overflow-x-auto overscroll-x-contain")
    expect(html).toContain("<code dir=\"ltr\" class=\"break-words\"")
    expect(html).toContain("<code dir=\"ltr\" class=\"language-txt\"")
    expect(html).not.toContain("break-all")
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
