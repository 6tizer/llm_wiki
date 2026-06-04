import type { DisplayMessage } from "@/stores/chat-store";
import { extractAgentTextContent } from "./agent-format";

export const AGENT_RESUME_INTENT_OVERRIDE =
	"[System: User's latest message is a correction or new topic. Do NOT continue previous pending actions. Treat the latest user message as the primary instruction.]";

const PENDING_QUESTION_RE = /[?？]|(?:要|需要|是否|继续|确认|允许|可以|同意|执行|应用|删除|修改|写入|保存).{0,12}(?:吗|么|？|\?)/i;
const CONFIRMATION_RE = /^(?:好的?|好|是|是的|对|对的|可以|确认|继续|同意|允许|行|没问题|yes|y|ok|okay|continue|confirm|no problem|no worries)\s*[。.!！]*$/i;
const CORRECTION_OR_NEW_TOPIC_RE = /(?:不对|不是|错了|不要|不用|别继续|别做|停止|停下|重新|换个话题|另外|不是这个|不需要|取消|算了|wrong|stop|cancel|instead)/i;
const ENGLISH_NEGATIVE_RE = /^(?:no|nope|nah)(?:\s*[,.!]|$)/i;

interface AgentResumeIntentInput {
	resumeSessionId?: string;
	latestUserText: string;
	lastAssistantText?: string;
}

function hasPendingQuestion(text: string | undefined): boolean {
	return Boolean(text?.trim()) && PENDING_QUESTION_RE.test(text ?? "");
}

function isExplicitCorrectionOrNewTopic(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || CONFIRMATION_RE.test(trimmed)) return false;
	return CORRECTION_OR_NEW_TOPIC_RE.test(trimmed)
		|| ENGLISH_NEGATIVE_RE.test(trimmed);
}

export function buildAgentResumeIntentOverride({
	resumeSessionId,
	latestUserText,
	lastAssistantText,
}: AgentResumeIntentInput): string | undefined {
	if (!resumeSessionId) return undefined;
	if (!hasPendingQuestion(lastAssistantText)) return undefined;
	if (!isExplicitCorrectionOrNewTopic(latestUserText)) return undefined;
	return AGENT_RESUME_INTENT_OVERRIDE;
}

function agentAssistantVisibleText(message: DisplayMessage): string {
	return message.content.trim() || extractAgentTextContent(message.agentBlocks);
}

export function buildAgentResumeIntentOverrideForConversation({
	messages,
	conversationId,
	resumeSessionId,
	latestUserText,
}: {
	messages: DisplayMessage[];
	conversationId: string;
	resumeSessionId?: string;
	latestUserText: string;
}): string | undefined {
	const lastAgentAssistantMessage = [...messages]
		.reverse()
		.find(
			(message) =>
				message.conversationId === conversationId
				&& message.role === "assistant"
				&& message.mode === "agent",
		);

	return buildAgentResumeIntentOverride({
		resumeSessionId,
		latestUserText,
		lastAssistantText: lastAgentAssistantMessage
			? agentAssistantVisibleText(lastAgentAssistantMessage)
			: undefined,
	});
}
