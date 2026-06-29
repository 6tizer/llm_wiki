import {
  RUNTIME_CONTRACT_FAMILIES,
  type CoreRuntimeContract,
  type RuntimeContractFamily,
  type RuntimeDirection,
} from "./index"
import { STORE_BOUNDARY_ENTRIES, type StoreBoundaryEntry } from "./store-boundary"

export type AdapterContractRole =
  | "ui-shell"
  | "platform-adapter"
  | "storage-boundary"
  | "agent-adapter"

export type PlatformAdapterFamily = Extract<RuntimeContractFamily, "file-platform" | "process-cli">
export type StorageBoundaryFamily = Extract<RuntimeContractFamily, "project" | "job-runtime" | "settings-status">
export type AgentAdapterFamily = Extract<RuntimeContractFamily, "agent-run">

export type AdapterFamilyMatrix = {
  readonly "ui-shell": readonly RuntimeContractFamily[]
  readonly "platform-adapter": readonly PlatformAdapterFamily[]
  readonly "storage-boundary": readonly StorageBoundaryFamily[]
  readonly "agent-adapter": readonly AgentAdapterFamily[]
}

export type MockAdapterContract<Role extends AdapterContractRole> = {
  readonly role: Role
  readonly allowedFamilies: AdapterFamilyMatrix[Role]
  readonly forbiddenFamilies: readonly RuntimeContractFamily[]
  readonly forbiddenDependencies: readonly string[]
}

export type AdapterDrivenMessage = {
  readonly family: RuntimeContractFamily
  readonly direction: RuntimeDirection
  readonly action: "invoked-command" | "collected-event"
}

export type MockShellAdapter = MockAdapterContract<"ui-shell"> & {
  driveFamilyDirections(): Promise<readonly AdapterDrivenMessage[]>
}

export type MockStorageBoundaryContract = MockAdapterContract<"storage-boundary"> & {
  readonly storeEntries: readonly StoreBoundaryEntry[]
  readonly runtimeDeferredEntries: readonly StoreBoundaryEntry[]
}

export type AdapterCoordination = {
  readonly sourceRole: AdapterContractRole
  readonly sourceFamily: RuntimeContractFamily
  readonly targetRole: AdapterContractRole
  readonly targetFamily: RuntimeContractFamily
  readonly mediatedBy: "core-runtime"
}

export const ADAPTER_FAMILY_MATRIX: AdapterFamilyMatrix = {
  "ui-shell": RUNTIME_CONTRACT_FAMILIES,
  "platform-adapter": ["file-platform", "process-cli"],
  "storage-boundary": ["project", "job-runtime", "settings-status"],
  "agent-adapter": ["agent-run"],
}

export const MOCK_ADAPTER_FORBIDDEN_DEPENDENCIES = [
  "react",
  "react/*",
  "zustand",
  "zustand/*",
  "@/stores/*",
  "@/commands/*",
  "@/components/*",
  "@tauri-apps/*",
  "@/lib/runtime.db",
] as const

function forbiddenFamiliesFor(allowedFamilies: readonly RuntimeContractFamily[]): readonly RuntimeContractFamily[] {
  return RUNTIME_CONTRACT_FAMILIES.filter((family) => !allowedFamilies.includes(family))
}

/**
 * Create inert metadata for one adapter role without importing shell or platform APIs.
 */
export function createMockAdapterContract<Role extends AdapterContractRole>(
  role: Role,
): MockAdapterContract<Role> {
  const allowedFamilies = ADAPTER_FAMILY_MATRIX[role]

  return {
    role,
    allowedFamilies,
    forbiddenFamilies: forbiddenFamiliesFor(allowedFamilies),
    forbiddenDependencies: MOCK_ADAPTER_FORBIDDEN_DEPENDENCIES,
  } as MockAdapterContract<Role>
}

/**
 * Drive the frozen core contract through a mock shell without rendering React.
 */
export function createMockShellAdapter(contract: CoreRuntimeContract): MockShellAdapter {
  const adapter = createMockAdapterContract("ui-shell")

  return {
    ...adapter,
    driveFamilyDirections: async () => {
      const messages = contract.listMessages()
      const driven: AdapterDrivenMessage[] = []

      for (const family of RUNTIME_CONTRACT_FAMILIES) {
        for (const direction of ["command", "event"] as const satisfies readonly RuntimeDirection[]) {
          const message = messages.find((candidate) => candidate.family === family && candidate.direction === direction)
          if (!message) {
            throw new Error(`Missing ${family} ${direction} message`)
          }
          if (direction === "command") {
            const result = await contract.invokePlaceholder(message)
            if (!result.ok) {
              throw new Error(result.error.message)
            }
            driven.push({ family, direction, action: "invoked-command" })
          } else {
            driven.push({ family, direction, action: "collected-event" })
          }
        }
      }

      return driven
    },
  }
}

/**
 * Create an inert platform adapter contract limited to platform-owned families.
 */
export function createMockPlatformAdapterContract(): MockAdapterContract<"platform-adapter"> {
  return createMockAdapterContract("platform-adapter")
}

/**
 * Create an inert storage boundary contract that consumes PR4 metadata only.
 */
export function createMockStorageBoundaryContract(): MockStorageBoundaryContract {
  return {
    ...createMockAdapterContract("storage-boundary"),
    storeEntries: STORE_BOUNDARY_ENTRIES,
    runtimeDeferredEntries: STORE_BOUNDARY_ENTRIES.filter(
      (entry) => entry.currentSurface === "runtime-db-deferred",
    ),
  }
}

/**
 * Create an inert agent adapter contract limited to the agent-run family.
 */
export function createMockAgentAdapterContract(): MockAdapterContract<"agent-adapter"> {
  return createMockAdapterContract("agent-adapter")
}

/**
 * Describe cross-adapter coordination without transferring family ownership.
 */
export function createAdapterCoordinationMatrix(): readonly AdapterCoordination[] {
  return [
    {
      sourceRole: "agent-adapter",
      sourceFamily: "agent-run",
      targetRole: "platform-adapter",
      targetFamily: "process-cli",
      mediatedBy: "core-runtime",
    },
  ]
}
