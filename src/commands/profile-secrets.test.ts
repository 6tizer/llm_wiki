import { beforeEach, describe, expect, it, vi } from "vitest"
import * as profileSecrets from "./profile-secrets"
import { profileSecretDelete, profileSecretWrite } from "./profile-secrets"

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => tauriMocks)

describe("profile secret commands", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
  })

  it("does not expose a frontend read command", () => {
    expect(Object.keys(profileSecrets).sort()).toEqual([
      "profileSecretDelete",
      "profileSecretWrite",
    ])
  })

  it("sends profile secret write payloads without transforming the secret", async () => {
    const response = {
      secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
    }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      profileSecretWrite({ secretValue: "fake-test-secret" }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("profile_secret_write", {
      request: { secretValue: "fake-test-secret" },
    })
  })

  it("sends profile secret delete payloads by secretRef only", async () => {
    const response = { ok: true }
    tauriMocks.invoke.mockResolvedValue(response)

    await expect(
      profileSecretDelete({
        secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toBe(response)

    expect(tauriMocks.invoke).toHaveBeenCalledWith("profile_secret_delete", {
      request: {
        secretRef: "llm-wiki-profile-secret:550e8400-e29b-41d4-a716-446655440000",
      },
    })
  })
})
