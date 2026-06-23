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

	it("passes isolation and active project root to the Rust command", async () => {
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

		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"claude_cli_spawn",
			expect.objectContaining({
				model: "claude-sonnet-4-20250514",
				isolateLocalConfig: true,
				workingDirectory: "/tmp/llm-wiki-project",
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
