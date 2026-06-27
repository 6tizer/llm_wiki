import JSZip from "jszip"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
}))

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn<() => Promise<void>>(),
  getFileSize: vi.fn<() => Promise<number>>(),
  readFileAsBase64: vi.fn<() => Promise<{ base64: string; mimeType: string }>>(),
  writeFileBase64: vi.fn<() => Promise<void>>(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: fsMocks.createDirectory,
  getFileSize: fsMocks.getFileSize,
  readFileAsBase64: fsMocks.readFileAsBase64,
  writeFileBase64: fsMocks.writeFileBase64,
}))

import { __mineruTest, parseWithMineru, testMineruConnection } from "./mineru"
import type { MineruConfig } from "@/stores/wiki-store"

function mineruConfig(overrides?: Partial<MineruConfig>): MineruConfig {
  return {
    enabled: true,
    token: "token",
    modelVersion: "vlm",
    apiBaseUrl: "",
    ...overrides,
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function zipResponse(files: Record<string, string>): Promise<Response> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  const bytes = await zip.generateAsync({ type: "uint8array" })
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return new Response(buffer)
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    throw new Error("expected promise to reject")
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeEach(() => {
  mockHttpFetch.mockReset()
  fsMocks.createDirectory.mockReset()
  fsMocks.getFileSize.mockReset()
  fsMocks.readFileAsBase64.mockReset()
  fsMocks.writeFileBase64.mockReset()
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.getFileSize.mockResolvedValue(1024)
  fsMocks.readFileAsBase64.mockResolvedValue({
    base64: btoa("pdf bytes"),
    mimeType: "application/pdf",
  })
  fsMocks.writeFileBase64.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("MinerU API helpers", () => {
  it("maps official API error codes to actionable messages", () => {
    expect(__mineruTest.mineruApiErrorMessage("A0202", "bad token")).toContain("invalid")
    expect(__mineruTest.mineruApiErrorMessage("A0211", "expired")).toContain("expired")
    expect(__mineruTest.mineruApiErrorMessage(-60005, "too large")).toContain("200 MB")
    expect(__mineruTest.mineruApiErrorMessage(-60006, "too many pages")).toContain("200 page")
    expect(__mineruTest.mineruApiErrorMessage(-60018, "quota")).toContain("quota")
    expect(__mineruTest.mineruApiErrorMessage(123, "other")).toBe("MinerU API error 123: other")
  })

  it("redacts exact MinerU tokens and bearer values in helper output", () => {
    const out = __mineruTest.redactMineruSensitiveText(
      "Authorization: Bearer abc.def-123 and token abc.def-123",
      "abc.def-123",
    )

    expect(out).toContain("Authorization: Bearer REDACTED")
    expect(out).not.toContain("abc.def-123")
  })

  it("exposes bounded polling options for regression tests", () => {
    expect(__mineruTest.MINERU_DEFAULT_POLLING_OPTIONS).toEqual({
      intervalMs: 3_000,
      timeoutMs: 300_000,
    })
    expect(__mineruTest.normalizeMineruPollingOptions({
      intervalMs: 0,
      timeoutMs: -1,
    })).toEqual({
      intervalMs: 1,
      timeoutMs: 1,
    })
  })

  it("prefers full.md from MinerU result zip", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "result/other.md": "other markdown",
      "result/full.md": "full markdown",
    }))

    await expect(__mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip"))
      .resolves.toBe("full markdown")
  })

  it("converts MinerU HTML tables outside fenced code blocks", async () => {
    const code = [
      "```html",
      "<table><tr><td>Keep raw</td></tr></table>",
      "```",
    ].join("\n")
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        code,
        "<table>",
        "<tr><th>Name</th><th>Value</th></tr>",
        "<tr><td>A&amp;B</td><td>1|2</td></tr>",
        "</table>",
      ].join("\n"),
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown("https://cdn/result.zip")

    expect(markdown).toContain(code)
    expect(markdown).toContain("| Name | Value |\n| --- | --- |\n| A&B | 1\\|2 |")
  })

  it("extracts MinerU zip images and rewrites Markdown image references", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": [
        "# Parsed",
        "![Chart](images/chart.png)",
        "<img src=\"figures/table 1.jpg\" alt=\"Table\">",
        "![Remote](https://example.test/x.png)",
      ].join("\n"),
      "images/chart.png": "chart-bytes",
      "figures/table 1.jpg": "table-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/media/paper/mineru")
    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/images/chart.png",
      btoa("chart-bytes"),
    )
    expect(markdown).toContain("![Chart](media/paper/mineru/images/chart.png)")
    expect(markdown).toContain("![Table](media/paper/mineru/figures/table%201.jpg)")
    expect(markdown).toContain("![Remote](https://example.test/x.png)")
  })

  it("keeps extracted zip paths inside the MinerU media directory", async () => {
    mockHttpFetch.mockResolvedValueOnce(await zipResponse({
      "full.md": "![Evil](evil.png)",
      "../../evil.png": "evil-bytes",
    }))

    const markdown = await __mineruTest.downloadAndExtractMarkdown(
      "https://cdn/result.zip",
      undefined,
      { projectPath: "/project", sourceSummarySlug: "paper" },
    )

    expect(fsMocks.writeFileBase64).toHaveBeenCalledWith(
      "/project/wiki/media/paper/mineru/evil.png",
      btoa("evil-bytes"),
    )
    expect(markdown).toBe("![Evil](media/paper/mineru/evil.png)")
  })
})

describe("parseWithMineru", () => {
  it("rejects unsupported MinerU model versions before reading or uploading", async () => {
    await expect(parseWithMineru({
      ...mineruConfig(),
      modelVersion: "mineru-html" as "vlm",
    }, "/tmp/doc.pdf")).rejects.toThrow("pipeline or vlm")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("rejects local files over MinerU's 200 MB limit before upload", async () => {
    fsMocks.getFileSize.mockResolvedValue(__mineruTest.MAX_ACCURATE_PARSE_BYTES + 1)

    await expect(parseWithMineru(mineruConfig(), "/tmp/large.pdf")).rejects.toThrow("200 MB")

    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
  })

  it("rejects before network access when the abort signal is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(parseWithMineru(
      mineruConfig(),
      "/tmp/doc.pdf",
      undefined,
      undefined,
      controller.signal,
    )).rejects.toThrow("cancelled")

    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("uploads decoded PDF bytes and downloads parsed markdown", async () => {
    fsMocks.readFileAsBase64.mockResolvedValueOnce({
      base64: btoa("custom pdf bytes"),
      mimeType: "application/pdf",
    })
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "done", full_zip_url: "https://zip" }],
        },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "parsed markdown" }))

    await expect(parseWithMineru(mineruConfig(), "/tmp/doc.pdf")).resolves.toBe("parsed markdown")

    const uploadBody = mockHttpFetch.mock.calls[1]?.[1]?.body
    expect(uploadBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(uploadBody as ArrayBuffer)).toBe("custom pdf bytes")
  })

  it("submits URL tasks without reading or uploading a local file", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: "0",
        msg: "ok",
        data: { task_id: "task-1" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { task_id: "task-1", state: "done", full_zip_url: "https://zip" },
      }))
      .mockResolvedValueOnce(await zipResponse({ "full.md": "url markdown" }))

    await expect(parseWithMineru(
      mineruConfig({ modelVersion: "pipeline" }),
      "/tmp/doc.pdf",
      "https://example.test/doc.pdf",
    )).resolves.toBe("url markdown")

    expect(fsMocks.getFileSize).not.toHaveBeenCalled()
    expect(fsMocks.readFileAsBase64).not.toHaveBeenCalled()
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://example.test/doc.pdf",
      model_version: "pipeline",
    })
  })

  it("uses the configured API base URL", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "0",
      msg: "ok",
      data: { task_id: "task-1" },
    }))

    await expect(testMineruConnection(mineruConfig({
      apiBaseUrl: "https://mineru-proxy.test/api/v4/",
    }))).resolves.toBeUndefined()

    expect(mockHttpFetch.mock.calls[0]?.[0]).toBe("https://mineru-proxy.test/api/v4/extract/task")
  })

  it("rejects MinerU failed states with the service error message", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          batch_id: "batch-1",
          extract_result: [{ file_name: "doc.pdf", state: "failed", err_msg: "parse exploded" }],
        },
      }))

    await expect(parseWithMineru(mineruConfig(), "/tmp/doc.pdf")).rejects.toThrow("parse exploded")
  })

  it("redacts tokens from API error messages surfaced during parsing", async () => {
    const token = "mineru-secret-token"
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "A0202",
      msg: `echoed Authorization: Bearer ${token}`,
      data: {},
    }))

    const message = await rejectionMessage(parseWithMineru(
      mineruConfig({ token }),
      "/tmp/doc.pdf",
      "https://example.test/doc.pdf",
    ))

    expect(message).toContain("Bearer REDACTED")
    expect(message).not.toContain(token)
  })

  it("redacts tokens from HTTP body errors surfaced during parsing", async () => {
    const token = "mineru-secret-token"
    mockHttpFetch.mockResolvedValueOnce(new Response(
      `proxy rejected Authorization: Bearer ${token}`,
      { status: 502 },
    ))

    await expect(parseWithMineru(mineruConfig({ token }), "/tmp/doc.pdf")).rejects.toThrow(
      "MinerU batch submit failed: HTTP 502: proxy rejected Authorization: Bearer REDACTED",
    )
  })

  it("stops polling immediately when the abort signal fires during the poll interval", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      }))

    const controller = new AbortController()
    const result = parseWithMineru(mineruConfig(), "/tmp/doc.pdf", undefined, undefined, controller.signal)

    setTimeout(() => controller.abort(), 10)

    await expect(result).rejects.toThrow("cancelled")
    expect(mockHttpFetch).toHaveBeenCalledTimes(3)
  })

  it("honors a test polling timeout without waiting for the production timeout", async () => {
    vi.useFakeTimers()
    mockHttpFetch
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", file_urls: ["https://upload"] },
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockImplementation(() => Promise.resolve(jsonResponse({
        code: 0,
        msg: "ok",
        data: { batch_id: "batch-1", extract_result: [{ file_name: "doc.pdf", state: "running" }] },
      })))

    const result = parseWithMineru(
      mineruConfig(),
      "/tmp/doc.pdf",
      undefined,
      undefined,
      undefined,
      undefined,
      { intervalMs: 10, timeoutMs: 25 },
    )
    // Attach the rejection assertion before advancing fake timers so Vitest
    // does not see the expected timeout as an unhandled rejection.
    const assertion = expect(result).rejects.toThrow("MinerU parsing timed out after 25 ms")
    await vi.advanceTimersByTimeAsync(30)

    await assertion
    expect(mockHttpFetch).toHaveBeenCalledTimes(5)
  })
})

describe("testMineruConnection", () => {
  it("redacts token echoes from HTTP error bodies", async () => {
    const token = "mineru-secret-token"
    mockHttpFetch.mockResolvedValueOnce(new Response(
      `bad gateway Authorization: Bearer ${token}`,
      { status: 502 },
    ))

    const message = await rejectionMessage(testMineruConnection(mineruConfig({ token })))

    expect(message).toBe(
      "MinerU connection test failed: HTTP 502: bad gateway Authorization: Bearer REDACTED",
    )
    expect(message).not.toContain(token)
  })

  it("maps MinerU API errors during connection test", async () => {
    mockHttpFetch.mockResolvedValueOnce(jsonResponse({
      code: "A0202",
      msg: "token invalid",
      data: {},
    }))

    await expect(testMineruConnection(mineruConfig({ token: "bad-token" }))).rejects.toThrow("invalid")
  })
})
