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

import { rewindAgentFiles, rewindAgentSession, streamAgent } from "./agent-transport";

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.reset();
	tauriMocks.invoke.mockImplementation(
		async (command: string): Promise<unknown> => {
			if (command === "runtime_profile_pool_list") {
				return {
					enabled: false,
					status: "disabled",
					activeClaims: [],
					circuitBreakers: [],
				};
			}
			if (command === "runtime_profile_pool_release") {
				return { claim: { claimId: "claim-agent" }, circuitBreaker: null };
			}
			return undefined;
		},
	);
	appToolMocks.runAgentAppTool.mockResolvedValue({
		ok: true,
		result: { value: "ok" },
	});
});

function latestAgentSpawnPayload(): { args: { streamId: string } & Record<string, unknown> } {
	const call = tauriMocks.invoke.mock.calls.find(
		([command]) => command === "agent_spawn",
	);
	expect(call).toBeTruthy();
	return call?.[1] as { args: { streamId: string } & Record<string, unknown> };
}

function agentRunProfile(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		profileId: "profile-agent",
		kind: "agent-run",
		displayName: "Agent profile",
		providerId: "anthropic",
		modelId: "claude-test",
		agentSdkModelId: null,
		endpoint: null,
		apiMode: "anthropic-messages",
		authStyle: "bearer",
		secretRef: "llm-wiki-profile-secret:11111111-1111-4111-8111-111111111111",
		enabled: true,
		taskFamilies: ["agent"],
		maxConcurrency: 1,
		capabilityStatus: "supported",
		capabilityJson: "{\"agentRunSupported\":true}",
		capabilityVersion: "profile-probe.v1",
		capabilityCheckedAtMs: 1,
		probeBackoffUntilMs: null,
		lastCapabilityError: null,
		createdAtMs: 1,
		updatedAtMs: 1,
		...patch,
	};
}

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

	it("threads disallowedTools into the agent_spawn payload when provided", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run agent",
			{
				apiKey: "test-key",
				disallowedTools: ["WebSearch", "WebFetch"],
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		const payload = latestAgentSpawnPayload();
		expect(payload.args.disallowedTools).toEqual(["WebSearch", "WebFetch"]);

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("omits disallowedTools from the agent_spawn payload when web tools are allowed", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		const payload = latestAgentSpawnPayload();
		expect(payload.args.disallowedTools).toBeUndefined();

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("keeps the legacy Agent config path when runtime profile pool is disabled", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run agent",
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
				projectPath: "/tmp/wiki",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"runtime_profile_pool_list",
			{ request: { kind: "agent-run", taskFamily: "agent" } },
		);
		const payload = latestAgentSpawnPayload();
		expect(payload.args).toMatchObject({
			apiKey: "legacy-key",
			baseUrl: "https://legacy.example",
			model: "legacy-model",
		});
		expect(payload.args.agentProfileId).toBeUndefined();
		expect(payload.args.agentProfileClaimId).toBeUndefined();

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("keeps the legacy Agent config path when runtime is healthy but no Agent-run profile is configured", async () => {
		tauriMocks.invoke.mockImplementation(async (command: string): Promise<unknown> => {
			if (command === "runtime_profile_pool_list") {
				return {
					enabled: true,
					status: "healthy",
					activeClaims: [],
					circuitBreakers: [],
				};
			}
			if (command === "runtime_profile_list") {
				return {
					enabled: true,
					status: "healthy",
					profiles: [],
				};
			}
			return undefined;
		});
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run agent",
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
				projectPath: "/tmp/wiki",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"runtime_profile_pool_claim",
			expect.anything(),
		);
		const payload = latestAgentSpawnPayload();
		expect(payload.args).toMatchObject({
			apiKey: "legacy-key",
			baseUrl: "https://legacy.example",
			model: "legacy-model",
		});
		expect(payload.args.agentProfileId).toBeUndefined();
		expect(payload.args.agentProfileClaimId).toBeUndefined();
		expect(callbacks.onError).not.toHaveBeenCalled();

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("keeps the legacy Agent config path when no project path is available", async () => {
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run agent",
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"runtime_profile_pool_list",
			expect.anything(),
		);
		const payload = latestAgentSpawnPayload();
		expect(payload.args).toMatchObject({
			apiKey: "legacy-key",
			baseUrl: "https://legacy.example",
			model: "legacy-model",
		});
		expect(payload.args.agentProfileId).toBeUndefined();
		expect(payload.args.agentProfileClaimId).toBeUndefined();

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
	});

	it("claims an Agent-run profile and strips legacy provider secrets before spawn", async () => {
		tauriMocks.invoke.mockImplementation(
			async (command: string): Promise<unknown> => {
				if (command === "runtime_profile_pool_list") {
					return {
						enabled: true,
						status: "healthy",
						activeClaims: [],
						circuitBreakers: [],
					};
				}
				if (command === "runtime_profile_list") {
					return {
						enabled: true,
						status: "healthy",
						profiles: [agentRunProfile()],
					};
				}
				if (command === "runtime_profile_pool_claim") {
					return {
						claimId: "claim-agent",
						profileId: "profile-agent",
						expiresAtMs: 1_200_000,
						claim: {
							claimId: "claim-agent",
							profileId: "profile-agent",
							kind: "agent-run",
							taskFamily: "agent",
							holder: "agent:stream",
							acquiredAtMs: 1,
							expiresAtMs: 1_200_000,
							status: "active",
						},
					};
				}
				return undefined;
			},
		);
		const callbacks = {
			onStreamStart: vi.fn(),
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"run agent",
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
				projectPath: "/tmp/wiki",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});
		const payload = latestAgentSpawnPayload();
		expect(payload.args.agentProfileId).toBe("profile-agent");
		expect(payload.args.agentProfileClaimId).toBe("claim-agent");
		expect(payload.args.apiKey).toBeUndefined();
		expect(payload.args.baseUrl).toBeUndefined();
		expect(payload.args.model).toBeUndefined();

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});
		await stream;
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"runtime_profile_pool_release",
			expect.anything(),
		);
	});

	it("reports profile_unavailable when runtime profile claim fails", async () => {
		tauriMocks.invoke.mockImplementation(async (command: string) => {
			if (command === "runtime_profile_pool_list") {
				return {
					enabled: true,
					status: "healthy",
					activeClaims: [],
					circuitBreakers: [],
				};
			}
			if (command === "runtime_profile_list") {
				return {
					enabled: true,
					status: "healthy",
					profiles: [agentRunProfile()],
				};
			}
			if (command === "runtime_profile_pool_claim") {
				throw new Error("no-eligible-profile: no profile pool capacity is available");
			}
			return undefined;
		});
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamAgent(
			"run agent",
			{ projectPath: "/tmp/wiki", apiKey: "legacy-key" },
			callbacks,
		);

		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"agent_spawn",
			expect.anything(),
		);
		expect(callbacks.onError).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "profile_unavailable",
			}),
		);
	});

	it("releases a claimed profile if agent_spawn fails before Rust accepts it", async () => {
		tauriMocks.invoke.mockImplementation(
			async (command: string): Promise<unknown> => {
				if (command === "runtime_profile_pool_list") {
					return {
						enabled: true,
						status: "healthy",
						activeClaims: [],
						circuitBreakers: [],
					};
				}
				if (command === "runtime_profile_list") {
					return {
						enabled: true,
						status: "healthy",
						profiles: [agentRunProfile()],
					};
				}
				if (command === "runtime_profile_pool_claim") {
					return {
						claimId: "claim-agent",
						profileId: "profile-agent",
						expiresAtMs: 1_200_000,
						claim: { claimId: "claim-agent" },
					};
				}
				if (command === "agent_spawn") {
					throw new Error("spawn failed");
				}
				if (command === "runtime_profile_pool_release") {
					return { claim: { claimId: "claim-agent" }, circuitBreaker: null };
				}
				return undefined;
			},
		);
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamAgent(
			"run agent",
			{ projectPath: "/tmp/wiki", apiKey: "legacy-key" },
			callbacks,
		);

		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"runtime_profile_pool_release",
			{
				request: expect.objectContaining({
					claimId: "claim-agent",
					outcome: "error",
				}),
			},
		);
		expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
	});

	it("swallows stale untransferred profile release errors", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		tauriMocks.invoke.mockImplementation(
			async (command: string): Promise<unknown> => {
				if (command === "runtime_profile_pool_list") {
					return {
						enabled: true,
						status: "healthy",
						activeClaims: [],
						circuitBreakers: [],
					};
				}
				if (command === "runtime_profile_list") {
					return {
						enabled: true,
						status: "healthy",
						profiles: [agentRunProfile()],
					};
				}
				if (command === "runtime_profile_pool_claim") {
					return {
						claimId: "claim-agent",
						profileId: "profile-agent",
						expiresAtMs: 1_200_000,
						claim: { claimId: "claim-agent" },
					};
				}
				if (command === "agent_spawn") {
					throw new Error("spawn failed");
				}
				if (command === "runtime_profile_pool_release") {
					throw new Error("claim-inactive: profile pool claim is not active");
				}
				return undefined;
			},
		);
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		await streamAgent(
			"run agent",
			{ projectPath: "/tmp/wiki", apiKey: "legacy-key" },
			callbacks,
		);

		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"runtime_profile_pool_release",
			expect.anything(),
		);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error));
		warnSpy.mockRestore();
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
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});

		const payload = latestAgentSpawnPayload();
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

	it("forwards profile_resolved events without treating them as SDK messages", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onProfileResolved: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_spawn",
				expect.anything(),
			);
		});

		const payload = latestAgentSpawnPayload();
		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "profile_resolved",
				data: {
					profileId: "profile-agent",
					claimId: "claim-agent",
					agentSdkModelId: "claude-runtime",
					authStyle: "x-api-key",
					endpoint: "https://agent.example/v1",
				},
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onProfileResolved).toHaveBeenCalledWith({
			streamId: payload.args.streamId,
			profileId: "profile-agent",
			claimId: "claim-agent",
			agentSdkModelId: "claude-runtime",
			authStyle: "x-api-key",
			endpoint: "https://agent.example/v1",
		});
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onToken).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("filters SDK compact boundary system messages out of normal output", async () => {
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
			type: "system",
			subtype: "compact_boundary",
			compact_metadata: {
				post_tokens: 1200,
			},
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
		});
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onToken).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it.each([
		["boundary-then-text", ["compact", "assistant"]],
		["text-then-boundary", ["assistant", "compact"]],
	])("handles compact boundary and assistant text out of order: %s", async (_name, order) => {
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
			type: "system",
			subtype: "compact_boundary",
		};
		const assistantMessage = {
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "continued output" }],
			},
			uuid: "assistant-1",
		};

		for (const item of order) {
			tauriMocks.emitString(
				`agent:${payload.args.streamId}`,
				JSON.stringify({
					streamId: payload.args.streamId,
					type: "message",
					data: item === "compact" ? compactMessage : assistantMessage,
				}),
			);
		}
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
		});
		expect(callbacks.onMessage).toHaveBeenCalledWith(assistantMessage);
		expect(callbacks.onToken).toHaveBeenCalledWith("continued output");
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

describe("rewindAgentSession", () => {
	it("invokes agent_rewind_session with the resume session and rewind uuid, and resolves on the rewind_session event", async () => {
		const promise = rewindAgentSession(
			{ apiKey: "test-key", resume: "session-abc", cwd: "/tmp/wiki" },
			"user-uuid-1",
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_rewind_session",
				expect.anything(),
			);
		});
		const call = tauriMocks.invoke.mock.calls.find(
			([command]) => command === "agent_rewind_session",
		);
		const payload = call?.[1] as { args: Record<string, unknown> };
		expect(payload.args.agentSessionId).toBe("session-abc");
		expect(payload.args.rewindUserMessageId).toBe("user-uuid-1");
		expect(payload.args.cwd).toBe("/tmp/wiki");

		const streamId = payload.args.streamId as string;
		tauriMocks.emitString(
			`agent:${streamId}`,
			JSON.stringify({
				streamId,
				type: "rewind_session",
				data: { ok: true, result: { canRewind: true, filesChanged: ["wiki/page.md"] } },
			}),
		);

		await expect(promise).resolves.toMatchObject({
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
		});
	});

	it("forwards profile_resolved events from rewindAgentSession", async () => {
		const onProfileResolved = vi.fn();
		const promise = rewindAgentSession(
			{ apiKey: "test-key", resume: "session-abc", cwd: "/tmp/wiki" },
			"user-uuid-1",
			undefined,
			onProfileResolved,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_rewind_session",
				expect.anything(),
			);
		});
		const call = tauriMocks.invoke.mock.calls.find(
			([command]) => command === "agent_rewind_session",
		);
		const payload = call?.[1] as { args: Record<string, unknown> };
		const streamId = payload.args.streamId as string;

		tauriMocks.emitString(
			`agent:${streamId}`,
			JSON.stringify({
				streamId,
				type: "profile_resolved",
				data: {
					profileId: "profile-rewind",
					claimId: "claim-rewind",
					agentSdkModelId: "claude-runtime",
					authStyle: "bearer",
				},
			}),
		);
		tauriMocks.emitString(
			`agent:${streamId}`,
			JSON.stringify({
				streamId,
				type: "rewind_session",
				data: { ok: true, result: { canRewind: true } },
			}),
		);

		await expect(promise).resolves.toMatchObject({
			ok: true,
			result: { canRewind: true },
		});
		expect(onProfileResolved).toHaveBeenCalledWith({
			streamId,
			profileId: "profile-rewind",
			claimId: "claim-rewind",
			agentSdkModelId: "claude-runtime",
			authStyle: "bearer",
		});
	});

	it("fails closed without invoking when there is no session to resume", async () => {
		const result = await rewindAgentSession({ apiKey: "test-key" }, "user-uuid-1");

		expect(result.ok).toBe(false);
		expect(result.unavailableReason).toBe("missing_message_id");
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"agent_rewind_session",
			expect.anything(),
		);
	});

	it("fails closed without invoking when the rewind uuid is missing", async () => {
		const result = await rewindAgentSession(
			{ apiKey: "test-key", resume: "session-abc" },
			"",
		);

		expect(result.ok).toBe(false);
		expect(result.unavailableReason).toBe("missing_message_id");
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"agent_rewind_session",
			expect.anything(),
		);
	});

	it("resolves with a spawn_failed error when the process exits nonzero before any rewind_session event (A10)", async () => {
		const promise = rewindAgentSession(
			{ apiKey: "test-key", resume: "session-abc" },
			"user-uuid-1",
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_rewind_session",
				expect.anything(),
			);
		});
		const call = tauriMocks.invoke.mock.calls.find(
			([command]) => command === "agent_rewind_session",
		);
		const payload = call?.[1] as { args: { streamId: string } };

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 1,
			stderr: "sidecar crashed",
		});

		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.unavailableReason).toBe("spawn_failed");
		expect(result.error).toContain("sidecar crashed");
	});

	it("keeps the legacy Agent config path for rewind when runtime is healthy but no Agent-run profile is configured", async () => {
		tauriMocks.invoke.mockImplementation(async (command: string): Promise<unknown> => {
			if (command === "runtime_profile_pool_list") {
				return {
					enabled: true,
					status: "healthy",
					activeClaims: [],
					circuitBreakers: [],
				};
			}
			if (command === "runtime_profile_list") {
				return {
					enabled: true,
					status: "healthy",
					profiles: [],
				};
			}
			return undefined;
		});

		const promise = rewindAgentSession(
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
				projectPath: "/tmp/wiki",
				resume: "session-abc",
			},
			"user-uuid-1",
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledWith(
				"agent_rewind_session",
				expect.anything(),
			);
		});
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"runtime_profile_pool_claim",
			expect.anything(),
		);
		const call = tauriMocks.invoke.mock.calls.find(
			([command]) => command === "agent_rewind_session",
		);
		const payload = call?.[1] as { args: Record<string, unknown> };
		expect(payload.args).toMatchObject({
			apiKey: "legacy-key",
			baseUrl: "https://legacy.example",
			model: "legacy-model",
		});
		expect(payload.args.agentProfileId).toBeUndefined();
		expect(payload.args.agentProfileClaimId).toBeUndefined();

		const streamId = payload.args.streamId as string;
		tauriMocks.emitString(
			`agent:${streamId}`,
			JSON.stringify({
				streamId,
				type: "rewind_session",
				data: { ok: true, result: { canRewind: true, filesChanged: ["wiki/page.md"] } },
			}),
		);

		await expect(promise).resolves.toMatchObject({
			ok: true,
			result: { canRewind: true, filesChanged: ["wiki/page.md"] },
		});
	});

	it("keeps profile_unavailable for rewind when an Agent-run candidate exists but claim fails", async () => {
		tauriMocks.invoke.mockImplementation(async (command: string): Promise<unknown> => {
			if (command === "runtime_profile_pool_list") {
				return {
					enabled: true,
					status: "healthy",
					activeClaims: [],
					circuitBreakers: [],
				};
			}
			if (command === "runtime_profile_list") {
				return {
					enabled: true,
					status: "healthy",
					profiles: [agentRunProfile()],
				};
			}
			if (command === "runtime_profile_pool_claim") {
				throw new Error("no-eligible-profile: no profile pool capacity is available");
			}
			return undefined;
		});

		await expect(
			rewindAgentSession(
				{
					apiKey: "legacy-key",
					projectPath: "/tmp/wiki",
					resume: "session-abc",
				},
				"user-uuid-1",
			),
		).rejects.toMatchObject({ kind: "profile_unavailable" });
		expect(tauriMocks.invoke).not.toHaveBeenCalledWith(
			"agent_rewind_session",
			expect.anything(),
		);
	});

	it("claims an Agent-run profile the same way streamAgent does, and releases it on invoke failure (A18)", async () => {
		tauriMocks.invoke.mockImplementation(
			async (command: string): Promise<unknown> => {
				if (command === "runtime_profile_pool_list") {
					return {
						enabled: true,
						status: "healthy",
						activeClaims: [],
						circuitBreakers: [],
					};
				}
				if (command === "runtime_profile_list") {
					return {
						enabled: true,
						status: "healthy",
						profiles: [agentRunProfile({ profileId: "profile-rewind" })],
					};
				}
				if (command === "runtime_profile_pool_claim") {
					return {
						claimId: "claim-rewind",
						profileId: "profile-rewind",
						expiresAtMs: 1_200_000,
						claim: {
							claimId: "claim-rewind",
							profileId: "profile-rewind",
							kind: "agent-run",
							taskFamily: "agent",
							holder: "agent:rewind",
							acquiredAtMs: 1,
							expiresAtMs: 1_200_000,
							status: "active",
						},
					};
				}
				if (command === "agent_rewind_session") {
					throw new Error("spawn exploded");
				}
				return undefined;
			},
		);

		const result = await rewindAgentSession(
			{
				apiKey: "legacy-key",
				baseUrl: "https://legacy.example",
				model: "legacy-model",
				projectPath: "/tmp/wiki",
				resume: "session-abc",
			},
			"user-uuid-1",
		);

		expect(result.ok).toBe(false);
		expect(result.unavailableReason).toBe("spawn_failed");
		const spawnCall = tauriMocks.invoke.mock.calls.find(
			([command]) => command === "agent_rewind_session",
		);
		const spawnPayload = spawnCall?.[1] as { args: Record<string, unknown> };
		expect(spawnPayload.args.agentProfileId).toBe("profile-rewind");
		expect(spawnPayload.args.agentProfileClaimId).toBe("claim-rewind");
		expect(spawnPayload.args.apiKey).toBeUndefined();
		expect(spawnPayload.args.baseUrl).toBeUndefined();
		expect(spawnPayload.args.model).toBeUndefined();

		expect(tauriMocks.invoke).toHaveBeenCalledWith(
			"runtime_profile_pool_release",
			expect.objectContaining({
				request: expect.objectContaining({ claimId: "claim-rewind" }),
			}),
		);
	});
});
