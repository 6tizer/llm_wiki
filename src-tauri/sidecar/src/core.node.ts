import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	createRequestHandler,
	omitNullish,
	setBundledClaudeCodeExecutablePath,
	type QueryControl,
	type QueryFn,
} from "./core.js";
import { handleRewindFilesRequest } from "./rewind-bridge.js";
import type { AgentMessage, AgentRequest } from "./types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const baseRequest: AgentRequest = {
	type: "query",
	streamId: "stream-1",
	prompt: "hello",
	options: {
		systemPrompt: "system",
		cwd: undefined,
		model: "claude-sonnet-4-20250514",
		maxTurns: undefined,
		maxBudgetUsd: undefined,
		apiKey: "test-key",
		baseUrl: "http://localhost:4000",
		persistSession: false,
	},
};

type RegisteredTool = {
	handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<CallToolResult>;
};

async function tempWikiProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-core-"));
	await fs.mkdir(path.join(dir, "wiki"), { recursive: true });
	await fs.writeFile(path.join(dir, "wiki", "index.md"), "# Index\n", "utf8");
	return dir;
}

test("omitNullish removes null and undefined but keeps falsey values", () => {
	assert.deepEqual(
		omitNullish({
			empty: "",
			falseValue: false,
			nullValue: null,
			undefinedValue: undefined,
			zero: 0,
		}),
		{
			empty: "",
			falseValue: false,
			zero: 0,
		},
	);
});

test("query request strips nullish SDK options and emits message then done", async () => {
	const sent: AgentMessage[] = [];
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
		yield { type: "assistant", message: { content: [] } };
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			cwd: null as unknown as string,
			maxBudgetUsd: null as unknown as number,
		},
	});

	assert.equal(capturedInput?.prompt, "hello");
	assert.equal(capturedInput?.options?.cwd, undefined);
	assert.equal(capturedInput?.options?.maxBudgetUsd, undefined);
	assert.equal(capturedInput?.options?.maxTurns, 30);
	assert.equal(capturedInput?.options?.tools, undefined);
	assert.deepEqual(capturedInput?.options?.allowedTools, []);
	assert.equal(capturedInput?.options?.permissionMode, "default");
	assert.equal(
		"allowDangerouslySkipPermissions" in (capturedInput?.options ?? {}),
		false,
	);
	assert.deepEqual(sent.map((msg) => msg.type), ["message", "done"]);
});

test("query request preserves provided maxTurns", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			maxTurns: 44,
		},
	});

	assert.equal(capturedInput?.options?.maxTurns, 44);
});

test("query request forwards disallowedTools to SDK options", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			disallowedTools: ["WebSearch", "WebFetch"],
		},
	});

	assert.deepEqual(capturedInput?.options?.disallowedTools, ["WebSearch", "WebFetch"]);
});

async function captureAgentProfileEnv(
	options: Partial<AgentRequest["options"]>,
	baseEnv: Record<string, string | undefined> = {},
): Promise<Record<string, string | undefined> | undefined> {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: baseEnv,
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			...options,
		},
	});

	return capturedInput?.options?.env;
}

test("agent profile bearer auth uses ANTHROPIC_AUTH_TOKEN", async () => {
	const env = await captureAgentProfileEnv({
		agentProfileAuthStyle: "bearer",
		apiKey: "bearer-token",
		model: "deepseek-chat",
	}, {
		ANTHROPIC_API_KEY: "ambient-api-key",
		ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
	});

	assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "bearer-token");
	assert.equal(env?.ANTHROPIC_API_KEY, undefined);
	assert.equal(env?.ANTHROPIC_MODEL, "deepseek-chat");
});

test("agent profile x-api-key auth uses ANTHROPIC_API_KEY", async () => {
	const env = await captureAgentProfileEnv({
		agentProfileAuthStyle: "x-api-key",
		apiKey: "api-key-token",
		model: "claude-code-alias",
	}, {
		ANTHROPIC_API_KEY: "ambient-api-key",
		ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
	});

	assert.equal(env?.ANTHROPIC_API_KEY, "api-key-token");
	assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(env?.ANTHROPIC_MODEL, "claude-code-alias");
});

test("agent profile api-key auth uses ANTHROPIC_API_KEY", async () => {
	const env = await captureAgentProfileEnv({
		agentProfileAuthStyle: "api-key",
		apiKey: "api-key-token",
		model: "claude-code-alias",
	}, {
		ANTHROPIC_API_KEY: "ambient-api-key",
		ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
	});

	assert.equal(env?.ANTHROPIC_API_KEY, "api-key-token");
	assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(env?.ANTHROPIC_MODEL, "claude-code-alias");
});

test("agent profile no-auth styles do not inject Anthropic secret env", async () => {
	for (const agentProfileAuthStyle of ["none", "oauth-local-cli"] as const) {
		const env = await captureAgentProfileEnv({
			agentProfileAuthStyle,
			apiKey: undefined,
			model: "claude-code-alias",
		}, {
			ANTHROPIC_API_KEY: "ambient-api-key",
			ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
		});

		assert.equal(env?.ANTHROPIC_API_KEY, undefined);
		assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
		assert.equal(env?.ANTHROPIC_MODEL, "claude-code-alias");
	}
});

test("agent profile unknown auth style keeps legacy API key mapping", async () => {
	const env = await captureAgentProfileEnv({
		agentProfileAuthStyle: "legacy-unknown" as AgentRequest["options"]["agentProfileAuthStyle"],
		apiKey: "legacy-token",
	}, {
		ANTHROPIC_AUTH_TOKEN: "ambient-auth-token",
	});

	assert.equal(env?.ANTHROPIC_API_KEY, "legacy-token");
	assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("query request forwards bundled Claude executable path when configured", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	setBundledClaudeCodeExecutablePath("/tmp/claude-native");
	try {
		const handleRequest = createRequestHandler({
			queryFn,
			send: () => {},
			error: () => {},
			env: {},
		});

		await handleRequest(baseRequest);
		assert.equal(
			capturedInput?.options?.pathToClaudeCodeExecutable,
			"/tmp/claude-native",
		);
	} finally {
		setBundledClaudeCodeExecutablePath(undefined);
	}
});

test("query request forwards session options to the SDK", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			sessionId: "11111111-1111-4111-8111-111111111111",
			resume: "22222222-2222-4222-8222-222222222222",
			continue: true,
			forkSession: true,
			resumeSessionAt: "msg-1",
			persistSession: true,
			title: "Wiki Agent",
		},
	});

	assert.equal(
		capturedInput?.options?.sessionId,
		"11111111-1111-4111-8111-111111111111",
	);
	assert.equal(
		capturedInput?.options?.resume,
		"22222222-2222-4222-8222-222222222222",
	);
	assert.equal(capturedInput?.options?.continue, true);
	assert.equal(capturedInput?.options?.forkSession, true);
	assert.equal(capturedInput?.options?.resumeSessionAt, "msg-1");
	assert.equal(capturedInput?.options?.persistSession, true);
	assert.equal(capturedInput?.options?.title, "Wiki Agent");
});

test("query request appends intent override to system prompt without forwarding it", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			systemPrompt: "base system",
			intentOverride: "Treat the latest user message as primary.",
		},
	});

	assert.equal(
		capturedInput?.options?.systemPrompt,
		"base system\n\nTreat the latest user message as primary.",
	);
	assert.equal(
		"intentOverride" in (capturedInput?.options ?? {}),
		false,
	);
});

test("query request uses intent override as system prompt when no system prompt exists", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			systemPrompt: undefined,
			intentOverride: "Treat the latest user message as primary.",
		},
	});

	assert.equal(
		capturedInput?.options?.systemPrompt,
		"Treat the latest user message as primary.",
	);
	assert.equal(
		"intentOverride" in (capturedInput?.options ?? {}),
		false,
	);
});

test("canUseTool pre-approves allowed Wiki read tools and denies disabled Wiki writes without prompting", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	let bridgeCalls = 0;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async () => {
				bridgeCalls += 1;
				throw new Error("bridge should not be called when writes are disabled");
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: false,
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const signal = new AbortController().signal;
	assert.deepEqual(
		await canUseTool(
			"mcp__llm_wiki__read_page",
			{ path: "wiki/index.md" },
			{ signal, toolUseID: "tool-1", requestId: "req-1" },
		),
		{
			behavior: "allow",
			toolUseID: "tool-1",
		},
	);
	assert.deepEqual(
		await canUseTool(
			"mcp__llm_wiki__update_page",
			{ path: "wiki/index.md" },
			{ signal, toolUseID: "tool-2", requestId: "req-2" },
		),
		{
			behavior: "deny",
			message: "Wiki write tools are disabled",
			toolUseID: "tool-2",
		},
	);
	assert.equal(bridgeCalls, 0);
});

test("canUseTool routes Wiki write tools through the permission bridge under the default policy", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const bridgeCalls: Array<{
		streamId: string;
		toolName: string;
		input: Record<string, unknown>;
		toolUseID: string;
	}> = [];
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (streamId, toolName, input, options) => {
				bridgeCalls.push({
					streamId,
					toolName,
					input,
					toolUseID: options.toolUseID,
				});
				return {
					behavior: "deny",
					message: "denied by user",
					toolUseID: options.toolUseID,
				};
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: true,
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const signal = new AbortController().signal;

	// Attack scenario: an agent (possibly steered by a prompt-injected
	// instruction) tries to write to the wiki. Under the default policy this
	// MUST NOT be silently allowed — it must surface as a real permission
	// request, and if the user denies it, the write must not proceed.
	const decision = await canUseTool(
		"mcp__llm_wiki__update_page",
		{ path: "wiki/index.md", contents: "attacker controlled" },
		{ signal, toolUseID: "tool-write-1", requestId: "req-write-1" },
	);

	assert.deepEqual(bridgeCalls, [
		{
			streamId: "stream-1",
			toolName: "mcp__llm_wiki__update_page",
			input: { path: "wiki/index.md", contents: "attacker controlled" },
			toolUseID: "tool-write-1",
		},
	]);
	assert.deepEqual(decision, {
		behavior: "deny",
		message: "denied by user",
		toolUseID: "tool-write-1",
	});
});

test("canUseTool forwards a sub-agent's agentID to the permission bridge under the default policy", async () => {
	// SDK 0.3.186: tool calls made by a sub-agent (or background task) are
	// routed through canUseTool with an `agentID` identifying the sub-agent,
	// instead of being auto-rejected. Lock down that this integration path
	// (core.ts canUseTool -> permissionBridge.requestPermission) forwards
	// `options.agentID` through unchanged.
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const bridgeCalls: Array<{
		toolName: string;
		toolUseID: string;
		agentID?: string;
	}> = [];
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (_streamId, toolName, _input, options) => {
				bridgeCalls.push({
					toolName,
					toolUseID: options.toolUseID,
					agentID: options.agentID,
				});
				return {
					behavior: "deny",
					message: "denied by user",
					toolUseID: options.toolUseID,
				};
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: true,
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	await canUseTool(
		"mcp__llm_wiki__update_page",
		{ path: "wiki/index.md", contents: "subagent write" },
		{
			signal: new AbortController().signal,
			toolUseID: "tool-write-sub",
			requestId: "req-write-sub",
			agentID: "subagent-1",
		},
	);

	assert.deepEqual(bridgeCalls, [
		{
			toolName: "mcp__llm_wiki__update_page",
			toolUseID: "tool-write-sub",
			agentID: "subagent-1",
		},
	]);
});

test("default policy write tools are not bare-allowed via allowedTools (SDK canUseTool shadowing)", async () => {
	// SDK 0.3.198+ auto-approves any bare `allowedTools` entry before
	// `canUseTool` is even consulted (confirmed against the 0.3.201 runtime
	// warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). If a write tool were still
	// listed in `allowedTools`, the "ask" approval below would never fire in
	// a real SDK — only in this mocked queryFn. This test locks down that
	// `allowedTools` never contains write tools so the ask path stays live.
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const bridgeCalls: string[] = [];
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (_streamId, toolName, _input, options) => {
				bridgeCalls.push(toolName);
				return { behavior: "allow", toolUseID: options.toolUseID };
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: true,
			permissionPolicy: "default",
		},
	});

	const allowedTools = capturedInput?.options?.allowedTools as string[] | undefined;
	assert.ok(allowedTools);
	assert.ok(allowedTools.includes("mcp__llm_wiki__read_page"));
	assert.ok(!allowedTools.includes("mcp__llm_wiki__update_page"));
	assert.ok(!allowedTools.includes("mcp__llm_wiki__run_pipeline"));

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const decision = await canUseTool(
		"mcp__llm_wiki__update_page",
		{ path: "wiki/index.md" },
		{ signal: new AbortController().signal, toolUseID: "tool-write-ask", requestId: "req-write-ask" },
	);

	assert.deepEqual(bridgeCalls, ["mcp__llm_wiki__update_page"]);
	assert.deepEqual(decision, {
		behavior: "allow",
		toolUseID: "tool-write-ask",
	});
});

test("canUseTool allows a Wiki write once the permission bridge approves it", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (_streamId, _toolName, _input, options) => ({
				behavior: "allow",
				toolUseID: options.toolUseID,
			}),
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: true,
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const decision = await canUseTool(
		"mcp__llm_wiki__update_page",
		{ path: "wiki/index.md", contents: "approved update" },
		{ signal: new AbortController().signal, toolUseID: "tool-write-2", requestId: "req-write-2" },
	);

	assert.deepEqual(decision, {
		behavior: "allow",
		toolUseID: "tool-write-2",
	});
});

test("canUseTool denies Wiki writes under the restricted policy without ever asking the bridge", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	let bridgeCalls = 0;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async () => {
				bridgeCalls += 1;
				throw new Error("bridge should not be called under restricted policy");
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: true,
			permissionPolicy: "restricted",
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const decision = await canUseTool(
		"mcp__llm_wiki__update_page",
		{ path: "wiki/index.md" },
		{ signal: new AbortController().signal, toolUseID: "tool-write-3", requestId: "req-write-3" },
	);

	assert.deepEqual(decision, {
		behavior: "deny",
		message: "Wiki write tools are restricted",
		toolUseID: "tool-write-3",
	});
	assert.equal(bridgeCalls, 0);
});

test("canUseTool fast-path allows Wiki writes under bypass policies without asking the bridge", async () => {
	for (const permissionPolicy of ["bypass", "bypassPermissions"] as const) {
		let capturedInput: Parameters<QueryFn>[0] | undefined;
		let bridgeCalls = 0;
		const queryFn: QueryFn = async function* (input) {
			capturedInput = input;
		};

		const handleRequest = createRequestHandler({
			queryFn,
			send: () => {},
			error: () => {},
			env: {},
			permissionBridge: {
				requestPermission: async () => {
					bridgeCalls += 1;
					throw new Error("bridge should not be called under bypass policy");
				},
				handleResponse: () => {},
				rejectStream: () => {},
				hasPending: () => false,
			},
		});

		await handleRequest({
			...baseRequest,
			options: {
				...baseRequest.options,
				projectPath: "/tmp/wiki",
				enableWikiTools: true,
				enableWriteTools: true,
				permissionPolicy,
			},
		});

		const canUseTool = capturedInput?.options?.canUseTool;
		assert.ok(canUseTool);
		const decision = await canUseTool(
			"mcp__llm_wiki__update_page",
			{ path: "wiki/index.md" },
			{ signal: new AbortController().signal, toolUseID: "tool-write-4", requestId: "req-write-4" },
		);

		assert.deepEqual(decision, {
			behavior: "allow",
			toolUseID: "tool-write-4",
		});
		assert.equal(bridgeCalls, 0);
	}
});

test("canUseTool asks permission bridge for non-Wiki tools", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const bridgeCalls: Array<{
		streamId: string;
		toolName: string;
		input: Record<string, unknown>;
		toolUseID: string;
	}> = [];
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (streamId, toolName, input, options) => {
				bridgeCalls.push({
					streamId,
					toolName,
					input,
					toolUseID: options.toolUseID,
				});
				return {
					behavior: "allow",
					toolUseID: options.toolUseID,
				};
			},
			handleResponse: () => {},
			rejectStream: () => {},
			hasPending: () => false,
		},
	});

	await handleRequest(baseRequest);

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	assert.deepEqual(
		await canUseTool(
			"Bash",
			{ command: "pwd" },
			{ signal: new AbortController().signal, toolUseID: "tool-3", requestId: "req-3" },
		),
		{
			behavior: "allow",
			toolUseID: "tool-3",
		},
	);
	assert.deepEqual(bridgeCalls, [
		{
			streamId: "stream-1",
			toolName: "Bash",
			input: { command: "pwd" },
			toolUseID: "tool-3",
		},
	]);
});

test("query request enables LLM Wiki MCP tools when project context is present", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			apiServerBaseUrl: "http://127.0.0.1:19828",
			enableWikiTools: true,
			enableWriteTools: true,
		},
	});

	assert.equal(capturedInput?.options?.tools, undefined);
	assert.equal(capturedInput?.options?.permissionMode, "default");
	// Write tools are intentionally absent from allowedTools even though
	// enableWriteTools is true: a bare allowedTools entry auto-approves the
	// tool call and shadows canUseTool (SDK 0.3.198+
	// CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Write-tool gating goes exclusively
	// through canUseTool + the PreToolUse hook. See the
	// "default policy write tools are not bare-allowed" test below.
	assert.deepEqual(capturedInput?.options?.allowedTools, [
		"mcp__llm_wiki__list_projects",
		"mcp__llm_wiki__list_pages",
		"mcp__llm_wiki__read_page",
		"mcp__llm_wiki__search_pages",
		"mcp__llm_wiki__get_graph",
		"mcp__llm_wiki__build_answer_context",
		"mcp__llm_wiki__run_lint",
		"mcp__llm_wiki__collect_research_sources",
		"mcp__llm_wiki__get_agent_task_status",
		"mcp__llm_wiki__detect_duplicates",
		"mcp__llm_wiki__merge_duplicate_group",
		"mcp__llm_wiki__optimize_research_topic",
		"mcp__llm_wiki__test_provider_connection",
		"mcp__llm_wiki__okf_validate",
		"mcp__llm_wiki__okf_export",
		"mcp__llm_wiki__taxonomy_preview",
		"mcp__llm_wiki__synthesis_preview",
		"mcp__llm_wiki__get_knowledge_agents_config",
	]);
	assert.ok(capturedInput?.options?.mcpServers);
	assert.ok(capturedInput?.options?.hooks);
});

test("query request forwards wiki write resource limits to MCP tools", async () => {
	const projectPath = await tempWikiProject();
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath,
			enableWikiTools: true,
			enableWriteTools: true,
			maxFilesChanged: 1,
			maxWriteBytes: 512,
		},
	});

	const server = capturedInput?.options?.mcpServers?.llm_wiki as
		| { instance?: { _registeredTools?: Record<string, RegisteredTool> } }
		| undefined;
	const updatePage = server?.instance?._registeredTools?.update_page;
	const createEntity = server?.instance?._registeredTools?.create_entity;
	assert.ok(updatePage);
	assert.ok(createEntity);

	const first = await updatePage.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nThis page now contains a concrete update about agent resource testing.",
		},
		{},
	);
	const oversized = await updatePage.handler(
		{
			path: "wiki/index.md",
			contents: `# Index\n\n${"Too large. ".repeat(80)}`,
		},
		{},
	);
	const secondFile = await createEntity.handler(
		{
			name: "Second File",
			summary: "This second file should exceed the write limit.",
		},
		{},
	);

	assert.equal(first.isError, undefined);
	assert.equal(oversized.isError, true);
	assert.equal(oversized.structuredContent?.kind, "max_write_bytes");
	assert.equal(oversized.structuredContent?.limit, 512);
	assert.match(String(oversized.structuredContent?.error), /maxWriteBytes/);
	assert.equal(secondFile.isError, true);
	assert.equal(secondFile.structuredContent?.kind, "max_files_changed");
	assert.equal(secondFile.structuredContent?.limit, 1);
});

test("query request can restrict tools to pre-approved Wiki MCP tools", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: false,
			permissionPolicy: "restricted",
		},
	});

	assert.deepEqual(capturedInput?.options?.tools, []);
	assert.equal(capturedInput?.options?.permissionMode, "dontAsk");
	assert.deepEqual(capturedInput?.options?.allowedTools, [
		"mcp__llm_wiki__list_projects",
		"mcp__llm_wiki__list_pages",
		"mcp__llm_wiki__read_page",
		"mcp__llm_wiki__search_pages",
		"mcp__llm_wiki__get_graph",
		"mcp__llm_wiki__build_answer_context",
		"mcp__llm_wiki__run_lint",
		"mcp__llm_wiki__collect_research_sources",
		"mcp__llm_wiki__get_agent_task_status",
		"mcp__llm_wiki__detect_duplicates",
		"mcp__llm_wiki__merge_duplicate_group",
		"mcp__llm_wiki__optimize_research_topic",
		"mcp__llm_wiki__test_provider_connection",
		"mcp__llm_wiki__okf_validate",
		"mcp__llm_wiki__okf_export",
		"mcp__llm_wiki__taxonomy_preview",
		"mcp__llm_wiki__synthesis_preview",
		"mcp__llm_wiki__get_knowledge_agents_config",
	]);
});

test("query request can explicitly bypass SDK permissions", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			permissionPolicy: "bypass",
		},
	});

	assert.equal(capturedInput?.options?.tools, undefined);
	assert.equal(capturedInput?.options?.permissionMode, "bypassPermissions");
	assert.equal(capturedInput?.options?.allowDangerouslySkipPermissions, true);
});

test("kill request aborts active query and removes it from tracking", async () => {
	const activeQueries = new Map<string, AbortController>();
	let capturedSignal: AbortSignal | undefined;
	let releaseQuery: (() => void) | undefined;
	let rejectedStream: string | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedSignal = input.options?.abortController?.signal;
		await new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		activeQueries,
		env: {},
		permissionBridge: {
			requestPermission: async () => ({ behavior: "deny", message: "no" }),
			handleResponse: () => {},
			rejectStream: (streamId) => {
				rejectedStream = streamId;
			},
			hasPending: () => false,
		},
	});

	const running = handleRequest(baseRequest);
	await Promise.resolve();

	assert.equal(activeQueries.has("stream-1"), true);
	await handleRequest({ type: "kill", streamId: "stream-1" });
	assert.equal(capturedSignal?.aborted, true);
	assert.equal(activeQueries.has("stream-1"), false);
	assert.equal(rejectedStream, "stream-1");

	releaseQuery?.();
	await running;
});

test("query errors emit error message and cleanup active query", async () => {
	const sent: AgentMessage[] = [];
	const activeQueries = new Map<string, AbortController>();
	const activeSdkQueries = new Map<string, QueryControl>();
	const queryFn: QueryFn = async function* () {
		throw new Error("boom");
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: () => {},
		activeQueries,
		activeSdkQueries,
		env: {},
	});

	await handleRequest(baseRequest);

	assert.equal(activeQueries.size, 0);
	assert.equal(activeSdkQueries.size, 0);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.type, "error");
	assert.match(String((sent[0]?.data as { error?: string }).error), /boom/);
});

test("max turns errors emit resource limit action before error", async () => {
	const sent: AgentMessage[] = [];
	const queryFn: QueryFn = async function* () {
		throw new Error("Claude Code returned an error result: Reached maximum number of turns (10)");
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			maxTurns: 10,
		},
	});

	assert.equal(sent.length, 2);
	assert.deepEqual(sent[0], {
		streamId: "stream-1",
		type: "agent_action_required",
		data: {
			kind: "resource_limit",
			limitKind: "max_turns_exceeded",
			limit: 10,
			used: 10,
			attempted: 10,
			message: "Claude Code returned an error result: Reached maximum number of turns (10)",
			recovery: "settings_agent",
		},
	});
	assert.equal(sent[1]?.type, "error");
});

test("max turns-like errors log a diagnostic when the turn count cannot be parsed", async () => {
	const sent: AgentMessage[] = [];
	const errors: unknown[][] = [];
	const queryFn: QueryFn = async function* () {
		throw new Error("Claude Code returned an error result: max turns exhausted");
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: (...args) => errors.push(args),
		env: {},
	});

	await handleRequest(baseRequest);

	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.type, "error");
	assert.equal(errors.length, 2);
	assert.deepEqual(errors[1], [
		"[sidecar] could not parse max turns limit from error:",
		"Claude Code returned an error result: max turns exhausted",
	]);
});

test("query completion releases retained active SDK query", async () => {
	const activeSdkQueries = new Map<string, QueryControl>();
	let releaseQuery: (() => void) | undefined;
	let releasedCount = 0;
	const query = (async function* () {
		await new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
		yield { type: "assistant", message: { content: [] } };
	})() as QueryControl;
	query.rewindFiles = async () => ({ canRewind: true });
	const queryFn: QueryFn = () => query;

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		activeSdkQueries,
		env: {},
		onActiveSdkQueryReleased: () => {
			releasedCount += 1;
		},
	});

	const running = handleRequest(baseRequest);
	await Promise.resolve();

	assert.equal(activeSdkQueries.get("stream-1"), query);
	releaseQuery?.();
	await running;

	assert.equal(activeSdkQueries.has("stream-1"), false);
	assert.equal(releasedCount, 1);
});


test("query request forwards enableFileCheckpointing and sandbox to SDK", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			enableFileCheckpointing: true,
			sandbox: {
				enabled: true,
				autoAllowBashIfSandboxed: false,
				failIfUnavailable: true,
			},
		},
	});

	assert.equal(capturedInput?.options?.enableFileCheckpointing, true);
	assert.deepEqual(capturedInput?.options?.sandbox, {
		enabled: true,
		autoAllowBashIfSandboxed: false,
		failIfUnavailable: true,
	});
});

test("rewind bridge calls retained query rewindFiles and emits result", async () => {
	const sent: AgentMessage[] = [];
	const rewindFiles = async (userMessageId: string) => ({
		canRewind: true,
		filesChanged: [`${userMessageId}.md`],
	});
	const query = (async function* () {})() as QueryControl;
	query.rewindFiles = rewindFiles;
	const activeSdkQueries = new Map<string, QueryControl>([["stream-1", query]]);

	handleRewindFilesRequest({
		request: {
			type: "rewind_files",
			streamId: "stream-1",
			messageId: "user-sdk-1",
		},
		activeSdkQueries,
		send: (msg) => sent.push(msg),
	});

	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(sent, [
		{
			streamId: "stream-1",
			type: "rewind_files",
			data: {
				messageId: "user-sdk-1",
				ok: true,
				result: {
					canRewind: true,
					filesChanged: ["user-sdk-1.md"],
				},
				error: undefined,
			},
		},
	]);
});

test("rewind bridge reports missing active query", () => {
	const sent: AgentMessage[] = [];

	handleRewindFilesRequest({
		request: {
			type: "rewind_files",
			streamId: "missing-stream",
			messageId: "user-sdk-1",
		},
		activeSdkQueries: new Map(),
		send: (msg) => sent.push(msg),
	});

	assert.equal(sent[0]?.type, "rewind_files");
	const data = sent[0]?.data as { ok?: boolean; error?: string; unavailableReason?: string };
	assert.equal(data.ok, false);
	assert.equal(data.unavailableReason, "inactive_stream");
	assert.match(String(data.error), /no longer active/);
});

test("rewind bridge reports missing message id as unavailable", () => {
	const sent: AgentMessage[] = [];
	const query = (async function* () {})() as QueryControl;
	query.rewindFiles = async () => ({ canRewind: true });

	handleRewindFilesRequest({
		request: {
			type: "rewind_files",
			streamId: "stream-1",
		},
		activeSdkQueries: new Map([["stream-1", query]]),
		send: (msg) => sent.push(msg),
	});

	const data = sent[0]?.data as { ok?: boolean; unavailableReason?: string };
	assert.equal(data.ok, false);
	assert.equal(data.unavailableReason, "missing_message_id");
});

test("rewind bridge reports unsupported active query", () => {
	const sent: AgentMessage[] = [];
	const query = (async function* () {})() as QueryControl;

	handleRewindFilesRequest({
		request: {
			type: "rewind_files",
			streamId: "stream-1",
			messageId: "user-sdk-1",
		},
		activeSdkQueries: new Map([["stream-1", query]]),
		send: (msg) => sent.push(msg),
	});

	const data = sent[0]?.data as { ok?: boolean; unavailableReason?: string };
	assert.equal(data.ok, false);
	assert.equal(data.unavailableReason, "unsupported");
});

test("rewind bridge removes stale query when transport is closed", async () => {
	const sent: AgentMessage[] = [];
	const query = (async function* () {})() as QueryControl;
	query.rewindFiles = async () => {
		throw new Error("ProcessTransport is not ready for writing");
	};
	const activeSdkQueries = new Map<string, QueryControl>([["stream-1", query]]);

	handleRewindFilesRequest({
		request: {
			type: "rewind_files",
			streamId: "stream-1",
			messageId: "user-sdk-1",
		},
		activeSdkQueries,
		send: (msg) => sent.push(msg),
	});

	await new Promise((resolve) => setImmediate(resolve));

	const data = sent[0]?.data as { ok?: boolean; error?: string; unavailableReason?: string };
	assert.equal(data.ok, false);
	assert.equal(data.unavailableReason, "transport_closed");
	assert.match(String(data.error), /no longer available/);
	assert.equal(activeSdkQueries.has("stream-1"), false);
});
