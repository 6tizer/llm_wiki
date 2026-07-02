import { describe, expect, it } from "vitest"
import { fnv1a64Hex } from "./stable-hash"

describe("fnv1a64Hex", () => {
  it("returns stable 64-bit hex for the default seed", () => {
    expect(fnv1a64Hex("")).toBe("cbf29ce484222325")
    expect(fnv1a64Hex("hello")).toBe(fnv1a64Hex("hello"))
    expect(fnv1a64Hex("hello")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("allows a deterministic alternate seed", () => {
    expect(fnv1a64Hex("hello", 0x6c62272e07bb0142n)).toMatch(/^[0-9a-f]{16}$/)
    expect(fnv1a64Hex("hello", 0x6c62272e07bb0142n)).not.toBe(
      fnv1a64Hex("hello"),
    )
  })
})
