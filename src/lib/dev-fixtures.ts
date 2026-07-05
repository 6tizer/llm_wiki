export type DevFixtureFn = (...args: unknown[]) => unknown

declare global {
  interface Window {
    __llmwiki_fixtures?: Record<string, DevFixtureFn>
  }
}

/**
 * Register a named browser-console fixture in development builds only.
 *
 * Shell owner: SPEC-8. Scenario owners must register their own entries from
 * dev-only modules so production builds can tree-shake the entire fixture path.
 */
export function registerDevFixture(name: string, fn: DevFixtureFn): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return
  window.__llmwiki_fixtures = window.__llmwiki_fixtures ?? {}
  window.__llmwiki_fixtures[name] = fn
}
