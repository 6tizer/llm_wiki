import assert from "node:assert/strict";
import test from "node:test";
import { createLlmWikiHooks } from "./agent-hooks.js";
import type { AgentMessage } from "./types.js";

test("PreToolUse hook emits tool_event and allows Wiki read tool", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: false,
		permissionPolicy: "default",
		changedPaths: new Set<string>(),
		send: (msg) => sent.push(msg),
	});

	const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
		{
			hook_event_name: "PreToolUse",
			tool_name: "mcp__llm_wiki__read_page",
			tool_input: { path: "wiki/entities/example.md" },
			tool_use_id: "tool-1",
		} as any,
		"tool-1",
		{ signal: new AbortController().signal },
	);

	assert.deepEqual(
		sent.map((msg) => msg.type),
		["tool_event"],
	);
	assert.equal(
		(sent[0]?.data as { toolName?: string }).toolName,
		"mcp__llm_wiki__read_page",
	);
	assert.equal(
		(result as any)?.hookSpecificOutput?.permissionDecision,
		"allow",
	);
});

test("PreToolUse hook ignores Claude Code built-in tools", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: true,
		permissionPolicy: "default",
		changedPaths: new Set<string>(),
		send: (msg) => sent.push(msg),
	});

	const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
		{
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "git status" },
			tool_use_id: "tool-1",
		} as any,
		"tool-1",
		{ signal: new AbortController().signal },
	);

	assert.deepEqual(sent, []);
	assert.deepEqual(result, {});
});

test("PreToolUse hook denies Wiki write tool when writes are disabled", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: false,
		permissionPolicy: "default",
		changedPaths: new Set<string>(),
		send: (msg) => sent.push(msg),
	});

	const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
		{
			hook_event_name: "PreToolUse",
			tool_name: "mcp__llm_wiki__update_page",
			tool_input: { path: "wiki/entities/example.md", contents: "hello" },
			tool_use_id: "tool-1",
		} as any,
		"tool-1",
		{ signal: new AbortController().signal },
	);

	assert.equal((result as any)?.hookSpecificOutput?.permissionDecision, "deny");
	assert.equal(
		(result as any)?.hookSpecificOutput?.permissionDecisionReason,
		"Wiki write tools are disabled",
	);
	assert.equal(
		(
			(sent[0]?.data as { inputPreview?: Record<string, unknown> })
				.inputPreview ?? {}
		).contents,
		undefined,
	);
});

test("PreToolUse hook defers Wiki writes to the permission bridge under the default policy", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: true,
		permissionPolicy: "default",
		changedPaths: new Set<string>(),
		send: (msg) => sent.push(msg),
	});

	const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
		{
			hook_event_name: "PreToolUse",
			tool_name: "mcp__llm_wiki__update_page",
			tool_input: { path: "wiki/entities/example.md", contents: "hello" },
			tool_use_id: "tool-1",
		} as any,
		"tool-1",
		{ signal: new AbortController().signal },
	);

	assert.equal((result as any)?.hookSpecificOutput?.permissionDecision, "ask");
	assert.equal(
		(result as any)?.hookSpecificOutput?.permissionDecisionReason,
		undefined,
	);
});

test("PreToolUse hook defers Wiki writes to the permission bridge under SDK-native ask-style policies", async () => {
	// Only "bypassPermissions" makes the SDK skip canUseTool entirely; every
	// other permissionMode (acceptEdits/plan/dontAsk/auto included) still
	// runs both canUseTool and this hook, so the "ask" fallthrough here must
	// hold for all of them too, not just "default".
	for (const permissionPolicy of [
		"acceptEdits",
		"plan",
		"dontAsk",
		"auto",
	] as const) {
		const sent: AgentMessage[] = [];
		const hooks = createLlmWikiHooks({
			streamId: "stream-1",
			enableWriteTools: true,
			permissionPolicy,
			changedPaths: new Set<string>(),
			send: (msg) => sent.push(msg),
		});

		const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
			{
				hook_event_name: "PreToolUse",
				tool_name: "mcp__llm_wiki__update_page",
				tool_input: { path: "wiki/entities/example.md", contents: "hello" },
				tool_use_id: "tool-1",
			} as any,
			"tool-1",
			{ signal: new AbortController().signal },
		);

		assert.equal(
			(result as any)?.hookSpecificOutput?.permissionDecision,
			"ask",
		);
		assert.equal(
			(result as any)?.hookSpecificOutput?.permissionDecisionReason,
			undefined,
		);
	}
});

test("PreToolUse hook denies Wiki writes under the restricted policy even when writes are enabled", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: true,
		permissionPolicy: "restricted",
		changedPaths: new Set<string>(),
		send: (msg) => sent.push(msg),
	});

	const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
		{
			hook_event_name: "PreToolUse",
			tool_name: "mcp__llm_wiki__update_page",
			tool_input: { path: "wiki/entities/example.md", contents: "hello" },
			tool_use_id: "tool-1",
		} as any,
		"tool-1",
		{ signal: new AbortController().signal },
	);

	assert.equal((result as any)?.hookSpecificOutput?.permissionDecision, "deny");
	assert.equal(
		(result as any)?.hookSpecificOutput?.permissionDecisionReason,
		"Wiki write tools are restricted",
	);
});

test("PreToolUse hook fast-path allows Wiki writes under bypass policies", async () => {
	for (const permissionPolicy of ["bypass", "bypassPermissions"] as const) {
		const sent: AgentMessage[] = [];
		const hooks = createLlmWikiHooks({
			streamId: "stream-1",
			enableWriteTools: true,
			permissionPolicy,
			changedPaths: new Set<string>(),
			send: (msg) => sent.push(msg),
		});

		const result = await hooks.PreToolUse?.[0]?.hooks[0]?.(
			{
				hook_event_name: "PreToolUse",
				tool_name: "mcp__llm_wiki__update_page",
				tool_input: { path: "wiki/entities/example.md", contents: "hello" },
				tool_use_id: "tool-1",
			} as any,
			"tool-1",
			{ signal: new AbortController().signal },
		);

		assert.equal(
			(result as any)?.hookSpecificOutput?.permissionDecision,
			"allow",
		);
	}
});

test("Stop hook emits agent summary with changed paths", async () => {
	const sent: AgentMessage[] = [];
	const hooks = createLlmWikiHooks({
		streamId: "stream-1",
		enableWriteTools: true,
		permissionPolicy: "default",
		changedPaths: new Set(["wiki/entities/example.md"]),
		send: (msg) => sent.push(msg),
	});

	await hooks.Stop?.[0]?.hooks[0]?.(
		{
			hook_event_name: "Stop",
			stop_hook_active: false,
			last_assistant_message: "done",
		} as any,
		undefined,
		{ signal: new AbortController().signal },
	);

	assert.deepEqual(
		sent.map((msg) => msg.type),
		["agent_summary"],
	);
	assert.deepEqual(
		(sent[0]?.data as { changedPaths?: string[] }).changedPaths,
		["wiki/entities/example.md"],
	);
	assert.equal(
		(sent[0]?.data as { lastAssistantMessage?: string }).lastAssistantMessage,
		"done",
	);
});
