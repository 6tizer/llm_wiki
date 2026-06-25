import { create } from "zustand"

export const DEFAULT_ZOOM_LEVEL = 1
export const MIN_ZOOM_LEVEL = 0.5
export const MAX_ZOOM_LEVEL = 3
export const ZOOM_STEP = 0.05
export const BASE_FONT_SIZE_PX = 16

export interface ZoomState {
  /** Current zoom level as a decimal, where 1 means 100%. */
  level: number
  setLevel: (level: number) => void
}

/** Clamp the zoom level to the app-supported range. */
export function clampZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

/** Round a zoom level to two decimal places for stable step controls. */
export function roundZoomLevel(level: number): number {
  return Math.round(level * 100) / 100
}

export const useZoomStore = create<ZoomState>((set) => ({
  level: DEFAULT_ZOOM_LEVEL,
  setLevel: (level) => set({ level: clampZoomLevel(level) }),
}))
