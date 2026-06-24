import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { createAppToolBridge, type AppToolResponseMessage } from "./app-tool-bridge.js";
import { createRequestHandler, type QueryControl } from "./core.js";
import {
	createPermissionBridge,
	type AgentPermissionResponseMessage,
} from "./permission-bridge.js";
import { handleRewindFilesRequest } from "./rewind-bridge.js";
import type { AgentKillRequest, AgentMessage, AgentRequest, RewindFilesRequest } from "./types.js";

const rl = createInterface({ input: process.stdin });
const activeQueries = new Map<string, AbortController>();
const activeSdkQueries = new Map<string, QueryControl>();
let exitTimer: NodeJS.Timeout | undefined;

function send(msg: AgentMessage): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

function cancelScheduledExit(): void {
	if (!exitTimer) return;
	clearTimeout(exitTimer);
	exitTimer = undefined;
}

function scheduleExitIfIdle(): void {
	// P1-5: also block exit while a bridge call (app-tool / permission) is
	// awaiting a host response. The activeQueries/activeSdkQueries maps can
	// be momentarily empty at the boundary where a query released but a
	// bridge promise hasn't settled yet — exiting then drops the in-flight
	// bridge call silently. hasPending() guards that window. The bridges
	// are created after this function (TDZ-safe: scheduleExitIfIdle is only
	// invoked at runtime after they exist).
	if (
		activeQueries.size !== 0 ||
		activeSdkQueries.size !== 0 ||
		appToolBridge.hasPending() ||
		permissionBridge.hasPending() ||
		exitTimer
	) {
		return;
	}
	exitTimer = setTimeout(() => {
		exitTimer = undefined;
		if (
			activeQueries.size === 0 &&
			activeSdkQueries.size === 0 &&
			!appToolBridge.hasPending() &&
			!permissionBridge.hasPending()
		) {
			process.exit(0);
		}
	}, 250);
}

const appToolBridge = createAppToolBridge({ send });
const permissionBridge = createPermissionBridge({ send });
const handleRequest = createRequestHandler({
	queryFn: query,
	send,
	error: console.error,
	activeQueries,
	activeSdkQueries,
	appToolBridge,
	permissionBridge,
	onActiveSdkQueryReleased: scheduleExitIfIdle,
});

rl.on("line", (line) => {
	try {
		cancelScheduledExit();
		const parsed = JSON.parse(line) as
			| AgentRequest
			| AgentKillRequest
			| AppToolResponseMessage
			| AgentPermissionResponseMessage
			| RewindFilesRequest;
		if (parsed.type === "app_tool_response") {
			appToolBridge.handleResponse(parsed);
			return;
		}
		if (parsed.type === "permission_response") {
			permissionBridge.handleResponse(parsed);
			return;
		}
		if (parsed.type === "rewind_files") {
			handleRewindFilesRequest({
				request: parsed,
				activeSdkQueries,
				send,
				onSettled: scheduleExitIfIdle,
			});
			return;
		}
		handleRequest(parsed).catch((err) => {
			console.error("[sidecar] unhandled error:", err);
		}).finally(() => {
			scheduleExitIfIdle();
		});
	} catch {
		// ignore malformed input
	}
});

// Keep process alive even after stdin EOF — active queries hold refs.
// When all queries finish and stdin is closed, exit cleanly.
rl.on("close", () => {
	// Don't exit immediately — active query() generators keep the event loop alive.
	// This setInterval prevents Node from exiting while queries are running.
	const keepAlive = setInterval(() => {}, 60000);
	const check = setInterval(() => {
		// P1-5: include bridge pending state — a tool/permission call
		// awaiting a host response keeps the process alive.
		if (
			activeQueries.size === 0 &&
			activeSdkQueries.size === 0 &&
			!appToolBridge.hasPending() &&
			!permissionBridge.hasPending()
		) {
			clearInterval(keepAlive);
			clearInterval(check);
			scheduleExitIfIdle();
		}
	}, 1000);
});

console.error("[sidecar] ready");
