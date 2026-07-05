import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Loader2, RefreshCw, Save, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import {
  runtimeProfileBreakerClear,
  runtimeProfileList,
  runtimeProfilePoolEventsList,
  runtimeProfilePoolList,
  runtimeTaskPolicyList,
  runtimeTaskPolicySet,
  type RuntimeDbHealthState,
  type RuntimeEventRecord,
  type RuntimeProfileCircuitBreakerRecord,
  type RuntimeProfileClaimRecord,
  type RuntimeProfileRecord,
  type RuntimeTaskFamilyPolicyRecord,
} from "@/commands/runtime-db"
import { PROFILE_TASK_FAMILY_OPTIONS } from "./model-profiles-section"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; enabled: boolean; status: RuntimeDbHealthState }
  | { kind: "error"; message: string }

interface PolicyDraft {
  profileOrder: string[]
  autoFailover: boolean
}

interface PoolSnapshot {
  activeClaims: RuntimeProfileClaimRecord[]
  circuitBreakers: RuntimeProfileCircuitBreakerRecord[]
}

interface ParsedPoolEvent {
  event: RuntimeEventRecord
  taskFamily: string
  requested: string
  selected: string
  reason: string
  fromOrder: boolean | null
}

interface Props {
  refreshToken?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function taskFamilyLabelKey(family: string): string {
  return `settings.sections.modelConfig.taskMatrix.families.${family}`
}

function defaultDraft(): PolicyDraft {
  return { profileOrder: [], autoFailover: true }
}

export function addProfileToOrder(order: string[], profileId: string): string[] {
  const trimmed = profileId.trim()
  if (!trimmed || order.includes(trimmed)) return order
  return [...order, trimmed]
}

export function removeProfileFromOrder(order: string[], profileId: string): string[] {
  return order.filter((value) => value !== profileId)
}

export function moveProfileInOrder(order: string[], profileId: string, direction: -1 | 1): string[] {
  const index = order.indexOf(profileId)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return order
  const next = [...order]
  const [item] = next.splice(index, 1)
  next.splice(nextIndex, 0, item)
  return next
}

function draftsFromPolicies(
  policies: RuntimeTaskFamilyPolicyRecord[],
  existingDrafts: Record<string, PolicyDraft> = {},
  dirtyFamilies: Set<string> = new Set(),
): Record<string, PolicyDraft> {
  const drafts: Record<string, PolicyDraft> = {}
  for (const family of PROFILE_TASK_FAMILY_OPTIONS) {
    if (dirtyFamilies.has(family) && existingDrafts[family]) {
      drafts[family] = existingDrafts[family]
      continue
    }
    const policy = policies.find((item) => item.taskFamily === family)
    drafts[family] = policy
      ? { profileOrder: policy.profileOrder, autoFailover: policy.autoFailover }
      : defaultDraft()
  }
  return drafts
}

function parsePoolEvent(event: RuntimeEventRecord): ParsedPoolEvent {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(event.payload) as Record<string, unknown>
  } catch {
    payload = {}
  }
  const taskFamily = typeof payload.taskFamily === "string" ? payload.taskFamily : ""
  if (event.eventName === "profile-pool:fallback") {
    return {
      event,
      taskFamily,
      requested: typeof payload.requested === "string" ? payload.requested : "",
      selected: typeof payload.selected === "string" ? payload.selected : "",
      reason: typeof payload.reason === "string" ? payload.reason : "",
      fromOrder: typeof payload.fromOrder === "boolean" ? payload.fromOrder : null,
    }
  }
  return {
    event,
    taskFamily,
    requested: "",
    selected: typeof payload.profileId === "string" ? payload.profileId : "",
    reason: typeof payload.outcome === "string" ? payload.outcome : event.eventName,
    fromOrder: null,
  }
}

export function FallbackPolicySection({ refreshToken = 0 }: Props) {
  const { t } = useTranslation()
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [profiles, setProfiles] = useState<RuntimeProfileRecord[]>([])
  const [drafts, setDrafts] = useState<Record<string, PolicyDraft>>({})
  const [savingFamilies, setSavingFamilies] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<string | null>(null)
  const [poolSnapshot, setPoolSnapshot] = useState<PoolSnapshot>({ activeClaims: [], circuitBreakers: [] })
  const [events, setEvents] = useState<RuntimeEventRecord[]>([])
  const [refreshingObservability, setRefreshingObservability] = useState(false)
  const profilesRef = useRef<RuntimeProfileRecord[]>([])
  const draftsRef = useRef<Record<string, PolicyDraft>>({})
  const dirtyFamiliesRef = useRef<Set<string>>(new Set())

  async function loadAll(shouldApply = () => true) {
    setLoadState({ kind: "loading" })
    try {
      const [profileResult, policyResult, observability] = await Promise.all([
        runtimeProfileList(),
        runtimeTaskPolicyList(),
        fetchObservability(),
      ])
      if (!shouldApply()) return
      const nextProfiles = Array.isArray(profileResult.profiles) ? profileResult.profiles : []
      const nextDrafts = draftsFromPolicies(
        Array.isArray(policyResult.policies) ? policyResult.policies : [],
        draftsRef.current,
        dirtyFamiliesRef.current,
      )
      profilesRef.current = nextProfiles
      draftsRef.current = nextDrafts
      setProfiles(nextProfiles)
      setDrafts(nextDrafts)
      setPoolSnapshot(observability.poolSnapshot)
      setEvents(observability.events)
      setLoadState({
        kind: "ready",
        enabled: Boolean(profileResult.enabled && policyResult.enabled),
        status: profileResult.status === "healthy" ? policyResult.status : profileResult.status,
      })
    } catch (error) {
      if (!shouldApply()) return
      setLoadState({ kind: "error", message: errorMessage(error) })
    }
  }

  async function fetchObservability(): Promise<{ poolSnapshot: PoolSnapshot; events: RuntimeEventRecord[] }> {
    const [pool, eventList] = await Promise.all([
      runtimeProfilePoolList(),
      runtimeProfilePoolEventsList({ limit: 50 }),
    ])
    return {
      poolSnapshot: {
        activeClaims: pool.activeClaims ?? [],
        circuitBreakers: pool.circuitBreakers ?? [],
      },
      events: eventList.events ?? [],
    }
  }

  async function refreshObservability(shouldApply = () => true) {
    setRefreshingObservability(true)
    try {
      const observability = await fetchObservability()
      if (!shouldApply()) return
      setPoolSnapshot(observability.poolSnapshot)
      setEvents(observability.events)
    } catch (error) {
      if (!shouldApply()) return
      setMessage(t("fallbackPolicy.refreshFailed", { message: errorMessage(error) }))
    } finally {
      if (shouldApply()) {
        setRefreshingObservability(false)
      }
    }
  }

  useEffect(() => {
    let active = true
    void loadAll(() => active)
    return () => {
      active = false
    }
  }, [refreshToken])

  const profilesById = useMemo(() => new Map(profiles.map((profile) => [profile.profileId, profile])), [profiles])
  const parsedEvents = useMemo(() => events.map(parsePoolEvent), [events])

  function updateDraft(family: string, updater: (draft: PolicyDraft) => PolicyDraft) {
    dirtyFamiliesRef.current = new Set([...dirtyFamiliesRef.current, family])
    setDrafts((current) => {
      const next = {
        ...current,
        [family]: updater(current[family] ?? defaultDraft()),
      }
      draftsRef.current = next
      return next
    })
  }

  async function saveFamily(family: string) {
    const draft = drafts[family] ?? defaultDraft()
    setSavingFamilies((current) => new Set([...current, family]))
    setMessage(null)
    try {
      const result = await runtimeTaskPolicySet({
        taskFamily: family,
        profileOrder: draft.profileOrder,
        autoFailover: draft.autoFailover,
      })
      setDrafts((current) => {
        const next = {
          ...current,
          [family]: {
            profileOrder: result.policy.profileOrder,
            autoFailover: result.policy.autoFailover,
          },
        }
        draftsRef.current = next
        return next
      })
      dirtyFamiliesRef.current = new Set(
        [...dirtyFamiliesRef.current].filter((value) => value !== family),
      )
      setMessage(result.removedProfileIds.length > 0
        ? t("fallbackPolicy.savedWithRemoved", { ids: result.removedProfileIds.join(", ") })
        : t("fallbackPolicy.saved"))
    } catch (error) {
      setMessage(t("fallbackPolicy.saveFailed", { message: errorMessage(error) }))
    } finally {
      setSavingFamilies((current) => {
        const next = new Set(current)
        next.delete(family)
        return next
      })
    }
  }

  async function clearBreaker(profileId: string) {
    setMessage(null)
    try {
      await runtimeProfileBreakerClear({ profileId })
      setMessage(t("fallbackPolicy.breakerCleared"))
      await refreshObservability()
    } catch (error) {
      setMessage(t("fallbackPolicy.breakerClearFailed", { message: errorMessage(error) }))
    }
  }

  if (loadState.kind === "ready" && loadState.status === "disabled") {
    return null
  }

  return (
    <div className="space-y-4" data-testid="fallback-policy-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{t("fallbackPolicy.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("fallbackPolicy.description")}</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60"
          onClick={() => void refreshObservability()}
          disabled={refreshingObservability}
          data-testid="fallback-refresh-observability"
        >
          {refreshingObservability ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("fallbackPolicy.refresh")}
        </button>
      </div>

      {loadState.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("fallbackPolicy.loading")}
        </div>
      )}
      {loadState.kind === "error" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {loadState.message}
        </div>
      )}
      {loadState.kind === "ready" && loadState.status === "no-project" && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t("settings.sections.modelConfig.profiles.runtimeUnavailableNoProject")}
        </div>
      )}

      {loadState.kind === "ready" && loadState.status === "healthy" && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {PROFILE_TASK_FAMILY_OPTIONS.map((family) => {
              const draft = drafts[family] ?? defaultDraft()
              const familySaving = savingFamilies.has(family)
              const orderSet = new Set(draft.profileOrder)
              const addableProfiles = profiles.filter((profile) => (
                profile.enabled && profile.taskFamilies.includes(family) && !orderSet.has(profile.profileId)
              ))
              return (
                <section key={family} className="space-y-3 rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold">{t(taskFamilyLabelKey(family))}</h4>
                      <p className="text-[11px] text-muted-foreground">{t("fallbackPolicy.queueSize", { count: draft.profileOrder.length })}</p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={draft.autoFailover}
                        disabled={familySaving}
                        onChange={(event) => updateDraft(family, (current) => ({
                          ...current,
                          autoFailover: event.target.checked,
                        }))}
                        data-testid={`fallback-auto-${family}`}
                      />
                      {t("fallbackPolicy.autoFailover")}
                    </label>
                  </div>

                  <div className="space-y-2">
                    {draft.profileOrder.length === 0 && (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        {t("fallbackPolicy.emptyQueue")}
                      </div>
                    )}
                    {draft.profileOrder.map((profileId, index) => {
                      const profile = profilesById.get(profileId)
                      return (
                        <div
                          key={profileId}
                          className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                          data-testid={`fallback-row-${family}-${profileId}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{profile?.displayName ?? profileId}</div>
                            <div className="truncate text-muted-foreground">{profile?.modelId ?? t("fallbackPolicy.missingProfile")}</div>
                          </div>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-50"
                            disabled={familySaving || index === 0}
                            onClick={() => updateDraft(family, (current) => ({
                              ...current,
                              profileOrder: moveProfileInOrder(current.profileOrder, profileId, -1),
                            }))}
                            aria-label={t("fallbackPolicy.moveUp")}
                            data-testid={`fallback-up-${family}-${profileId}`}
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border hover:bg-accent disabled:opacity-50"
                            disabled={familySaving || index === draft.profileOrder.length - 1}
                            onClick={() => updateDraft(family, (current) => ({
                              ...current,
                              profileOrder: moveProfileInOrder(current.profileOrder, profileId, 1),
                            }))}
                            aria-label={t("fallbackPolicy.moveDown")}
                            data-testid={`fallback-down-${family}-${profileId}`}
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-destructive/40 text-destructive hover:bg-destructive/5"
                            disabled={familySaving}
                            onClick={() => updateDraft(family, (current) => ({
                              ...current,
                              profileOrder: removeProfileFromOrder(current.profileOrder, profileId),
                            }))}
                            aria-label={t("fallbackPolicy.remove")}
                            data-testid={`fallback-remove-${family}-${profileId}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <select
                      className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs"
                      data-testid={`fallback-add-select-${family}`}
                      value=""
                      disabled={familySaving}
                      onChange={(event) => updateDraft(family, (current) => ({
                        ...current,
                        profileOrder: addProfileToOrder(current.profileOrder, event.target.value),
                      }))}
                    >
                      <option value="">{t("fallbackPolicy.addProfile")}</option>
                      {addableProfiles.map((profile) => (
                        <option key={profile.profileId} value={profile.profileId}>
                          {profile.displayName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                      disabled={familySaving}
                      onClick={() => void saveFamily(family)}
                      data-testid={`fallback-save-${family}`}
                    >
                      {familySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {t("fallbackPolicy.save")}
                    </button>
                  </div>
                </section>
              )
            })}
          </div>

          <section className="space-y-3 rounded-md border p-3">
            <h4 className="text-sm font-semibold">{t("fallbackPolicy.breakersTitle")}</h4>
            {poolSnapshot.activeClaims.length === 0 && poolSnapshot.circuitBreakers.length === 0 && (
              <div className="text-xs text-muted-foreground">{t("fallbackPolicy.noPoolState")}</div>
            )}
            {poolSnapshot.activeClaims.map((claim) => (
              <div key={claim.claimId} className="rounded-md border px-3 py-2 text-xs">
                {t("fallbackPolicy.activeClaim", {
                  profile: profilesById.get(claim.profileId)?.displayName ?? claim.profileId,
                  family: claim.taskFamily,
                  time: new Date(claim.expiresAtMs).toLocaleString(),
                })}
              </div>
            ))}
            {poolSnapshot.circuitBreakers.map((breaker) => (
              <div key={breaker.profileId} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{profilesById.get(breaker.profileId)?.displayName ?? breaker.profileId}</div>
                  <div className="text-muted-foreground">
                    {breaker.status} · {breaker.reason ?? t("fallbackPolicy.noReason")} · {new Date(breaker.openUntilMs).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 hover:bg-accent"
                  onClick={() => void clearBreaker(breaker.profileId)}
                  data-testid={`fallback-clear-breaker-${breaker.profileId}`}
                >
                  {t("fallbackPolicy.clearBreaker")}
                </button>
              </div>
            ))}
          </section>

          <section className="space-y-3 rounded-md border p-3">
            <h4 className="text-sm font-semibold">{t("fallbackPolicy.eventsTitle")}</h4>
            {parsedEvents.length === 0 && (
              <div className="text-xs text-muted-foreground">{t("fallbackPolicy.noEvents")}</div>
            )}
            {parsedEvents.map((item) => (
              <div key={item.event.eventId} className="grid gap-1 rounded-md border px-3 py-2 text-xs sm:grid-cols-[150px_1fr]">
                <div className="text-muted-foreground">{new Date(item.event.createdAtMs).toLocaleString()}</div>
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {item.taskFamily || t("fallbackPolicy.unknownFamily")} · {item.event.eventName}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {t("fallbackPolicy.eventRoute", {
                      from: item.requested || "-",
                      to: item.selected || "-",
                      reason: item.fromOrder === null
                        ? item.reason || "-"
                        : item.fromOrder
                          ? t("fallbackPolicy.eventOrdered", { reason: item.reason || "-" })
                          : t("fallbackPolicy.eventExhausted", { reason: item.reason || "-" }),
                    })}
                  </div>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}
