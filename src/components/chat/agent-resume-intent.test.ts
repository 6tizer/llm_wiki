import { describe, expect, it } from "vitest";
import {
	AGENT_RESUME_INTENT_OVERRIDE,
	buildAgentResumeIntentOverride,
	buildAgentResumeIntentOverrideForConversation,
} from "./agent-resume-intent";
import type { DisplayMessage } from "@/stores/chat-store";

describe("buildAgentResumeIntentOverride", () => {
	it("guards resume when a pending question receives an explicit correction", () => {
		expect(
			buildAgentResumeIntentOverride({
				resumeSessionId: "session-1",
				lastAssistantText: "要继续应用这些修改吗？",
				latestUserText: "不对，这个是手动触发的",
			}),
		).toBe(AGENT_RESUME_INTENT_OVERRIDE);
	});

	it("does not guard confirmation replies", () => {
		for (const latestUserText of ["是的", "继续", "可以", "no problem", "no worries"]) {
			expect(
				buildAgentResumeIntentOverride({
					resumeSessionId: "session-1",
					lastAssistantText: "要继续执行吗？",
					latestUserText,
				}),
			).toBeUndefined();
		}
	});

	it("does not guard non-resume conversations", () => {
		expect(
			buildAgentResumeIntentOverride({
				lastAssistantText: "要继续吗？",
				latestUserText: "不对，重新来",
			}),
		).toBeUndefined();
	});

	it("does not guard when the last assistant message is not a question", () => {
		expect(
			buildAgentResumeIntentOverride({
				resumeSessionId: "session-1",
				lastAssistantText: "我已经完成了本次整理。",
				latestUserText: "不对，换个方向",
			}),
		).toBeUndefined();
	});

	it("does not guard ordinary new instructions without explicit correction words", () => {
		expect(
			buildAgentResumeIntentOverride({
				resumeSessionId: "session-1",
				lastAssistantText: "是否要继续写入这些文件？",
				latestUserText: "请总结一下刚才的改动",
			}),
		).toBeUndefined();
	});

	it("uses agent block text when the assistant content is empty", () => {
		const messages: DisplayMessage[] = [
			{
				id: "m1",
				conversationId: "conv-1",
				role: "assistant",
				content: "",
				timestamp: 1,
				mode: "agent",
				agentBlocks: [{ type: "text", text: "是否要继续写入这些文件？" }],
			},
		];

		expect(
			buildAgentResumeIntentOverrideForConversation({
				messages,
				conversationId: "conv-1",
				resumeSessionId: "session-1",
				latestUserText: "不对，先别继续",
			}),
		).toBe(AGENT_RESUME_INTENT_OVERRIDE);
	});

	it("ignores pending agent questions from other conversations", () => {
		const messages: DisplayMessage[] = [
			{
				id: "m1",
				conversationId: "other-conv",
				role: "assistant",
				content: "是否要继续写入这些文件？",
				timestamp: 1,
				mode: "agent",
			},
		];

		expect(
			buildAgentResumeIntentOverrideForConversation({
				messages,
				conversationId: "conv-1",
				resumeSessionId: "session-1",
				latestUserText: "不对，先别继续",
			}),
		).toBeUndefined();
	});
});
