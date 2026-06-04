import { create } from "zustand"
import {
  DEFAULT_AGENT_RESOURCE_CONFIG,
  normalizeAgentResourceConfig,
  type AgentResourceConfig,
} from "@/lib/agent/agent-settings"

interface AgentSettingsState {
  resourceConfig: AgentResourceConfig
  setResourceConfig: (config: Partial<AgentResourceConfig>) => void
  resetResourceConfig: () => void
}

export const useAgentSettingsStore = create<AgentSettingsState>((set) => ({
  resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG,
  setResourceConfig: (config) =>
    set({ resourceConfig: normalizeAgentResourceConfig(config) }),
  resetResourceConfig: () =>
    set({ resourceConfig: DEFAULT_AGENT_RESOURCE_CONFIG }),
}))
