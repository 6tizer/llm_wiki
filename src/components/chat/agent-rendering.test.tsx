import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"
import { AgentBlockList } from "./agent-block-list"
import { AgentCostCard } from "./agent-cost-card"
import { AgentToolTimeline } from "./agent-tool-timeline"
import { ChatMessage } from "./chat-message"
import type { DisplayMessage } from "@/stores/chat-store"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

function assistantMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Plain answer",
    timestamp: 0,
    conversationId: "conv-1",
    ...overrides,
  }
}

describe("agent message rendering", () => {
  it("renders agent cost card when stats exist", () => {
    const html = renderToStaticMarkup(
      <AgentCostCard
        costUsd={0.12}
        inputTokens={1000}
        outputTokens={50}
        durationMs={1250}
        numTurns={2}
      />,
    )

    expect(html).toContain("Agent run")
    expect(html).toContain("$0.12")
    expect(html).toContain("1,000")
    expect(html).toContain("1.3 s")
  })

  it("renders tool timeline details when expanded", () => {
    const html = renderToStaticMarkup(
      <AgentToolTimeline
        defaultCollapsed={false}
        toolCalls={[
          {
            toolName: "wiki_read",
            toolUseId: "tool-1",
            phase: "failure",
            error: "boom",
            inputPreview: { path: "wiki/index.md" },
          },
        ]}
      />,
    )

    expect(html).toContain("Activity timeline")
    expect(html).toContain("wiki_read")
    expect(html).toContain("Failed")
    expect(html).toContain("boom")
    expect(html).toContain("wiki/index.md")
  })

  it("renders lightweight progress, permission, and rewind status rows", () => {
    const html = renderToStaticMarkup(
      <AgentToolTimeline
        defaultCollapsed={false}
        toolCalls={[]}
        progressSummaries={[{ text: "Analyzing authentication module", timestamp: 123 }]}
        permissionEvents={[
          {
            toolName: "wiki_write",
            decision: "allow_temporary",
            timestamp: 456,
          },
          {
            toolName: "bash",
            decision: "deny_interrupt",
            timestamp: 789,
          },
        ]}
        rewindUnavailableReason="inactive_stream"
      />,
    )

    expect(html).toContain("Activity timeline")
    expect(html).toContain("Analyzing authentication module")
    expect(html).toContain("Progress update")
    expect(html).toContain("Allowed wiki_write")
    expect(html).toContain("Denied and interrupted bash")
    expect(html).toContain("Rewind is unavailable because this Agent stream is no longer active.")
  })

  it("renders SDK content blocks", () => {
    const html = renderToStaticMarkup(
      <AgentBlockList
        blocks={[
          { type: "text", text: "Hello from agent" },
          { type: "tool_use", id: "tool-1", name: "wiki_search", input: { q: "rope" } },
          { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "Found result" }] },
        ]}
        renderText={(text) => <p>{text}</p>}
      />,
    )

    expect(html).toContain("Hello from agent")
    expect(html).toContain("Tool use")
    expect(html).toContain("wiki_search")
    expect(html).toContain("Found result")
  })

  it("does not warn when tool use and result share the same SDK id", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    renderToStaticMarkup(
      <AgentBlockList
        blocks={[
          { type: "tool_use", id: "1", name: "wiki_search", input: { q: "rope" } },
          { type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "Found result" }] },
        ]}
        renderText={(text) => <p>{text}</p>}
      />,
    )

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("same key"),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })

	  it("keeps ordinary assistant messages free of agent chrome", () => {
	    const html = renderToStaticMarkup(<ChatMessage message={assistantMessage()} />)

    expect(html).toContain("Plain answer")
    expect(html).not.toContain("Activity timeline")
    expect(html).not.toContain("Agent run")
	    expect(html).not.toContain("Wiki changes")
	    expect(html).not.toContain("Rewind files")
	    expect(html).not.toContain("Retry")
	  })

	  it("renders a persistent retry action for the last agent error message", () => {
	    const html = renderToStaticMarkup(
	      <ChatMessage
	        message={assistantMessage({
	          mode: "agent",
	          content: "Agent timed out",
	          agentErrorKind: "timeout",
	        })}
	        isLastAssistant
	        onRegenerate={() => undefined}
	      />,
	    )

	    expect(html).toContain("Agent timed out")
	    expect(html).toContain("Retry")
	  })

  it("renders max files changed resource limit notices", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentResourceLimit: {
            kind: "resource_limit",
            limitKind: "max_files_changed",
            limit: 1,
            used: 1,
            attempted: 2,
            changedPaths: ["wiki/index.md"],
            message: "Write would exceed maxFilesChanged (1)",
            recovery: "split_task",
          },
        })}
      />,
    )

    expect(html).toContain("Max changed files reached")
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("This Agent run can change up to 1 distinct wiki files")
    expect(html).toContain("Changed files: wiki/index.md")
    expect(html).toContain("send &quot;continue&quot;")
  })

  it("renders normal user message images without agent chrome", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          id: "m-img",
          role: "user",
          content: "see this",
          timestamp: 0,
          conversationId: "conv-1",
          images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
        }}
      />,
    )

    expect(html).toContain("data:image/png;base64,AAAA")
    expect(html).toContain("see this")
    expect(html).toContain("self-end")
    expect(html).not.toContain("Activity timeline")
    expect(html).not.toContain("Agent run")
  })

  it("renders max write bytes notices with split-content recovery", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentResourceLimit: {
            kind: "resource_limit",
            limitKind: "max_write_bytes",
            limit: 1024,
            bytes: 2048,
            path: "wiki/large.md",
            message: "Write exceeds maxWriteBytes (2048 > 1024)",
            recovery: "settings_agent",
          },
        })}
      />,
    )

    expect(html).toContain("Write is too large")
    expect(html).toContain("This write is about 2 KiB")
    expect(html).toContain("Target: wiki/large.md")
    expect(html).toContain("make the page shorter or split it across files")
  })

  it("renders max turns notices", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentResourceLimit: {
            kind: "resource_limit",
            limitKind: "max_turns_exceeded",
            limit: 10,
            used: 10,
            attempted: 10,
            message: "Reached maximum number of turns (10)",
            recovery: "settings_agent",
          },
        })}
      />,
    )

    expect(html).toContain("Max turns reached")
    expect(html).toContain("This Agent run can use up to 10 turns")
    expect(html).toContain("Settings &gt; Agent")
  })

  it("renders resource limit notices without literal undefined values", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentResourceLimit: {
            kind: "resource_limit",
            limitKind: "max_write_bytes",
            bytes: Number.NaN,
            message: "Write exceeds maxWriteBytes",
            recovery: "settings_agent",
          },
        })}
      />,
    )

    expect(html).toContain("This write is about ?")
    expect(html).not.toContain("undefined")
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("Infinity")
  })

  it("renders agent blocks, timeline, and cost for agent messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentBlocks: [
            { type: "text", text: "Agent text" },
            { type: "tool_use", id: "tool-1", name: "wiki_read", input: { path: "wiki/index.md" } },
          ],
          toolCalls: [
            {
              toolName: "wiki_read",
              toolUseId: "tool-1",
              phase: "post",
              ok: true,
              durationMs: 20,
            },
          ],
          costUsd: 0.01,
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 1000,
          numTurns: 1,
        })}
      />,
    )

    expect(html).toContain("Agent text")
    expect(html).toContain("Tool use")
    expect(html).toContain("Activity timeline")
    expect(html).toContain("Agent run")
  })

  it("renders agent wiki changes and rewind action for rewindable agent messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          wikiChanges: [
            {
              path: "wiki/page.md",
              operation: "update",
              timestamp: 123,
            },
          ],
        })}
        canRewind
        onRewind={() => undefined}
      />,
    )

    expect(html).toContain("Wiki changes")
    expect(html).toContain("Agent updated wiki/page.md")
    expect(html).toContain("Rewind files")
  })

  it("does not render rewind action without a rewind target", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          wikiChanges: [
            {
              path: "wiki/page.md",
              operation: "update",
              timestamp: 123,
            },
          ],
        })}
        onRewind={() => undefined}
      />,
    )

    expect(html).toContain("Wiki changes")
    expect(html).not.toContain("Rewind files")
  })

  it("renders compact summaries as a safe collapsed status row", () => {
    const hiddenSdkText = "The context has run out. Summary: secret sdk internals."
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: hiddenSdkText,
          mode: "agent",
          sessionCompact: true,
          agentBlocks: undefined,
        })}
      />,
    )

    expect(html).toContain("Context summarized")
    expect(html).toContain("Internal summary details are hidden")
    expect(html).not.toContain(hiddenSdkText)
    expect(html).not.toContain("Activity timeline")
    expect(html).not.toContain("Agent run")
    expect(html).not.toContain("Rewind files")
  })

  it("renders agent errors as a notice with raw detail collapsed", () => {
    const detail = "Provider failed with redacted key sk-***1234"
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "Agent failed.",
          mode: "agent",
          agentErrorKind: "model_not_found",
          agentErrorDetail: detail,
        })}
      />,
    )

    expect(html).toContain("Model not found")
    expect(html).toContain("Switch models")
    expect(html).toContain("Details")
    expect(html).toContain(detail)
    expect(html).not.toContain("Agent failed: Provider failed")
  })

  it("renders legacy persisted agent errors with non-empty content through the notice", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "Agent failed: old raw message",
          mode: "agent",
          agentErrorKind: "failed",
          agentErrorDetail: "old raw message",
        })}
      />,
    )

    expect(html).toContain("Agent failed")
    expect(html).toContain("old raw message")
    expect(html).not.toContain("Agent failed: old raw message")
  })

  it("renders permission-deny text as normal agent output when no agentErrorKind is set", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "Permission denied by user.",
          mode: "agent",
        })}
      />,
    )

    expect(html).toContain("Permission denied by user.")
    expect(html).not.toContain("Agent failed")
    expect(html).not.toContain("Details")
  })

  it("uses agent block text as a fallback for references when content is empty", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "",
          mode: "agent",
          agentBlocks: [
            { type: "text", text: "See [[Phase 4 Notes]]" },
          ],
        })}
      />,
    )

    expect(html).toContain("wikilink:Phase 4 Notes")
    expect(html).toContain("References (1)")
  })

  it("does not warn when saved references contain duplicate paths", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "Answer with saved refs",
          references: [
            { title: "Same Page", path: "wiki/entities/same.md" },
            { title: "Same Page Again", path: "wiki/entities/same.md" },
          ],
        })}
      />,
    )

    expect(html).toContain("References (2)")
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("same key"),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })
})
