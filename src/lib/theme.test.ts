// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tauriWindowMock = vi.hoisted(() => ({
  setTheme: vi.fn(),
}))

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    setTheme: tauriWindowMock.setTheme,
  })),
}))

import {
  activateThemePreference,
  applyPrePaintTheme,
  applyThemePreference,
  applyThemeToDocument,
  normalizeTheme,
  resolveEffectiveTheme,
  stopThemeWatcher,
  THEME_LOCAL_STORAGE_KEY,
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

function makeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value)
    }),
  }
}

describe("theme helpers", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: makeStorage(),
      configurable: true,
    })
    tauriWindowMock.setTheme.mockResolvedValue(undefined)
    window.localStorage.clear()
    document.documentElement.className = ""
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.style.colorScheme = ""
  })

  afterEach(() => {
    stopThemeWatcher()
    vi.clearAllMocks()
  })

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

  it("applies pre-paint theme from the localStorage mirror", () => {
    window.localStorage.setItem(THEME_LOCAL_STORAGE_KEY, "dark")

    expect(applyPrePaintTheme()).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.theme).toBe("dark")
  })

  it("cleans up the previous active system watcher when re-activated", () => {
    const firstMedia = makeMedia(false)
    const secondMedia = makeMedia(true)
    const matchMedia = vi.fn(() => firstMedia)

    activateThemePreference("system", {
      root: document.documentElement,
      matchMedia,
      localStorage: window.localStorage,
      syncNative: false,
    })
    expect(firstMedia.addEventListener).toHaveBeenCalledTimes(1)

    matchMedia.mockReturnValue(secondMedia)
    activateThemePreference("dark", {
      root: document.documentElement,
      matchMedia,
      localStorage: window.localStorage,
      syncNative: false,
    })

    expect(firstMedia.removeEventListener).toHaveBeenCalledTimes(1)
    expect(secondMedia.addEventListener).not.toHaveBeenCalled()
  })

  it("best-effort syncs the native Tauri window theme", async () => {
    applyThemePreference("dark", { root: document.documentElement })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(tauriWindowMock.setTheme).toHaveBeenCalledWith("dark")
  })
})
