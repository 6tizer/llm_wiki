import type {
	AgentPermissionDecision,
	AgentProgressSummaryPayload,
} from "@/lib/agent/agent-types";
import type {
	AgentPermissionEventDecision,
	AgentProgressSummaryRecord,
} from "@/stores/chat-store";

function progressSummaryTimestamp(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function parseAgentProgressSummaryPayload(
	payload: AgentProgressSummaryPayload,
	now = Date.now(),
): AgentProgressSummaryRecord[] {
	const items = Array.isArray(payload) ? payload : [payload];
	return items.flatMap((item) => {
		if (typeof item === "string") {
			const text = item.trim();
			return text ? [{ text, timestamp: now }] : [];
		}
		if (!item || typeof item !== "object") return [];
		const textValue = item.summary ?? item.text;
		if (typeof textValue !== "string") return [];
		const text = textValue.trim();
		if (!text) return [];
		return [{
			text,
			timestamp: progressSummaryTimestamp(item.timestamp, now),
		}];
	});
}

export function classifyAgentPermissionDecision(
	decision: AgentPermissionDecision,
	timeoutMessage: string,
): AgentPermissionEventDecision {
	if (decision.behavior === "allow") {
		if (
			decision.decisionClassification === "user_permanent" ||
			(decision.updatedPermissions?.length ?? 0) > 0
		) {
			return "allow_permanent";
		}
		return "allow_temporary";
	}
	void timeoutMessage;
	if (decision.autoTimeout) return "timeout";
	if (decision.interrupt) return "deny_interrupt";
	return "deny";
}
