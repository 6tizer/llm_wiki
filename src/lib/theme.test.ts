// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import {
  applyThemeToDocument,
  normalizeTheme,
  resolveEffectiveTheme,
  watchThemePreference,
} from "./theme"

function makeMedia(matches: boolean) {
  let currentMatches = matches
  const listeners = new Set<() => void>()
  const media = {
    media: "(prefers-color-scheme: dark)",
    get matches() {
      return currentMatches
    },
    onchange: null,
    addEventListener: vi.fn((_event: "change", listener: () => void) => {
      listeners.add(listener)
    }),
    removeEventListener: vi.fn((_event: "change", listener: () => void) => {
      listeners.delete(listener)
    }),
    addListener: vi.fn((listener: () => void) => {
      listeners.add(listener)
    }),
    removeListener: vi.fn((listener: () => void) => {
      listeners.delete(listener)
    }),
    dispatchEvent: vi.fn(() => true),
    dispatch(matchesNext: boolean) {
      currentMatches = matchesNext
      for (const listener of listeners) listener()
    },
  }
  return media as unknown as MediaQueryList & { dispatch(matchesNext: boolean): void }
}

describe("theme helpers", () => {
  it("normalizes theme values", () => {
    expect(normalizeTheme("light")).toBe("light")
    expect(normalizeTheme("dark")).toBe("dark")
    expect(normalizeTheme("system")).toBe("system")
    expect(normalizeTheme("blue")).toBe("system")
  })

  it("resolves effective theme from system preference", () => {
    const media = makeMedia(true)
    const matchMedia = vi.fn(() => media)
    expect(resolveEffectiveTheme("light", { matchMedia })).toBe("light")
    expect(resolveEffectiveTheme("dark", { matchMedia })).toBe("dark")
    expect(resolveEffectiveTheme("system", { matchMedia })).toBe("dark")
    media.dispatch(false)
    expect(resolveEffectiveTheme("system", { matchMedia })).toBe("light")
  })

  it("applies root classes and data-theme", () => {
    const root = document.createElement("html")
    applyThemeToDocument("dark", { root })
    expect(root.classList.contains("dark")).toBe(true)
    expect(root.classList.contains("light")).toBe(false)
    expect(root.dataset.theme).toBe("dark")
    expect(root.style.colorScheme).toBe("dark")

    applyThemeToDocument("light", { root })
    expect(root.classList.contains("dark")).toBe(false)
    expect(root.classList.contains("light")).toBe(true)
    expect(root.dataset.theme).toBe("light")
    expect(root.style.colorScheme).toBe("light")
  })

  it("watches system theme only for system preference", () => {
    const root = document.createElement("html")
    const media = makeMedia(false)
    const matchMedia = vi.fn(() => media)

    const stopLight = watchThemePreference("light", {
      root,
      matchMedia,
      localStorage: window.localStorage,
      syncNative: false,
    })
    expect(media.addEventListener).not.toHaveBeenCalled()
    stopLight()

    const stopSystem = watchThemePreference("system", {
      root,
      matchMedia,
      localStorage: window.localStorage,
      syncNative: false,
    })
    expect(media.addEventListener).toHaveBeenCalledTimes(1)
    expect(root.dataset.theme).toBe("light")
    media.dispatch(true)
    expect(root.dataset.theme).toBe("dark")
    stopSystem()
    expect(media.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
