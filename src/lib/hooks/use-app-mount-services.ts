import { useEffect } from "react"
import { setupAutoSave } from "@/lib/auto-save"
import { startClipWatcher } from "@/lib/clip-watcher"

/**
 * Starts the app-wide background services that historically mounted from App.
 */
export function useAppMountServices(): void {
  // Characterization: App currently has no cleanup and setupAutoSave has no
  // idempotency guard, so React StrictMode double-subscribes in dev. Preserve
  // that behavior here; the cleanup/guard fix belongs in a follow-up ticket.
  useEffect(() => {
    setupAutoSave()
    startClipWatcher()
  }, [])
}
