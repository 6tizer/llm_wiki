import { beforeEach, describe, expect, it, vi } from "vitest"
import { BULK_KNOWLEDGE_PREPARE_JOB_KIND } from "@/core-runtime/parallel-knowledge"
import type { RuntimeJobRecord, RuntimeProfilePoolClaim, RuntimeProfileRecord } from "@/commands/runtime-db"
import type { PrepareModelCallRequest } from "./prepare-worker-pool"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

const runtimeDbMocks = vi.hoisted(() => ({
  runtimeModelCallForward: vi.fn(),
  runtimeProfileStatus: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("@/commands/runtime-db", () => runtimeDbMocks)

function openAiProfile(overrides: Partial<RuntimeProfileRecord> = {}): RuntimeProfileRecord {
  return {
    profileId: "profile-ingest",
    kind: "model-call",
    displayName: "Test Profile",
    providerId: "openai",
    modelId: "gpt-test",
    endpoint: null,
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    secretRef: "llm-wiki-profile-secret:00000000-0000-4000-8000-000000000000",
    enabled: true,
    taskFamilies: ["ingest"],
    maxConcurrency: 2,
    capabilityStatus: "supported",
    capabilityJson: "{}",
    capabilityVersion: "profile-probe.v1",
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  }
}

function job(sources: Array<{ sourcePath: string; sourceIdentity: string; duplicateCount: number }>): RuntimeJobRecord {
  return {
    jobId: "job-1",
    kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
    payload: JSON.stringify({
      kind: BULK_KNOWLEDGE_PREPARE_JOB_KIND,
      batchIndex: 0,
      sources,
    }),
    state: "running",
    attempt: 1,
    maxAttempts: 3,
    priority: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  }
}

function profileClaim(): RuntimeProfilePoolClaim {
  return {
    claimId: "claim-1",
    profileId: "profile-ingest",
    expiresAtMs: 1_202,
    claim: {
      claimId: "claim-1",
      profileId: "profile-ingest",
      kind: "model-call",
      taskFamily: "ingest",
      jobId: "job-1",
      holder: "bulk-prepare:1",
      acquiredAtMs: 2,
      expiresAtMs: 1_202,
      status: "active",
    },
  }
}

function requestFor(
  sources: Array<{ sourcePath: string; sourceIdentity: string; duplicateCount: number }>,
): PrepareModelCallRequest {
  return {
    workerId: "bulk-prepare:1",
    job: job(sources),
    leaseId: "lease-job-1",
    payload: JSON.parse(job(sources).payload),
    profileClaim: profileClaim(),
  }
}

function openAiSse(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "data: [DONE]",
  ].join("\n")
}

describe("createPrepareModelCallExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeDbMocks.runtimeProfileStatus.mockResolvedValue(openAiProfile())
  })

  it("forwards a secretless plan matching the claimed profile and returns a committable artifact", async () => {
    fsMocks.readFile.mockResolvedValue("raw source body")
    runtimeDbMocks.runtimeModelCallForward.mockResolvedValue(openAiSse("# Title\nBody."))

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(runtimeDbMocks.runtimeModelCallForward).toHaveBeenCalledTimes(1)
    const forwardedRequest = runtimeDbMocks.runtimeModelCallForward.mock.calls[0][0]
    expect(forwardedRequest.claimId).toBe("claim-1")
    expect(forwardedRequest.provider).toBe("openai")
    expect(forwardedRequest.apiMode).toBe("openai-chat-completions")
    expect(forwardedRequest.model).toBe("gpt-test")
    // The secretless plan must never carry an api key / secret / final URL.
    expect(JSON.stringify(forwardedRequest)).not.toMatch(/apiKey|secret|https?:\/\//i)

    expect(outcome).toMatchObject({ status: "success" })
    if (outcome.status !== "success") throw new Error("expected success")
    expect(outcome.artifacts).toHaveLength(1)
    expect(outcome.artifacts?.[0]).toMatchObject({
      sourcePath: "/project/raw/sources/a.md",
      operationIntent: "create",
      sourceKind: "ingest",
      markdown: "# Title\nBody.",
      baseHash: null,
    })
    expect((outcome.artifacts?.[0] as { targetPath: string }).targetPath).toBe("Wiki/a.md")
    expect((outcome.artifacts?.[0] as { artifactPath: string }).artifactPath).toBe("job-1/a.md")
  })

  it("derives distinct target/artifact paths for multiple sources in one batch", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith("a.md") ? "source a" : "source b",
    )
    runtimeDbMocks.runtimeModelCallForward.mockResolvedValue(openAiSse("# Page"))

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
      { sourcePath: "/project/raw/sources/nested/b.md", sourceIdentity: "/project/raw/sources/nested/b.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome.status).toBe("success")
    if (outcome.status !== "success") throw new Error("expected success")
    expect(outcome.artifacts).toHaveLength(2)
    const targetPaths = (outcome.artifacts as Array<{ targetPath: string }>).map((a) => a.targetPath)
    const artifactPaths = (outcome.artifacts as Array<{ artifactPath: string }>).map((a) => a.artifactPath)
    expect(new Set(targetPaths).size).toBe(2)
    expect(new Set(artifactPaths).size).toBe(2)
    expect(artifactPaths.every((p) => p.startsWith("job-1/"))).toBe(true)
  })

  it("resolves a slug collision within one batch instead of overwriting the first artifact's path", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith(".md") ? "source markdown" : "source text",
    )
    runtimeDbMocks.runtimeModelCallForward.mockResolvedValue(openAiSse("# Page"))

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    // Both normalize to slug "a" once slugifySourcePath drops the extension.
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
      { sourcePath: "/project/raw/sources/a.txt", sourceIdentity: "/project/raw/sources/a.txt", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome.status).toBe("success")
    if (outcome.status !== "success") throw new Error("expected success")
    expect(outcome.artifacts).toHaveLength(2)
    const targetPaths = (outcome.artifacts as Array<{ targetPath: string }>).map((a) => a.targetPath)
    const artifactPaths = (outcome.artifacts as Array<{ artifactPath: string }>).map((a) => a.artifactPath)
    // First source keeps the bare slug; the colliding second source is
    // deterministically disambiguated by its own extension.
    expect(targetPaths).toEqual(["Wiki/a.md", "Wiki/a-txt.md"])
    expect(artifactPaths).toEqual(["job-1/a.md", "job-1/a-txt.md"])
    expect(new Set(targetPaths).size).toBe(2)
    expect(new Set(artifactPaths).size).toBe(2)

    // Rerunning the identical batch must reproduce the same resolution
    // (deterministic, not e.g. seeded by call order/timing).
    const rerunOutcome = await executor(requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
      { sourcePath: "/project/raw/sources/a.txt", sourceIdentity: "/project/raw/sources/a.txt", duplicateCount: 0 },
    ]))
    if (rerunOutcome.status !== "success") throw new Error("expected success")
    expect((rerunOutcome.artifacts as Array<{ targetPath: string }>).map((a) => a.targetPath)).toEqual([
      "Wiki/a.md",
      "Wiki/a-txt.md",
    ])
  })

  it("reports rate-limited outcomes from the Rust forwarder without leaking provider details", async () => {
    fsMocks.readFile.mockResolvedValue("raw source body")
    runtimeDbMocks.runtimeModelCallForward.mockRejectedValue(
      new Error("model-call-rate-limited: retryAfterMs=12000 provider returned 429 Too Many Requests"),
    )

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome).toMatchObject({
      status: "rate-limited",
      retryAfterMs: 12_000,
      jobRetryAfterMs: 12_000,
    })
    if (outcome.status !== "rate-limited") throw new Error("expected rate-limited")
    expect(outcome.error).toBe(
      "model-call-rate-limited: retryAfterMs=12000 provider returned 429 Too Many Requests",
    )
  })

  it("reports non-2xx forwarder failures as a job-level error without decoration", async () => {
    fsMocks.readFile.mockResolvedValue("raw source body")
    runtimeDbMocks.runtimeModelCallForward.mockRejectedValue(
      new Error("model-call-http-failed: provider returned 500 Internal Server Error"),
    )

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome).toEqual({
      status: "error",
      error: "model-call-http-failed: provider returned 500 Internal Server Error",
    })
  })

  it("short-circuits unsupported api modes without ever calling the forwarder", async () => {
    fsMocks.readFile.mockResolvedValue("raw source body")
    runtimeDbMocks.runtimeProfileStatus.mockResolvedValue(
      openAiProfile({ apiMode: "local-cli", providerId: "claude-code", authStyle: "oauth-local-cli" }),
    )

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/a.md", sourceIdentity: "/project/raw/sources/a.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(runtimeDbMocks.runtimeModelCallForward).not.toHaveBeenCalled()
    expect(outcome.status).toBe("error")
    if (outcome.status !== "error") throw new Error("expected error")
    expect(outcome.error).toContain("model-call-api-mode-unsupported")
  })

  it("reports source read failures as a job-level error identifying only the path", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("os-level detail that should not leak"))

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/missing.md", sourceIdentity: "/project/raw/sources/missing.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome).toEqual({
      status: "error",
      error: "prepare-source-read-failed: /project/raw/sources/missing.md",
    })
    expect(runtimeDbMocks.runtimeModelCallForward).not.toHaveBeenCalled()
  })

  it("processes a long source through map-reduce, calling the model once per chunk", async () => {
    const longContent = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n${"word ".repeat(2000)}`).join("\n\n")
    fsMocks.readFile.mockResolvedValue(longContent)
    runtimeDbMocks.runtimeModelCallForward.mockResolvedValue(openAiSse("chunk analysis"))

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/long.md", sourceIdentity: "/project/raw/sources/long.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(runtimeDbMocks.runtimeModelCallForward.mock.calls.length).toBeGreaterThan(1)
    expect(outcome.status).toBe("success")
    if (outcome.status !== "success") throw new Error("expected success")
    expect(outcome.mapReduceResults).toBeDefined()
    const reduceResult = Array.isArray(outcome.mapReduceResults)
      ? outcome.mapReduceResults[0]
      : outcome.mapReduceResults
    expect(reduceResult?.status).toBe("complete")
    expect(outcome.artifacts).toHaveLength(1)
  })

  it("captures a single chunk's non-rate-limit failure as a repair candidate instead of aborting the job", async () => {
    const longContent = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n${"word ".repeat(2000)}`).join("\n\n")
    fsMocks.readFile.mockResolvedValue(longContent)
    let call = 0
    runtimeDbMocks.runtimeModelCallForward.mockImplementation(async () => {
      call += 1
      if (call === 2) throw new Error("model-call-http-failed: provider returned 500 Internal Server Error")
      return openAiSse("chunk analysis")
    })

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/long.md", sourceIdentity: "/project/raw/sources/long.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome.status).toBe("success")
    if (outcome.status !== "success") throw new Error("expected success")
    const reduceResult = Array.isArray(outcome.mapReduceResults)
      ? outcome.mapReduceResults[0]
      : outcome.mapReduceResults
    expect(reduceResult?.status).toBe("partial")
    expect(reduceResult?.commitPolicy).toBe("repair-only")
    expect(reduceResult?.failedChunks[0]?.error).toBe("provider-error")
    // repair-only source must not also get a committable artifact
    expect(outcome.artifacts).toHaveLength(0)
  })

  it("aborts the whole job when a map-reduce chunk call is rate-limited", async () => {
    const longContent = Array.from({ length: 40 }, (_, index) => `## Section ${index}\n${"word ".repeat(2000)}`).join("\n\n")
    fsMocks.readFile.mockResolvedValue(longContent)
    let call = 0
    runtimeDbMocks.runtimeModelCallForward.mockImplementation(async () => {
      call += 1
      if (call === 2) {
        throw new Error("model-call-rate-limited: retryAfterMs=5000 provider returned 429 Too Many Requests")
      }
      return openAiSse("chunk analysis")
    })

    const { createPrepareModelCallExecutor } = await import("./prepare-model-call-executor")
    const executor = createPrepareModelCallExecutor()
    const request = requestFor([
      { sourcePath: "/project/raw/sources/long.md", sourceIdentity: "/project/raw/sources/long.md", duplicateCount: 0 },
    ])

    const outcome = await executor(request)

    expect(outcome).toMatchObject({ status: "rate-limited", retryAfterMs: 5_000 })
  })
})
