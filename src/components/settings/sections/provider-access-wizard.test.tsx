// @vitest-environment jsdom

import { act } from "react"
import type { ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "@/i18n"
import { ProviderAccessWizard } from "./provider-access-wizard"
import type { RuntimeProfileRecord } from "@/commands/runtime-db"

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeProfileCreate: vi.fn(),
  runtimeProfileModelsList: vi.fn(),
  runtimeProfileProbe: vi.fn(),
}))

const secretMocks = vi.hoisted(() => ({
  profileSecretWrite: vi.fn(),
  profileSecretDelete: vi.fn(),
}))

vi.mock("@/commands/runtime-db", () => runtimeDbMocks)
vi.mock("@/commands/profile-secrets", () => secretMocks)
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

function runtimeProfile(patch: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-1",
    kind: "model-call",
    displayName: "OpenAI",
    providerId: "openai",
    modelId: "gpt-5.5",
    agentSdkModelId: null,
    endpoint: "https://api.openai.com/v1",
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    secretRef: "new-secret-ref",
    enabled: true,
    taskFamilies: ["chat"],
    maxConcurrency: 1,
    capabilityStatus: "supported",
    capabilityJson: "{\"modelCallSupported\":true}",
    capabilityVersion: "profile-probe.v1",
    capabilityCheckedAtMs: 1,
    probeBackoffUntilMs: null,
    lastCapabilityError: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...patch,
  }
}

function renderWizard(
  props: Partial<ComponentProps<typeof ProviderAccessWizard>> = {},
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ProviderAccessWizard onProfileCreated={vi.fn()} {...props} />)
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

async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function byTestId<T extends Element = Element>(testId: string): T {
  const element = document.body.querySelector<T>(`[data-testid='${testId}']`)
  if (!element) throw new Error(`missing ${testId}`)
  return element
}

function unmount(root: Root): void {
  act(() => {
    root.unmount()
  })
}

describe("ProviderAccessWizard secretRef protection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ""
    secretMocks.profileSecretWrite.mockResolvedValue({ secretRef: "new-secret-ref" })
    secretMocks.profileSecretDelete.mockResolvedValue(undefined)
    runtimeDbMocks.runtimeProfileCreate.mockResolvedValue(runtimeProfile())
    runtimeDbMocks.runtimeProfileProbe.mockResolvedValue({
      status: "supported",
      message: null,
      capabilityJson: "{\"modelCallSupported\":true}",
    })
    runtimeDbMocks.runtimeProfileModelsList.mockResolvedValue({
      models: ["gpt-5.5"],
      sourceUrl: "https://api.openai.com/v1/models",
    })
  })

  it("does not delete a reused initialConnection secretRef when canceled or unmounted", async () => {
    const { root } = renderWizard({
      initialConnection: {
        providerId: "openai",
        endpoint: "https://api.openai.com/v1",
        secretRef: "shared-secret-ref",
      },
    })
    await click(byTestId("profile-quick-connect"))
    await click(byTestId("wizard-cancel"))
    await flush()
    unmount(root)
    await flush()

    expect(secretMocks.profileSecretDelete).not.toHaveBeenCalled()
  })

  it("does not delete the old shared secretRef when a reused connection rotates to a new key", async () => {
    const { root } = renderWizard({
      initialConnection: {
        providerId: "openai",
        endpoint: "https://api.openai.com/v1",
        secretRef: "shared-secret-ref",
      },
    })
    await click(byTestId("profile-quick-connect"))
    await input(byTestId<HTMLInputElement>("wizard-api-key"), "sk-new")
    await click(byTestId("wizard-next"))
    await click(byTestId("wizard-finish"))
    await flush()

    expect(secretMocks.profileSecretWrite).toHaveBeenCalledWith({ secretValue: "sk-new" })
    expect(secretMocks.profileSecretDelete).not.toHaveBeenCalledWith({ secretRef: "shared-secret-ref" })
    unmount(root)
  })

  it("deletes a newly written draft secretRef when a fresh wizard session is canceled", async () => {
    const { root } = renderWizard()
    await click(byTestId("profile-quick-connect"))
    await click(byTestId("wizard-template-openai"))
    await input(byTestId<HTMLInputElement>("wizard-api-key"), "sk-draft")
    await click(byTestId("wizard-next"))
    await click(byTestId("wizard-test-connection"))
    await flush()
    await click(byTestId("wizard-cancel"))
    await flush()

    expect(secretMocks.profileSecretWrite).toHaveBeenCalledWith({ secretValue: "sk-draft" })
    expect(secretMocks.profileSecretDelete).toHaveBeenCalledWith({ secretRef: "new-secret-ref" })
    unmount(root)
  })
})
