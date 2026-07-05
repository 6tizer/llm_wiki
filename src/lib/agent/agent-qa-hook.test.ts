import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@/stores/chat-store";
import {
	isDuplicateQa,
	cleanupLegacyPendingQaStorage,
	saveQaForConversation,
	shouldExtractQa,
	stripOuterMarkdownFence,
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

	it("skips cleanup-only conversations without new knowledge", () => {
		const messages = [
			msg("user", "cleanup stale references for the deleted page"),
			msg(
				"assistant",
				"Cleaned up stale references and found no changes left to apply. ".repeat(
					3,
				),
			),
		];
		const result = shouldExtractQa(messages, { trigger: "delete" });
		expect(result.extract).toBe(false);
		expect(result.reason).toBe("delete-only");
	});

	it("skips no-op delete conversations without new knowledge", () => {
		const messages = [
			msg("user", "删除 wiki/entities/missing.md"),
			msg(
				"assistant",
				"Nothing to delete. The page was already missing, not deleted, and no changes were made. ".repeat(
					2,
				),
			),
		];
		const result = shouldExtractQa(messages, { trigger: "delete" });
		expect(result.extract).toBe(false);
		expect(result.reason).toBe("delete-only");
	});

	it("skips permission-denied cleanup conversations without new knowledge", () => {
		const messages = [
			msg("user", "remove the old QA page"),
			msg(
				"assistant",
				"Permission denied while removing the page. The cleanup was cancelled and no changes were made. ".repeat(
					2,
				),
			),
		];
		const result = shouldExtractQa(messages, { trigger: "delete" });
		expect(result.extract).toBe(false);
		expect(result.reason).toBe("delete-only");
	});

	it("does not apply delete-only skip to ordinary manual QA eligibility", () => {
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

	it("keeps cleanup conversations that include a new issue or insight", () => {
		const messages = [
			msg("user", "cleanup the code around the QA hook and explain the bug"),
			msg(
				"assistant",
				"I cleaned up the QA hook implementation. The bug was that delete-triggered extraction treated operation-only cleanup as reusable knowledge.".repeat(
					2,
				),
			),
		];
		expect(shouldExtractQa(messages, { trigger: "delete" }).extract).toBe(
			true,
		);
	});
});

describe("stripOuterMarkdownFence", () => {
	it("strips a complete outer markdown fence", () => {
		const content = [
			"```markdown",
			"---",
			"type: qa",
			"title: What is RAG?",
			"---",
			"",
			"# Q: What is RAG?",
			"```",
		].join("\n");
		expect(stripOuterMarkdownFence(content).startsWith("---")).toBe(true);
		expect(stripOuterMarkdownFence(content)).not.toContain("```markdown");
	});

	it("preserves non-wrapper fences in the body", () => {
		const content = [
			"---",
			"type: qa",
			"title: How to show code?",
			"---",
			"",
			"```ts",
			"const ok = true",
			"```",
		].join("\n");
		expect(stripOuterMarkdownFence(content)).toBe(content);
	});
});

// ── Legacy automatic QA queue cleanup ───────────────────────────────────────

describe("cleanupLegacyPendingQaStorage", () => {
	function stubLocalStorage() {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => storage.get(key) ?? null),
			removeItem: vi.fn((key: string) => {
				storage.delete(key);
			}),
			setItem: vi.fn((key: string, value: string) => {
				storage.set(key, value);
			}),
		});
	}

	it("clears old pending QA localStorage keys", () => {
		stubLocalStorage();
		localStorage.setItem("llm-wiki:pendingQa", JSON.stringify(["conv-1"]));
		localStorage.setItem(
			"llm-wiki:pendingQaRetryCounts",
			JSON.stringify({ "conv-1": 2 }),
		);

		cleanupLegacyPendingQaStorage();

		expect(localStorage.getItem("llm-wiki:pendingQa")).toBeNull();
		expect(localStorage.getItem("llm-wiki:pendingQaRetryCounts")).toBeNull();
	});

	it("does not throw when legacy keys are absent", () => {
		stubLocalStorage();
		expect(() => cleanupLegacyPendingQaStorage()).not.toThrow();
	});
});

// ── Mock setup ───────────────────────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
	files: new Map<string, string>(),
}));

const streamChatMock = vi.hoisted(() =>
	vi.fn(
		async (
			_family: unknown,
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

vi.mock("@/lib/pool-chat", () => ({
	streamChatRouted: streamChatMock,
}));

vi.mock("@/lib/web-search", () => ({
	webSearch: webSearchMock,
}));

vi.mock("@/lib/output-language", () => ({
	buildLanguageDirective: vi.fn(
		() => "Respond in the same language as the input.",
	),
}));

// ── saveQaForConversation tests ─────────────────────────────────────────────

describe("saveQaForConversation", () => {
	beforeEach(() => {
		fsMock.files.clear();
		vi.clearAllMocks();
		listDirectoryMock.mockImplementation(async () => {
			throw new Error("no qa dir");
		});
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken(
				"---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n",
			);
			h.onDone();
		});
	});

	it("saves QA explicitly without pending state", async () => {
		const messages = [
			msg("user", "What is RAG?"),
			msg("assistant", longAnswer),
		];
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);
		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
		expect(fsMock.files.has("/project/wiki/qa/what-is-rag.md")).toBe(true);
	});

	it("saves fenced markdown QA as clean frontmatter-first markdown", async () => {
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken(
				"```markdown\n---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n```",
			);
			h.onDone();
		});
		const messages = [
			msg("user", "What is RAG?", "conv-fenced"),
			msg("assistant", longAnswer, "conv-fenced"),
		];
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
		const saved = fsMock.files.get("/project/wiki/qa/what-is-rag.md");
		expect(saved?.startsWith("---")).toBe(true);
		expect(saved).not.toContain("```markdown");
	});

	it("skips fenced SKIP responses without writing a file", async () => {
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken("```\nSKIP\n```");
			h.onDone();
		});
		const messages = [
			msg("user", "What is RAG?", "conv-fenced-skip"),
			msg("assistant", longAnswer, "conv-fenced-skip"),
		];
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("llm-skipped");
		expect([...fsMock.files.keys()].some((path) => path.includes("/wiki/qa/"))).toBe(false);
	});

	it("rejects recovered frontmatter that is not at the start of the saved file", async () => {
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken(
				"Here is the QA page:\n---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\n---\n\n# Q: What is RAG?",
			);
			h.onDone();
		});
		const messages = [
			msg("user", "What is RAG?", "conv-prefixed"),
			msg("assistant", longAnswer, "conv-prefixed"),
		];

		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("LLM output missing valid qa frontmatter");
		expect([...fsMock.files.keys()].some((path) => path.includes("/wiki/qa/"))).toBe(false);
	});

	it("reports a specific error when a fenced QA has trailing content", async () => {
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken(
				"```markdown\n---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\n---\n\n# Q: What is RAG?\n```\nHope this helps!",
			);
			h.onDone();
		});
		const messages = [
			msg("user", "What is RAG?", "conv-fenced-trailing"),
			msg("assistant", longAnswer, "conv-fenced-trailing"),
		];
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toBe(
			"LLM output wrapped in code fence with trailing content",
		);
		expect([...fsMock.files.keys()].some((path) => path.includes("/wiki/qa/"))).toBe(false);
	});

	it("rejects non-QA frontmatter without writing a file", async () => {
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onToken(
				"---\ntype: entity\ntitle: What is RAG?\ntags: [qa]\n---\n\n# What is RAG?",
			);
			h.onDone();
		});
		const messages = [
			msg("user", "What is RAG?", "conv-non-qa"),
			msg("assistant", longAnswer, "conv-non-qa"),
		];
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(false);
		expect([...fsMock.files.keys()].some((path) => path.includes("/wiki/qa/"))).toBe(false);
	});

	it("keeps manual-save prompt free of delete-only instructions", async () => {
		const messages = [
			msg("user", "What is RAG?", "conv-manual"),
			msg("assistant", longAnswer, "conv-manual"),
		];

		await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		const llmMessages = streamChatMock.mock.calls[0]?.[2] as Array<{
			content: string;
		}>;
		expect(llmMessages[0].content).not.toContain(
			"Delete-Triggered Extraction",
		);
	});

	it("adds recency and delete-intent guidance for delete-triggered extraction", async () => {
		const messages = [
			msg("user", "What causes duplicate QA pages?", "conv-delete"),
			msg("assistant", longAnswer, "conv-delete"),
		];

		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
			{ trigger: "delete" },
		);

		const llmMessages = streamChatMock.mock.calls[0]?.[2] as Array<{
			content: string;
		}>;
		expect(result.ok).toBe(true);
		expect(result.saved).toBe(true);
		expect(llmMessages[0].content).toContain("Delete-Triggered Extraction");
		expect(llmMessages[0].content).toContain("latest user-observed issue");
		expect(llmMessages[0].content).toContain("conversation cleanup");
	});

	it("throws extraction errors without persisting retry state", async () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => storage.get(key) ?? null),
			removeItem: vi.fn((key: string) => {
				storage.delete(key);
			}),
			setItem: vi.fn((key: string, value: string) => {
				storage.set(key, value);
			}),
		});
		streamChatMock.mockImplementation(async (_family, _c, _m, h) => {
			h.onError?.(new Error("LLM error"));
		});
		const messages = [
			msg("user", "What is RAG?", "conv-err"),
			msg("assistant", longAnswer, "conv-err"),
		];
		await expect(
			saveQaForConversation(
				"/project",
				{ model: "test" } as never,
				{ provider: "none" } as never,
				messages,
			),
		).rejects.toThrow("LLM error");
		expect(localStorage.getItem("llm-wiki:pendingQa")).toBeNull();
		expect(localStorage.getItem("llm-wiki:pendingQaRetryCounts")).toBeNull();
	});

	it("skips when existing QA has matching title (dedup)", async () => {
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
		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);
		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("duplicate");
	});

	it("skips near-duplicate Chinese operational topics before calling the LLM", async () => {
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

		const result = await saveQaForConversation(
			"/project",
			{ model: "test" } as never,
			{ provider: "none" } as never,
			messages,
		);

		expect(result.ok).toBe(true);
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("duplicate");
		expect(streamChatMock).not.toHaveBeenCalled();
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
