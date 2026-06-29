/**
 * Shell-agnostic Core Runtime contract skeleton.
 *
 * This file is intentionally limited to inert types and mockable interfaces.
 * It must not import React, Zustand stores, Tauri APIs, plugin-store, or any
 * runtime persistence implementation.
 */

export type RuntimeContractFamily =
  | "project"
  | "job-runtime"
  | "markdown-commit"
  | "profiles"
  | "derived"
  | "search-vector"
  | "file-platform"
  | "process-cli"
  | "agent-run"
  | "settings-status"

export type RuntimeDirection = "command" | "event"

export interface RuntimeContractMessage {
  family: RuntimeContractFamily
  direction: RuntimeDirection
  name: string
  payloadShape: "placeholder"
}

export interface RuntimeContractError {
  code: string
  message: string
  retryable?: boolean
}

export interface CoreRuntimeContract {
  readonly maturity: "frozen"
  listMessages(): readonly RuntimeContractMessage[]
  invokePlaceholder(
    message: RuntimeContractMessage,
  ): Promise<{ ok: true } | { ok: false; error: RuntimeContractError }>
}

export const RUNTIME_CONTRACT_FAMILIES: readonly RuntimeContractFamily[] = [
  "project",
  "job-runtime",
  "markdown-commit",
  "profiles",
  "derived",
  "search-vector",
  "file-platform",
  "process-cli",
  "agent-run",
  "settings-status",
]

export function createMockCoreRuntimeContract(): CoreRuntimeContract {
  const messages = RUNTIME_CONTRACT_FAMILIES.flatMap((family) => [
    {
      family,
      direction: "command" as const,
      name: `${family}:placeholder-command`,
      payloadShape: "placeholder" as const,
    },
    {
      family,
      direction: "event" as const,
      name: `${family}:placeholder-event`,
      payloadShape: "placeholder" as const,
    },
  ])

  return {
    maturity: "frozen",
    listMessages: () => messages,
    invokePlaceholder: async (message) => {
      if (!RUNTIME_CONTRACT_FAMILIES.includes(message.family)) {
        return {
          ok: false,
          error: {
            code: "UNKNOWN_FAMILY",
            message: `Unknown runtime contract family: ${message.family}`,
            retryable: false,
          },
        }
      }
      return { ok: true }
    },
  }
}
