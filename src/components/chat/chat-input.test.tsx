// @vitest-environment jsdom

import { act } from "react"
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

function renderChatInput(
  props: Partial<React.ComponentProps<typeof ChatInput>> = {},
): {
  container: HTMLDivElement
  root: Root
  onSend: ReturnType<typeof vi.fn>
} {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  const onSend = vi.fn()

  act(() => {
    root.render(
      <ChatInput
        onSend={onSend}
        onStop={() => undefined}
        isStreaming={false}
        showSearchToggles={false}
        {...props}
      />,
    )
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
      { useWebSearch: false, useAnyTxtSearch: false },
    )
    expect(container.querySelector("img")).toBeNull()

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
      { useWebSearch: false, useAnyTxtSearch: false },
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
      { useWebSearch: false, useAnyTxtSearch: false },
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
      { useWebSearch: false, useAnyTxtSearch: false },
    )
    expect(container.querySelector("img")).toBeNull()

    act(() => root.unmount())
  })
})
