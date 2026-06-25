import { describe, expect, it } from "vitest"
import { isAcceptedChatImageType, messageImageToDataUrl } from "./chat-image-utils"

describe("chat image utilities", () => {
  it("accepts only chat-supported image MIME types", () => {
    expect(isAcceptedChatImageType("image/png")).toBe(true)
    expect(isAcceptedChatImageType("image/jpeg")).toBe(true)
    expect(isAcceptedChatImageType("image/webp")).toBe(true)
    expect(isAcceptedChatImageType("image/gif")).toBe(true)
    expect(isAcceptedChatImageType("image/svg+xml")).toBe(false)
    expect(isAcceptedChatImageType("text/plain")).toBe(false)
  })

  it("renders persisted message images as data URLs", () => {
    expect(
      messageImageToDataUrl({ mediaType: "image/png", dataBase64: "AAAA" }),
    ).toBe("data:image/png;base64,AAAA")
  })
})
