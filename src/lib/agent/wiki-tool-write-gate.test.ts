import { describe, expect, it } from "vitest"
import { isWikiWriteToolCall } from "./wiki-tool-write-gate"
// Test-only cross-package import: the sidecar (src-tauri/sidecar) is a
// separately-built Node package, never bundled into the frontend, so this
// import cannot leak into production — vitest resolves it at test time
// only. This is deliberate: wiki-tool-write-gate.ts is a hand-copied
// duplicate of the sidecar's authoritative classifier (see the "Keep in
// sync" comment at the top of that file) with zero automated sync
// protection before this test. Without it, a tool added to
// agent-policy.ts's READ/WRITE lists (or reclassified in the sidecar) can
// silently drift from what the frontend gate believes.
import {
  isWikiWriteToolCall as sidecarIsWikiWriteToolCall,
  KNOWN_WIKI_TOOL_NAMES,
} from "../../../src-tauri/sidecar/src/wiki-tool-write-classifier"
import {
  READ_WIKI_TOOLS,
  WRITE_WIKI_TOOLS,
} from "../../../src-tauri/sidecar/src/agent-policy"

describe("wiki-tool-write-gate drift guard (sidecar is the source of truth)", () => {
  it("the classifier's known universe still equals agent-policy's READ ∪ WRITE union", () => {
    // Catches: a tool added to READ_WIKI_TOOLS/WRITE_WIKI_TOOLS without the
    // sidecar classifier being updated to know about it (r2 P3 concern) —
    // KNOWN_WIKI_TOOL_NAMES is exported as its own concrete list rather
    // than re-derived here from the same imports, so this only holds if
    // the classifier's internal derivation actually still covers the
    // policy lists.
    const policyUnion = new Set([...READ_WIKI_TOOLS, ...WRITE_WIKI_TOOLS])
    expect(new Set(KNOWN_WIKI_TOOL_NAMES)).toEqual(policyUnion)
  })

  it("the frontend gate agrees with the sidecar's authoritative classifier for every known wiki tool", () => {
    const mismatches = KNOWN_WIKI_TOOL_NAMES.filter(
      (name) => isWikiWriteToolCall(name) !== sidecarIsWikiWriteToolCall(name),
    )
    expect(mismatches).toEqual([])
  })

  it("agrees on non-wiki and unknown-wiki-tool fallback behavior", () => {
    for (const name of ["Bash", "Read", "Write", "mcp__other_server__write_thing"]) {
      expect(isWikiWriteToolCall(name)).toBe(sidecarIsWikiWriteToolCall(name))
    }
    // A wiki-prefixed name that exists in neither list must fail closed as
    // a write on both sides — this is the case the per-name diff above
    // can't distinguish from "both sides happen to agree by their own
    // independent default," so it's asserted explicitly here.
    const unknownName = "mcp__llm_wiki__not_a_real_tool_yet"
    expect(KNOWN_WIKI_TOOL_NAMES).not.toContain(unknownName)
    expect(isWikiWriteToolCall(unknownName)).toBe(true)
    expect(sidecarIsWikiWriteToolCall(unknownName)).toBe(true)
  })
})
