/**
 * Path-safety regression tests for applyLlmFix (#119 P1-3).
 *
 * applyLlmFix constructs a target path from LLM output (block.path). Without
 * the isSafeIngestPath guard, a prompt-injected LLM could emit
 * `---FILE: ../../etc/passwd---` and the fixer would write to it. These tests
 * verify the guard rejects traversal vectors and only writes wiki/-rooted
 * paths.
 *
 * Note: parseFileBlocks (used by executeIngestWrites, #119 P0-1) already has
 * end-to-end traversal coverage in ingest-parse.test.ts. applyLlmFix uses a
 * separate path-construction branch (it handles bare page paths without the
 * wiki/ prefix that lint prompts produce), so it needs its own coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { realFs } from "@/test-helpers/fs-temp"
import type { LintResult } from "./lint"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

// vi.mock is hoisted to the top of the file, before any const initializers.
// Use vi.hoisted to share the mock response between the factory and each test.
const { getMockResponse, setMockResponse } = vi.hoisted(() => {
  let response = ""
  return {
    getMockResponse: () => response,
    setMockResponse: (r: string) => {
      response = r
    },
  }
})

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_cfg: unknown, _messages: unknown, cb: { onToken: (t: string) => void; onDone: () => void }) => {
    const resp = getMockResponse()
    if (resp) {
      cb.onToken(resp)
    }
    cb.onDone()
  }),
}))

/** Set the FILE block the mocked streamChat will emit on the next call. */
function mockStreamChatWithBlock(blockPath: string, blockContent: string) {
  setMockResponse(`---FILE: ${blockPath}---\n${blockContent}\n---END FILE---`)
}

const fakeLlmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "test-model",
  maxContextSize: 128000,
  ollamaUrl: "",
  customEndpoint: "",
}

describe("applyLlmFix — path-traversal guard (#119 P1-3)", () => {
  let projectDir: string
  let outsideTarget: string

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-lint-fix-safety-"))
    // A target outside the project that a traversal would write to.
    outsideTarget = path.join(projectDir, "..", "MALICIOUS-traversal-output.md")
    // Ensure clean state
    try {
      await fs.unlink(outsideTarget)
    } catch {
      // may not exist
    }
  })

  afterEach(async () => {
    try {
      await fs.unlink(outsideTarget)
    } catch {
      // ignore
    }
    await fs.rm(projectDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it("rejects a ../../ traversal path and does not write outside the project", async () => {
    mockStreamChatWithBlock("../MALICIOUS-traversal-output.md", "# malicious")
    const { fixLintResult } = await import("./lint-fixer")

    const result: LintResult = {
      type: "broken-link",
      severity: "warning",
      page: "concepts/test",
      detail: "[[nonexistent]] is a broken link",
    }

    const ok = await fixLintResult(projectDir, result, fakeLlmConfig)
    // The fix returns false because the only block was rejected (nothing written).
    expect(ok).toBe(false)

    const exists = await fs
      .access(outsideTarget)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("rejects an absolute path /etc/passwd-style", async () => {
    mockStreamChatWithBlock("/tmp/MALICIOUS-absolute-lint-fix.md", "# malicious")
    const { fixLintResult } = await import("./lint-fixer")

    const result: LintResult = {
      type: "broken-link",
      severity: "warning",
      page: "concepts/test",
      detail: "[[nonexistent]] is a broken link",
    }

    const ok = await fixLintResult(projectDir, result, fakeLlmConfig)
    expect(ok).toBe(false)

    const exists = await fs
      .access("/tmp/MALICIOUS-absolute-lint-fix.md")
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it("writes a safe wiki/-rooted path successfully", async () => {
    // Pre-create the page file that fixBrokenLink reads for context.
    // result.page is relative to wiki/ and includes the .md extension.
    await fs.mkdir(path.join(projectDir, "wiki", "concepts"), { recursive: true })
    await fs.writeFile(
      path.join(projectDir, "wiki", "concepts", "test.md"),
      "---\ntype: concept\ntitle: Test\n---\n\n# Test\n\nLinks to [[nonexistent]].",
    )

    mockStreamChatWithBlock(
      "concepts/test.md",
      "---\ntype: concept\ntitle: Test\n---\n\n# Test\n\nFixed content.",
    )
    const { fixLintResult } = await import("./lint-fixer")

    const result: LintResult = {
      type: "broken-link",
      severity: "warning",
      page: "concepts/test.md",
      detail: "Broken link: [[nonexistent]] — page does not exist",
    }

    const ok = await fixLintResult(projectDir, result, fakeLlmConfig)
    expect(ok).toBe(true)

    // The file should exist at wiki/concepts/test.md inside the project.
    const writtenPath = path.join(projectDir, "wiki", "concepts", "test.md")
    const exists = await fs
      .access(writtenPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })
})
