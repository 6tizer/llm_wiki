import type { RuntimeProfileRecord } from "@/commands/runtime-db"
import { LLM_PRESETS } from "@/lib/llm-presets"

export interface ProfileConnectionGroup {
  key: string
  providerId: string
  providerLabel: string
  endpoint: string
  secretRef: string
  profiles: RuntimeProfileRecord[]
}

function presetForProviderId(providerId: string) {
  return LLM_PRESETS.find((preset) => preset.id === providerId)
}

function providerLabel(providerId: string): string {
  return presetForProviderId(providerId)?.label ?? providerId
}

export function profileConnectionGroupKey(profile: RuntimeProfileRecord): string {
  return JSON.stringify([
    profile.providerId,
    profile.endpoint ?? "",
    profile.secretRef ?? "",
  ])
}

/** Groups runtime profiles by shared provider endpoint and secret reference. */
export function groupProfilesByConnection(profiles: RuntimeProfileRecord[]): ProfileConnectionGroup[] {
  const groups = new Map<string, ProfileConnectionGroup>()
  for (const profile of profiles) {
    const key = profileConnectionGroupKey(profile)
    const existing = groups.get(key)
    if (existing) {
      existing.profiles.push(profile)
      continue
    }
    groups.set(key, {
      key,
      providerId: profile.providerId,
      providerLabel: providerLabel(profile.providerId),
      endpoint: profile.endpoint ?? "",
      secretRef: profile.secretRef ?? "",
      profiles: [profile],
    })
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      profiles: [...group.profiles].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => (
      a.providerLabel.localeCompare(b.providerLabel)
        || a.endpoint.localeCompare(b.endpoint)
        || a.secretRef.localeCompare(b.secretRef)
    ))
}
