import { describe, expect, it } from "vitest"
import { chatMessagesToLLM, type DisplayMessage } from "./chat-store"

function msg(
  partial: Partial<DisplayMessage> & Pick<DisplayMessage, "role" | "content">,
): DisplayMessage {
  return {
    id: partial.id ?? "m1",
    timestamp: 0,
    conversationId: "conv-1",
    ...partial,
  }
}

describe("chatMessagesToLLM multimodal conversion", () => {
  it("keeps legacy string content for text-only messages", () => {
    expect(chatMessagesToLLM([msg({ role: "user", content: "hello" })])).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  it("converts normal chat text and images into provider ContentBlock[]", () => {
    const out = chatMessagesToLLM([
      msg({
        role: "user",
        content: "what is this?",
        images: [
          { mediaType: "image/png", dataBase64: "AAAA" },
          { mediaType: "image/jpeg", dataBase64: "BBBB" },
        ],
      }),
    ])

    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mediaType: "image/png", dataBase64: "AAAA" },
          { type: "image", mediaType: "image/jpeg", dataBase64: "BBBB" },
        ],
      },
    ])
  })

  it("omits empty text blocks for image-only normal chat messages", () => {
    expect(
      chatMessagesToLLM([
        msg({
          role: "user",
          content: "",
          images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
        }),
        msg({
          role: "user",
          content: "   ",
          images: [{ mediaType: "image/jpeg", dataBase64: "BBBB" }],
        }),
      ]),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", dataBase64: "AAAA" }],
      },
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/jpeg", dataBase64: "BBBB" }],
      },
    ])
  })

  it("preserves caller history truncation", () => {
    const history = [
      msg({ id: "m1", role: "user", content: "old" }),
      msg({ id: "m2", role: "assistant", content: "middle" }),
      msg({ id: "m3", role: "user", content: "new" }),
    ]

    expect(chatMessagesToLLM(history.slice(-2))).toEqual([
      { role: "assistant", content: "middle" },
      { role: "user", content: "new" },
    ])
  })

  it("does not emit image blocks for agent or ingest-origin messages", () => {
    const images = [{ mediaType: "image/png", dataBase64: "AAAA" }]

    expect(
      chatMessagesToLLM([
        msg({ role: "user", content: "agent text", mode: "agent", images }),
        msg({ role: "user", content: "ingest text", mode: "ingest", images }),
      ]),
    ).toEqual([
      { role: "user", content: "agent text" },
      { role: "user", content: "ingest text" },
    ])
  })
})
