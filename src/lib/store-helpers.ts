export interface PersistSettingOptions<T> {
  onError?: (error: unknown, revertedValue: T) => void
}

/** Value-based equality (not reference) so a freshly-synthesized "current
 *  snapshot" object still compares equal to the plain object literal a
 *  caller passed as nextValue, as long as their JSON-safe contents match. */
function sameValue<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Optimistic write with rollback: applies `nextValue` to in-memory state
 * immediately (so the UI feels instant), then persists it. If the persist
 * call rejects, the in-memory state is reverted to `prevValue` so it never
 * drifts from what's actually on disk, and `onError` lets the caller drive
 * local error UI. Returns whether the persist succeeded.
 *
 * `current` reads the live value at revert time. Callers here fire these
 * writes without awaiting the previous one (fire-and-forget on rapid
 * edits), so by the time an earlier call's persist rejects, a later call
 * may have already applied (and even successfully saved) a newer value.
 * Reverting unconditionally would stomp that newer value with the stale
 * `prevValue` — a silent data loss bug of the same shape this whole
 * module exists to prevent. So revert only fires if nothing has moved
 * the value past what THIS call applied.
 */
export async function persistSetting<T>(
  prevValue: T,
  nextValue: T,
  set: (value: T) => void,
  persist: (value: T) => Promise<void>,
  current: () => T,
  options?: PersistSettingOptions<T>,
): Promise<boolean> {
  set(nextValue)
  try {
    await persist(nextValue)
    return true
  } catch (error) {
    if (sameValue(current(), nextValue)) {
      set(prevValue)
    }
    options?.onError?.(error, prevValue)
    return false
  }
}

export interface PersistManyOptions {
  onError?: (error: unknown) => void
}

/**
 * Multi-value counterpart to persistSetting: one logical action that
 * touches several in-memory fields and issues several sequential
 * persist calls (e.g. activating an LLM preset writes providerConfigs,
 * activePresetId, AND the resolved llmConfig). A single persistSetting
 * per field can't guard this — if the second or third save rejects,
 * reverting only its own field would leave the earlier fields optimistically
 * applied in memory while their disk writes may or may not have landed,
 * splitting in-memory state from disk state. `apply`/`revert` are opaque
 * closures so the caller captures and restores the exact set of fields
 * the operation touches; `persist` performs all the writes for the action.
 *
 * `isCurrent` is the multi-field analogue of persistSetting's `current`
 * comparison: it should return whether every field `apply` touched is
 * still exactly what `apply` set it to. Since the fields are opaque to
 * this helper, the caller (who knows the shape) supplies the check
 * instead of a raw value to compare. Revert only fires when true, so a
 * fire-and-forget caller that's since applied (or already saved) a
 * newer value doesn't get stomped by this call's stale revert.
 */
export async function persistMany(
  apply: () => void,
  revert: () => void,
  persist: () => Promise<void>,
  isCurrent: () => boolean,
  options?: PersistManyOptions,
): Promise<boolean> {
  apply()
  try {
    await persist()
    return true
  } catch (error) {
    if (isCurrent()) {
      revert()
    }
    options?.onError?.(error)
    return false
  }
}
