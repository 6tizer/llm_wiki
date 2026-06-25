export type AppTheme = "light" | "dark" | "system"
export type EffectiveTheme = "light" | "dark"

export const DEFAULT_APP_THEME: AppTheme = "system"
export const THEME_LOCAL_STORAGE_KEY = "llmWiki.theme"

type MatchMediaLike = (query: string) => MediaQueryList

interface ThemeOptions {
  root?: HTMLElement
  matchMedia?: MatchMediaLike
  localStorage?: Storage
  syncNative?: boolean
}

let activeThemeCleanup: (() => void) | null = null

export function normalizeTheme(value: unknown): AppTheme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_APP_THEME
}

function getRoot(options?: ThemeOptions): HTMLElement | null {
  return options?.root ?? globalThis.document?.documentElement ?? null
}

function getStorage(options?: ThemeOptions): Storage | undefined {
  try {
    return options?.localStorage ?? globalThis.localStorage
  } catch {
    return undefined
  }
}

function getMatchMedia(options?: ThemeOptions): MatchMediaLike | undefined {
  return options?.matchMedia ?? globalThis.matchMedia?.bind(globalThis)
}

export function readThemeMirror(options?: ThemeOptions): AppTheme {
  const storage = getStorage(options)
  if (typeof storage?.getItem !== "function") return DEFAULT_APP_THEME
  return normalizeTheme(storage.getItem(THEME_LOCAL_STORAGE_KEY))
}

export function writeThemeMirror(theme: AppTheme, options?: ThemeOptions): void {
  const storage = getStorage(options)
  try {
    if (typeof storage?.setItem === "function") {
      storage.setItem(THEME_LOCAL_STORAGE_KEY, normalizeTheme(theme))
    }
  } catch {
    // localStorage can be unavailable in private/browser test contexts.
  }
}

export function resolveEffectiveTheme(theme: AppTheme, options?: ThemeOptions): EffectiveTheme {
  if (theme === "light" || theme === "dark") return theme
  return getMatchMedia(options)?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function applyThemeToDocument(
  theme: AppTheme,
  options?: ThemeOptions,
): EffectiveTheme {
  const effective = resolveEffectiveTheme(normalizeTheme(theme), options)
  const root = getRoot(options)
  if (root) {
    root.classList.toggle("dark", effective === "dark")
    root.classList.toggle("light", effective === "light")
    root.dataset.theme = effective
    root.style.colorScheme = effective
  }
  return effective
}

async function syncNativeWindowTheme(effective: EffectiveTheme): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().setTheme(effective)
  } catch {
    // Browser mode and older native surfaces may not expose Tauri window theme.
  }
}

export function applyThemePreference(theme: AppTheme, options?: ThemeOptions): EffectiveTheme {
  const normalized = normalizeTheme(theme)
  writeThemeMirror(normalized, options)
  const effective = applyThemeToDocument(normalized, options)
  if (options?.syncNative !== false) {
    void syncNativeWindowTheme(effective)
  }
  return effective
}

export function watchThemePreference(
  theme: AppTheme,
  options?: ThemeOptions,
): () => void {
  const normalized = normalizeTheme(theme)
  applyThemePreference(normalized, options)
  if (normalized !== "system") return () => {}

  const media = getMatchMedia(options)?.("(prefers-color-scheme: dark)")
  if (!media) return () => {}

  const onChange = () => {
    applyThemePreference("system", options)
  }
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export function activateThemePreference(
  theme: AppTheme,
  options?: ThemeOptions,
): EffectiveTheme {
  activeThemeCleanup?.()
  activeThemeCleanup = watchThemePreference(theme, options)
  return resolveEffectiveTheme(normalizeTheme(theme), options)
}

export function stopThemeWatcher(): void {
  activeThemeCleanup?.()
  activeThemeCleanup = null
}

export function applyPrePaintTheme(): EffectiveTheme {
  // app-state.json is async through tauri-plugin-store, so first paint uses
  // this tiny localStorage mirror. App-state remains the source of truth after
  // hydration; saving Settings updates both.
  return applyThemeToDocument(readThemeMirror(), { syncNative: false })
}
