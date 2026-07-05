// @vitest-environment jsdom

import { act } from "react"
import type { ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { TaskMatrixSection } from "./task-matrix-section"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileList: vi.fn(),
  runtimeProfileUpdate: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)

const projectStoreMocks = vi.hoisted(() => ({
  saveEmbeddingConfig: vi.fn(),
  saveMultimodalConfig: vi.fn(),
}))

const embeddingMocks = vi.hoisted(() => ({
  dropLegacyVectorTable: vi.fn(),
  embedAllPages: vi.fn(),
  getEmbeddingCount: vi.fn(),
  getLastEmbeddingError: vi.fn(),
  legacyVectorRowCount: vi.fn(),
}))

const connectionTestMocks = vi.hoisted(() => ({
  testEmbeddingConnection: vi.fn(),
  testEmbeddingFunction: vi.fn(),
}))

vi.mock("@/lib/project-store", () => projectStoreMocks)
vi.mock("@/lib/embedding", () => embeddingMocks)
vi.mock("@/lib/connection-tests", () => connectionTestMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "Primary profile",
    providerId: "anthropic",
    modelId: "claude-sonnet",
    agentSdkModelId: null,
    endpoint: null,
    apiMode: "anthropic-messages",
    authStyle: "x-api-key",
    secretRef: null,
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "unknown",
    capabilityJson: "{}",
    capabilityVersion: "spec-4-pr1",
    capabilityCheckedAtMs: null,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderSection(
  props: Partial<ComponentProps<typeof TaskMatrixSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<TaskMatrixSection {...props} />)
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function changeTextarea(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
  await act(async () => {
    setter?.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("TaskMatrixSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      project: { id: "p1", name: "Project", path: "/project" },
      embeddingConfig: {
        enabled: false,
        endpoint: "",
        apiKey: "",
        model: "",
      },
      multimodalConfig: {
        enabled: false,
        useMainLlm: true,
        provider: "custom",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        apiMode: "chat_completions",
        concurrency: 4,
      },
    })
    projectStoreMocks.saveEmbeddingConfig.mockResolvedValue(undefined)
    projectStoreMocks.saveMultimodalConfig.mockResolvedValue(undefined)
    embeddingMocks.getEmbeddingCount.mockResolvedValue(0)
    embeddingMocks.legacyVectorRowCount.mockResolvedValue(0)
    embeddingMocks.getLastEmbeddingError.mockReturnValue(null)
    embeddingMocks.embedAllPages.mockResolvedValue(3)
    embeddingMocks.dropLegacyVectorTable.mockResolvedValue(undefined)
    connectionTestMocks.testEmbeddingConnection.mockResolvedValue({ ok: true, message: "connected" })
    connectionTestMocks.testEmbeddingFunction.mockResolvedValue({ ok: true, message: "functional" })
  })

  it("labels effective and not-yet-wired task families and expands embedding and vision configuration inline", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='task-matrix-status-agent']")?.textContent).toContain("Effective")
    expect(container.querySelector("[data-testid='task-matrix-status-ingest']")?.textContent).toContain("Effective")
    expect(container.querySelector("[data-testid='task-matrix-status-review']")?.textContent).toContain("Not wired")

    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    const visionLink = container.querySelector("[data-testid='task-matrix-config-vision']")
    if (!embeddingLink || !visionLink) throw new Error("configuration links not found")

    await click(embeddingLink)
    expect(container.querySelector("[data-testid='task-matrix-inline-embedding']")).not.toBeNull()

    await click(visionLink)
    expect(container.querySelector("[data-testid='task-matrix-inline-vision']")).not.toBeNull()
    expect(container.querySelector("[data-testid='task-matrix-inline-embedding']")).toBeNull()

    unmount(root)
  })

  it("persists embedding inline edits immediately", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()

    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    if (!embeddingLink) throw new Error("embedding configuration link not found")
    await click(embeddingLink)

    const enabled = container.querySelector("[data-testid='embedding-inline-enabled']")
    if (!enabled) throw new Error("embedding enable toggle not found")
    await click(enabled)
    await flush()

    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    )

    const endpoint = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-endpoint']")
    if (!endpoint) throw new Error("embedding endpoint input not found")
    await changeInput(endpoint, "http://127.0.0.1:1234/v1/embeddings")

    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: "http://127.0.0.1:1234/v1/embeddings" }),
    )

    unmount(root)
  })

  it("keeps partial extra header input local and persists parsed headers once complete", async () => {
    useWikiStore.setState({
      embeddingConfig: {
        enabled: true,
        endpoint: "",
        apiKey: "",
        model: "",
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()
    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    if (!embeddingLink) throw new Error("embedding configuration link not found")
    await click(embeddingLink)

    const headers = container.querySelector<HTMLTextAreaElement>("[data-testid='embedding-inline-extra-headers']")
    if (!headers) throw new Error("headers textarea not found")
    await changeTextarea(headers, "X-Fo")

    expect(headers.value).toBe("X-Fo")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ extraHeaders: {} }),
    )

    await changeTextarea(headers, "X-Foo: bar")
    expect(headers.value).toBe("X-Foo: bar")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ extraHeaders: { "X-Foo": "bar" } }),
    )

    unmount(root)
  })

  it("persists embedding detailed fields and shows success feedback", async () => {
    useWikiStore.setState({
      embeddingConfig: {
        enabled: true,
        endpoint: "",
        apiKey: "",
        model: "",
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()
    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    if (!embeddingLink) throw new Error("embedding configuration link not found")
    await click(embeddingLink)

    const apiKey = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-api-key']")
    const model = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-model']")
    const outputDimensionality = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-output-dimensionality']")
    const maxChunkChars = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-max-chunk-chars']")
    const overlapChunkChars = container.querySelector<HTMLInputElement>("[data-testid='embedding-inline-overlap-chunk-chars']")
    if (!apiKey || !model || !outputDimensionality || !maxChunkChars || !overlapChunkChars) {
      throw new Error("embedding detail inputs not found")
    }

    await changeInput(apiKey, "embed-key")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "embed-key" }))
    await changeInput(model, "text-embedding-3-large")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(expect.objectContaining({ model: "text-embedding-3-large" }))
    await changeInput(outputDimensionality, "1024")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(expect.objectContaining({ outputDimensionality: 1024 }))
    await changeInput(maxChunkChars, "1200")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(expect.objectContaining({ maxChunkChars: 1200 }))
    await changeInput(overlapChunkChars, "150")
    expect(projectStoreMocks.saveEmbeddingConfig).toHaveBeenLastCalledWith(expect.objectContaining({ overlapChunkChars: 150 }))
    expect(container.textContent).toContain("Configuration saved.")

    unmount(root)
  })

  it("rolls back embedding inline edits and shows failure feedback when persist fails", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    projectStoreMocks.saveEmbeddingConfig.mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    await flush()
    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    if (!embeddingLink) throw new Error("embedding configuration link not found")
    await click(embeddingLink)
    const enabled = container.querySelector<HTMLButtonElement>("[data-testid='embedding-inline-enabled']")
    if (!enabled) throw new Error("embedding enable toggle not found")

    await click(enabled)
    await flush()

    expect(useWikiStore.getState().embeddingConfig.enabled).toBe(false)
    expect(container.textContent).toContain("Configuration save failed: disk full")

    unmount(root)
  })

  it("persists vision inline edits immediately", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()

    const visionLink = container.querySelector("[data-testid='task-matrix-config-vision']")
    if (!visionLink) throw new Error("vision configuration link not found")
    await click(visionLink)

    const enabled = container.querySelector("[data-testid='multimodal-inline-enabled']")
    if (!enabled) throw new Error("vision enable toggle not found")
    await click(enabled)
    await flush()

    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    )

    unmount(root)
  })

  it("persists vision detailed fields and shows success feedback", async () => {
    useWikiStore.setState({
      multimodalConfig: {
        enabled: true,
        useMainLlm: true,
        provider: "custom",
        apiKey: "",
        model: "",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        apiMode: "chat_completions",
        concurrency: 4,
      },
    })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()
    const visionLink = container.querySelector("[data-testid='task-matrix-config-vision']")
    if (!visionLink) throw new Error("vision configuration link not found")
    await click(visionLink)

    const useMain = container.querySelector("[aria-label='Use main LLM for captions']")
    if (!useMain) throw new Error("use main toggle not found")
    await click(useMain)
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ useMainLlm: false }))

    const provider = container.querySelector<HTMLSelectElement>("[data-testid='multimodal-inline-provider']")
    if (!provider) throw new Error("provider select not found")
    await changeSelect(provider, "azure")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "azure" }))

    const endpoint = container.querySelector<HTMLInputElement>("[data-testid='multimodal-inline-endpoint']")
    const apiKey = container.querySelector<HTMLInputElement>("[data-testid='multimodal-inline-api-key']")
    const model = container.querySelector<HTMLInputElement>("[data-testid='multimodal-inline-model']")
    const concurrency = container.querySelector<HTMLInputElement>("[data-testid='multimodal-inline-concurrency']")
    const azureApiVersion = container.querySelector<HTMLInputElement>("[data-testid='multimodal-inline-azure-api-version']")
    const azureModelFamily = container.querySelector<HTMLSelectElement>("[data-testid='multimodal-inline-azure-model-family']")
    if (!endpoint || !apiKey || !model || !concurrency || !azureApiVersion || !azureModelFamily) {
      throw new Error("vision detail inputs not found")
    }

    await changeInput(endpoint, "https://vision.example.com")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ customEndpoint: "https://vision.example.com" }))
    await changeInput(apiKey, "vision-key")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "vision-key" }))
    await changeInput(model, "vision-deployment")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ model: "vision-deployment" }))
    await changeInput(concurrency, "6")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ concurrency: 6 }))
    await changeInput(azureApiVersion, "2025-01-01")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ azureApiVersion: "2025-01-01" }))
    await changeSelect(azureModelFamily, "gpt5")
    expect(projectStoreMocks.saveMultimodalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ azureModelFamily: "gpt5" }))
    expect(container.textContent).toContain("Configuration saved.")

    unmount(root)
  })

  it("rolls back vision inline edits and shows failure feedback when persist fails", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    projectStoreMocks.saveMultimodalConfig.mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    await flush()
    const visionLink = container.querySelector("[data-testid='task-matrix-config-vision']")
    if (!visionLink) throw new Error("vision configuration link not found")
    await click(visionLink)
    const enabled = container.querySelector<HTMLButtonElement>("[data-testid='multimodal-inline-enabled']")
    if (!enabled) throw new Error("vision enable toggle not found")

    await click(enabled)
    await flush()

    expect(useWikiStore.getState().multimodalConfig.enabled).toBe(false)
    expect(container.textContent).toContain("Configuration save failed: disk full")

    unmount(root)
  })

  it("runs embedding reindex, legacy drop, and provider test actions", async () => {
    useWikiStore.setState({
      embeddingConfig: {
        enabled: true,
        endpoint: "http://127.0.0.1:1234/v1/embeddings",
        apiKey: "",
        model: "embed-model",
      },
    })
    embeddingMocks.getEmbeddingCount.mockResolvedValueOnce(0)
    embeddingMocks.legacyVectorRowCount.mockResolvedValueOnce(2)
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })

    const { container, root } = renderSection()
    await flush()
    const embeddingLink = container.querySelector("[data-testid='task-matrix-config-embedding']")
    if (!embeddingLink) throw new Error("embedding configuration link not found")
    await click(embeddingLink)
    await flush()

    const reindex = container.querySelector("[data-testid='embedding-inline-reindex']")
    const dropLegacy = container.querySelector("[data-testid='embedding-inline-drop-legacy']")
    const testConnection = container.querySelector("[data-testid='embedding-inline-test-connection']")
    const testFunction = container.querySelector("[data-testid='embedding-inline-test-function']")
    if (!reindex || !dropLegacy || !testConnection || !testFunction) {
      throw new Error("embedding action buttons not found")
    }

    await click(dropLegacy)
    expect(embeddingMocks.dropLegacyVectorTable).toHaveBeenCalledWith("/project")
    await click(reindex)
    expect(embeddingMocks.embedAllPages).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ model: "embed-model" }),
      expect.any(Function),
      { clearExisting: true },
    )
    await click(testConnection)
    expect(connectionTestMocks.testEmbeddingConnection).toHaveBeenCalledWith(expect.objectContaining({ model: "embed-model" }))
    await click(testFunction)
    expect(connectionTestMocks.testEmbeddingFunction).toHaveBeenCalledWith(expect.objectContaining({ model: "embed-model" }))

    unmount(root)
  })

  it("updates only profileId and taskFamilies when toggling an assignment", async () => {
    const updated = runtimeProfile({ taskFamilies: ["chat", "ingest"] })
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(updated)

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector("[data-testid='task-matrix-profile-1-ingest']")
    if (!ingestToggle) throw new Error("ingest toggle not found")

    await click(ingestToggle)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith({
      profileId: "profile-1",
      taskFamilies: ["chat", "ingest"],
    })

    unmount(root)
  })

  it("disables every cell for the same profile while a toggle update is in flight", async () => {
    const pending = deferred<RuntimeProfileRecord>()
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockReturnValueOnce(pending.promise)

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-ingest']")
    const reviewToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-review']")
    if (!ingestToggle || !reviewToggle) throw new Error("matrix toggles not found")

    await click(ingestToggle)

    expect(reviewToggle.disabled).toBe(true)
    await click(reviewToggle)
    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(runtimeProfile({ taskFamilies: ["chat", "ingest"] }))
      await Promise.resolve()
    })

    unmount(root)
  })

  it("rolls back the checkbox and shows a save failure when update rejects", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockRejectedValueOnce(new Error("update rejected"))

    const { container, root } = renderSection()
    await flush()

    const ingestToggle = container.querySelector<HTMLInputElement>("[data-testid='task-matrix-profile-1-ingest']")
    if (!ingestToggle) throw new Error("ingest toggle not found")

    await click(ingestToggle)

    expect(ingestToggle.checked).toBe(false)
    expect(container.textContent).toContain("Save failed: update rejected")

    unmount(root)
  })

  it("keeps not-yet-wired labels visible and only updates taskFamilies", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile()],
    })
    runtimeDbMocks.runtimeProfileUpdate.mockResolvedValueOnce(runtimeProfile({ taskFamilies: ["chat", "review"] }))

    const { container, root } = renderSection()
    await flush()

    const reviewToggle = container.querySelector("[data-testid='task-matrix-profile-1-review']")
    if (!reviewToggle) throw new Error("review toggle not found")
    await click(reviewToggle)

    expect(runtimeDbMocks.runtimeProfileUpdate).toHaveBeenCalledWith({
      profileId: "profile-1",
      taskFamilies: ["chat", "review"],
    })
    expect(container.querySelector("[data-testid='task-matrix-status-review']")?.textContent).toContain("Not wired")

    unmount(root)
  })

  it("shows the model-call agent warning when agent is assigned outside an agent-run profile", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "healthy",
      profiles: [runtimeProfile({ kind: "model-call", taskFamilies: ["agent"] })],
    })

    const { container, root } = renderSection()
    await flush()

    expect(container.querySelector("[data-testid='task-matrix-agent-kind-warning-profile-1']")?.textContent)
      .toContain("agent-run")

    unmount(root)
  })

  it("hides when runtime is disabled and degrades when no project is open", async () => {
    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: false,
      status: "disabled",
      profiles: [],
    })
    const disabled = renderSection()
    await flush()
    expect(disabled.container.querySelector("[data-testid='task-matrix-section']")).toBeNull()
    unmount(disabled.root)

    runtimeDbMocks.runtimeProfileList.mockResolvedValueOnce({
      enabled: true,
      status: "no-project",
      profiles: [],
    })
    const noProject = renderSection()
    await flush()
    expect(noProject.container.querySelector("[data-testid='task-matrix-runtime-unavailable']")).not.toBeNull()
    unmount(noProject.root)
  })
})
