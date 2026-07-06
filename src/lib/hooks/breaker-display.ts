import type { RuntimeProfileCircuitBreakerRecord } from "@/commands/runtime-db"

/** Returns the user-facing circuit breaker reason with a stable fallback order. */
export function breakerDisplayReason(breaker: RuntimeProfileCircuitBreakerRecord): string {
  return breaker.reason ?? breaker.error ?? breaker.status
}

/** Converts remaining milliseconds to a whole-second countdown for UI labels. */
export function countdownSeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1_000))
}
