import { describe, expect, it } from "vitest"

import {
  clampMineruPollIntervalMs,
  clampMineruPollTimeoutMs,
  normalizeMineruConfig,
} from "./mineru-config"

describe("MinerU config normalization", () => {
  it("preserves persisted polling fields during app startup normalization", () => {
    expect(normalizeMineruConfig({
      enabled: true,
      token: "token",
      modelVersion: "pipeline",
      apiBaseUrl: "https://mineru.test/api/v4",
      pollIntervalMs: 4500,
      pollTimeoutMs: 600000,
    })).toEqual({
      enabled: true,
      token: "token",
      modelVersion: "pipeline",
      apiBaseUrl: "https://mineru.test/api/v4",
      pollIntervalMs: 4500,
      pollTimeoutMs: 600000,
    })
  })

  it("clamps invalid persisted polling fields and defaults legacy configs", () => {
    expect(normalizeMineruConfig({
      enabled: true,
      token: "token",
      modelVersion: "legacy" as "vlm",
      pollIntervalMs: 0,
      pollTimeoutMs: Number.NaN,
    })).toMatchObject({
      enabled: true,
      token: "token",
      modelVersion: "vlm",
      apiBaseUrl: "",
      pollIntervalMs: 500,
      pollTimeoutMs: 300000,
    })
    expect(clampMineruPollIntervalMs(999999)).toBe(30000)
    expect(clampMineruPollTimeoutMs(0)).toBe(60000)
  })
})
