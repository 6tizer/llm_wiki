import { useEffect, useRef, useState } from "react"

export interface ProjectPersistedResource<T> {
  state: T
  loading: boolean
  error: string | null
}

/**
 * Load a project-scoped resource keyed by `projectPath`, discarding a
 * stale in-flight resolve/reject when the path changes again (or the
 * component unmounts) before it lands. Extracted from tag-taxonomy-section
 * and knowledge-agents-section, which hand-rolled the identical
 * cancelled-flag guard around their `useEffect([project?.path])` loads.
 *
 * Conflict detection is NOT built in: taxonomy's slug-collision conflict
 * and agents' stale-`updatedAt` conflict are shaped differently, so `T`
 * (whatever `load` resolves to) carries that field and the caller
 * interprets it. Likewise there's no built-in "refetch" — callers that
 * need to reload after a mutating action (e.g. after applying a batch)
 * call their loader directly and manage that result themselves, exactly
 * as they did before this hook existed.
 */
export function useProjectPersistedResource<T>(
  projectPath: string | undefined,
  load: (path: string) => Promise<T>,
  fallback: T,
): ProjectPersistedResource<T> {
  const [state, setState] = useState<T>(fallback)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Ref so a `load` closure recreated on every render doesn't retrigger
  // the effect — only `projectPath` changing should start a new load.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!projectPath) {
      setState(fallback)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    loadRef
      .current(projectPath)
      .then((result) => {
        if (cancelled) return
        setState(result)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setState(fallback)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // fallback is a caller-supplied default, not a reload trigger —
    // only projectPath changes should start a new load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  return { state, loading, error }
}
