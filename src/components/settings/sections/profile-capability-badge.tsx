import type { TFunction } from "i18next"
import type { RuntimeProfileCapabilityStatus } from "@/commands/runtime-db"

interface CapabilityBadgeMeta {
  className: string
  label: string
}

const STATUS_CLASS: Record<RuntimeProfileCapabilityStatus, string> = {
  supported: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  limited: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  unsupported: "border-destructive/40 bg-destructive/10 text-destructive",
  unknown: "border-muted bg-muted text-muted-foreground",
}

/** Returns display metadata for the runtime profile capability status badge. */
export function capabilityBadgeMeta(
  status: RuntimeProfileCapabilityStatus,
  t: TFunction,
): CapabilityBadgeMeta {
  return {
    className: STATUS_CLASS[status] ?? STATUS_CLASS.unknown,
    label: t(`settings.sections.modelConfig.profiles.capabilityStatus.${status}`),
  }
}

/** Renders the compact three-color runtime profile health badge. */
export function ProfileCapabilityBadge({
  status,
  t,
  as = "span",
  onClick,
}: {
  status: RuntimeProfileCapabilityStatus
  t: TFunction
  as?: "span" | "button"
  onClick?: () => void
}) {
  const meta = capabilityBadgeMeta(status, t)
  const className = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] ${meta.className}`
  if (as === "button") {
    return (
      <button
        type="button"
        className={`${className} hover:opacity-80`}
        onClick={onClick}
      >
        {meta.label}
      </button>
    )
  }
  return <span className={className}>{meta.label}</span>
}
