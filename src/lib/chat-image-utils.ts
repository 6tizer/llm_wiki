import type { MessageImage } from "@/stores/chat-store"

/** Image MIME types accepted by the existing provider ContentBlock translators. */
export const ACCEPTED_CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

/** Per-image cap for chat attachments before base64 expansion/persistence. */
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CHAT_IMAGE_MB = 5

/** Max images attached to one normal Chat message. */
export const MAX_CHAT_IMAGES_PER_MESSAGE = 5

export function isAcceptedChatImageType(type: string): boolean {
  return (ACCEPTED_CHAT_IMAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Read a browser File/Blob into the local chat image shape.
 * `dataBase64` is raw base64; provider adapters add `data:` framing.
 */
export function fileToMessageImage(file: File | Blob): Promise<MessageImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"))
        return
      }
      const comma = result.indexOf(",")
      resolve({
        mediaType: file.type || "image/png",
        dataBase64: comma >= 0 ? result.slice(comma + 1) : result,
      })
    }
    reader.readAsDataURL(file)
  })
}

/** Build a renderable data URL from a persisted chat image. */
export function messageImageToDataUrl(image: MessageImage): string {
  return `data:${image.mediaType};base64,${image.dataBase64}`
}
