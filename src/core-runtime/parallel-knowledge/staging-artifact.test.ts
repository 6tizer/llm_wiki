import { describe, expect, it } from "vitest"
import {
  BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
  derivePrepareArtifactId,
  MAX_PREPARE_ARTIFACT_DIAGNOSTICS_BYTES,
  MAX_PREPARE_ARTIFACT_HASH_BYTES,
  MAX_PREPARE_ARTIFACT_MARKDOWN_BYTES,
  MAX_PREPARE_ARTIFACT_PATH_BYTES,
  normalizeCommitTargetPath,
  validatePrepareArtifacts,
} from "./staging-artifact"

const validArtifact = {
  kind: BULK_KNOWLEDGE_PREPARE_OUTPUT_KIND,
  sourcePath: "sources/a.md",
  targetPath: "Wiki/Page.md",
  artifactPath: "job-1/page.md",
  operationIntent: "create",
  sourceKind: "ingest",
  markdown: "# Page\n",
  baseHash: null,
}

describe("validatePrepareArtifacts", () => {
  it("normalizes target paths and derives stable artifact ids from the job and target", () => {
    const [artifact] = validatePrepareArtifacts([validArtifact], { jobId: "job-1" })

    expect(artifact).toMatchObject({
      artifactId: derivePrepareArtifactId("job-1", "wiki/page.md"),
      targetPath: "Wiki/Page.md",
      targetResourceKey: "wiki/page.md",
      artifactPath: "job-1/page.md",
      operationIntent: "create",
      baseHash: null,
    })
    expect(artifact.artifactId).toMatch(/^bulk-artifact-[0-9a-f]{32}$/)
  })

  it("rejects model-provided artifact ids", () => {
    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, artifactId: "model-id" }], {
        jobId: "job-1",
      }),
    ).toThrow("prepare-artifact-id-forbidden")
  })

  it("rejects duplicate target paths after commit resource-key normalization", () => {
    expect(() =>
      validatePrepareArtifacts([
        validArtifact,
        {
          ...validArtifact,
          targetPath: "wiki/page.md",
          artifactPath: "job-1/page-2.md",
        },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-target-duplicate")
  })

  it("rejects duplicate artifact paths after staging path normalization", () => {
    expect(() =>
      validatePrepareArtifacts([
        validArtifact,
        {
          ...validArtifact,
          targetPath: "Wiki/Other.md",
          artifactPath: "job-1/Cafe\u{301}.md",
        },
        {
          ...validArtifact,
          targetPath: "Wiki/Third.md",
          artifactPath: "job-1/Café.md",
        },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-path-duplicate")
  })

  it("rejects unsafe target and artifact paths", () => {
    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, targetPath: "../Wiki/Page.md" }], {
        jobId: "job-1",
      }),
    ).toThrow("prepare-artifact-targetPath-invalid")

    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, artifactPath: "/job-1/page.md" }], {
        jobId: "job-1",
      }),
    ).toThrow("prepare-artifact-artifactPath-invalid")

    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, artifactPath: "job-2/page.md" }], {
        jobId: "job-1",
      }),
    ).toThrow("artifactPath must start with jobId")
  })

  it("enforces markdown target paths", () => {
    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, targetPath: "Wiki/Page.txt" }], {
        jobId: "job-1",
      }),
    ).toThrow("prepare-artifact-target-invalid")
  })

  it("enforces operation intent and base hash coupling", () => {
    expect(() =>
      validatePrepareArtifacts([{ ...validArtifact, baseHash: "sha256:base" }], {
        jobId: "job-1",
      }),
    ).toThrow("create requires null baseHash")

    expect(() =>
      validatePrepareArtifacts([
        { ...validArtifact, operationIntent: "update", baseHash: null },
      ], { jobId: "job-1" }),
    ).toThrow("update requires baseHash")

    expect(() =>
      validatePrepareArtifacts([
        { ...validArtifact, operationIntent: "delete", baseHash: "sha256:base" },
      ], { jobId: "job-1" }),
    ).not.toThrow()

    expect(() =>
      validatePrepareArtifacts([
        {
          ...validArtifact,
          operationIntent: "update",
          baseHash: `sha256:${"x".repeat(MAX_PREPARE_ARTIFACT_HASH_BYTES)}`,
        },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-baseHash-too-large")
  })

  it("bounds markdown and diagnostics payloads", () => {
    expect(() =>
      validatePrepareArtifacts([
        {
          ...validArtifact,
          sourcePath: "x".repeat(MAX_PREPARE_ARTIFACT_PATH_BYTES + 1),
        },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-sourcePath-too-large")

    expect(() =>
      validatePrepareArtifacts([
        { ...validArtifact, markdown: "x".repeat(MAX_PREPARE_ARTIFACT_MARKDOWN_BYTES + 1) },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-markdown-too-large")

    expect(() =>
      validatePrepareArtifacts([
        {
          ...validArtifact,
          diagnostics: { message: "x".repeat(MAX_PREPARE_ARTIFACT_DIAGNOSTICS_BYTES) },
        },
      ], { jobId: "job-1" }),
    ).toThrow("prepare-artifact-diagnostics-too-large")
  })
})

describe("normalizeCommitTargetPath", () => {
  it("matches the Rust commit resource key shape for NFC and lowercase", () => {
    expect(normalizeCommitTargetPath("Wiki/Cafe\u{301}.MD")).toEqual({
      displayKey: "Wiki/Cafe\u{301}.MD",
      resourceKey: "wiki/café.md",
    })
  })

  it("matches the Rust commit display key shape for backslash separators", () => {
    expect(normalizeCommitTargetPath("Wiki\\Page.md")).toEqual({
      displayKey: "Wiki/Page.md",
      resourceKey: "wiki/page.md",
    })
  })
})
