import { describe, expect, it } from "vitest"

import {
  coerceSettingsCategory,
  getSettingsCategories,
  isMacLikeRuntime,
  persistAppPreferences,
} from "./settings-view"

describe("settings platform categories", () => {
  it("detects mac-like runtimes from browser navigator signals", () => {
    expect(isMacLikeRuntime({ platform: "MacIntel" })).toBe(true)
    expect(isMacLikeRuntime({ userAgentData: { platform: "macOS" } })).toBe(true)
    expect(isMacLikeRuntime({ userAgent: "Mozilla/5.0 (Darwin)" })).toBe(true)
    expect(isMacLikeRuntime({ platform: "Win32" })).toBe(false)
    expect(isMacLikeRuntime({ userAgentData: { platform: "Linux" } })).toBe(false)
  })

  it("hides General outside mac-like runtimes", () => {
    expect(getSettingsCategories(true).some((category) => category.id === "general")).toBe(true)
    expect(getSettingsCategories(false).some((category) => category.id === "general")).toBe(false)
  })

  it("falls back when active category is not available", () => {
    const nonMacCategories = getSettingsCategories(false)
    expect(coerceSettingsCategory("interface", nonMacCategories)).toBe("interface")
    expect(coerceSettingsCategory("general", nonMacCategories)).toBe("llm")
  })
})

describe("settings app preference save flow", () => {
  it("flushes theme, applies it, then saves close behavior", async () => {
    const calls: string[] = []
    const saved = {
      theme: "",
      closeBehavior: "",
    }

    await persistAppPreferences(
      { theme: "dark", closeBehavior: "quit" },
      {
        saveTheme: async (theme) => {
          calls.push(`saveTheme:${theme}`)
        },
        activateThemePreference: (theme) => {
          calls.push(`activateTheme:${theme}`)
        },
        saveCloseBehavior: async (behavior) => {
          calls.push(`saveCloseBehavior:${behavior}`)
        },
        setSavedTheme: (theme) => {
          saved.theme = theme
          calls.push(`setSavedTheme:${theme}`)
        },
        setSavedCloseBehavior: (behavior) => {
          saved.closeBehavior = behavior
          calls.push(`setSavedCloseBehavior:${behavior}`)
        },
      },
    )

    expect(calls).toEqual([
      "saveTheme:dark",
      "setSavedTheme:dark",
      "activateTheme:dark",
      "saveCloseBehavior:quit",
      "setSavedCloseBehavior:quit",
    ])
    expect(saved).toEqual({ theme: "dark", closeBehavior: "quit" })
  })
})
