import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => {
	const listeners: Record<
		string,
		Array<(event: { payload: unknown }) => void>
	> = {};
	const listenerEvents: string[] = [];
	let unlistenImpl:
		| undefined
		| ((event: string) => void | Promise<void>) = undefined;
	const emit = (event: string, payload: unknown) => {
		for (const listener of listeners[event] ?? []) {
			listener({ payload });
		}
	};
	return {
		invoke: vi.fn(
			async (_command: string, _payload?: unknown): Promise<unknown> =>
				undefined,
		),
		listen: vi.fn(
			async (event: string, cb: (event: { payload: unknown }) => void) => {
				listenerEvents.push(event);
				listeners[event] = [...(listeners[event] ?? []), cb];
				return vi.fn(() => {
					listeners[event] = (listeners[event] ?? []).filter(
						(listener) => listener !== cb,
					);
					if (listeners[event]?.length === 0) {
						delete listeners[event];
					}
					return unlistenImpl?.(event);
				});
			},
		),
		emit,
		emitString: emit,
		listenerEvents,
		setUnlistenImpl: (
			next: undefined | ((event: string) => void | Promise<void>),
		) => {
			unlistenImpl = next;
		},
		reset: () => {
			for (const event of Object.keys(listeners)) {
				delete listeners[event];
			}
			listenerEvents.length = 0;
			unlistenImpl = undefined;
		},
	};
});

const appToolMocks = vi.hoisted(() => ({
	runAgentAppTool: vi.fn(async () => ({ ok: true, result: { value: "ok" } })),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: tauriMocks.listen,
}));

vi.mock("./agent-app-tools", () => ({
	runAgentAppTool: appToolMocks.runAgentAppTool,
}));

import { rewindAgentFiles, streamAgent } from "./agent-transport";

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.reset();
	tauriMocks.invoke.mockResolvedValue(undefined);
	appToolMocks.runAgentAppTool.mockResolvedValue({
		ok: true,
		result: { value: "ok" },
	});
});

describe("streamAgent", () => {
	it("calls onStreamStart with the generated stream id", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		expect(callbacks.onStreamStart).toHaveBeenCalledWith(payload.args.streamId);

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("registers data and done listeners before invoking agent_spawn", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		expect(tauriMocks.listenerEvents).toEqual([
			`agent:${payload.args.streamId}`,
			`agent:${payload.args.streamId}:done`,
		]);
		expect(tauriMocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
			tauriMocks.invoke.mock.invocationCallOrder[0],
		);
		expect(tauriMocks.listen.mock.invocationCallOrder[1]).toBeLessThan(
			tauriMocks.invoke.mock.invocationCallOrder[0],
		);

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("swallows stale listener cleanup errors when a stream finishes", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		tauriMocks.setUnlistenImpl(() => {
			throw new Error("The resource id 123 is invalid.");
		});
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "done",
				data: null,
			}),
		);

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("failed to unlisten"),
				expect.any(Error),
			);
		});
		warnSpy.mockRestore();
	});

	it("swallows async cleanup rejections from one-shot rewind listeners", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		tauriMocks.setUnlistenImpl(() =>
			Promise.reject(new Error("The resource id 456 is invalid.")),
		);

		const request = rewindAgentFiles("stream-1", "user-sdk-1");

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_rewind_files", {
				streamId: "stream-1",
				messageId: "user-sdk-1",
			});
		});

		tauriMocks.emitString(
			"agent:stream-1",
			JSON.stringify({
				streamId: "stream-1",
				type: "rewind_files",
				data: {
					messageId: "user-sdk-1",
					ok: true,
					result: { canRewind: true, filesChanged: ["wiki/page.md"] },
				},
			}),
		);

		await expect(request).resolves.toMatchObject({
			streamId: "stream-1",
			messageId: "user-sdk-1",
			ok: true,
		});
		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("failed to unlisten"),
				expect.any(Error),
			);
		});
		warnSpy.mockRestore();
	});

	it("passes rewind result events through with the stream id", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onRewindFiles: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "rewind_files",
				data: {
					messageId: "user-sdk-1",
					ok: true,
					result: { canRewind: true, filesChanged: ["wiki/page.md"] },
				},
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;

		expect(callbacks.onRewindFiles).toHaveBeenCalledWith({
			streamId: payload.args.streamId,
			messageId: "user-sdk-1",
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
		});
	});

	it("passes rewind unavailable reasons through with the stream id", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onRewindFiles: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "rewind_files",
				data: {
					messageId: "user-sdk-1",
					ok: false,
					error: "Agent stream is no longer active",
					unavailableReason: "inactive_stream",
				},
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;

		expect(callbacks.onRewindFiles).toHaveBeenCalledWith({
			streamId: payload.args.streamId,
			messageId: "user-sdk-1",
			ok: false,
			error: "Agent stream is no longer active",
			unavailableReason: "inactive_stream",
		});
	});

	it("rewindAgentFiles waits for the rewind result event", async () => {
		const request = rewindAgentFiles("stream-1", "user-sdk-1");

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_rewind_files", {
				streamId: "stream-1",
				messageId: "user-sdk-1",
			});
		});

		tauriMocks.emitString(
			"agent:stream-1",
			JSON.stringify({
				streamId: "stream-1",
				type: "rewind_files",
				data: {
					messageId: "user-sdk-1",
					ok: true,
					result: { canRewind: true, filesChanged: ["wiki/page.md"] },
				},
			}),
		);

		await expect(request).resolves.toMatchObject({
			streamId: "stream-1",
			messageId: "user-sdk-1",
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
		});
	});

	it("allows stream and one-shot rewind listeners to consume the same rewind event", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onRewindFiles: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const rewind = rewindAgentFiles(payload.args.streamId, "user-sdk-1");

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_rewind_files", {
				streamId: payload.args.streamId,
				messageId: "user-sdk-1",
			});
		});

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "rewind_files",
				data: {
					messageId: "user-sdk-1",
					ok: true,
					result: { canRewind: true, filesChanged: ["wiki/page.md"] },
				},
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await expect(rewind).resolves.toMatchObject({
			streamId: payload.args.streamId,
			messageId: "user-sdk-1",
			ok: true,
		});
		await stream;
		expect(callbacks.onRewindFiles).toHaveBeenCalledWith({
			streamId: payload.args.streamId,
			messageId: "user-sdk-1",
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
		});
	});

	it("passes session options to agent_spawn", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"resume agent",
			{
				apiKey: "test-key",
				sessionId: "11111111-1111-4111-8111-111111111111",
				resume: "22222222-2222-4222-8222-222222222222",
				continueSession: true,
				forkSession: true,
				resumeSessionAt: "msg-1",
				intentOverride: "Treat the latest user message as primary.",
				persistSession: true,
				title: "Wiki Agent",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: Record<string, unknown> & { streamId: string };
		};
		expect(payload.args).toMatchObject({
			prompt: "resume agent",
			sessionId: "11111111-1111-4111-8111-111111111111",
			resume: "22222222-2222-4222-8222-222222222222",
			continueSession: true,
			forkSession: true,
			resumeSessionAt: "msg-1",
			intentOverride: "Treat the latest user message as primary.",
			persistSession: true,
			title: "Wiki Agent",
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("returns SDK result metadata through onDone", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const result = {
			type: "result",
			result: "ok",
			session_id: "11111111-1111-4111-8111-111111111111",
			total_cost_usd: 0.01,
			duration_ms: 1234,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
			},
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "message",
				data: result,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onMessage).toHaveBeenCalledWith(result);
		expect(callbacks.onToken).toHaveBeenCalledWith("\n");
		expect(callbacks.onDone).toHaveBeenCalledWith(result);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("finishes when the sidecar sends a data-channel done event", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const result = {
			type: "result",
			result: "ok",
			session_id: "11111111-1111-4111-8111-111111111111",
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "message",
				data: result,
			}),
		);
		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "done",
				data: null,
			}),
		);

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(result);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("forwards wiki_changed events to the wiki change callback", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onWikiChanged: vi.fn(),
		};

		const stream = streamAgent(
			"update wiki",
			{
				apiKey: "test-key",
				projectPath: "/tmp/wiki",
				enableWikiTools: true,
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const changed = {
			path: "wiki/entities/example.md",
			operation: "update",
			oldSha256: "old",
			newSha256: "new",
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "wiki_changed",
				data: changed,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onWikiChanged).toHaveBeenCalledWith(changed);
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onToken).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("filters SDK compact summaries out of normal assistant output", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onSessionCompact: vi.fn(),
		};

		const stream = streamAgent("resume agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const compactMessage = {
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "The context has run out, so here is a compact summary of the prior session.",
					},
				],
			},
			uuid: "assistant-compact-1",
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "message",
				data: compactMessage,
			}),
		);
		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "done",
				data: null,
			}),
		);

		await stream;

		expect(callbacks.onSessionCompact).toHaveBeenCalledWith({
			kind: "compact",
			message: compactMessage,
		});
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onToken).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("forwards sidecar control events to optional callbacks", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onWikiChanged: vi.fn(),
			onToolEvent: vi.fn(),
			onAgentSummary: vi.fn(),
			onActionRequired: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;
		const toolEvent = {
			phase: "pre",
			toolName: "mcp__llm_wiki__read_page",
			toolUseId: "tool-1",
		};
		const summary = {
			changedPaths: ["wiki/entities/example.md"],
			toolCalls: 1,
			failedToolCalls: 0,
		};
		const action = {
			kind: "lint_recommended",
			paths: ["wiki/entities/example.md"],
			reason: "agent_write",
		};
		const resourceAction = {
			kind: "resource_limit",
			limitKind: "max_files_changed",
			limit: 1,
			used: 1,
			attempted: 2,
			changedPaths: ["wiki/entities/example.md"],
			message: "Write would exceed maxFilesChanged (1)",
			recovery: "split_task",
		};

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "tool_event",
				data: toolEvent,
			}),
		);
		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_summary",
				data: summary,
			}),
		);
		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_action_required",
				data: action,
			}),
		);
		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_action_required",
				data: resourceAction,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onToolEvent).toHaveBeenCalledWith(toolEvent);
		expect(callbacks.onAgentSummary).toHaveBeenCalledWith(summary);
		expect(callbacks.onActionRequired).toHaveBeenCalledWith(action);
		expect(callbacks.onActionRequired).toHaveBeenCalledWith(resourceAction);
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("handles app tool requests and sends responses back to the sidecar", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run app tool",
			{ apiKey: "test-key" },
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "app_tool_request",
				data: {
					requestId: "request-1",
					toolName: "run_lint",
					args: { includeSemantic: false },
				},
			}),
		);

		await vi.waitFor(() => {
			expect(appToolMocks.runAgentAppTool).toHaveBeenCalledWith("run_lint", {
				includeSemantic: false,
			});
			expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_tool_response", {
				streamId: payload.args.streamId,
				requestId: "request-1",
				ok: true,
				data: { ok: true, result: { value: "ok" } },
			});
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("passes app tool budgets to runAgentAppTool", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run budgeted app tool",
			{ apiKey: "test-key" },
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;
		const budget = {
			maxFilesChanged: 2,
			changedPaths: ["wiki/index.md"],
		};

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "app_tool_request",
				data: {
					requestId: "request-budget",
					toolName: "ingest_source",
					args: { sourcePath: "raw/sources/source.pdf" },
					budget,
				},
			}),
		);

		await vi.waitFor(() => {
			expect(appToolMocks.runAgentAppTool).toHaveBeenCalledWith(
				"ingest_source",
				{ sourcePath: "raw/sources/source.pdf" },
				{ budget },
			);
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("handles permission requests and sends decisions back to the sidecar", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onPermissionRequest: vi.fn(async () => ({
				behavior: "allow" as const,
				updatedInput: { command: "pwd" },
			})),
		};

		const stream = streamAgent(
			"run protected tool",
			{ apiKey: "test-key" },
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;
		const request = {
			requestId: "permission-1",
			toolName: "Bash",
			inputPreview: { commandBytes: 3 },
			toolUseID: "tool-1",
			title: "Claude wants to run Bash",
		};

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_permission_request",
				data: request,
			}),
		);

		await vi.waitFor(() => {
			expect(callbacks.onPermissionRequest).toHaveBeenCalledWith(request);
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_permission_response",
				{
					streamId: payload.args.streamId,
					requestId: "permission-1",
					ok: true,
					decision: {
						behavior: "allow",
						updatedInput: { command: "pwd" },
					},
				},
			);
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("denies permission requests when no callback is registered", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run protected tool",
			{ apiKey: "test-key" },
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_permission_request",
				data: {
					requestId: "permission-2",
					toolName: "Bash",
					inputPreview: {},
					toolUseID: "tool-2",
				},
			}),
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_permission_response",
				{
					streamId: payload.args.streamId,
					requestId: "permission-2",
					ok: true,
					decision: {
						behavior: "deny",
						message: "Permission request was not handled",
					},
				},
			);
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("reports invoke failures without debug prefixes", async () => {
		tauriMocks.invoke.mockRejectedValueOnce(
			new Error("Failed to spawn agent sidecar: denied"),
		);
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		expect(callbacks.onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Failed to spawn agent sidecar: denied",
			}),
		);
		expect(callbacks.onError.mock.calls[0]?.[0].message).not.toContain(
			"[outer-catch]",
		);
		expect(callbacks.onDone).not.toHaveBeenCalled();
	});

	it("does not spawn when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamAgent(
			"run agent",
			{ apiKey: "test-key" },
			callbacks,
			controller.signal,
		);

		expect(tauriMocks.invoke).not.toHaveBeenCalled();
		expect(tauriMocks.listen).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});
});
