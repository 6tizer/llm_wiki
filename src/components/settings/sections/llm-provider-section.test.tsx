// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { saveActivePresetId, saveLlmConfig, saveProviderConfigs } from "@/lib/project-store"
import { LlmProviderSection } from "./llm-provider-section"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ""),
}))

vi.mock("@/lib/project-store", () => ({
  saveProviderConfigs: vi.fn(async () => undefined),
  saveActivePresetId: vi.fn(async () => undefined),
  saveLlmConfig: vi.fn(async () => undefined),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSection(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<LlmProviderSection />)
  })

  return { container, root }
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

// Several presets share the same "Activate"/"Expand config" affordances,
// so scope lookups to the row identified by its visible label instead of
// querying by aria-label/role alone.
function findPresetRow(container: HTMLDivElement, label: string): Element {
  const labelSpan = Array.from(container.querySelectorAll("span")).find(
    (el) => el.textContent === label,
  )
  const row = labelSpan?.closest(".rounded-lg")
  if (!row) throw new Error(`row for preset "${label}" not found`)
  return row
}

function findPresetToggle(container: HTMLDivElement, label: string): Element {
  const toggle = findPresetRow(container, label).querySelector(
    'button[aria-label="Activate"], button[aria-label="Deactivate"]',
  )
  if (!toggle) throw new Error(`toggle button for preset "${label}" not found`)
  return toggle
}

function findPresetExpandButton(container: HTMLDivElement, label: string): Element {
  const labelSpan = Array.from(container.querySelectorAll("span")).find(
    (el) => el.textContent === label,
  )
  const button = labelSpan?.closest("button")
  if (!button) throw new Error(`expand button for preset "${label}" not found`)
  return button
}

describe("LlmProviderSection", () => {
  beforeEach(() => {
    useWikiStore.setState({
      providerConfigs: {},
      activePresetId: null,
    })
    vi.mocked(saveProviderConfigs).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveActivePresetId).mockReset().mockResolvedValue(undefined)
    vi.mocked(saveLlmConfig).mockReset().mockResolvedValue(undefined)
  })

  it("does not render the full runtime profiles editor inside the LLM provider section", () => {
    const { container, root } = renderSection()

    expect(container.textContent).toContain("LLM Models")
    expect(container.textContent).not.toContain("New profile")
    expect(container.textContent).not.toContain("Display name")
    expect(container.querySelector("[data-testid='model-profiles-section']")).toBeNull()

    unmount(root)
  })

  it("shows a save-failed badge and reverts activePresetId when persisting the toggle fails", async () => {
    // toggleActive's only disk write is saveActivePresetId — providerConfigs
    // is unchanged by activation and llmConfig is never independently
    // persisted (see llm-provider-section.tsx), so this is the one write
    // that can actually fail.
    vi.mocked(saveActivePresetId).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    const toggle = container.querySelector('button[aria-label="Activate"]')
    if (!toggle) throw new Error("activate toggle not found")

    await click(toggle)

    expect(useWikiStore.getState().activePresetId).toBeNull()
    expect(container.textContent).toContain("save failed")

    unmount(root)
  })

  it("has a single authoritative write for override edits: rolls back providerConfigs+llmConfig and never touches saveLlmConfig", async () => {
    useWikiStore.setState({
      providerConfigs: {},
      activePresetId: "claude-code-cli",
    })
    const prevProviderConfigs = useWikiStore.getState().providerConfigs
    const prevLlmConfig = useWikiStore.getState().llmConfig
    // saveProviderConfigs is now the ONLY disk write updateOverride makes.
    // llmConfig is purely a runtime projection (App.tsx's boot init always
    // re-resolves it from providerConfigs[activePresetId] when a preset is
    // active), so persisting it here would be a redundant second write
    // that — if it alone failed — used to leave providerConfigs/llmConfig
    // split between memory and disk (Codex P2-1). With no second write,
    // there's nothing left to split.
    vi.mocked(saveProviderConfigs).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    await click(findPresetExpandButton(container, "Claude Code CLI (local)"))

    const checkbox = findPresetRow(container, "Claude Code CLI (local)").querySelector(
      'input[type="checkbox"]',
    )
    if (!checkbox) throw new Error("localCliIsolation checkbox not found")

    await click(checkbox)

    expect(useWikiStore.getState().providerConfigs).toEqual(prevProviderConfigs)
    expect(useWikiStore.getState().llmConfig).toEqual(prevLlmConfig)
    expect(saveLlmConfig).not.toHaveBeenCalled()
    expect(container.textContent).toContain("save failed")

    unmount(root)
  })

  it("applies the new override optimistically and persists only providerConfigs when saving succeeds", async () => {
    useWikiStore.setState({
      providerConfigs: {},
      activePresetId: "claude-code-cli",
    })
    const prevLlmConfig = useWikiStore.getState().llmConfig

    const { container, root } = renderSection()
    await click(findPresetExpandButton(container, "Claude Code CLI (local)"))

    const checkbox = findPresetRow(container, "Claude Code CLI (local)").querySelector(
      'input[type="checkbox"]',
    )
    if (!checkbox) throw new Error("localCliIsolation checkbox not found")

    await click(checkbox)

    expect(useWikiStore.getState().providerConfigs).toEqual({
      "claude-code-cli": { localCliIsolation: true },
    })
    // The runtime projection picks up the new override immediately —
    // this is the in-memory-only lockstep update, not a persisted write.
    expect(useWikiStore.getState().llmConfig).not.toEqual(prevLlmConfig)
    expect(saveProviderConfigs).toHaveBeenCalledWith({
      "claude-code-cli": { localCliIsolation: true },
    })
    expect(saveLlmConfig).not.toHaveBeenCalled()
    expect(saveActivePresetId).not.toHaveBeenCalled()

    unmount(root)
  })

  it("has a single authoritative write for activation: rolls back activePresetId+llmConfig and never touches saveProviderConfigs/saveLlmConfig", async () => {
    const prevActivePresetId = useWikiStore.getState().activePresetId
    const prevLlmConfig = useWikiStore.getState().llmConfig
    // toggleActive's only disk write is saveActivePresetId — providerConfigs
    // is unchanged by activation, and llmConfig is never independently
    // persisted (see llm-provider-section.tsx). With a single write, a
    // failure here can't leave any other field's disk state ahead of memory.
    vi.mocked(saveActivePresetId).mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection()
    const toggle = findPresetToggle(container, "Claude Code CLI (local)")

    await click(toggle)

    expect(useWikiStore.getState().activePresetId).toBe(prevActivePresetId)
    expect(useWikiStore.getState().llmConfig).toEqual(prevLlmConfig)
    expect(saveProviderConfigs).not.toHaveBeenCalled()
    expect(saveLlmConfig).not.toHaveBeenCalled()
    expect(container.textContent).toContain("save failed")

    unmount(root)
  })

  it("activates a preset optimistically and persists only activePresetId when saving succeeds", async () => {
    const { container, root } = renderSection()
    const toggle = findPresetToggle(container, "Claude Code CLI (local)")

    await click(toggle)

    expect(useWikiStore.getState().activePresetId).toBe("claude-code-cli")
    expect(useWikiStore.getState().llmConfig.provider).toBe("claude-code")
    expect(saveActivePresetId).toHaveBeenCalledWith("claude-code-cli")
    expect(saveProviderConfigs).not.toHaveBeenCalled()
    expect(saveLlmConfig).not.toHaveBeenCalled()

    unmount(root)
  })
})
