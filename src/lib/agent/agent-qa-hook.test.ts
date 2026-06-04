import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@/stores/chat-store";
import {
	flushAllPendingQa,
	flushQaForConversation,
	getPendingQaIds,
	isConversationPending,
	isDuplicateQa,
	markConversationDirty,
	shouldExtractQa,
	unmarkConversation,
} from "./agent-qa-hook";

// ── Helpers ──────────────────────────────────────────────────────────────────

function msg(
	role: "user" | "assistant",
	content: string,
	conversationId = "conv-1",
): DisplayMessage {
	return {
		id: `${role}-${Math.random()}`,
		role,
		content,
		timestamp: Date.now(),
		conversationId,
	};
}

const longAnswer =
	"RAG (Retrieval-Augmented Generation) is a technique that combines retrieval from a knowledge base with language model generation. It works by first retrieving relevant documents from a vector store, then feeding those documents as context to the LLM to generate more accurate and grounded responses.";

// ── shouldExtractQa ──────────────────────────────────────────────────────────

describe("shouldExtractQa", () => {
	it("returns false for empty messages", () => {
		expect(shouldExtractQa([]).extract).toBe(false);
	});

	it("returns false when only user messages", () => {
		expect(shouldExtractQa([msg("user", "hello")]).extract).toBe(false);
	});

	it("returns false when only assistant messages", () => {
		expect(shouldExtractQa([msg("assistant", "Hello!")]).extract).toBe(false);
	});

	it("returns false for greeting-only conversations", () => {
		const messages = [
			msg("user", "hi"),
			msg("assistant", "Hello! How can I help?"),
		];
		expect(shouldExtractQa(messages).extract).toBe(false);
	});

	it("returns false when last assistant message is too short", () => {
		const messages = [
			msg("user", "What is RAG?"),
			msg("assistant", "RAG is retrieval augmented generation."),
		];
		expect(shouldExtractQa(messages).extract).toBe(false);
	});

	it("returns true for substantive conversation", () => {
		const messages = [
			msg("user", "Explain RAG in detail"),
			msg("assistant", longAnswer),
		];
		expect(shouldExtractQa(messages).extract).toBe(true);
	});

	it("accepts substantive Agent assistant content", () => {
		const messages = [
			msg("user", "Explain RAG in detail"),
			{ ...msg("assistant", longAnswer), mode: "agent" as const },
		];
		expect(shouldExtractQa(messages).extract).toBe(true);
	});

	it("skips delete-only conversations without new knowledge", () => {
		const messages = [
			msg("user", "删除 wiki/entities/old-page.md"),
			msg(
				"assistant",
				"已删除 wiki/entities/old-page.md，并清理了对应引用。".repeat(8),
			),
		];
		const result = shouldExtractQa(messages, { trigger: "delete" });
		expect(result.extract).toBe(false);
		expect(result.reason).toBe("delete-only");
	});

	it("does not apply delete-only skip to ordinary auto QA eligibility", () => {
		const messages = [
			msg("user", "删除 wiki/entities/old-page.md"),
			msg(
				"assistant",
				"已删除 wiki/entities/old-page.md，并清理了对应引用。".repeat(8),
			),
		];
		expect(shouldExtractQa(messages).extract).toBe(true);
	});

	it("keeps delete conversations that include a new issue or insight", () => {
		const messages = [
			msg("user", "删除旧页面，并说明为什么会出现重复 QA"),
			msg(
				"assistant",
				"删除完成。重复 QA 的原因是删除触发的提取流程过度依赖旧消息，没有足够强调最后几轮用户观察和 dedup 策略。".repeat(3),
			),
		];
		expect(shouldExtractQa(messages).extract).toBe(true);
	});
});

// ── Dirty flag ───────────────────────────────────────────────────────────────

describe("dirty flag management", () => {
	beforeEach(() => {
		for (const id of getPendingQaIds()) {
			unmarkConversation(id);
		}
	});

	it("marks conversation dirty", () => {
		markConversationDirty("conv-1");
		expect(isConversationPending("conv-1")).toBe(true);
		expect(isConversationPending("conv-2")).toBe(false);
	});

	it("unmarks conversation", () => {
		markConversationDirty("conv-1");
		unmarkConversation("conv-1");
		expect(isConversationPending("conv-1")).toBe(false);
	});

	it("tracks multiple pending conversations", () => {
		markConversationDirty("conv-1");
		markConversationDirty("conv-2");
		expect(getPendingQaIds()).toEqual(
			expect.arrayContaining(["conv-1", "conv-2"]),
		);
	});

	it("unmark on non-existent id is a no-op", () => {
		unmarkConversation("nonexistent");
		expect(isConversationPending("nonexistent")).toBe(false);
	});
});

// ── Mock setup ───────────────────────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
	files: new Map<string, string>(),
}));

const streamChatMock = vi.hoisted(() =>
	vi.fn(
		async (
			_config: unknown,
			_messages: unknown[],
			handlers: {
				onToken: (t: string) => void;
				onDone: () => void;
				onError?: (e: unknown) => void;
			},
		) => {
			handlers.onToken(
				"---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n",
			);
			handlers.onDone();
		},
	),
);

const webSearchMock = vi.hoisted(() => vi.fn(async () => []));

const listDirectoryMock = vi.hoisted(() =>
	vi.fn<(path: string) => Promise<unknown>>(async () => {
		throw new Error("no qa dir");
	}),
);

vi.mock("@/commands/fs", () => ({
	readFile: vi.fn(async (path: string) => {
		const val = fsMock.files.get(path);
		if (val === undefined) throw new Error(`missing: ${path}`);
		return val;
	}),
	listDirectory: listDirectoryMock,
	writeFile: vi.fn(async (path: string, content: string) => {
		fsMock.files.set(path, content);
	}),
	createDirectory: vi.fn(async () => {}),
}));

vi.mock("@/lib/frontmatter", () => ({
	parseFrontmatter: vi.fn((content: string) => {
		const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return { frontmatter: null, body: content, rawBlock: "" };
		const yaml = match[1];
		const body = match[2];
		const fm: Record<string, string | string[]> = {};
		for (const line of yaml.split("\n")) {
			const m = line.match(/^(\w+):\s*(.*)$/);
			if (m) {
				const key = m[1];
				let val: string | string[] = m[2].trim();
				if (val.startsWith("[") && val.endsWith("]")) {
					val = val
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim().replace(/^"|"$/g, ""))
						.filter(Boolean);
				} else {
					val = val.replace(/^"|"$/g, "");
				}
				fm[key] = val;
			}
		}
		return { frontmatter: fm, body, rawBlock: match[0] };
	}),
}));

vi.mock("@/lib/llm-client", () => ({
	streamChat: streamChatMock,
}));

vi.mock("@/lib/web-search", () => ({
	webSearch: webSearchMock,
}));

vi.mock("@/lib/output-language", () => ({
	buildLanguageDirective: vi.fn(
		() => "Respond in the same language as the input.",
	),
}));

// ── flushQaForConversation tests ─────────────────────────────────────────────

describe("flushQaForConversation", () => {
	beforeEach(() => {
		fsMock.files.clear();
		vi.clearAllMocks();
		for (const id of getPendingQaIds()) {
			unmarkConversation(id);
		}
		listDirectoryMock.mockImplementation(async () => {
			throw new Error("no qa dir");
		});
		streamChatMock.mockImplementation(async (_c, _m, h) => {
			h.onToken(
				"---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n",
			);
			h.onDone();
		});
	});

	it("skips if conversation is not pending", async () => {
		const messages = [
			msg("user", "What is RAG?"),
			msg("assistant", longAnswer),
		];
		const result = await flushQaForConversation(
			"conv-1",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("not-pending");
	});

	it("extracts QA and removes from pending", async () => {
		markConversationDirty("conv-1");
		const messages = [
			msg("user", "What is RAG?"),
			msg("assistant", longAnswer),
		];
		const result = await flushQaForConversation(
			"conv-1",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
		expect(isConversationPending("conv-1")).toBe(false);
	});

	it("keeps auto-trigger prompt free of delete-only instructions", async () => {
		markConversationDirty("conv-auto");
		const messages = [
			msg("user", "What is RAG?", "conv-auto"),
			msg("assistant", longAnswer, "conv-auto"),
		];

		await flushQaForConversation(
			"conv-auto",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);

		const llmMessages = streamChatMock.mock.calls[0]?.[1] as Array<{
			content: string;
		}>;
		expect(llmMessages[0].content).not.toContain(
			"Delete-Triggered Extraction",
		);
	});

	it("adds recency and delete-intent guidance for delete-triggered extraction", async () => {
		markConversationDirty("conv-delete");
		const messages = [
			msg("user", "What causes duplicate QA pages?", "conv-delete"),
			msg("assistant", longAnswer, "conv-delete"),
		];

		const result = await flushQaForConversation(
			"conv-delete",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			{ trigger: "delete" },
		);

		const llmMessages = streamChatMock.mock.calls[0]?.[1] as Array<{
			content: string;
		}>;
		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
		expect(llmMessages[0].content).toContain("Delete-Triggered Extraction");
		expect(llmMessages[0].content).toContain("latest user-observed issue");
		expect(llmMessages[0].content).toContain("conversation cleanup");
	});

	it("filters messages by conversationId", async () => {
		markConversationDirty("conv-1");
		const messages = [
			msg("user", "Hello", "conv-2"),
			msg("assistant", "Hi there!", "conv-2"),
			msg("user", "What is RAG?", "conv-1"),
			msg("assistant", longAnswer, "conv-1"),
		];
		const result = await flushQaForConversation(
			"conv-1",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
	});

	it("skips when no messages for conversation", async () => {
		markConversationDirty("conv-empty");
		const result = await flushQaForConversation(
			"conv-empty",
			[],
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("no-messages");
		expect(isConversationPending("conv-empty")).toBe(false);
	});

	it("removes from pending even on error", async () => {
		markConversationDirty("conv-err");
		streamChatMock.mockImplementation(async (_c, _m, h) => {
			h.onError?.(new Error("LLM error"));
		});
		const messages = [
			msg("user", "What is RAG?", "conv-err"),
			msg("assistant", longAnswer, "conv-err"),
		];
		await expect(
			flushQaForConversation(
				"conv-err",
				messages,
				"/project",
				{ model: "test" } as never,
				{ provider: "none" } as never,
			),
		).rejects.toThrow("LLM error");
		expect(isConversationPending("conv-err")).toBe(false);
	});

	it("skips when existing QA has matching title (dedup)", async () => {
		markConversationDirty("conv-dedup");
		listDirectoryMock.mockResolvedValueOnce([
			{
				name: "existing.md",
				path: "/project/wiki/qa/existing.md",
				is_dir: false,
			},
		]);
		fsMock.files.set(
			"/project/wiki/qa/existing.md",
			"---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\n---\n\n# Q: What is RAG?\n\n## A: existing answer",
		);
		const messages = [
			msg("user", "What is RAG?", "conv-dedup"),
			msg("assistant", longAnswer, "conv-dedup"),
		];
		const result = await flushQaForConversation(
			"conv-dedup",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("duplicate");
		expect(isConversationPending("conv-dedup")).toBe(false);
	});

	it("skips near-duplicate Chinese operational topics before calling the LLM", async () => {
		markConversationDirty("conv-near-dedup");
		listDirectoryMock.mockResolvedValueOnce([
			{
				name: "existing.md",
				path: "/project/wiki/qa/existing.md",
				is_dir: false,
			},
		]);
		fsMock.files.set(
			"/project/wiki/qa/existing.md",
			"---\ntype: qa\ntitle: llm-wiki工具中文件修改限制的具体表现和应对策略是什么\ntags: [qa]\n---\n\n# Q: llm-wiki工具中文件修改限制的具体表现和应对策略是什么\n\n## A: mcp__llm_wiki__update_page 默认限制单次最多修改 3 个文件，Agent 批量修复时会在第三个文件后停止，需要用户手动继续。",
		);
		const messages = [
			msg(
				"user",
				"wiki维护工具中文件修改限制的具体情况是什么",
				"conv-near-dedup",
			),
			msg("assistant", longAnswer, "conv-near-dedup"),
		];

		const result = await flushQaForConversation(
			"conv-near-dedup",
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);

		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("duplicate");
		expect(streamChatMock).not.toHaveBeenCalled();
	});
});

// ── flushAllPendingQa ────────────────────────────────────────────────────────

describe("flushAllPendingQa", () => {
	beforeEach(() => {
		fsMock.files.clear();
		vi.clearAllMocks();
		for (const id of getPendingQaIds()) {
			unmarkConversation(id);
		}
		listDirectoryMock.mockImplementation(async () => {
			throw new Error("no qa dir");
		});
		streamChatMock.mockImplementation(async (_c, _m, h) => {
			h.onToken(
				"---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: answer\n\n## Key Insights\n\n- Insight 1\n",
			);
			h.onDone();
		});
	});

	it("flushes all pending conversations", async () => {
		markConversationDirty("conv-a");
		markConversationDirty("conv-b");
		const messages = [
			msg("user", "What is RAG?", "conv-a"),
			msg("assistant", longAnswer, "conv-a"),
			msg("user", "Explain transformers", "conv-b"),
			msg("assistant", longAnswer, "conv-b"),
		];
		const results = await flushAllPendingQa(
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(results).toHaveLength(2);
		expect(getPendingQaIds()).toHaveLength(0);
	});

	it("handles mixed results: success + error + skip", async () => {
		markConversationDirty("conv-ok");
		markConversationDirty("conv-err");
		markConversationDirty("conv-skip");
		const messages = [
			msg("user", "What is RAG?", "conv-ok"),
			msg("assistant", longAnswer, "conv-ok"),
			msg("user", "hi", "conv-skip"),
			msg("assistant", "Hello!", "conv-skip"),
			msg("user", "What is RAG?", "conv-err"),
			msg("assistant", longAnswer, "conv-err"),
		];
		let callCount = 0;
		streamChatMock.mockImplementation(async (_c, _m, h) => {
			callCount++;
			if (callCount === 2) {
				h.onError?.(new Error("LLM error"));
				return;
			}
			h.onToken(
				"---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: answer\n\n## Key Insights\n\n- Insight 1\n",
			);
			h.onDone();
		});

		const results = await flushAllPendingQa(
			messages,
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
		);
		expect(results).toHaveLength(3);
		// All removed from pending despite mixed results (finally block)
		expect(getPendingQaIds()).toHaveLength(0);
	});
});

describe("isDuplicateQa", () => {
	it("detects Chinese near-duplicate via body bigram overlap", () => {
		const existing = [
			{
				title:
					"在维护wiki知识库时遇到mcp llm wiki update_page工具的文件数量限制3文件是什么情",
				body: "在维护 Wiki 知识库时，mcp__llm_wiki__update_page 工具会限制单次运行的文件修改数量，默认为 maxFilesChanged = 3。当 Agent 尝试修复多个 broken links 时，会在第三个文件写入后被拒绝，需要用户发送「继续」来重置配额。",
			},
			{
				title: "llm-wiki工具中文件修改限制的具体表现和应对策略是什么",
				body: "在使用 LLM Wiki 的维护工具时，mcp__llm_wiki__update_page 默认限制单次最多修改 3 个文件（maxFilesChanged）。这个限制会导致 Agent 批量修复 broken links 时中途停止，需要手动继续。",
			},
		];

		// Near-duplicate Chinese title with similar body should be detected
		const nearDupeTitle = "wiki维护工具中文件修改限制的具体情况是什么";
		const nearDupeBody =
			"Wiki 维护工具 mcp__llm_wiki__update_page 的文件修改限制默认为 3 个文件。Agent 批量修复时会在第三个文件后停止，需要用户手动继续。";
		expect(isDuplicateQa(nearDupeTitle, nearDupeBody, existing)).toBe(true);
	});

	it("does not false-positive on unrelated Chinese content", () => {
		const existing = [
			{
				title:
					"在维护wiki知识库时遇到mcp llm wiki update_page工具的文件数量限制3文件是什么情",
				body: "在维护 Wiki 知识库时，mcp__llm_wiki__update_page 工具会限制单次运行的文件修改数量，默认为 maxFilesChanged = 3。",
			},
		];

		// Unrelated topic should not be flagged
		const differentTitle = "如何使用RAG检索增强生成技术";
		const differentBody =
			"RAG（检索增强生成）是一种结合信息检索和语言模型的技术，通过从知识库中检索相关文档来增强生成质量。";
		expect(isDuplicateQa(differentTitle, differentBody, existing)).toBe(false);
	});
});
