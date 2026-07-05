/**
 * Tests for the update-checker's pure logic. The network call itself
 * (`fetchLatestRelease`) is covered via `checkForUpdates` mocking the
 * fetch layer — we don't exercise it against real GitHub in CI.
 */
import { beforeEach, describe, it, expect, vi } from "vitest"
import {
  checkForUpdates,
  formatAppVersion,
  isNewer,
  toLatestReleaseUrl,
} from "./update-check"

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock("./tauri-fetch", () => ({
  getHttpFetch: vi.fn(async () => fetchMock),
  isFetchNetworkError: vi.fn((err: unknown) => err instanceof TypeError),
}))

beforeEach(() => {
  fetchMock.mockReset()
})

describe("isNewer — semver comparison", () => {
  it("remote > local on patch", () => {
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
  })

  it("remote > local on minor", () => {
    expect(isNewer("0.4.0", "0.3.99")).toBe(true)
  })

  it("remote > local on major", () => {
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
  })

  it("remote equal to local is NOT newer", () => {
    expect(isNewer("0.3.9", "0.3.9")).toBe(false)
  })

  it("remote < local is NOT newer (user on a nightly build)", () => {
    expect(isNewer("0.3.8", "0.3.9")).toBe(false)
  })

  it("tolerates leading 'v' on remote tag", () => {
    expect(isNewer("v0.3.10", "0.3.9")).toBe(true)
  })

  it("tolerates leading 'v' on local too", () => {
    expect(isNewer("v0.4.0", "v0.3.9")).toBe(true)
  })

  it("handles missing components as zero", () => {
    // Weirdly short tag like "v1" — treat as 1.0.0.
    expect(isNewer("v1", "0.3.9")).toBe(true)
    expect(isNewer("v1.0", "1.0.0")).toBe(false)
  })

  it("does not false-positive on lexicographic comparison", () => {
    // "0.3.9" comes AFTER "0.3.10" alphabetically — the check must be
    // numeric, not string-based. If this ever regressed to .localeCompare
    // or similar, users on 0.3.10 would be told there's a newer 0.3.9.
    expect(isNewer("0.3.9", "0.3.10")).toBe(false)
    expect(isNewer("0.3.10", "0.3.9")).toBe(true)
  })

  it("double-digit minor/patch compare correctly", () => {
    expect(isNewer("0.10.0", "0.9.99")).toBe(true)
    expect(isNewer("0.10.5", "0.10.4")).toBe(true)
    expect(isNewer("0.10.4", "0.10.5")).toBe(false)
  })

  it("non-numeric garbage in a slot collapses to 0 (can't sneak through an upgrade)", () => {
    // Defense against a malformed remote tag like "v0.3.foo" — don't
    // treat "foo" as infinity and tell the user to upgrade to nothing.
    expect(isNewer("v0.3.foo", "0.3.9")).toBe(false)
    expect(isNewer("v0.foo.0", "0.3.0")).toBe(false)
  })

  it("empty string treated as 0.0.0", () => {
    expect(isNewer("", "0.3.9")).toBe(false)
    expect(isNewer("0.3.9", "")).toBe(true)
  })
})

describe("toLatestReleaseUrl — canonical /releases/latest mapping", () => {
  it("converts a tag-specific release URL to /releases/latest", () => {
    expect(
      toLatestReleaseUrl("https://github.com/nashsu/llm_wiki/releases/tag/v0.4.0"),
    ).toBe("https://github.com/nashsu/llm_wiki/releases/latest")
  })

  it("normalizes a bare /releases listing URL to /releases/latest", () => {
    expect(
      toLatestReleaseUrl("https://github.com/nashsu/llm_wiki/releases"),
    ).toBe("https://github.com/nashsu/llm_wiki/releases/latest")
  })

  it("is idempotent on an already-/latest URL", () => {
    expect(
      toLatestReleaseUrl("https://github.com/nashsu/llm_wiki/releases/latest"),
    ).toBe("https://github.com/nashsu/llm_wiki/releases/latest")
  })

  it("works for any owner/repo combination", () => {
    expect(
      toLatestReleaseUrl("https://github.com/octocat/Hello-World/releases/tag/v3.2.1"),
    ).toBe("https://github.com/octocat/Hello-World/releases/latest")
  })

  it("accepts http (not just https) and case-insensitive github.com", () => {
    // The regex is case-insensitive on the host part — paranoia for
    // capitalization mishaps in user-edited config. Body of the URL
    // (owner/repo) is preserved verbatim.
    expect(
      toLatestReleaseUrl("http://GitHub.com/foo/bar/releases/tag/v1.0"),
    ).toBe("http://GitHub.com/foo/bar/releases/latest")
  })

  it("falls through unchanged for non-GitHub URLs (don't break random links)", () => {
    expect(toLatestReleaseUrl("https://example.com/releases/tag/v1.0")).toBe(
      "https://example.com/releases/tag/v1.0",
    )
    expect(toLatestReleaseUrl("https://gitlab.com/foo/bar/-/releases")).toBe(
      "https://gitlab.com/foo/bar/-/releases",
    )
  })

  it("falls through unchanged for non-release github URLs", () => {
    expect(toLatestReleaseUrl("https://github.com/nashsu/llm_wiki/issues/42")).toBe(
      "https://github.com/nashsu/llm_wiki/issues/42",
    )
    expect(toLatestReleaseUrl("https://github.com/nashsu/llm_wiki")).toBe(
      "https://github.com/nashsu/llm_wiki",
    )
  })
})

describe("checkForUpdates — GitHub latest release states", () => {
  it("returns no-release when GitHub reports latest release 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }))

    await expect(
      checkForUpdates({ currentVersion: "0.7.0", repo: "6tizer/llm_wiki" }),
    ).resolves.toEqual({ kind: "no-release", local: "0.7.0" })
  })

  it("returns error when the release request has a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    await expect(
      checkForUpdates({ currentVersion: "0.7.0", repo: "6tizer/llm_wiki" }),
    ).resolves.toEqual({
      kind: "error",
      local: "0.7.0",
      message: "Could not reach GitHub Releases API.",
    })
  })
})

describe("formatAppVersion — channel display", () => {
  it("appends alpha channel", () => {
    expect(formatAppVersion("0.7.0", "alpha")).toBe("v0.7.0-alpha")
  })

  it("does not append stable channel", () => {
    expect(formatAppVersion("0.7.0", "stable")).toBe("v0.7.0")
  })

  it("appends other non-stable channels", () => {
    expect(formatAppVersion("0.7.0", "beta")).toBe("v0.7.0-beta")
  })
})
