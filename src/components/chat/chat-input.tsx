import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { ChevronDown, FileSearch, Globe2, Loader2, Plus, Send, Square, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ACCEPTED_CHAT_IMAGE_TYPES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_MB,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  fileToMessageImage,
  isAcceptedChatImageType,
  messageImageToDataUrl,
} from "@/lib/chat-image-utils"
import { isImeComposing } from "@/lib/keyboard-utils"
import type { MessageImage } from "@/stores/chat-store"

const ACCEPTED_IMAGE_ACCEPT = ACCEPTED_CHAT_IMAGE_TYPES.join(",")

export interface ChatSendOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
}

interface ChatInputProps {
  onSend: (text: string, images: MessageImage[], options: ChatSendOptions) => void
  onStop: () => void
  isStreaming: boolean
  anyTxtAvailable?: boolean
  imageInputAvailable?: boolean
  placeholder?: string
}

interface ImageAttachment {
  id: string
  name: string
  image?: MessageImage
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  anyTxtAvailable = true,
  imageInputAvailable = true,
  placeholder,
}: ChatInputProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState("")
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [useWebSearch, setUseWebSearch] = useState(false)
  const [useAnyTxtSearch, setUseAnyTxtSearch] = useState(false)
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sourceMenuRef = useRef<HTMLDivElement>(null)
  const pendingImageIdsRef = useRef(new Set<string>())
  const imageIdRef = useRef(0)
  const images = useMemo(
    () => imageAttachments.flatMap((attachment) => (attachment.image ? [attachment.image] : [])),
    [imageAttachments],
  )
  const hasPendingImages = imageAttachments.some((attachment) => !attachment.image)

  useEffect(() => {
    return () => {
      pendingImageIdsRef.current.clear()
    }
  }, [])

  const clearImageAttachments = useCallback(() => {
    pendingImageIdsRef.current.clear()
    setImageAttachments([])
  }, [])

  useEffect(() => {
    if (!anyTxtAvailable) setUseAnyTxtSearch(false)
  }, [anyTxtAvailable])

  useEffect(() => {
    if (imageInputAvailable || imageAttachments.length === 0) return
    clearImageAttachments()
    setImageError(null)
  }, [clearImageAttachments, imageAttachments.length, imageInputAvailable])

  useEffect(() => {
    if (!sourceMenuOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && sourceMenuRef.current?.contains(target)) return
      setSourceMenuOpen(false)
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [sourceMenuOpen])

  useEffect(() => {
    if (isStreaming) setSourceMenuOpen(false)
  }, [isStreaming])

  const addFiles = useCallback(
    (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith("image/"))
      if (imageFiles.length === 0) return
      if (!imageInputAvailable) {
        setImageError(t("chat.imageInputUnavailable", "Images are available in Chat mode only."))
        return
      }

      let error: string | null = null
      let remaining = MAX_CHAT_IMAGES_PER_MESSAGE - imageAttachments.length

      for (const file of imageFiles) {
        if (remaining <= 0) {
          error = t("chat.tooManyImages", "Attach up to {{max}} images.", {
            max: MAX_CHAT_IMAGES_PER_MESSAGE,
          })
          break
        }
        if (!isAcceptedChatImageType(file.type)) {
          error = t("chat.unsupportedImageType", "Unsupported image type: {{type}}", {
            type: file.type || "?",
          })
          continue
        }
        if (file.size > MAX_CHAT_IMAGE_BYTES) {
          error = t("chat.imageTooLarge", "{{name}} is larger than {{max}} MB.", {
            name: file.name || "image",
            max: MAX_CHAT_IMAGE_MB,
          })
          continue
        }

        const id = `chat-image-${Date.now()}-${imageIdRef.current++}`
        remaining -= 1
        pendingImageIdsRef.current.add(id)
        setImageAttachments((prev) => [...prev, { id, name: file.name || "image" }])
        void fileToMessageImage(file)
          .then((image) => {
            if (!pendingImageIdsRef.current.has(id)) return
            pendingImageIdsRef.current.delete(id)
            setImageAttachments((prev) =>
              prev.map((attachment) =>
                attachment.id === id ? { ...attachment, image } : attachment,
              ),
            )
          })
          .catch(() => {
            if (!pendingImageIdsRef.current.has(id)) return
            pendingImageIdsRef.current.delete(id)
            setImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
            setImageError(t("chat.imageReadFailed", "Could not read image."))
          })
      }
      setImageError(error)
    },
    [imageAttachments.length, imageInputAvailable, t],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (isStreaming) return
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (files.length === 0) return
      e.preventDefault()
      const pastedText = e.clipboardData.getData("text/plain")
      if (pastedText) {
        const textarea = e.currentTarget
        const start = textarea.selectionStart ?? textarea.value.length
        const end = textarea.selectionEnd ?? textarea.value.length
        const nextValue = `${textarea.value.slice(0, start)}${pastedText}${textarea.value.slice(end)}`
        setValue(nextValue)
        const cursor = start + pastedText.length
        requestAnimationFrame(() => {
          textarea.selectionStart = cursor
          textarea.selectionEnd = cursor
          textarea.style.height = "auto"
          textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
        })
      }
      void addFiles(files)
    },
    [addFiles, isStreaming],
  )

  const handleFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : []
      void addFiles(files)
      e.target.value = ""
    },
    [addFiles],
  )

  const removeImageAttachment = useCallback((id: string) => {
    pendingImageIdsRef.current.delete(id)
    setImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
    setImageError(null)
  }, [])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const ta = e.target
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if ((!trimmed && images.length === 0) || hasPendingImages || isStreaming) return
    if (images.length > 0 && !imageInputAvailable) {
      setImageError(t("chat.imageInputUnavailable", "Images are available in Chat mode only."))
      return
    }
    onSend(trimmed, images, { useWebSearch, useAnyTxtSearch })
    setValue("")
    clearImageAttachments()
    setImageError(null)
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [
    imageInputAvailable,
    images,
    isStreaming,
    clearImageAttachments,
    hasPendingImages,
    onSend,
    t,
    useAnyTxtSearch,
    useWebSearch,
    value,
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Don't submit on the Enter that commits an IME candidate —
      // the user is mid-composition (Chinese / Japanese / Korean
      // input method picking an English word or phrase) and would
      // see the message fire before they finished typing.
      if (isImeComposing(e)) return
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const searchToggleClass = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
      active
        ? "border-border bg-accent text-foreground shadow-sm"
        : "border-transparent bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    } disabled:pointer-events-none disabled:opacity-50`

  const sourceToggleClass = (active: boolean) =>
    `flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    } disabled:pointer-events-none disabled:opacity-50`

  return (
    <div className="border-t bg-background/95 p-3">
      <div className="rounded-lg border border-border/80 bg-card/80 p-2 shadow-sm ring-1 ring-black/5 focus-within:border-ring/60 focus-within:ring-ring/20 dark:ring-white/5">
        {imageAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {imageAttachments.map((attachment) =>
              attachment.image ? (
                <div key={attachment.id} className="group relative h-16 w-16 overflow-hidden rounded-md border border-border/70">
                  <img
                    src={messageImageToDataUrl(attachment.image)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-100 shadow-sm transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    title={t("chat.removeImage", "Remove image")}
                    aria-label={t("chat.removeImage", "Remove image")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <div
                  key={attachment.id}
                  role="status"
                  aria-live="polite"
                  aria-label={t("chat.imageProcessing", "Processing image")}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-border/70 bg-muted/60"
                >
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="max-w-full truncate text-[10px] leading-3">
                      {attachment.name}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-100 shadow-sm transition-opacity hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    title={t("chat.removeImage", "Remove image")}
                    aria-label={t("chat.removeImage", "Remove image")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        {imageError && (
          <p className="mb-1 px-1 text-xs text-destructive">{imageError}</p>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          dir="auto"
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? "Type a message... (Enter to send, Shift+Enter for newline)"}
          disabled={isStreaming}
          rows={1}
          className="block w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: "120px", overflowY: "auto" }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_ACCEPT}
          multiple
          className="hidden"
          onChange={handleFilePick}
        />
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                isStreaming ||
                !imageInputAvailable ||
                imageAttachments.length >= MAX_CHAT_IMAGES_PER_MESSAGE
              }
              className={searchToggleClass(false)}
              title={
                imageInputAvailable
                  ? t("chat.attachImage", "Attach image")
                  : t("chat.imageInputUnavailable", "Images are available in Chat mode only.")
              }
              aria-label={t("chat.attachImage", "Attach image")}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <div ref={sourceMenuRef} className="relative">
              <button
                type="button"
                aria-expanded={sourceMenuOpen}
                onClick={() => setSourceMenuOpen((open) => !open)}
                disabled={isStreaming}
                className={searchToggleClass(useWebSearch || useAnyTxtSearch)}
              >
                <Globe2 className="h-3.5 w-3.5" />
                {t("chat.sources")}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {sourceMenuOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-md border bg-popover p-2 shadow-md">
                  <button
                    type="button"
                    aria-pressed={useWebSearch}
                    onClick={() => {
                      setUseWebSearch((v) => !v)
                      setSourceMenuOpen(false)
                    }}
                    disabled={isStreaming}
                    className={sourceToggleClass(useWebSearch)}
                  >
                    <span className="flex min-w-0 items-start gap-2">
                      <Globe2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="flex min-w-0 flex-col">
                        <span>{t("chat.useWebSearch")}</span>
                        <span className="text-[11px] leading-4 text-muted-foreground">
                          {t("chat.webSearchOffHint")}
                        </span>
                      </span>
                    </span>
                    <span className={`h-2 w-2 shrink-0 rounded-full ${useWebSearch ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                  </button>
                  <TooltipProvider delay={0}>
                    <Tooltip>
                      <TooltipTrigger render={<span className="mt-1 block" />}>
                        <button
                          type="button"
                          aria-pressed={useAnyTxtSearch}
                          onClick={() => {
                            setUseAnyTxtSearch((v) => !v)
                            setSourceMenuOpen(false)
                          }}
                          disabled={isStreaming || !anyTxtAvailable}
                          className={sourceToggleClass(useAnyTxtSearch)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <FileSearch className="h-3.5 w-3.5 shrink-0" />
                            <span>{t("chat.useAnyTxtSearch")}</span>
                          </span>
                          <span className={`h-2 w-2 shrink-0 rounded-full ${useAnyTxtSearch ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                        </button>
                      </TooltipTrigger>
                      {!anyTxtAvailable && (
                        <TooltipContent side="top" className="max-w-64 whitespace-normal leading-relaxed">
                          {t("chat.enableAnyTxtInSettings")}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </div>
              )}
            </div>
          </div>
          {isStreaming ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={onStop}
              className="h-8 shrink-0 gap-1.5 rounded-md px-3"
              title={t("chat.stopGeneration")}
            >
              <Square className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("chat.stopGeneration")}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleSend}
              disabled={hasPendingImages || (!value.trim() && images.length === 0)}
              className="h-8 shrink-0 gap-1.5 rounded-md px-3"
              title={t("chat.sendMessage")}
            >
              <Send className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("chat.sendMessage")}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
