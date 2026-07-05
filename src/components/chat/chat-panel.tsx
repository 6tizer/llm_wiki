import {
	BookOpen,
	Bot,
	Check,
	ChevronDown,
	GitFork,
	Loader2,
	MessageSquare,
	Plus,
	Trash2,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { deleteFile, listDirectory } from "@/commands/fs";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { enqueueAgentStructuralLint } from "@/lib/agent/agent-lint-queue";
import {
	startAgentChatRunJob,
	type AgentChatRunJobController,
} from "@/lib/agent/agent-chat-run-job";
import { isAgentAssistantMessage } from "@/lib/agent/agent-summary";
import {
	cleanupLegacyPendingQaStorage,
	saveQaForConversation,
	shouldExtractQa,
} from "@/lib/agent/agent-qa-hook";
import {
	type AgentErrorKind,
	type AgentRunPhase,
	agentProviderNeedsApiKey,
	agentErrorKindFromError,
	agentRunPhaseI18nKey,
	getAgentPreflightError,
} from "@/lib/agent/agent-run-state";
import { hasAgentRunProfileCandidate, streamAgent } from "@/lib/agent/agent-transport";
import {
	runtimeProfileList,
	type RuntimeProfileList,
	type RuntimeProfileRecord,
} from "@/commands/runtime-db";
import type {
	AgentActionRequiredPayload,
	AgentPermissionPolicy,
	AgentRewindFilesPayload,
	AgentWikiChangedPayload,
} from "@/lib/agent/agent-types";
import { hasConfiguredAnyTxt } from "@/lib/anytxt-search";
import { executeIngestWrites, startIngest } from "@/lib/ingest";
import { streamChat } from "@/lib/llm-client";
import { normalizePath } from "@/lib/path-utils";
import { SOURCE_WATCH_FILE_TYPE_GROUPS } from "@/lib/source-watch-config";
import { buildChatAgentMessages, type ChatAgentEvent } from "@/lib/chat-agent";
import {
	chatMessagesToLLM,
	type DisplayMessage,
	type MessageImage,
	type MessageReference,
	useChatStore,
} from "@/stores/chat-store";
import { useReviewStore } from "@/stores/review-store";
import { useAgentSettingsStore } from "@/stores/agent-settings-store";
import { useWikiStore } from "@/stores/wiki-store";
import { AgentPermissionDialogHost } from "./agent-permission-dialog";
import { AgentRewindDialogHost } from "./agent-rewind-dialog";
import { buildAgentResumeIntentOverrideForConversation } from "./agent-resume-intent";
import {
	classifyAgentPermissionDecision,
	parseAgentProgressSummaryPayload,
} from "./agent-timeline-events";
import { buildAgentTransportOptionsFromState } from "./agent-transport-options";
import {
	agentResultToStats,
	agentToolBatchToRecords,
	agentToolEventToRecord,
	isSdkAssistantMessage,
	isSdkUserMessage,
} from "./agent-stream-integration";
import { ChatInput, type ChatSendOptions } from "./chat-input";
import { ChatMessage, StreamingMessage, useSourceFiles } from "./chat-message";
// Store the page mapping from the last query so SourceFilesBar can show which pages were cited
export let lastQueryPages: { title: string; path: string }[] = [];
const DOCUMENT_DIALOG_EXTENSIONS = [
	...new Set(SOURCE_WATCH_FILE_TYPE_GROUPS.flatMap((group) => group.extensions)),
];

function formatDate(timestamp: number): string {
	const d = new Date(timestamp);
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	if (isToday) {
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function shouldPromptForQaBeforeConversationDelete(
	conversationMessages: DisplayMessage[],
	options: { hasProject: boolean },
): boolean {
	if (!options.hasProject) return false;
	if (!shouldExtractQa(conversationMessages, { trigger: "delete" }).extract) {
		return false;
	}
	return (
		conversationMessages.some(
			(message) => isAgentAssistantMessage(message),
		)
	);
}

const qaSaveInFlightConversationIds = new Set<string>();

function beginQaSaveForConversation(conversationId: string): boolean {
	if (qaSaveInFlightConversationIds.has(conversationId)) return false;
	qaSaveInFlightConversationIds.add(conversationId);
	return true;
}

function finishQaSaveForConversation(conversationId: string): void {
	qaSaveInFlightConversationIds.delete(conversationId);
}

async function refreshAgentFileTree(projectPath?: string): Promise<void> {
	if (!projectPath) return;
	const tree = await listDirectory(projectPath);
	const wikiStore = useWikiStore.getState();
	wikiStore.setFileTree(tree);
	wikiStore.bumpDataVersion();
}

function enqueueAgentLintFromPaths(
	projectPath: string | undefined,
	paths: readonly string[],
): void {
	if (!projectPath || paths.length === 0) return;
	enqueueAgentStructuralLint(projectPath, paths);
}

function changedPathsFromAction(payload: AgentActionRequiredPayload): string[] {
	return payload.kind === "lint_recommended" ? payload.paths : [];
}

function agentWikiOperationLabel(operation: AgentWikiChangedPayload["operation"]): string {
	if (operation === "create") return "创建";
	if (operation === "delete") return "删除";
	return "更新";
}

function addAgentWriteReviewItem(args: {
	payload: AgentWikiChangedPayload;
	conversationId: string;
	messageId: string;
	streamId: string;
}): void {
	const { payload, conversationId, messageId, streamId } = args;
	const label = agentWikiOperationLabel(payload.operation);
	const canUndo = payload.snapshotted === true;
	const reason = canUndo
		? "已保存写前快照，可查看、撤销或接受此写入。"
		: "未保存写前快照，撤销不可用；可查看页面后接受。";
	useReviewStore.getState().addItem({
		type: "agent-write",
		title: `${label} ${payload.path}`,
		description: `Agent ${label}了 ${payload.path}。${reason}`,
		sourcePath: payload.path,
		affectedPages: [payload.path],
		agentWrite: {
			path: payload.path,
			operation: payload.operation,
			conversationId,
			messageId,
			streamId,
			toolUseId: payload.toolUseId,
			snapshotted: canUndo,
			timestamp: Date.now(),
		},
		options: canUndo
			? [
					{ label: "查看页面", action: `open:${payload.path}` },
					{ label: "撤销此写入", action: "__agent_write_undo__" },
					{ label: "接受", action: "__agent_write_accept__" },
				]
			: [
					{ label: "查看页面", action: `open:${payload.path}` },
					{ label: "接受", action: "__agent_write_accept__" },
				],
	});
}

const AGENT_NETWORK_TOOLS = ["WebSearch", "WebFetch"] as const;

function buildAgentTransportOptions(useWebSearch: boolean) {
	const wikiState = useWikiStore.getState();
	const chatState = useChatStore.getState();
	const agentSettings = useAgentSettingsStore.getState();

	return buildAgentTransportOptionsFromState({
		project: wikiState.project,
		llmConfig: wikiState.llmConfig,
		apiConfig: wikiState.apiConfig,
		conversations: chatState.conversations,
		activeConversationId: chatState.activeConversationId,
		resourceConfig: agentSettings.resourceConfig,
		disallowedTools: useWebSearch ? undefined : [...AGENT_NETWORK_TOOLS],
	});
}

function agentRunCandidatesInList(result: RuntimeProfileList): RuntimeProfileRecord[] {
	if (!result.enabled || result.status !== "healthy") return [];
	return result.profiles.filter(hasAgentRunProfileCandidate);
}

function shortProfileId(profileId: string): string {
	return profileId.length <= 10 ? profileId : `${profileId.slice(0, 8)}...`;
}

function ConversationSidebar() {
	const { t } = useTranslation();
	const conversations = useChatStore((s) => s.conversations);
	const activeConversationId = useChatStore((s) => s.activeConversationId);
	const messages = useChatStore((s) => s.messages);
	const createConversation = useChatStore((s) => s.createConversation);
	const deleteConversation = useChatStore((s) => s.deleteConversation);
	const setActiveConversation = useChatStore((s) => s.setActiveConversation);
	const forkAgentConversation = useChatStore((s) => s.forkAgentConversation);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [menu, setMenu] = useState<{
		conversationId: string;
		x: number;
		y: number;
	} | null>(null);
	const [qaDeleteDialog, setQaDeleteDialog] = useState<{
		conversationId: string;
		title: string;
	} | null>(null);
	const [qaDeleteError, setQaDeleteError] = useState<string | null>(null);
	const [qaDeleteBusy, setQaDeleteBusy] = useState(false);
	const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

	function getConversationMessages(convId: string): DisplayMessage[] {
		return messages.filter((m) => m.conversationId === convId);
	}
	function getMessageCount(convId: string): number {
		return getConversationMessages(convId).length;
	}
	function deleteConversationFiles(convId: string): void {
		deleteConversation(convId);
		const proj = useWikiStore.getState().project;
		if (proj) {
			deleteFile(`${proj.path}/.llm-wiki/chats/${convId}.json`).catch(() => {});
		}
	}
	function requestDeleteConversation(convId: string, title: string): void {
		const s = useWikiStore.getState();
		const convMessages = getConversationMessages(convId);
		const shouldPrompt = shouldPromptForQaBeforeConversationDelete(
			convMessages,
			{
				hasProject: Boolean(s.project),
			},
		);
		if (!shouldPrompt) {
			deleteConversationFiles(convId);
			return;
		}
		setQaDeleteError(null);
		setQaDeleteDialog({ conversationId: convId, title });
	}
	async function extractQaThenDelete(): Promise<void> {
		if (!qaDeleteDialog) return;
		const s = useWikiStore.getState();
		if (!s.project) {
			deleteConversationFiles(qaDeleteDialog.conversationId);
			setQaDeleteDialog(null);
			return;
		}
		const convId = qaDeleteDialog.conversationId;
		const msgs = useChatStore
			.getState()
			.messages.filter((m) => m.conversationId === convId);
		if (!beginQaSaveForConversation(convId)) {
			setQaDeleteError(t("chat.qaDelete.saveInProgress"));
			return;
		}
		setQaDeleteBusy(true);
		setQaDeleteError(null);
		try {
			const result = await saveQaForConversation(
				s.project.path,
				s.llmConfig,
				s.searchApiConfig,
				msgs,
				{ trigger: "delete" },
			);
			if (!result.ok) {
				setQaDeleteError(result.error || t("chat.qaDelete.failed"));
				return;
			}
			deleteConversationFiles(convId);
			setQaDeleteDialog(null);
		} catch (err) {
			setQaDeleteError(err instanceof Error ? err.message : String(err));
		} finally {
			finishQaSaveForConversation(convId);
			setQaDeleteBusy(false);
		}
	}
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		window.addEventListener("click", close);
		window.addEventListener("keydown", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", close);
		};
	}, [menu]);
	return (
		<div className="flex h-full w-[200px] flex-shrink-0 flex-col border-r bg-muted/30">
			<div className="border-b p-2">
				<Button
					variant="outline"
					size="sm"
					className="w-full gap-2"
					onClick={() => createConversation()}
				>
					<Plus className="h-3.5 w-3.5" />
					{t("chat.newChat")}
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto py-1">
				{sorted.length === 0 ? (
					<p className="px-3 py-4 text-xs text-muted-foreground text-center">
						{t("chat.noConversationsYet")}
					</p>
				) : (
					sorted.map((conv) => {
						const isActive = conv.id === activeConversationId;
						const msgCount = getMessageCount(conv.id);
						return (
							<div
								key={conv.id}
								className={`group relative mx-1 my-0.5 flex cursor-pointer flex-col rounded-md px-2 py-1.5 text-sm transition-colors ${
									isActive
										? "bg-primary/10 text-primary"
										: "hover:bg-accent text-foreground"
								}`}
								onClick={() => {
									setActiveConversation(conv.id);
								}}
								onContextMenu={(event) => {
									event.preventDefault();
									setMenu({
										conversationId: conv.id,
										x: event.clientX,
										y: event.clientY,
									});
								}}
								onMouseEnter={() => setHoveredId(conv.id)}
								onMouseLeave={() => setHoveredId(null)}
							>
								<div className="flex items-start justify-between gap-1">
									<span className="line-clamp-2 flex-1 text-xs font-medium leading-snug">
										{conv.title}
									</span>
									{hoveredId === conv.id && (
										<button
											className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
											onClick={(e) => {
												e.stopPropagation();
												requestDeleteConversation(conv.id, conv.title);
											}}
										>
											<Trash2 className="h-3 w-3" />
										</button>
									)}
								</div>
								<div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
									<span>{formatDate(conv.updatedAt)}</span>
									{msgCount > 0 && (
										<>
											<span>·</span>
											<span>
												{msgCount} {t("chat.msgCount")}
											</span>
										</>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>
			{menu && (
				<div
					className="fixed z-50 min-w-36 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
					style={{ left: menu.x, top: menu.y }}
					onClick={(event) => event.stopPropagation()}
				>
					<button
						type="button"
						disabled={
							!conversations.find((conv) => conv.id === menu.conversationId)
								?.agentSessionId
						}
						className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
						onClick={() => {
							forkAgentConversation(menu.conversationId);
							setMenu(null);
						}}
					>
						<GitFork className="h-3.5 w-3.5" />
						{t("agent.session.fork")}
					</button>
				</div>
			)}
			<Dialog
				open={Boolean(qaDeleteDialog)}
				onOpenChange={(open) => {
					if (!open && !qaDeleteBusy) setQaDeleteDialog(null);
				}}
			>
				<DialogContent
					className="w-[calc(100vw-2rem)] max-w-md"
					showCloseButton={!qaDeleteBusy}
				>
					<DialogHeader>
						<DialogTitle>{t("chat.qaDelete.title")}</DialogTitle>
						<DialogDescription>
							{t("chat.qaDelete.description", {
								title: qaDeleteDialog?.title || "",
							})}
						</DialogDescription>
					</DialogHeader>
					{qaDeleteError && (
						<p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
							{t("chat.qaDelete.failedWithError", { error: qaDeleteError })}
						</p>
					)}
					<DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
						<Button
							type="button"
							variant="outline"
							disabled={qaDeleteBusy}
							onClick={() => setQaDeleteDialog(null)}
						>
							{t("chat.qaDelete.cancel")}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={qaDeleteBusy}
							onClick={() => {
								if (!qaDeleteDialog) return;
								deleteConversationFiles(qaDeleteDialog.conversationId);
								setQaDeleteDialog(null);
							}}
						>
							{t("chat.qaDelete.deleteWithoutQa")}
						</Button>
						<Button
							type="button"
							disabled={qaDeleteBusy}
							onClick={() => {
								void extractQaThenDelete();
							}}
						>
							{qaDeleteBusy
								? t("chat.qaDelete.extracting")
								: t("chat.qaDelete.extractAndDelete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
export function ChatPanel() {
	const { t } = useTranslation();
	useSourceFiles(); // Keep source file cache warm
	const activeConversationId = useChatStore((s) => s.activeConversationId);
	const isStreaming = useChatStore((s) => s.isStreaming);
	const agentRewindLocks = useChatStore((s) => s.agentRewindLocks);
	// SPEC-7 PR2 matrix A6: a rewind orchestration in progress for the active
	// conversation must block new sends the same way an active stream does —
	// isStreaming alone can't express a per-conversation rewind lock.
	const activeConversationRewindLocked = Boolean(
		activeConversationId && agentRewindLocks[activeConversationId],
	);
	const streamingContent = useChatStore((s) => s.streamingContent);
	const streamingConversationId = useChatStore((s) => s.streamingConversationId);
	const streamingAgentMessageId = useChatStore((s) => s.streamingAgentMessageId);
	const ingestSource = useChatStore((s) => s.ingestSource);
	const activeRunModelByConversation = useChatStore(
		(s) => s.activeRunModelByConversation,
	);
	const activeRunProfileByConversation = useChatStore(
		(s) => s.activeRunProfileByConversation,
	);
	const conversations = useChatStore((s) => s.conversations);
	const addMessage = useChatStore((s) => s.addMessage);
	const setStreaming = useChatStore((s) => s.setStreaming);
	const appendStreamToken = useChatStore((s) => s.appendStreamToken);
	const finalizeStream = useChatStore((s) => s.finalizeStream);
	const setActiveRunModel = useChatStore((s) => s.setActiveRunModel);
	const setActiveRunProfile = useChatStore((s) => s.setActiveRunProfile);
	const setConversationAgentProfileOverride = useChatStore(
		(s) => s.setConversationAgentProfileOverride,
	);
	const setConversationAgentPermissionPolicyOverride = useChatStore(
		(s) => s.setConversationAgentPermissionPolicyOverride,
	);
	const createConversation = useChatStore((s) => s.createConversation);
	const removeLastAssistantMessage = useChatStore(
		(s) => s.removeLastAssistantMessage,
	);
	const maxHistoryMessages = useChatStore((s) => s.maxHistoryMessages);
	const startAgentStreamMessage = useChatStore(
		(s) => s.startAgentStreamMessage,
	);
	const updateAgentStreamMessage = useChatStore(
		(s) => s.updateAgentStreamMessage,
	);
	const finishAgentStreamMessage = useChatStore(
		(s) => s.finishAgentStreamMessage,
	);
	const updateAgentProgress = useChatStore((s) => s.updateAgentProgress);
	const appendAgentProgressSummary = useChatStore(
		(s) => s.appendAgentProgressSummary,
	);
	const appendAgentPermissionEvent = useChatStore(
		(s) => s.appendAgentPermissionEvent,
	);
	const appendAgentWikiChange = useChatStore((s) => s.appendAgentWikiChange);
	const markAgentMessageRewindable = useChatStore(
		(s) => s.markAgentMessageRewindable,
	);
	const clearAgentMessageRewindable = useChatStore(
		(s) => s.clearAgentMessageRewindable,
	);
	const requestAgentRewind = useChatStore((s) => s.requestAgentRewind);
	const requestAgentPermission = useChatStore((s) => s.requestAgentPermission);
	const clearAgentPermissionRequestsForConversation = useChatStore(
		(s) => s.clearAgentPermissionRequestsForConversation,
	);
	const agentRewindTargets = useChatStore((s) => s.agentRewindTargets);
	const agentResourceConfig = useAgentSettingsStore((s) => s.resourceConfig);
	// Derive active messages via selector to re-render on message changes
	const allMessages = useChatStore((s) => s.messages);
	const activeMessages = activeConversationId
		? allMessages.filter((m) => m.conversationId === activeConversationId)
		: [];
	const project = useWikiStore((s) => s.project);
	const llmConfig = useWikiStore((s) => s.llmConfig);
	const searchApiConfig = useWikiStore((s) => s.searchApiConfig);
	const anyTxtAvailable = hasConfiguredAnyTxt(searchApiConfig.anyTxt);
	const setFileTree = useWikiStore((s) => s.setFileTree);
	const setActiveView = useWikiStore((s) => s.setActiveView);
	const abortRef = useRef<AbortController | null>(null);
	const agentRunJobRef = useRef<AgentChatRunJobController | null>(null);
	// Abort any in-flight agent/LLM stream on unmount to prevent stale callbacks
	useEffect(() => {
		return () => {
			agentRunJobRef.current?.cancel("unmount");
			agentRunJobRef.current = null;
			abortRef.current?.abort();
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		runtimeProfileList()
			.then((result) => {
				if (cancelled) return;
				const candidates = agentRunCandidatesInList(result);
				setAgentRunProfileCandidates(candidates);
				setHasAgentRunCandidate(candidates.length > 0);
				setAgentRunCandidateResolved(true);
			})
			.catch(() => {
				if (!cancelled) {
					setAgentRunProfileCandidates([]);
					setHasAgentRunCandidate(false);
					setAgentRunCandidateResolved(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [agentRunPhase, setAgentRunPhase] = useState<AgentRunPhase>("idle");
	const [chatAgentEvents, setChatAgentEvents] = useState<ChatAgentEvent[]>([]);
	const [manualQaBusy, setManualQaBusy] = useState(false);
	const [hasAgentRunCandidate, setHasAgentRunCandidate] = useState(false);
	const [agentRunProfileCandidates, setAgentRunProfileCandidates] = useState<
		RuntimeProfileRecord[]
	>([]);
	const [agentRunCandidateResolved, setAgentRunCandidateResolved] =
		useState(false);
	const [agentRouteMenuOpen, setAgentRouteMenuOpen] = useState(false);
	const agentRouteMenuRef = useRef<HTMLDivElement>(null);
	const [manualQaStatus, setManualQaStatus] = useState<{
		kind: "success" | "error" | "skipped";
		message: string;
	} | null>(null);
	useEffect(() => {
		if (!agentRouteMenuOpen) return;
		const close = (event: MouseEvent | KeyboardEvent) => {
			if (
				event instanceof MouseEvent &&
				agentRouteMenuRef.current?.contains(event.target as Node)
			) {
				return;
			}
			setAgentRouteMenuOpen(false);
		};
		window.addEventListener("click", close);
		window.addEventListener("keydown", close);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", close);
		};
	}, [agentRouteMenuOpen]);
	// Auto-scroll to bottom when messages change or streaming content updates
	useEffect(() => {
		const container = scrollContainerRef.current;
		if (container) {
			container.scrollTop = container.scrollHeight;
		}
	}, [activeMessages, streamingContent]);

	// Startup: clear legacy automatic QA queue keys from older builds.
	useEffect(() => {
		cleanupLegacyPendingQaStorage();
	}, []);

	const handleAgentSend = useCallback(
		async (
			text: string,
			options: ChatSendOptions = {
				useWebSearch: false,
				useAnyTxtSearch: false,
			},
		) => {
			let convId = useChatStore.getState().activeConversationId;
			if (!convId) {
				convId = createConversation();
			}

			if (useChatStore.getState().agentRewindLocks[convId]) {
				// A6: a rewind orchestration is in progress for this conversation.
				console.warn(
					"[agent] send blocked — a rewind is in progress for this conversation",
				);
				return;
			}

			const activeConversation = useChatStore
				.getState()
				.conversations.find((conversation) => conversation.id === convId);
			const agentSessionId = activeConversation?.agentSessionId;
			const intentOverride = buildAgentResumeIntentOverrideForConversation({
				messages: useChatStore.getState().messages,
				conversationId: convId,
				resumeSessionId: agentSessionId,
				latestUserText: text,
			});
			addMessage("user", text, {
				agentSessionId,
			});

			const messageId = startAgentStreamMessage({ agentSessionId });
			if (!messageId) return;

			let accumulated = "";
			let settled = false;
			let streamId: string | undefined;
			let sawSessionCompact = false;
			let runJob: AgentChatRunJobController | null = null;

			const finishAgentError = (kind: AgentErrorKind, detail?: string) => {
				if (settled) return;
				settled = true;
				const finishesCurrent =
					useChatStore.getState().streamingAgentMessageId === messageId;
				// SPEC-7 PR2 (fixes #60): do NOT clear the rewind target here.
				// Rewind must remain available after the turn ends (error or
				// success) — that's the whole point of the resume-only-for-rewind
				// path (agent_rewind_session). Only an actually-unavailable rewind
				// (sidecar/session gone) clears the target, via onRewindFiles'
				// unavailableReason handling below.
				finishAgentStreamMessage(
					messageId,
					"",
					undefined,
					{
						agentErrorKind: kind,
						agentErrorDetail: detail,
					},
				);
				if (finishesCurrent) {
					abortRef.current = null;
					if (agentRunJobRef.current === runJob) {
						agentRunJobRef.current = null;
					}
					setAgentRunPhase("idle");
				}
			};

			const preflightError = getAgentPreflightError(project, llmConfig, {
				deferApiKeyCheck: true,
			});
			if (preflightError) {
				finishAgentError(preflightError);
				return;
			}

			const transportOptions = buildAgentTransportOptions(options.useWebSearch);
			if (!transportOptions) {
				finishAgentError("unavailable");
				return;
			}
			if (intentOverride) {
				transportOptions.intentOverride = intentOverride;
			}

			const controller = new AbortController();
			abortRef.current = controller;
			setAgentRunPhase("connecting");

			const finishAgentMessage = (
				content: string,
				stats = agentResultToStats(null),
			) => {
				if (settled) return;
				settled = true;
				const finishesCurrent =
					useChatStore.getState().streamingAgentMessageId === messageId;
				// SPEC-7 PR2 (fixes #60): see comment in finishAgentError — the
				// rewind target must survive normal completion too.
				finishAgentStreamMessage(messageId, content, stats);
				if (finishesCurrent) {
					abortRef.current = null;
					if (agentRunJobRef.current === runJob) {
						agentRunJobRef.current = null;
					}
					setAgentRunPhase("idle");
				}
			};

				const markAgentRunning = () => {
					setAgentRunPhase((phase) => (phase === "idle" ? phase : "running"));
				};
				const heartbeatRunJob = () => {
					const job = runJob;
					if (job) job.heartbeat();
				};
				const completeRunJob = () => {
					const job = runJob;
					if (job) job.complete();
				};
				const failRunJob = (error: unknown) => {
					const job = runJob;
					if (job) job.fail(error);
				};

				try {
				await streamAgent(
					text,
					transportOptions,
					{
						onStreamStart: (id) => {
							streamId = id;
							runJob = startAgentChatRunJob({
								conversationId: convId,
								streamId: id,
								title: text,
							});
							agentRunJobRef.current = runJob;
							},
							onToken: (token) => {
								markAgentRunning();
								heartbeatRunJob();
								accumulated += token;
								updateAgentStreamMessage(messageId, { content: accumulated });
							},
							onMessage: (message) => {
								markAgentRunning();
								heartbeatRunJob();
							if (isSdkUserMessage(message) && message.uuid) {
								markAgentMessageRewindable(messageId, {
									streamId,
									agentSessionId: message.session_id,
									userMessageId: message.uuid,
								});
								return;
							}
							if (!isSdkAssistantMessage(message)) return;
							setActiveRunModel(convId, message.message.model ?? null);
							updateAgentStreamMessage(messageId, {
								agentBlocks: message.message.content,
							});
							markAgentMessageRewindable(messageId, {
								streamId,
								agentSessionId: message.session_id,
								assistantMessageId: message.uuid,
							});
							},
							onProfileResolved: (payload) => {
								markAgentRunning();
								setActiveRunProfile(convId, payload);
							},
							onDone: (result) => {
								markAgentRunning();
								completeRunJob();
								const stats = agentResultToStats(result);
							const finalContent =
								accumulated || (sawSessionCompact ? "" : result?.result || "");
							finishAgentMessage(finalContent, stats);
							},
							onError: (err) => {
								failRunJob(err);
								const kind = agentErrorKindFromError(err);
							finishAgentError(kind, err.message);
						},
						onToolEvent: (event) => {
							markAgentRunning();
							if (event.phase === "batch") {
								// SPEC-7 PR2 matrix A16: this used to call
								// setAgentToolCalls(messageId, records), which REPLACES
								// the message's whole toolCalls array — wiki-write calls
								// recorded by an earlier batch/event within the same
								// assistant message were silently dropped, which made the
								// rewind fail-closed gate (A2/A17) blind to them. Merge
								// each batch record through the same per-call dedupe
								// updateAgentProgress already uses instead.
								for (const record of agentToolBatchToRecords(event)) {
									updateAgentProgress(messageId, record);
								}
								return;
							}
							updateAgentProgress(messageId, agentToolEventToRecord(event));
						},
						onPermissionRequest: (payload) => {
							markAgentRunning();
							return requestAgentPermission({
								...payload,
								streamId,
								conversationId: convId,
							}).then((decision) => {
								appendAgentPermissionEvent(messageId, {
									toolName: payload.toolName,
									decision: classifyAgentPermissionDecision(
										decision,
										t("agent.permission.timeoutDenied"),
									),
									timestamp: Date.now(),
									...(transportOptions.permissionPolicy
										? { permissionPolicy: transportOptions.permissionPolicy }
										: {}),
								});
								return decision;
							});
						},
						onAgentProgressSummary: (payload) => {
							markAgentRunning();
							for (const summary of parseAgentProgressSummaryPayload(payload)) {
								appendAgentProgressSummary(messageId, summary);
							}
						},
						onWikiChanged: (payload) => {
							markAgentRunning();
							appendAgentWikiChange(messageId, payload);
							addAgentWriteReviewItem({
								payload,
								conversationId: convId,
								messageId,
								streamId: streamId ?? "",
							});
							const projectPath =
								transportOptions.projectPath ?? transportOptions.cwd ?? project?.path;
							refreshAgentFileTree(projectPath).catch((err) => {
								console.warn("[agent] failed to refresh file tree:", err);
							});
						},
						onAgentSummary: (payload) => {
							console.debug("[agent] summary:", payload);
						},
						onSessionCompact: () => {
							markAgentRunning();
							sawSessionCompact = true;
							updateAgentStreamMessage(messageId, {
								sessionCompact: true,
							});
						},
						onActionRequired: (payload) => {
							markAgentRunning();
							if (payload.kind === "resource_limit") {
								updateAgentStreamMessage(messageId, {
									agentResourceLimit: payload,
								});
								return;
							}
							const paths = changedPathsFromAction(payload);
							enqueueAgentLintFromPaths(
								transportOptions.projectPath ?? transportOptions.cwd ?? project?.path,
								paths,
							);
						},
						onRewindFiles: (payload: AgentRewindFilesPayload) => {
							markAgentRunning();
							if (!payload.ok) {
								console.warn("[agent] rewind failed:", payload.error);
								if (payload.unavailableReason) {
									clearAgentMessageRewindable(messageId);
								}
								return;
							}
							const paths = payload.result?.filesChanged ?? [];
							const projectPath =
								transportOptions.projectPath ?? transportOptions.cwd ?? project?.path;
							enqueueAgentLintFromPaths(projectPath, paths);
							refreshAgentFileTree(projectPath).catch((err) => {
								console.warn(
									"[agent] failed to refresh file tree after rewind:",
									err,
								);
							});
						},
					},
					controller.signal,
				);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					failRunJob(err);
					const kind = agentErrorKindFromError(err);
				finishAgentError(kind, message);
			}
		},
		[
			addMessage,
			appendAgentPermissionEvent,
			appendAgentProgressSummary,
			appendAgentWikiChange,
			clearAgentMessageRewindable,
			createConversation,
			finishAgentStreamMessage,
			llmConfig,
			markAgentMessageRewindable,
			project,
			requestAgentPermission,
			setActiveRunProfile,
			setActiveRunModel,
			startAgentStreamMessage,
			t,
			updateAgentProgress,
			updateAgentStreamMessage,
		],
	);

	const handleManualSaveQa = useCallback(async () => {
		if (!project) {
			setManualQaStatus({
				kind: "error",
				message: t("chat.qaSave.noProject"),
			});
			return;
		}
		const convId = useChatStore.getState().activeConversationId;
		if (!convId) {
			setManualQaStatus({
				kind: "error",
				message: t("chat.qaSave.noConversation"),
			});
			return;
		}
		const msgs = useChatStore
			.getState()
			.messages.filter((m) => m.conversationId === convId);
		if (!beginQaSaveForConversation(convId)) {
			setManualQaStatus({
				kind: "skipped",
				message: t("chat.qaSave.saveInProgress"),
			});
			return;
		}
		setManualQaBusy(true);
		setManualQaStatus(null);
		try {
			const result = await saveQaForConversation(
				project.path,
				llmConfig,
				searchApiConfig,
				msgs,
				{ trigger: "manual" },
			);
			if (!result.ok) {
				setManualQaStatus({
					kind: "error",
					message: result.error || t("chat.qaSave.failed"),
				});
				return;
			}
			if (result.skipped) {
				setManualQaStatus({
					kind: "skipped",
					message: t("chat.qaSave.skipped"),
				});
				return;
			}
			setManualQaStatus({
				kind: "success",
				message: t("chat.qaSave.saved"),
			});
		} catch (err) {
			setManualQaStatus({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			finishQaSaveForConversation(convId);
			setManualQaBusy(false);
		}
	}, [llmConfig, project, searchApiConfig, t]);

	const handleSend = useCallback(
		async (
			text: string,
			images: MessageImage[] = [],
			options: ChatSendOptions = {
				useWebSearch: false,
				useAnyTxtSearch: false,
			},
		) => {
			if (text.trim() === "/save-qa") {
				await handleManualSaveQa();
				return;
			}
			setManualQaStatus(null);
			const hasImages = images.length > 0;
			let canDeferApiKeyCheck = hasAgentRunCandidate;
			if (
				!canDeferApiKeyCheck &&
				!agentRunCandidateResolved &&
				agentProviderNeedsApiKey(llmConfig.provider) &&
				!llmConfig.apiKey.trim()
			) {
				try {
					const result = await runtimeProfileList();
					const candidates = agentRunCandidatesInList(result);
					canDeferApiKeyCheck = candidates.length > 0;
					setAgentRunProfileCandidates(candidates);
					setHasAgentRunCandidate(canDeferApiKeyCheck);
					setAgentRunCandidateResolved(true);
				} catch {
					setAgentRunProfileCandidates([]);
					canDeferApiKeyCheck = false;
					setHasAgentRunCandidate(false);
					setAgentRunCandidateResolved(true);
				}
			}
			const preflightError = getAgentPreflightError(project, llmConfig, {
				deferApiKeyCheck: canDeferApiKeyCheck,
			});
			if (ingestSource === null && !hasImages && !preflightError) {
				await handleAgentSend(text, options);
				return;
			}

			// Auto-create a conversation if none is active
			let convId = useChatStore.getState().activeConversationId;
			if (!convId) {
				convId = createConversation();
			}
			addMessage("user", text, {
				images,
				chatOptions: options,
			});
			setStreaming(true);
			try {
				setChatAgentEvents([]);
				const controller = new AbortController();
				abortRef.current = controller;
				const activeConvMessages = useChatStore
					.getState()
					.getActiveMessages()
					.filter((m) => m.role === "user" || m.role === "assistant")
					.slice(-maxHistoryMessages);
				const historyMessages = chatMessagesToLLM(activeConvMessages);
				const retrievalHistory = collectRecentRetrievalHistory(activeConvMessages);
				const agentResult = await buildChatAgentMessages({
					project: project ? { name: project.name, path: project.path } : null,
					llmConfig,
					searchApiConfig,
					text,
					historyMessages,
					retrievalHistory,
					dataVersion: useWikiStore.getState().dataVersion,
					options,
					signal: controller.signal,
					onEvent: (event) => {
						setChatAgentEvents((prev) => [...prev, event].slice(-6));
					},
				});
				lastQueryPages = agentResult.queryPages;

				let accumulated = "";
				let thinkingOpen = false;
				const appendReasoning = (token: string) => {
					if (!token) return;
					if (!thinkingOpen) {
						thinkingOpen = true;
						accumulated += "<think>";
						appendStreamToken("<think>");
					}
					accumulated += token;
					appendStreamToken(token);
				};
				const closeReasoning = () => {
					if (!thinkingOpen) return;
					thinkingOpen = false;
					accumulated += "</think>";
					appendStreamToken("</think>");
				};
				const streamFinalAnswer = async (reasoningOff: boolean) => {
					let streamError: Error | null = null;
					await streamChat(
						llmConfig,
						agentResult.messages,
						{
							onToken: (token) => {
								closeReasoning();
								accumulated += token;
								appendStreamToken(token);
							},
							onReasoningToken: (token) => {
								if (!reasoningOff) appendReasoning(token);
							},
							onDone: () => {},
							onError: (err) => {
								streamError = err;
							},
						},
						controller.signal,
						reasoningOff ? { reasoning: { mode: "off" } } : undefined,
					);
					if (streamError) throw streamError;
				};
				try {
					await streamFinalAnswer(false);
				} catch (err) {
					if (!isReasoningOnlyResponseError(err)) throw err;
					accumulated = "";
					thinkingOpen = false;
					useChatStore.setState({ streamingContent: "" });
					await streamFinalAnswer(true);
				}
				closeReasoning();
				finalizeStream(accumulated, agentResult.references, convId, agentResult.steps);
				setChatAgentEvents([]);
				abortRef.current = null;
			} catch (err) {
				setChatAgentEvents([]);
				abortRef.current = null;
				if (isAbortLikeError(err)) {
					useChatStore.setState({
						isStreaming: false,
						streamingConversationId: null,
						streamingAgentMessageId: null,
						streamingContent: "",
					});
				} else {
					const message = err instanceof Error ? err.message : String(err);
					finalizeStream(`Error: ${message}`, undefined, convId);
				}
			}
			return;
		},
		[
			agentRunCandidateResolved,
			hasAgentRunCandidate,
			handleAgentSend,
			handleManualSaveQa,
			ingestSource,
			llmConfig,
			searchApiConfig,
			project,
			addMessage,
			setStreaming,
			appendStreamToken,
			finalizeStream,
			createConversation,
			maxHistoryMessages,
		],
	);
	const handleStop = useCallback(() => {
		const streamingConversationId =
			useChatStore.getState().streamingConversationId;
		agentRunJobRef.current?.cancel("stopped");
		agentRunJobRef.current = null;
		abortRef.current?.abort();
		abortRef.current = null;
		setAgentRunPhase("idle");
		setChatAgentEvents([]);
		setStreaming(false);
		if (streamingConversationId) {
			clearAgentPermissionRequestsForConversation(streamingConversationId, {
				behavior: "deny",
				interrupt: true,
				message: t("agent.permission.stopped"),
				decisionClassification: "user_reject",
			});
		}
	}, [clearAgentPermissionRequestsForConversation, setStreaming, t]);
	const handleDocumentDiscussion = useCallback(async (sourcePath: string) => {
		if (!project || isStreaming) return;
		const controller = new AbortController();
		abortRef.current = controller;
		setActiveView("wiki");
		try {
			await startIngest(project.path, sourcePath, llmConfig, controller.signal);
		} catch (err) {
			if (!isAbortLikeError(err)) {
				console.error("Failed to start document discussion:", err);
			}
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
			}
		}
	}, [isStreaming, llmConfig, project, setActiveView]);
	const handlePickDocument = useCallback(async () => {
		if (!project || isStreaming) return;
		const selected = await open({
			multiple: false,
			title: t("chat.attachDocument"),
			filters: [
				{
					name: "Documents",
					extensions: DOCUMENT_DIALOG_EXTENSIONS,
				},
			],
		});
		if (!selected || typeof selected !== "string") return;
		await handleDocumentDiscussion(selected);
	}, [handleDocumentDiscussion, isStreaming, project, t]);
	const handleDropDocuments = useCallback((paths: string[]) => {
		const [sourcePath] = paths;
		if (!sourcePath) return;
		void handleDocumentDiscussion(sourcePath);
	}, [handleDocumentDiscussion]);
	const handleRegenerate = useCallback(async () => {
		if (isStreaming) return;
		// Find the last user message in active conversation
		const active = useChatStore.getState().getActiveMessages();
		const lastUserMsg = [...active].reverse().find((m) => m.role === "user");
		if (!lastUserMsg) return;
		// Remove the last assistant reply, then re-send
		removeLastAssistantMessage();
		// Small delay to let state update
		await new Promise((r) => setTimeout(r, 50));
		// Trigger send with the same text (handleSend will add a new user message,
		// so also remove the original to avoid duplication)
		// Actually: just call handleSend — but it adds a user message. To avoid dupe,
		// we remove the last user message too and let handleSend re-add it.
		const store = useChatStore.getState();
		const updatedActive = store.getActiveMessages();
		const lastUser = [...updatedActive]
			.reverse()
			.find((m) => m.role === "user");
		if (lastUser) {
			useChatStore.setState((s) => ({
				messages: s.messages.filter((m) => m.id !== lastUser.id),
			}));
		}
		const chatOptions = lastUserMsg.chatOptions
			? {
					useWebSearch: lastUserMsg.chatOptions.useWebSearch,
					useAnyTxtSearch: lastUserMsg.chatOptions.useAnyTxtSearch,
				}
			: undefined;
		handleSend(lastUserMsg.content, lastUserMsg.images ?? [], chatOptions);
	}, [isStreaming, removeLastAssistantMessage, handleSend]);
	const handleWriteToWiki = useCallback(async () => {
		if (!project) return;
		const pp = normalizePath(project.path);
		try {
			await executeIngestWrites(pp, llmConfig, undefined, undefined);
			try {
				const tree = await listDirectory(pp);
				setFileTree(tree);
			} catch {
				// ignore
			}
		} catch (err) {
			console.error("Failed to write to wiki:", err);
		}
	}, [project, llmConfig, setFileTree]);
	const isActiveAgentStream =
		isStreaming &&
		streamingConversationId === activeConversationId &&
		Boolean(streamingAgentMessageId);
	const agentStatusKey = isActiveAgentStream
		? agentRunPhaseI18nKey(agentRunPhase)
		: null;
	const hasAssistantMessages = activeMessages.some(
		(m) => m.role === "assistant",
	);
	const showWriteButton =
		ingestSource !== null && !isStreaming && hasAssistantMessages;
	const activeConversation = conversations.find(
		(conversation) => conversation.id === activeConversationId,
	);
	const activeRunProfile = activeConversationId
		? activeRunProfileByConversation[activeConversationId] ?? null
		: null;
	const resolvedProfileRecord = activeRunProfile
		? agentRunProfileCandidates.find(
				(profile) => profile.profileId === activeRunProfile.profileId,
			)
		: undefined;
	const activeRunModel = activeConversationId
		? activeRunModelByConversation[activeConversationId]
		: null;
	const modelIndicator = activeRunProfile
		? (resolvedProfileRecord?.displayName ?? shortProfileId(activeRunProfile.profileId))
		: (activeRunModel ?? t("chat.modelAuto"));
	const selectedProfileId = activeConversation?.agentProfileIdOverride;
	const selectedPermissionPolicy =
		activeConversation?.agentPermissionPolicyOverride ??
		agentResourceConfig.defaultPermissionPolicy ??
		"default";
	const showPermissionPolicyBadge = selectedPermissionPolicy !== "default";
	const permissionPolicyBadgeClass =
		selectedPermissionPolicy === "bypassPermissions"
			? "bg-destructive/10 text-destructive ring-destructive/20"
			: "bg-muted text-muted-foreground ring-border";
	const setProfileOverride = (profileId: string | undefined) => {
		if (!activeConversationId || isActiveAgentStream) return;
		setConversationAgentProfileOverride(activeConversationId, profileId);
		setAgentRouteMenuOpen(false);
	};
	const setPolicyOverride = (policy: AgentPermissionPolicy | undefined) => {
		if (!activeConversationId || isActiveAgentStream) return;
		setConversationAgentPermissionPolicyOverride(activeConversationId, policy);
		setAgentRouteMenuOpen(false);
	};
	const emptySuggestionKeys = [
		"chat.emptySuggestions.brokenLinks",
		"chat.emptySuggestions.recentSources",
		"chat.emptySuggestions.topicOverview",
		"chat.emptySuggestions.findGaps",
	];
	return (
		<div className="flex h-full flex-row overflow-hidden">
			<AgentPermissionDialogHost />
			<AgentRewindDialogHost />
			<ConversationSidebar />
			<div className="flex flex-1 flex-col overflow-hidden">
				{!activeConversationId ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">
						<div className="text-center">
							<MessageSquare className="mx-auto mb-3 h-8 w-8 opacity-30" />
							<p className="text-sm">{t("chat.startNewConversation")}</p>
							<p className="mt-1 text-xs opacity-60">
								{t("chat.clickNewChatToBegin")}
							</p>
						</div>
					</div>
				) : (
					<>
						<div
							ref={scrollContainerRef}
							className="flex-1 overflow-y-auto px-3 py-2"
						>
							<div className="flex flex-col gap-3">
								{activeMessages.length === 0 && (
									<div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-2 py-6 sm:grid-cols-2">
										{emptySuggestionKeys.map((key) => {
											const label = t(key);
											return (
												<button
													key={key}
													type="button"
													onClick={() =>
														void handleSend(label, [], {
															useWebSearch: false,
															useAnyTxtSearch: false,
														})
													}
													disabled={isStreaming || activeConversationRewindLocked}
													className="rounded-md border border-border bg-background p-3 text-left text-sm leading-5 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
												>
													{label}
												</button>
											);
										})}
									</div>
								)}
								{activeMessages.map((msg, idx) => {
									// Check if this is the last assistant message
									const isLastAssistant =
										msg.role === "assistant" &&
										!activeMessages
											.slice(idx + 1)
											.some((m) => m.role === "assistant");
									return (
										<ChatMessage
											key={msg.id}
											message={msg}
											isLastAssistant={isLastAssistant && !isStreaming}
											onRegenerate={
												isLastAssistant ? handleRegenerate : undefined
											}
											canRewind={Boolean(agentRewindTargets[msg.id])}
											onRewind={requestAgentRewind}
										/>
									);
								})}
								{isStreaming && !streamingAgentMessageId && (
									<StreamingMessage
										content={streamingContent}
										agentEvents={chatAgentEvents}
									/>
								)}
								<div ref={bottomRef} />
							</div>
						</div>
						{showWriteButton && (
							<div className="border-t px-3 py-2">
								<Button
									variant="outline"
									size="sm"
									onClick={handleWriteToWiki}
									className="w-full gap-2"
								>
									<BookOpen className="h-4 w-4" />
									{t("chat.writeToWiki")}
								</Button>
							</div>
						)}
					</>
				)}
				<div className="border-t bg-muted/20 px-3 py-2">
					<div className="flex items-center justify-end">
						<div ref={agentRouteMenuRef} className="relative">
							<button
								type="button"
								disabled={!activeConversationId || isActiveAgentStream}
								onClick={(event) => {
									event.stopPropagation();
									setAgentRouteMenuOpen((open) => !open);
								}}
								className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
								title={t("chat.modelIndicator")}
							>
								<Bot className="h-3.5 w-3.5" />
								<span className="truncate">{modelIndicator}</span>
								{showPermissionPolicyBadge && (
									<span
										className={`inline-flex max-w-32 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${permissionPolicyBadgeClass}`}
									>
										{t(
											`chat.agentRouting.policyOptions.${selectedPermissionPolicy}.label`,
										)}
									</span>
								)}
								<ChevronDown className="h-3.5 w-3.5" />
							</button>
							{agentRouteMenuOpen && !isActiveAgentStream && (
								<div className="absolute bottom-9 right-0 z-50 w-80 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-lg">
									<div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase text-muted-foreground">
										{t("chat.agentRouting.profile")}
									</div>
									<button
										type="button"
										onClick={() => setProfileOverride(undefined)}
										className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-accent ${
											!selectedProfileId ? "bg-accent text-accent-foreground" : ""
										}`}
									>
										<span>{t("chat.agentRouting.profileAuto")}</span>
										{!selectedProfileId && <Check className="h-3 w-3" />}
									</button>
									{agentRunProfileCandidates.map((profile) => (
										<button
											key={profile.profileId}
											type="button"
											onClick={() => setProfileOverride(profile.profileId)}
											className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent ${
												selectedProfileId === profile.profileId
													? "bg-accent text-accent-foreground"
													: ""
											}`}
										>
											<span className="min-w-0 truncate">{profile.displayName}</span>
											{selectedProfileId === profile.profileId && (
												<Check className="h-3 w-3 shrink-0" />
											)}
										</button>
									))}
									<div className="mt-2 border-t border-border pt-2">
										<div className="px-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground">
											{t("chat.agentRouting.policy")}
										</div>
										{(["default", "restricted", "bypassPermissions"] as const).map((policy) => (
											<button
												key={policy}
												type="button"
												onClick={() => setPolicyOverride(policy)}
												className={`flex w-full items-start justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent ${
													selectedPermissionPolicy === policy
														? "bg-accent text-accent-foreground"
														: ""
												}`}
											>
												<span className="min-w-0">
													<span className="block font-medium">
														{t(`chat.agentRouting.policyOptions.${policy}.label`)}
													</span>
													<span className="block text-[10px] text-muted-foreground">
														{t(`chat.agentRouting.policyOptions.${policy}.description`)}
													</span>
												</span>
												{selectedPermissionPolicy === policy && (
													<Check className="h-3 w-3 shrink-0" />
												)}
											</button>
										))}
									</div>
								</div>
							)}
						</div>
					</div>
				</div>
				{agentStatusKey && (
					<div className="border-t bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
						<div className="flex items-center gap-2">
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							<span>{t(agentStatusKey)}</span>
						</div>
					</div>
				)}
				{activeConversationId && ingestSource === null && (
					<div className="border-t bg-muted/10 px-3 py-2">
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => void handleManualSaveQa()}
								disabled={!project || manualQaBusy || isStreaming}
								className="gap-2"
							>
								{manualQaBusy ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<BookOpen className="h-3.5 w-3.5" />
								)}
								{manualQaBusy ? t("chat.qaSave.saving") : t("chat.qaSave.button")}
							</Button>
							{manualQaStatus && (
								<span
									className={`text-xs ${
										manualQaStatus.kind === "error"
											? "text-destructive"
											: manualQaStatus.kind === "success"
												? "text-emerald-600"
												: "text-muted-foreground"
									}`}
								>
									{manualQaStatus.message}
								</span>
							)}
						</div>
					</div>
				)}
				<ChatInput
					onSend={handleSend}
					onStop={handleStop}
					isStreaming={isStreaming || activeConversationRewindLocked}
					anyTxtAvailable={anyTxtAvailable}
					imageInputAvailable={true}
					onPickDocument={handlePickDocument}
					onDropDocuments={handleDropDocuments}
					placeholder={ingestSource ? t("chat.ingestPlaceholder") : t("chat.typeAMessage")}
				/>
			</div>
		</div>
	);
}

function collectRecentRetrievalHistory(messages: DisplayMessage[]): MessageReference[] {
	const refs: MessageReference[] = [];
	const seen = new Set<string>();
	for (const msg of [...messages].reverse()) {
		if (msg.role !== "assistant" || !msg.references) continue;
		for (const ref of msg.references) {
			const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			refs.push(ref);
			if (refs.length >= 10) return refs;
		}
	}
	return refs;
}

function isReasoningOnlyResponseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /^Model produced [\d,]+ characters of reasoning \/ chain-of-thought, but no actual response content\./.test(message);
}

function isAbortLikeError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === "AbortError") return true;
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || /abort|cancel/i.test(err.message);
}
