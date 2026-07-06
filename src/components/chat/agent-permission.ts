import type {
  AgentPermissionDecision,
  AgentPermissionRequestPayload,
} from "@/lib/agent/agent-types"
import { safeStringify } from "./agent-format"

export type AgentPermissionAction =
  | "allow_temporary"
  | "allow_permanent"
  | "allow_run"
  | "deny"
  | "deny_interrupt"

/** Convert a user dialog action into the SDK permission decision shape. */
export function buildAgentPermissionDecision(
  action: AgentPermissionAction,
  payload: AgentPermissionRequestPayload,
): AgentPermissionDecision {
  if (action === "allow_temporary") {
    return {
      behavior: "allow",
      decisionClassification: "user_temporary",
    }
  }
  if (action === "allow_permanent") {
    const suggestions = payload.suggestions
    return {
      behavior: "allow",
      // An empty suggestions array must not be written back as
      // `updatedPermissions: []` — the SDK treats an explicit empty array as
      // "wipe the permission list", which would silently produce a blank
      // allow-list. Omit the field entirely when there is nothing to persist.
      ...(suggestions && suggestions.length > 0
        ? { updatedPermissions: suggestions }
        : {}),
      decisionClassification: "user_permanent",
    }
  }
  if (action === "allow_run") {
    return {
      behavior: "allow",
      decisionClassification: "user_permanent",
      scope: "run",
    }
  }
  const reason = payload.decisionReason ?? "Permission denied"
  return {
    behavior: "deny",
    message: reason,
    reason,
    interrupt: action === "deny_interrupt" ? true : undefined,
    decisionClassification: "user_reject",
  }
}

/** Safely format the permission input preview for the dialog. */
export function formatAgentPermissionInputPreview(value: unknown): string {
  return safeStringify(value)
}

export function isAgentPermissionInteractiveElement(
  tagName?: string | null,
  role?: string | null,
): boolean {
  const tag = tagName?.toUpperCase()
  return tag === "BUTTON"
    || tag === "INPUT"
    || tag === "TEXTAREA"
    || tag === "SELECT"
    || tag === "A"
    || role === "button"
}

export function isAgentPermissionShortcutInteractiveTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false
  }
  const interactiveTarget = target.closest("button,input,textarea,select,a,[role='button']")
  if (!(interactiveTarget instanceof HTMLElement)) return false
  return isAgentPermissionInteractiveElement(
    interactiveTarget.tagName,
    interactiveTarget.getAttribute("role"),
  )
}
