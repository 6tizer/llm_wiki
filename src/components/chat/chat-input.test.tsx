// @vitest-environment jsdom

import { StrictMode, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import {
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES_PER_MESSAGE,
} from "@/lib/chat-image-utils"
import { ChatInput } from "./chat-input"

const PNG_BASE64 = "iVBORw0KGgo="

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

class MockFileReader {
  error: Error | null = null
  result: string | ArrayBuffer | null = null
  onerror: (() => void) | null = null
  onload: (() => void) | null = null

  readAsDataURL(file: Blob): void {
    this.result = `data:${file.type || "image/png"};base64,${PNG_BASE64}`
    this.onload?.()
  }
}

const deferredFileReaders: DeferredFileReader[] = []

class DeferredFileReader {
  error: Error | null = null
  result: string | ArrayBuffer | null = null
  onerror: (() => void) | null = null
  onload: (() => void) | null = null

  readAsDataURL(file: Blob): void {
    this.result = `data:${file.type || "image/png"};base64,${PNG_BASE64}`
    deferredFileReaders.push(this)
  }
}

function renderChatInput(
  props: Partial<React.ComponentProps<typeof ChatInput>> = {},
  options: { strict?: boolean } = {},
): {
  container: HTMLDivElement
  root: Root
  onSend: ReturnType<typeof vi.fn>
} {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const onSend = vi.fn()

  const input = (
    <ChatInput
      onSend={onSend}
      onStop={() => undefined}
      isStreaming={false}
      showSearchToggles={false}
      {...props}
    />
  )

  act(() => {
    root.render(options.strict ? <StrictMode>{input}</StrictMode> : input)
  })

  return { container, root, onSend }
}

function pngFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "tiny.png", {
    type: "image/png",
  })
}

function imageFile(name: string, type: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type })
}

async function chooseFiles(container: HTMLElement, files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error("file input not found")
  Object.defineProperty(input, "files", {
    value: files,
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
  })
}

async function chooseFile(container: HTMLElement, file = pngFile()): Promise<void> {
  await chooseFiles(container, [file])
}

async function pasteFiles(
  container: HTMLElement,
  files: File[],
  text = "",
): Promise<void> {
  const textarea = container.querySelector("textarea")
  if (!textarea) throw new Error("textarea not found")
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  })
  await act(async () => {
    textarea.dispatchEvent(event)
    await Promise.resolve()
  })
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

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function buttonByTitle(container: HTMLElement, title: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
  if (!button) throw new Error(`button not found: ${title}`)
  return button
}

function useDeferredFileReader(): void {
  deferredFileReaders.length = 0
  globalThis.FileReader = DeferredFileReader as unknown as typeof FileReader
}

async function resolveDeferredFileReader(index = 0): Promise<void> {
  const reader = deferredFileReaders[index]
  if (!reader) throw new Error(`deferred reader not found: ${index}`)
  await act(async () => {
    reader.onload?.()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function modeScroller(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-testid="chat-mode-scroll"]')
  if (!scroller) throw new Error("mode scroller not found")
  return scroller
}

async function setModeScrollMetrics(
  scroller: HTMLElement,
  metrics: { clientWidth: number; scrollWidth: number; scrollLeft: number },
): Promise<void> {
  Object.defineProperty(scroller, "clientWidth", {
    value: metrics.clientWidth,
    configurable: true,
  })
  Object.defineProperty(scroller, "scrollWidth", {
    value: metrics.scrollWidth,
    configurable: true,
  })
  Object.defineProperty(scroller, "scrollLeft", {
    value: metrics.scrollLeft,
    configurable: true,
  })
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
    window.dispatchEvent(new Event("resize"))
    await Promise.resolve()
  })
}

describe("ChatInput image attachments", () => {
  let originalFileReader: typeof FileReader

  beforeEach(() => {
    originalFileReader = globalThis.FileReader
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
  })

  afterEach(() => {
    globalThis.FileReader = originalFileReader
    document.body.innerHTML = ""
    vi.clearAllMocks()
  })

  it("reads a picked png, renders preview/removal, sends raw base64, then clears preview", async () => {
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "describe this")
    await chooseFile(container)

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    )
    expect(buttonByTitle(container, "Remove image").className).toContain("opacity-100")
    expect(buttonByTitle(container, "Remove image").className).toContain("sm:opacity-0")

    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "describe this",
      [{ mediaType: "image/png", dataBase64: PNG_BASE64 }],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )
    expect(container.querySelector("img")).toBeNull()

    act(() => root.unmount())
  })

  it("shows a processing tile and disables send while an image is still reading", async () => {
    useDeferredFileReader()
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "describe this")
    await chooseFile(container)

    expect(container.querySelector('[role="status"]')?.textContent).toContain("tiny.png")
    expect(container.querySelector("img")).toBeNull()
    expect(buttonByTitle(container, "Send message").disabled).toBe(true)

    await clickButton(buttonByTitle(container, "Send message"))
    expect(onSend).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it("replaces the processing tile with a preview and sends after the read completes", async () => {
    useDeferredFileReader()
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "describe this")
    await chooseFile(container)
    await resolveDeferredFileReader()

    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    )
    expect(buttonByTitle(container, "Send message").disabled).toBe(false)

    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "describe this",
      [{ mediaType: "image/png", dataBase64: PNG_BASE64 }],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )

    act(() => root.unmount())
  })

  it("resolves pending images after StrictMode effect replay", async () => {
    useDeferredFileReader()
    const { container, root } = renderChatInput({}, { strict: true })

    await chooseFile(container)
    await resolveDeferredFileReader()

    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    )

    act(() => root.unmount())
  })

  it("does not attach a pending image that was removed before read completion", async () => {
    useDeferredFileReader()
    const { container, root, onSend } = renderChatInput()

    await chooseFile(container)
    await clickButton(buttonByTitle(container, "Remove image"))
    await resolveDeferredFileReader()
    await typeText(container, "text only")
    await clickButton(buttonByTitle(container, "Send message"))

    expect(container.querySelector("img")).toBeNull()
    expect(onSend).toHaveBeenCalledWith(
      "text only",
      [],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )

    act(() => root.unmount())
  })

  it("preserves multi-image selection order when reads finish out of order", async () => {
    useDeferredFileReader()
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "compare these")
    await chooseFiles(container, [
      imageFile("first.png", "image/png"),
      imageFile("second.webp", "image/webp"),
    ])

    await resolveDeferredFileReader(1)
    await resolveDeferredFileReader(0)
    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "compare these",
      [
        { mediaType: "image/png", dataBase64: PNG_BASE64 },
        { mediaType: "image/webp", dataBase64: PNG_BASE64 },
      ],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )

    act(() => root.unmount())
  })

  it("preserves pasted text when the clipboard also contains an image", async () => {
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "caption: ")
    await pasteFiles(container, [pngFile()], "pasted text")
    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "caption: pasted text",
      [{ mediaType: "image/png", dataBase64: PNG_BASE64 }],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )

    act(() => root.unmount())
  })

  it("reads pasted png files into the same image attachment path", async () => {
    const { container, root, onSend } = renderChatInput()

    await typeText(container, "from paste")
    await pasteFiles(container, [pngFile()])

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    )
    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "from paste",
      [{ mediaType: "image/png", dataBase64: PNG_BASE64 }],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )

    act(() => root.unmount())
  })

  it("removes a selected image before sending", async () => {
    const { container, root, onSend } = renderChatInput()

    await chooseFile(container)
    await clickButton(buttonByTitle(container, "Remove image"))

    expect(container.querySelector("img")).toBeNull()
    expect(buttonByTitle(container, "Send message").disabled).toBe(true)
    await clickButton(buttonByTitle(container, "Send message"))
    expect(onSend).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it("disables image attach when image input is unavailable and does not send image-only", async () => {
    const { container, root, onSend } = renderChatInput({
      imageInputAvailable: false,
    })

    expect(buttonByTitle(container, "Images are available in Chat mode only.").disabled).toBe(true)

    await chooseFile(container)
    expect(container.querySelector("img")).toBeNull()

    const send = buttonByTitle(container, "Send message")
    expect(send.disabled).toBe(true)
    await clickButton(send)
    expect(onSend).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it("rejects unsupported image types", async () => {
    const { container, root, onSend } = renderChatInput()

    await chooseFile(container, imageFile("vector.svg", "image/svg+xml"))

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("Unsupported image type: image/svg+xml")
    await clickButton(buttonByTitle(container, "Send message"))
    expect(onSend).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it("rejects oversized images", async () => {
    const { container, root, onSend } = renderChatInput()

    await chooseFile(
      container,
      imageFile("huge.png", "image/png", MAX_CHAT_IMAGE_BYTES + 1),
    )

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("huge.png is larger than 5 MB.")
    await clickButton(buttonByTitle(container, "Send message"))
    expect(onSend).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it("caps each message at the maximum image count", async () => {
    const { container, root, onSend } = renderChatInput()
    const files = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, (_, index) =>
      imageFile(`tiny-${index}.png`, "image/png"),
    )

    await chooseFiles(container, files)

    expect(container.querySelectorAll("img")).toHaveLength(MAX_CHAT_IMAGES_PER_MESSAGE)
    expect(container.textContent).toContain(
      `Attach up to ${MAX_CHAT_IMAGES_PER_MESSAGE} images.`,
    )

    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][1]).toHaveLength(MAX_CHAT_IMAGES_PER_MESSAGE)
    expect(onSend.mock.calls[0][1]).toEqual(
      Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE }, () => ({
        mediaType: "image/png",
        dataBase64: PNG_BASE64,
      })),
    )

    act(() => root.unmount())
  })

  it("allows image-only normal Chat sends", async () => {
    const { container, root, onSend } = renderChatInput()

    await chooseFile(container)
    await clickButton(buttonByTitle(container, "Send message"))

    expect(onSend).toHaveBeenCalledWith(
      "",
      [{ mediaType: "image/png", dataBase64: PNG_BASE64 }],
      { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" },
    )
    expect(container.querySelector("img")).toBeNull()

    act(() => root.unmount())
  })

  it("shows mode selector fades only on overflowing scroll edges", async () => {
    const { container, root } = renderChatInput({ showSearchToggles: true })
    const scroller = modeScroller(container)

    await setModeScrollMetrics(scroller, {
      clientWidth: 120,
      scrollWidth: 240,
      scrollLeft: 0,
    })

    expect(container.querySelector('[data-testid="chat-mode-fade-left"]')).toBeNull()
    expect(container.querySelector('[data-testid="chat-mode-fade-right"]')).not.toBeNull()

    await setModeScrollMetrics(scroller, {
      clientWidth: 120,
      scrollWidth: 240,
      scrollLeft: 120,
    })

    expect(container.querySelector('[data-testid="chat-mode-fade-left"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="chat-mode-fade-right"]')).toBeNull()

    await setModeScrollMetrics(scroller, {
      clientWidth: 240,
      scrollWidth: 240,
      scrollLeft: 0,
    })

    expect(container.querySelector('[data-testid="chat-mode-fade-left"]')).toBeNull()
    expect(container.querySelector('[data-testid="chat-mode-fade-right"]')).toBeNull()

    act(() => root.unmount())
  })
})
