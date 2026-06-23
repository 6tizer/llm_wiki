import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => {
	const listeners: Record<string, (event: { payload: unknown }) => void> = {};
	return {
		invoke: vi.fn(
			async (_command: string, _payload?: unknown): Promise<unknown> =>
				undefined,
		),
		listen: vi.fn(
			async (event: string, cb: (event: { payload: unknown }) => void) => {
				listeners[event] = cb;
				return vi.fn(() => {
					delete listeners[event];
				});
			},
		),
		emit: (event: string, payload: unknown) => listeners[event]?.({ payload }),
		reset: () => {
			for (const event of Object.keys(listeners)) {
				delete listeners[event];
			}
		},
	};
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: tauriMocks.listen,
}));

import { streamClaudeCodeCli } from "./claude-cli-transport";
import { useWikiStore } from "@/stores/wiki-store";

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.reset();
	tauriMocks.invoke.mockResolvedValue(undefined);
	useWikiStore.getState().setProject({
		id: "project-1",
		name: "Project",
		path: "/tmp/llm-wiki-project",
	});
});

describe("streamClaudeCodeCli", () => {
	it("does not spawn when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
			controller.signal,
		);

		expect(tauriMocks.invoke).not.toHaveBeenCalled();
		expect(tauriMocks.listen).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalled();
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("passes isolation, timeout, and active project root to the Rust command", async () => {
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
				localCliIsolation: true,
				claudeCliTimeoutMinutes: 30,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
		);

		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"claude_cli_spawn",
			expect.objectContaining({
				model: "claude-sonnet-4-20250514",
				isolateLocalConfig: true,
				timeoutMinutes: 30,
				workingDirectory: "/tmp/llm-wiki-project",
			}),
		);
	});

	it("does not enable a Rust timeout when the config leaves it empty", async () => {
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
				localCliIsolation: true,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
		);

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			timeoutMinutes?: number;
		};
		expect(payload.timeoutMinutes).toBeUndefined();
	});

	it("surfaces timed-out done payloads as timeout-specific errors", async () => {
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			streamId: string;
		};
		tauriMocks.emit(`claude-cli:${payload.streamId}:done`, {
			code: -1,
			timedOut: true,
			stderr: "Claude Code CLI timed out after 1 minute.",
		});

		await stream;

		expect(callbacks.onDone).not.toHaveBeenCalled();
		expect(callbacks.onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Claude Code CLI timed out after 1 minute.",
			}),
		);
		expect(callbacks.onError.mock.calls[0]?.[0].message).not.toContain(
			"code -1",
		);
	});

	it("keeps ordinary code -1 done payloads on the generic exit-code path", async () => {
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			streamId: string;
		};
		tauriMocks.emit(`claude-cli:${payload.streamId}:done`, {
			code: -1,
			timedOut: false,
			stderr: "manual failure",
		});

		await stream;

		expect(callbacks.onDone).not.toHaveBeenCalled();
		expect(callbacks.onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "claude CLI exited with code -1: manual failure",
			}),
		);
	});

	it("fails before spawning when no active project is open", async () => {
		useWikiStore.getState().setProject(null);
		const callbacks = {
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamClaudeCodeCli(
			{
				provider: "claude-code",
				apiKey: "",
				model: "claude-sonnet-4-20250514",
				ollamaUrl: "",
				customEndpoint: "",
				maxContextSize: 128000,
			},
			[{ role: "user", content: "Analyze this source." }],
			callbacks,
		);

		expect(tauriMocks.invoke).not.toHaveBeenCalled();
		expect(tauriMocks.listen).not.toHaveBeenCalled();
		expect(callbacks.onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Claude Code CLI requires an active project working directory",
			}),
		);
	});
});
