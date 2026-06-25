import { describe, expect, it } from "vitest"

import {
  coerceSettingsCategory,
  getSettingsCategories,
  isMacLikeRuntime,
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
