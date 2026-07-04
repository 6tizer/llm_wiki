import { describe, expect, it } from "vitest"
import { DERIVED_REBUILD_JOB_KIND, parseDerivedRebuildJobPayload } from "./index"

describe("DERIVED_REBUILD_JOB_KIND", () => {
  it("is the stable job kind string shared with the Rust side", () => {
    expect(DERIVED_REBUILD_JOB_KIND).toBe("derived-rebuild")
  })
})

describe("parseDerivedRebuildJobPayload", () => {
  it("parses a commit-intent payload written by runtimeDerivedMarkerClaimBatch", () => {
    const payload = JSON.stringify({
      layer: "embedding",
      affectedPath: "wiki/Page.md",
      markerIds: ["marker-1", "marker-2"],
      baseVersion: "sha256:hash3",
      inputHash: "sha256:hash3",
      reason: "commit",
    })

    expect(parseDerivedRebuildJobPayload(payload)).toEqual({
      layer: "embedding",
      affectedPath: "wiki/Page.md",
      markerIds: ["marker-1", "marker-2"],
      baseVersion: "sha256:hash3",
      inputHash: "sha256:hash3",
      reason: "commit",
    })
  })

  it("parses a delete-intent payload with a null inputHash", () => {
    const payload = JSON.stringify({
      layer: "embedding",
      affectedPath: "wiki/gone.md",
      markerIds: ["marker-3"],
      baseVersion: "sha256:hash1",
      inputHash: null,
      reason: "delete",
    })

    const parsed = parseDerivedRebuildJobPayload(payload)
    expect(parsed.reason).toBe("delete")
    expect(parsed.inputHash).toBeNull()
  })
})
