// @vitest-environment jsdom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import { CreateProjectDialog, validateCreateProjectInput } from "./create-project-dialog"

const fsMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  writeFile: vi.fn(async () => undefined),
  createDirectory: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", () => fsMocks)

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}))

const projectStoreMocks = vi.hoisted(() => ({
  saveOutputLanguage: vi.fn(async () => undefined),
}))

vi.mock("@/lib/project-store", () => projectStoreMocks)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function renderDialog(props: {
  onOpenChange?: (open: boolean) => void
  onCreated?: (project: WikiProject) => void | Promise<void>
} = {}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(
      <CreateProjectDialog
        open
        onOpenChange={props.onOpenChange ?? vi.fn()}
        onCreated={props.onCreated ?? vi.fn()}
      />,
    )
  })

  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set
  setter?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set
  setter?.call(select, value)
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await Promise.resolve()
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${text}`)
  }
  return button
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

beforeEach(() => {
  fsMocks.createProject.mockReset().mockResolvedValue({
    id: "created-project",
    name: "Created Project",
    path: "/tmp/created-project",
  } satisfies WikiProject)
  fsMocks.writeFile.mockClear()
  fsMocks.createDirectory.mockClear()
  projectStoreMocks.saveOutputLanguage.mockClear()
  useWikiStore.getState().setOutputLanguage("auto")
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("validateCreateProjectInput", () => {
  it("requires both project name and parent directory", () => {
    expect(validateCreateProjectInput("", "/tmp", "English")).toBe(
      "project.errorNameRequired",
    )
    expect(validateCreateProjectInput("Wiki", "", "English")).toBe(
      "project.errorNameRequired",
    )
  })

  it("requires an explicit output language", () => {
    expect(validateCreateProjectInput("Wiki", "/tmp", "")).toBe(
      "project.errorLanguageRequired",
    )
  })

  it("accepts complete project input", () => {
    expect(validateCreateProjectInput("Wiki", "/tmp", "English")).toBeNull()
  })
})

describe("CreateProjectDialog", () => {
  it("closes and does not show a creation error when opening the created project fails", async () => {
    const onOpenChange = vi.fn()
    const onCreated = vi.fn(async () => {
      throw new Error("open failed")
    })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    const { root } = renderDialog({ onOpenChange, onCreated })

    await setInputValue(document.body.querySelector("#name") as HTMLInputElement, "Created Project")
    await setInputValue(document.body.querySelector("#path") as HTMLInputElement, "/tmp")
    await setSelectValue(document.body.querySelector("#language") as HTMLSelectElement, "English")
    await click(buttonByText("Create"))
    await flush()

    expect(onCreated).toHaveBeenCalledWith({
      id: "created-project",
      name: "Created Project",
      path: "/tmp/created-project",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.body.textContent).not.toContain("open failed")
    expect(buttonByText("Create").disabled).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to open created project:",
      expect.any(Error),
    )

    unmount(root)
  })
})
