// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { KnowledgeAgentsSection } from "./knowledge-agents-section"
import {
  KNOWLEDGE_AGENT_IDS,
  defaultKnowledgeAgentsConfig,
  knowledgeAgentsConfigPath,
} from "@/lib/agent/knowledge-agents-config"

const fsMocks = vi.hoisted(() => ({
  fileExists: vi.fn(async (_path: string) => false),
  readFile: vi.fn(async (_path: string) => ""),
  writeFileAtomic: vi.fn(async (_path: string, _contents: string) => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderSection(
  props: Partial<React.ComponentProps<typeof KnowledgeAgentsSection>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<KnowledgeAgentsSection {...props} />)
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function click(element: Element): Promise<void> {
  return act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function input(element: HTMLTextAreaElement, value: string): Promise<void> {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    await Promise.resolve()
  })
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("KnowledgeAgentsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockResolvedValue("")
  })

  it("disables editing when no project is open", async () => {
    const { container, root } = renderSection()
    await flush()

    expect(container.textContent).toContain("Open a project first")
    expect(container.querySelector<HTMLButtonElement>("[data-testid='knowledge-agents-save']")?.disabled).toBe(true)

    unmount(root)
  })

  it("loads a project config and renders the six frozen agents", async () => {
    const { container, root } = renderSection({
      project: { path: "/project" },
    })
    await flush()

    expect(container.querySelectorAll("[data-testid^='knowledge-agent-row-']")).toHaveLength(6)
    expect([...container.querySelectorAll("[data-testid^='knowledge-agent-row-']")].map((row) => row.textContent)).toEqual(
      expect.arrayContaining(KNOWLEDGE_AGENT_IDS.map((id) => expect.stringContaining(id))),
    )
    expect(container.querySelectorAll("[data-testid^='knowledge-agent-guidance-']")).toHaveLength(5)
    expect(container.querySelector("[data-testid='knowledge-agent-guidance-tagger']")).toBeNull()

    unmount(root)
  })

  it("loads a valid persisted config with checked compiler toggles and guidance", async () => {
    const config = defaultKnowledgeAgentsConfig(10)
    config.agents.compiler = { enabled: true, autoRun: true, guidance: "Prefer concept-first output." }
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(config))

    const { container, root } = renderSection({
      project: { path: "/project" },
    })
    await flush()

    expect(container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")?.checked).toBe(true)
    expect(container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-auto-run-compiler']")?.checked).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>("[data-testid='knowledge-agent-guidance-compiler']")?.value).toBe("Prefer concept-first output.")

    unmount(root)
  })

  it("disables agent checkboxes while loading a project config", () => {
    fsMocks.fileExists.mockReturnValue(new Promise(() => {}))

    const { container, root } = renderSection({
      project: { path: "/project" },
    })

    expect(container.textContent).toContain("Loading")
    expect(container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-auto-run-compiler']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>("[data-testid='knowledge-agent-guidance-compiler']")?.disabled).toBe(true)

    unmount(root)
  })

  it("toggles an agent and saves with an injected timestamp", async () => {
    const { container, root } = renderSection({
      project: { path: "/project" },
      now: () => 987,
    })
    await flush()

    const enabled = container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")
    if (!enabled) throw new Error("compiler enabled checkbox not found")
    await click(enabled)

    const autoRun = container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-auto-run-compiler']")
    if (!autoRun) throw new Error("compiler auto-run checkbox not found")
    await click(autoRun)

    const guidance = container.querySelector<HTMLTextAreaElement>("[data-testid='knowledge-agent-guidance-compiler']")
    if (!guidance) throw new Error("compiler guidance textarea not found")
    await input(guidance, "Focus on stable wiki links.")

    const save = container.querySelector<HTMLButtonElement>("[data-testid='knowledge-agents-save']")
    if (!save) throw new Error("save button not found")
    await click(save)

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      knowledgeAgentsConfigPath("/project"),
      expect.stringMatching(/\n$/),
    )
    const content = fsMocks.writeFileAtomic.mock.calls[0]?.[1] ?? ""
    const parsed = JSON.parse(content)
    expect(parsed.updatedAt).toBe(987)
    expect(parsed.agents.compiler.enabled).toBe(true)
    expect(parsed.agents.compiler.autoRun).toBe(true)
    expect(parsed.agents.compiler.guidance).toBe("Focus on stable wiki links.")

    unmount(root)
  })

  it("recovers from save failures and shows an error", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))

    const { container, root } = renderSection({
      project: { path: "/project" },
      now: () => 987,
    })
    await flush()

    const enabled = container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")
    if (!enabled) throw new Error("compiler enabled checkbox not found")
    await click(enabled)

    const save = container.querySelector<HTMLButtonElement>("[data-testid='knowledge-agents-save']")
    if (!save) throw new Error("save button not found")
    await click(save)

    expect(container.textContent).toContain("Save failed")
    expect(save.disabled).toBe(false)

    const guidance = container.querySelector<HTMLTextAreaElement>("[data-testid='knowledge-agent-guidance-compiler']")
    if (!guidance) throw new Error("compiler guidance textarea not found")
    await input(guidance, "Recover after failed save.")
    await click(save)

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(2)
    const content = fsMocks.writeFileAtomic.mock.calls[1]?.[1] ?? ""
    expect(JSON.parse(content).agents.compiler.guidance).toBe("Recover after failed save.")

    unmount(root)
  })

  it("recovers from stale updatedAt conflicts and allows a second save", async () => {
    const first = defaultKnowledgeAgentsConfig(1)
    const second = defaultKnowledgeAgentsConfig(2)
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile
      .mockResolvedValue(JSON.stringify(second))
      .mockResolvedValueOnce(JSON.stringify(first))

    const { container, root } = renderSection({
      project: { path: "/project" },
      now: () => 3,
    })
    await flush()

    const enabled = container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")
    if (!enabled) throw new Error("compiler enabled checkbox not found")
    await click(enabled)

    const save = container.querySelector<HTMLButtonElement>("[data-testid='knowledge-agents-save']")
    if (!save) throw new Error("save button not found")
    await click(save)

    expect(container.textContent).toContain("changed on disk")
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(save.disabled).toBe(false)
    expect(enabled.disabled).toBe(false)

    await click(enabled)
    await click(save)

    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const content = fsMocks.writeFileAtomic.mock.calls[0]?.[1] ?? ""
    const parsed = JSON.parse(content)
    expect(parsed.updatedAt).toBe(3)
    expect(parsed.agents.compiler.enabled).toBe(true)

    unmount(root)
  })

  it("renders future schema conflicts as read-only and does not write", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify({
      schemaVersion: 3,
      updatedAt: 10,
      agents: {},
    }))

    const { container, root } = renderSection({
      project: { path: "/project" },
      now: () => 11,
    })
    await flush()

    expect(container.textContent).toContain("newer than this app supports")
    expect(container.querySelector<HTMLInputElement>("[data-testid='knowledge-agent-enabled-compiler']")?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>("[data-testid='knowledge-agents-save']")?.disabled).toBe(true)
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()

    unmount(root)
  })
})
