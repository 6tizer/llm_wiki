import { listDirectory, readFile } from "@/commands/fs"
import { anyTxtSearchSmart } from "@/lib/anytxt-search"
import { computeContextBudget } from "@/lib/context-budget"
import { isGreeting } from "@/lib/greeting-detector"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { buildLanguageDirective, buildLanguageReminder } from "@/lib/output-language"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { searchWiki, type SearchResult } from "@/lib/search"
import { resolveSearchConfig, webSearch, type WebSearchResult } from "@/lib/web-search"
import type { MessageReference } from "@/stores/chat-store"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

export type ChatAgentAction =
  | "answer"
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "external_search"
  | "multi_search"
  | "finish"

export interface ChatAgentDecision {
  action: ChatAgentAction
  queries: string[]
  answer?: string
  reason?: string
}

export type ChatAgentIntent =
  | "chitchat"
  | "follow_up"
  | "rewrite"
  | "kb_search"
  | "graph"
  | "external"
  | "mixed"

export interface ChatQueryUnderstanding {
  intent: ChatAgentIntent
  rewrittenQuery: string
  wikiQueries: string[]
  graphQueries: string[]
  externalQueries: string[]
  needsWiki: boolean
  needsGraph: boolean
  needsExternal: boolean
  isFollowUp: boolean
  reason?: string
}

export interface ChatAgentProject {
  name: string
  path: string
}

export type ChatAgentMode = "fast" | "standard" | "deep" | "local_first"

export interface ChatAgentOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  mode?: ChatAgentMode
}

export interface ChatAgentDeps {
  searchWiki?: typeof searchWiki
  webSearch?: typeof webSearch
  anyTxtSearchSmart?: typeof anyTxtSearchSmart
  streamChat?: typeof streamChat
}

export type ChatAgentEventStage =
  | "understanding"
  | "routing"
  | "tool_call"
  | "tool_result"
  | "searching_wiki"
  | "searching_graph"
  | "searching_web"
  | "searching_anytxt"
  | "reading_context"
  | "writing"

export interface ChatAgentEvent {
  stage: ChatAgentEventStage
  query?: string
  tool?: ChatAgentToolName
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
}

export interface ChatAgentInput {
  project: ChatAgentProject | null
  llmConfig: LlmConfig
  searchApiConfig: SearchApiConfig
  text: string
  historyMessages: LLMMessage[]
  retrievalHistory?: MessageReference[]
  dataVersion: number
  options: ChatAgentOptions
  signal?: AbortSignal
  onEvent?: (event: ChatAgentEvent) => void
  deps?: ChatAgentDeps
}

export interface ChatAgentResult {
  messages: LLMMessage[]
  references: MessageReference[]
  queryPages: { title: string; path: string }[]
  plan: ChatAgentDecision[]
  steps: ChatAgentStep[]
}

export type ChatAgentToolName =
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "web_search"
  | "anytxt_search"

export interface ChatAgentToolDefinition {
  name: ChatAgentToolName
  action: Extract<ChatAgentAction, "project_files" | "project_file_read" | "wiki_search" | "graph_search" | "external_search">
  stage: Extract<ChatAgentEventStage, "searching_wiki" | "searching_graph" | "searching_web" | "searching_anytxt">
  label: string
  description: string
  requiresProject?: boolean
}

export interface ChatAgentStep {
  id: string
  type: "understanding" | "routing" | "tool_call" | "tool_result" | "final"
  tool?: ChatAgentToolName
  query?: string
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
}

interface ToolObservation {
  tool: "project_files" | "project_file_read" | "wiki_search" | "graph_search" | "external_search"
  query: string
  content: string
  references: MessageReference[]
  pages: { title: string; path: string }[]
  items: RetrievedItem[]
  errorCount?: number
}

type PageEntry = { title: string; path: string; content: string; priority: number }
type ProjectPromptContext = { purpose: string; index: string; overview: string }
type RetrievedItemKind = "wiki" | "graph" | "external" | "history"

interface RetrievedItem {
  id: string
  kind: RetrievedItemKind
  source: string
  title: string
  path: string
  url?: string
  snippet: string
  content: string
  score: number
  reference: MessageReference
  page?: { title: string; path: string }
}

interface RetrievedContext {
  contextText: string
  references: MessageReference[]
  pages: { title: string; path: string }[]
  itemCount: number
}

const MAX_AGENT_ROUNDS = 3
const MAX_DEEP_AGENT_ROUNDS = 5
const MAX_TOOL_CONTEXT_CHARS = 48_000

const CHAT_AGENT_TOOL_REGISTRY: ChatAgentToolDefinition[] = [
  {
    name: "project_files",
    action: "project_files",
    stage: "searching_wiki",
    label: "Project Files",
    description: "List project and wiki files using project-bound read-only file access.",
    requiresProject: true,
  },
  {
    name: "project_file_read",
    action: "project_file_read",
    stage: "searching_wiki",
    label: "Project File Read",
    description: "Read a specific wiki/source text file when the user names a path.",
    requiresProject: true,
  },
  {
    name: "wiki_search",
    action: "wiki_search",
    stage: "searching_wiki",
    label: "Wiki Search",
    description: "Search local wiki pages and retrieve relevant page content.",
    requiresProject: true,
  },
  {
    name: "graph_search",
    action: "graph_search",
    stage: "searching_graph",
    label: "Graph Search",
    description: "Inspect relationships between wiki entities, concepts, and pages.",
    requiresProject: true,
  },
  {
    name: "web_search",
    action: "external_search",
    stage: "searching_web",
    label: "Web Search",
    description: "Search the configured web provider for current or external information.",
  },
  {
    name: "anytxt_search",
    action: "external_search",
    stage: "searching_anytxt",
    label: "AnyTXT Search",
    description: "Search external local files indexed by AnyTXT.",
  },
]

/** Return the read-only tools available to normal Chat for a turn. */
export function getChatAgentTools(args: {
  hasProject: boolean
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode?: ChatAgentMode
}): ChatAgentToolDefinition[] {
  return CHAT_AGENT_TOOL_REGISTRY.filter((tool) => {
    if (tool.requiresProject && !args.hasProject) return false
    if (tool.name === "web_search") return args.webSearchEnabled && args.mode !== "local_first"
    if (tool.name === "anytxt_search") return args.anyTxtSearchEnabled
    if (tool.name === "project_file_read") return args.mode !== "fast"
    return true
  })
}

/** Return a direct-answer decision for turns that should skip retrieval. */
export function shouldBypassAgentPlanner(text: string): ChatAgentDecision | null {
  const q = text.trim()
  const lower = q.toLowerCase()
  if (!q) return { action: "answer", queries: [], reason: "empty" }
  if (isGreeting(q)) return { action: "answer", queries: [], reason: "greeting" }
  if (/^(继续|接着说|展开|展开一下|详细说说|换个说法|重新说|总结一下|总结上面|翻译|翻译成英文|翻译成中文|这是什么意思|什么意思)[\s\S]{0,30}$/i.test(q)) {
    return { action: "answer", queries: [], reason: "short follow-up" }
  }
  if (/^(continue|go on|expand|summari[sz]e|translate|rewrite|rephrase|what do you mean)\b/i.test(lower) && q.length < 120) {
    return { action: "answer", queries: [], reason: "short follow-up" }
  }
  return null
}

/** Build final LLM messages plus references by running the normal Chat router. */
export async function buildChatAgentMessages(input: ChatAgentInput): Promise<ChatAgentResult> {
  throwIfAborted(input.signal)
  const deps = { searchWiki, webSearch, anyTxtSearchSmart, streamChat, ...input.deps }
  const projectPath = input.project ? normalizePath(input.project.path) : ""
  const mode = input.options.mode ?? "standard"
  const searchConfig = resolveSearchConfig(input.searchApiConfig)
  const observations: ToolObservation[] = []
  const plan: ChatAgentDecision[] = []
  const steps: ChatAgentStep[] = []
  const executedToolKeys = new Set<string>()
  const enabledTools = getChatAgentTools({
    hasProject: Boolean(input.project),
    webSearchEnabled: input.options.useWebSearch,
    anyTxtSearchEnabled: input.options.useAnyTxtSearch,
    mode,
  })
  const direct = shouldBypassAgentPlanner(input.text)
    ?? (!input.project && !input.options.useWebSearch && !input.options.useAnyTxtSearch
      ? { action: "answer", queries: [], reason: "no retrieval sources" }
      : null)
  const projectContext = input.project
    && !direct
    ? await readProjectRoutingContext(projectPath, input.text, input.llmConfig)
    : undefined
  let historicalObservations: ToolObservation[] = []

  if (direct) {
    plan.push(direct)
    steps.push(step(steps, "understanding", { message: direct.reason ?? "Direct answer", status: "success" }))
  } else {
    input.onEvent?.({ stage: "understanding", status: "running" })
    const understanding = await understandUserQuery({
      llmConfig: input.llmConfig,
      text: input.text,
      historyMessages: input.historyMessages,
      hasProject: Boolean(input.project),
      projectContext,
      webSearchEnabled: input.options.useWebSearch,
      anyTxtSearchEnabled: input.options.useAnyTxtSearch,
      mode,
      tools: enabledTools,
      signal: input.signal,
      streamChatImpl: deps.streamChat,
    })
    steps.push(step(steps, "understanding", {
      query: understanding.rewrittenQuery,
      message: understanding.reason ?? understanding.intent,
      status: "success",
    }))
    input.onEvent?.({
      stage: "understanding",
      query: understanding.rewrittenQuery,
      message: understanding.reason ?? understanding.intent,
      status: "success",
    })

    const firstDecision = decisionFromUnderstanding(understanding, input.text)
    if (firstDecision.action === "answer" || firstDecision.action === "finish") {
      plan.push(firstDecision)
    }
    if (firstDecision.action !== "answer") {
      historicalObservations = await buildHistoricalObservations({
        projectPath,
        references: input.retrievalHistory ?? [],
        llmConfig: input.llmConfig,
      })
    }

    const maxRounds = mode === "deep" ? MAX_DEEP_AGENT_ROUNDS : MAX_AGENT_ROUNDS
    for (
      let round = 0;
      round < maxRounds && !["answer", "finish"].includes(plan[plan.length - 1]?.action ?? "");
      round++
    ) {
      throwIfAborted(input.signal)
      const decision = round === 0 && firstDecision.action !== "answer" && firstDecision.action !== "finish"
        ? firstDecision
        : await decideNextAction({
            llmConfig: input.llmConfig,
            text: input.text,
            understanding,
            tools: enabledTools,
            historyMessages: input.historyMessages,
            observations,
            historicalObservations,
            projectName: input.project?.name,
            hasProject: Boolean(input.project),
            projectContext,
            webSearchEnabled: input.options.useWebSearch,
            anyTxtSearchEnabled: input.options.useAnyTxtSearch,
            mode,
            signal: input.signal,
            streamChatImpl: deps.streamChat,
          })
      plan.push(decision)
      steps.push(step(steps, "routing", {
        query: decision.queries.join(" | "),
        message: decision.reason ?? decision.action,
        status: "success",
      }))
      input.onEvent?.({
        stage: "routing",
        query: decision.queries.join(" | "),
        message: decision.reason ?? decision.action,
        status: "success",
      })
      if (decision.action === "answer" || decision.action === "finish") break

      const queries = normalizeDecisionQueries(decision, input.text)
      const toolKey = `${decision.action}:${queries.map((query) => query.toLowerCase()).join("|")}`
      if (queries.length === 0 || executedToolKeys.has(toolKey)) break
      executedToolKeys.add(toolKey)

      const before = observations.length
      await runDecisionTools({
        decision,
        queries,
        projectPath,
        dataVersion: input.dataVersion,
        llmConfig: input.llmConfig,
        searchConfig,
        useWebSearch: input.options.useWebSearch,
        useAnyTxtSearch: input.options.useAnyTxtSearch,
        enabledTools,
        steps,
        onEvent: input.onEvent,
        deps,
        observations,
        signal: input.signal,
      })
      if (observations.length === before) break
    }
  }

  throwIfAborted(input.signal)
  const lastDecision = plan[plan.length - 1]
  const observationsForAnswer = observations.length > 0
    ? observations
    : lastDecision?.action === "finish"
      ? historicalObservations
      : []
  if (observations.length > 0) input.onEvent?.({ stage: "reading_context", status: "success" })
  const finalProjectContext = input.project && hasLocalObservation(observationsForAnswer)
    ? await readProjectPromptContext(projectPath, input.text, input.llmConfig)
    : undefined
  const retrievedContext = buildRetrievedContext(observationsForAnswer, input.text, input.llmConfig)
  input.onEvent?.({ stage: "writing", status: "running" })
  steps.push(step(steps, "final", {
    message: retrievedContext.itemCount > 0 ? "Answer with retrieved context" : "Direct answer",
    count: retrievedContext.references.length,
    status: "success",
  }))

  return {
    messages: buildFinalMessages({
      project: input.project,
      text: input.text,
      historyMessages: input.historyMessages,
      observations: observationsForAnswer,
      retrievedContext,
      directAnswerHint: plan.find((item) => item.answer)?.answer,
      projectContext: finalProjectContext,
    }),
    references: retrievedContext.references,
    queryPages: retrievedContext.pages,
    plan,
    steps,
  }
}

interface RunDecisionToolsArgs {
  decision: ChatAgentDecision
  queries: string[]
  projectPath: string
  dataVersion: number
  llmConfig: LlmConfig
  searchConfig: SearchApiConfig
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  enabledTools: ChatAgentToolDefinition[]
  steps: ChatAgentStep[]
  onEvent?: (event: ChatAgentEvent) => void
  deps: Required<ChatAgentDeps>
  observations: ToolObservation[]
  signal?: AbortSignal
}

async function runDecisionTools(args: RunDecisionToolsArgs): Promise<void> {
  const runTool = async (name: ChatAgentToolName, fn: () => Promise<ToolObservation>) => {
    const tool = args.enabledTools.find((item) => item.name === name)
    if (!tool) return
    throwIfAborted(args.signal)
    emitToolCall({ tool, queries: args.queries, steps: args.steps, onEvent: args.onEvent })
    const observation = await fn()
    throwIfAborted(args.signal)
    args.observations.push(observation)
    emitToolResult({ tool, observation, steps: args.steps, onEvent: args.onEvent })
  }
  const action = args.decision.action
  if (action === "project_files" || action === "multi_search") {
    await runTool("project_files", () => runProjectFilesTool(args))
  }
  if (action === "project_file_read" || action === "multi_search") {
    await runTool("project_file_read", () => runProjectFileReadTool(args))
  }
  if (action === "wiki_search" || action === "multi_search") {
    await runTool("wiki_search", () => runWikiSearchTool({ ...args, searchWikiImpl: args.deps.searchWiki }))
  }
  if (action === "graph_search" || action === "multi_search") {
    await runTool("graph_search", () => runGraphSearchTool({ ...args, searchWikiImpl: args.deps.searchWiki }))
  }
  if ((action === "external_search" || action === "multi_search") && args.useWebSearch) {
    await runTool("web_search", () => runExternalSearchTool({ ...args, webSearchImpl: args.deps.webSearch, source: "web" }))
  }
  if ((action === "external_search" || action === "multi_search") && args.useAnyTxtSearch) {
    await runTool("anytxt_search", () => runExternalSearchTool({ ...args, anyTxtSearchSmartImpl: args.deps.anyTxtSearchSmart, source: "anytxt" }))
  }
}

async function decideNextAction(args: {
  llmConfig: LlmConfig
  text: string
  understanding: ChatQueryUnderstanding
  tools: ChatAgentToolDefinition[]
  historyMessages: LLMMessage[]
  observations: ToolObservation[]
  historicalObservations: ToolObservation[]
  projectName?: string
  hasProject: boolean
  projectContext?: ProjectPromptContext
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode: ChatAgentMode
  signal?: AbortSignal
  streamChatImpl: typeof streamChat
}): Promise<ChatAgentDecision> {
  const toolDescriptions = args.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n") || "- none"
  const system = [
    "You are a routing controller for a local knowledge assistant.",
    "Return JSON only. Do not answer in prose.",
    "Available actions: answer, project_files, project_file_read, wiki_search, graph_search, external_search, multi_search, finish.",
    "Return shape: {\"action\":\"...\",\"queries\":[\"...\"],\"answer\":\"optional\",\"reason\":\"short reason\"}",
    "Rules:",
    "- Do not retrieve for greetings, casual chat, translation/rewrite/summarize/follow-up requests about prior assistant messages.",
    "- Use wiki_search for local wiki/project/document questions.",
    "- Use project_files before project_file_read when a file/page name is fuzzy.",
    "- Use graph_search for relationships, dependencies, links, entities, concepts, clusters, or graph questions.",
    "- Respect enabled external sources. Never choose external_search if no external source is enabled.",
    "- local_first prefers project_files, project_file_read, wiki_search, or graph_search.",
    "- fast avoids multi-step file inspection.",
    "- deep may use multiple tools when broader evidence is needed.",
    "- If observations are enough, choose finish.",
    "Enabled tools:",
    toolDescriptions,
  ].join("\n")
  const user = [
    `Project: ${args.projectName ?? "none"}`,
    `Local wiki available: ${args.hasProject ? "yes" : "no"}`,
    `Web Search enabled: ${args.webSearchEnabled ? "yes" : "no"}`,
    `AnyTXT Search enabled: ${args.anyTxtSearchEnabled ? "yes" : "no"}`,
    `Agent mode: ${args.mode}`,
    `Query understanding: ${JSON.stringify(args.understanding)}`,
    formatProjectContextForRouting(args.projectContext),
    formatHistory(args.historyMessages, 6, 1200),
    formatObservations("Tool observations", args.observations, 5000),
    formatObservations("Recent retrieval history", args.historicalObservations, 3000),
    `Current user message:\n${args.text}`,
  ].join("\n\n")
  const raw = await collectChatText(args.llmConfig, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], args.streamChatImpl, args.signal, { temperature: 0, max_tokens: 300 })
  return parseDecision(raw, args.text)
}

async function understandUserQuery(args: {
  llmConfig: LlmConfig
  text: string
  historyMessages: LLMMessage[]
  hasProject: boolean
  projectContext?: ProjectPromptContext
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode: ChatAgentMode
  tools: ChatAgentToolDefinition[]
  signal?: AbortSignal
  streamChatImpl: typeof streamChat
}): Promise<ChatQueryUnderstanding> {
  const toolDescriptions = args.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n") || "- none"
  const system = [
    "You are the query understanding stage for a local knowledge assistant.",
    "Return JSON only. Do not answer the user.",
    "Return shape: {\"intent\":\"chitchat|follow_up|rewrite|kb_search|graph|external|mixed\",\"rewrittenQuery\":\"...\",\"wikiQueries\":[\"...\"],\"graphQueries\":[\"...\"],\"externalQueries\":[\"...\"],\"needsWiki\":true,\"needsGraph\":false,\"needsExternal\":false,\"isFollowUp\":false,\"reason\":\"short reason\"}",
    "Rules:",
    "- chitchat/follow_up/rewrite should not require retrieval unless the user explicitly asks to search.",
    "- Use kb_search for local wiki/project/document questions.",
    "- Use graph for relationship/entity/connection questions.",
    "- Use external for current facts, public docs, web pages, versions, pricing, or local files outside the wiki when enabled.",
    "- In local_first mode, set needsWiki=true for any topic plausibly covered by the project.",
    "- In deep mode, prefer mixed when both local and external evidence could help.",
    "Enabled tools:",
    toolDescriptions,
  ].join("\n")
  const user = [
    `Local wiki available: ${args.hasProject ? "yes" : "no"}`,
    `Web Search enabled: ${args.webSearchEnabled ? "yes" : "no"}`,
    `AnyTXT Search enabled: ${args.anyTxtSearchEnabled ? "yes" : "no"}`,
    `Agent mode: ${args.mode}`,
    formatProjectContextForRouting(args.projectContext),
    formatHistory(args.historyMessages, 6, 1000),
    `Current user message:\n${args.text}`,
  ].join("\n\n")
  const raw = await collectChatText(args.llmConfig, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], args.streamChatImpl, args.signal, { temperature: 0, max_tokens: 450 })
  return parseUnderstanding(raw, args.text, {
    hasProject: args.hasProject,
    webSearchEnabled: args.webSearchEnabled,
    anyTxtSearchEnabled: args.anyTxtSearchEnabled,
  })
}

/** Parse query-understanding JSON with a deterministic heuristic fallback. */
export function parseUnderstanding(
  raw: string,
  fallbackQuery: string,
  availability: { hasProject: boolean; webSearchEnabled: boolean; anyTxtSearchEnabled: boolean },
): ChatQueryUnderstanding {
  const fallback = fallbackUnderstanding(fallbackQuery, availability)
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<ChatQueryUnderstanding>
    const intent = normalizeIntent(parsed.intent)
    const rewrittenQuery = stringOr(parsed.rewrittenQuery, fallback.rewrittenQuery)
    return {
      intent,
      rewrittenQuery,
      wikiQueries: normalizeQueryList(parsed.wikiQueries, rewrittenQuery),
      graphQueries: normalizeQueryList(parsed.graphQueries, rewrittenQuery),
      externalQueries: normalizeQueryList(parsed.externalQueries, rewrittenQuery),
      needsWiki: boolOr(parsed.needsWiki, fallback.needsWiki),
      needsGraph: boolOr(parsed.needsGraph, fallback.needsGraph),
      needsExternal: boolOr(parsed.needsExternal, fallback.needsExternal),
      isFollowUp: boolOr(parsed.isFollowUp, intent === "follow_up"),
      reason: stringOr(parsed.reason, fallback.reason),
    }
  } catch {
    return fallback
  }
}

/** Parse a router action JSON object with a safe local-search fallback. */
export function parseDecision(raw: string, fallbackQuery: string): ChatAgentDecision {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<ChatAgentDecision>
    return {
      action: normalizeAction(parsed.action),
      queries: normalizeQueryList(parsed.queries, fallbackQuery),
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
    }
  } catch {
    return { action: "wiki_search", queries: [fallbackQuery], reason: "router fallback" }
  }
}

function fallbackUnderstanding(
  query: string,
  availability: { hasProject: boolean; webSearchEnabled: boolean; anyTxtSearchEnabled: boolean },
): ChatQueryUnderstanding {
  const lower = query.toLowerCase()
  const needsGraph = /(关系|关联|连接|图谱|依赖|relationship|related|graph|connection|linked)/i.test(query)
  const asksExternal = /(latest|current|today|news|price|version|docs|api|最新|现在|今天|新闻|价格|版本|官方文档)/i.test(lower)
  const needsExternal = (availability.webSearchEnabled && asksExternal) || availability.anyTxtSearchEnabled
  const needsWiki = availability.hasProject && (!needsExternal || availability.anyTxtSearchEnabled || needsGraph)
  const intent: ChatAgentIntent = needsGraph
    ? "graph"
    : needsExternal && needsWiki
      ? "mixed"
      : needsExternal
        ? "external"
        : needsWiki
          ? "kb_search"
          : "chitchat"
  return {
    intent,
    rewrittenQuery: query.trim(),
    wikiQueries: needsWiki ? [query.trim()] : [],
    graphQueries: needsGraph ? [query.trim()] : [],
    externalQueries: needsExternal ? [query.trim()] : [],
    needsWiki,
    needsGraph,
    needsExternal,
    isFollowUp: false,
    reason: "fallback understanding",
  }
}

function decisionFromUnderstanding(understanding: ChatQueryUnderstanding, fallback: string): ChatAgentDecision {
  if (understanding.intent === "chitchat" || understanding.intent === "rewrite") {
    return { action: "answer", queries: [], reason: understanding.reason ?? understanding.intent }
  }
  if (understanding.intent === "follow_up") {
    return { action: "finish", queries: [], reason: understanding.reason ?? understanding.intent }
  }
  if ((understanding.needsWiki && understanding.needsGraph) || (understanding.needsWiki && understanding.needsExternal)) {
    return { action: "multi_search", queries: preferredQueries(understanding, fallback), reason: understanding.reason }
  }
  if (understanding.needsGraph) {
    return { action: "graph_search", queries: nonEmptyQueries(understanding.graphQueries, fallback), reason: understanding.reason }
  }
  if (understanding.needsExternal) {
    return { action: "external_search", queries: nonEmptyQueries(understanding.externalQueries, fallback), reason: understanding.reason }
  }
  if (understanding.needsWiki) {
    return { action: "wiki_search", queries: nonEmptyQueries(understanding.wikiQueries, fallback), reason: understanding.reason }
  }
  return { action: "answer", queries: [], reason: understanding.reason }
}

function normalizeIntent(intent: unknown): ChatAgentIntent {
  switch (intent) {
    case "chitchat":
    case "follow_up":
    case "rewrite":
    case "kb_search":
    case "graph":
    case "external":
    case "mixed":
      return intent
    default:
      return "kb_search"
  }
}

function normalizeAction(action: unknown): ChatAgentAction {
  switch (action) {
    case "answer":
    case "project_files":
    case "project_file_read":
    case "wiki_search":
    case "graph_search":
    case "external_search":
    case "multi_search":
    case "finish":
      return action
    default:
      return "wiki_search"
  }
}

function preferredQueries(understanding: ChatQueryUnderstanding, fallback: string): string[] {
  return nonEmptyQueries([
    ...understanding.wikiQueries,
    ...understanding.graphQueries,
    ...understanding.externalQueries,
  ], fallback)
}

function nonEmptyQueries(queries: string[], fallback: string): string[] {
  const normalized = queries.map((query) => query.trim()).filter(Boolean)
  return (normalized.length > 0 ? normalized : [fallback]).slice(0, 5)
}

function normalizeQueryList(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return fallback ? [fallback] : []
  const queries = value.map((item) => String(item).trim()).filter(Boolean)
  return (queries.length > 0 ? queries : fallback ? [fallback] : []).slice(0, 5)
}

function normalizeDecisionQueries(decision: ChatAgentDecision, fallback: string): string[] {
  return nonEmptyQueries(decision.queries, fallback)
}

function extractJsonObject(raw: string): string {
  const text = raw.trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

function stringOr(value: unknown, fallback: string | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback ?? ""
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

async function runProjectFilesTool(args: { projectPath: string; queries: string[]; llmConfig: LlmConfig; signal?: AbortSignal }): Promise<ToolObservation> {
  const maxEntries = args.llmConfig.maxContextSize > 180_000 ? 160 : 80
  throwIfAborted(args.signal)
  const [wikiTree, rawTree] = await Promise.all([
    listDirectory(`${args.projectPath}/wiki`).catch(() => [] as FileNode[]),
    listDirectory(`${args.projectPath}/raw/sources`).catch(() => [] as FileNode[]),
  ])
  throwIfAborted(args.signal)
  const wikiEntries = flattenFileTree(wikiTree, "wiki").slice(0, maxEntries)
  const rawEntries = flattenFileTree(rawTree, "raw/sources").slice(0, Math.floor(maxEntries / 2))
  const content = [
    "# Project file listing",
    `Query: ${args.queries.join(" | ")}`,
    "## Wiki files",
    wikiEntries.length > 0 ? wikiEntries.map((entry) => `- ${entry}`).join("\n") : "(none)",
    "## Source files",
    rawEntries.length > 0 ? rawEntries.map((entry) => `- ${entry}`).join("\n") : "(none)",
  ].join("\n\n")
  const reference: MessageReference = {
    title: "Project file listing",
    path: `${args.projectPath}/wiki/index.md`,
    kind: "wiki",
    snippet: wikiEntries.slice(0, 10).join("\n"),
  }
  return {
    tool: "project_files",
    query: args.queries.join(" | "),
    content,
    references: [reference],
    pages: [],
    items: [{
      id: "project-files",
      kind: "wiki",
      source: "project_files",
      title: "Project file listing",
      path: reference.path,
      snippet: reference.snippet ?? "",
      content,
      score: 0.8,
      reference,
    }],
    errorCount: 0,
  }
}

async function runProjectFileReadTool(args: { projectPath: string; queries: string[]; llmConfig: LlmConfig; signal?: AbortSignal }): Promise<ToolObservation> {
  const { maxPageSize } = computeContextBudget(args.llmConfig.maxContextSize)
  const pages: PageEntry[] = []
  const errors: string[] = []
  for (const query of args.queries.slice(0, 5)) {
    throwIfAborted(args.signal)
    const rel = normalizeProjectRelativePath(query)
    if (!rel || !isReadableProjectTextPath(rel)) {
      errors.push(`Skipped unsafe or unsupported path: ${query}`)
      continue
    }
    try {
      const raw = await readFile(`${args.projectPath}/${rel}`)
      throwIfAborted(args.signal)
      pages.push({
        title: getFileName(rel),
        path: rel,
        content: trimForBudget(raw, maxPageSize),
        priority: pages.length,
      })
    } catch (err) {
      errors.push(`Failed to read ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    tool: "project_file_read",
    query: args.queries.join(" | "),
    content: [formatWikiObservation("Project file contents", pages, []), formatErrors(errors)].filter(Boolean).join("\n\n"),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem(args.projectPath, page, "wiki", "project_file_read", 0.95)),
    errorCount: errors.length,
  }
}

async function runWikiSearchTool(args: {
  projectPath: string
  queries: string[]
  llmConfig: LlmConfig
  searchWikiImpl: typeof searchWiki
  signal?: AbortSignal
}): Promise<ToolObservation> {
  const { pageBudget, maxPageSize } = computeContextBudget(args.llmConfig.maxContextSize)
  const results = await collectSearchResults(args.projectPath, args.queries, args.searchWikiImpl, 8, args.signal)
  const pages = await materializePages(args.projectPath, results, Math.min(pageBudget, MAX_TOOL_CONTEXT_CHARS), maxPageSize, args.signal)
  return {
    tool: "wiki_search",
    query: args.queries.join(" | "),
    content: formatWikiObservation("Wiki search results", pages, results),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem(args.projectPath, page, "wiki", "wiki", searchScoreForPage(page, results))),
    errorCount: 0,
  }
}

async function runGraphSearchTool(args: {
  projectPath: string
  dataVersion: number
  queries: string[]
  llmConfig: LlmConfig
  searchWikiImpl: typeof searchWiki
  signal?: AbortSignal
}): Promise<ToolObservation> {
  throwIfAborted(args.signal)
  const base = await args.searchWikiImpl(args.projectPath, args.queries[0] ?? "")
  throwIfAborted(args.signal)
  const graph = await buildRetrievalGraph(args.projectPath, args.dataVersion)
  throwIfAborted(args.signal)
  const relatedResults = collectGraphResults(args.projectPath, base, graph)
  throwIfAborted(args.signal)
  const pages = await materializePages(args.projectPath, relatedResults, Math.min(computeContextBudget(args.llmConfig.maxContextSize).pageBudget, 24_000), 6000, args.signal)
  return {
    tool: "graph_search",
    query: args.queries.join(" | "),
    content: formatWikiObservation("Graph-related pages", pages, relatedResults),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem(args.projectPath, page, "graph", "graph", searchScoreForPage(page, relatedResults))),
    errorCount: 0,
  }
}

async function runExternalSearchTool(args: {
  queries: string[]
  searchConfig: SearchApiConfig
  source: "web" | "anytxt"
  llmConfig?: LlmConfig
  projectPath?: string
  webSearchImpl?: typeof webSearch
  anyTxtSearchSmartImpl?: typeof anyTxtSearchSmart
  signal?: AbortSignal
}): Promise<ToolObservation> {
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  const errors: string[] = []
  for (const query of args.queries.slice(0, 3)) {
    throwIfAborted(args.signal)
    try {
      const batch = args.source === "web"
        ? await args.webSearchImpl?.(query, args.searchConfig, 5, args.signal) ?? []
        : await args.anyTxtSearchSmartImpl?.(query, args.searchConfig.anyTxt, args.llmConfig, 5, args.projectPath, args.signal) ?? []
      throwIfAborted(args.signal)
      appendUniqueExternalResults(results, seen, batch, 8)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
    if (results.length >= 8) break
  }
  return {
    tool: "external_search",
    query: args.queries.join(" | "),
    content: [formatExternalSearchContext(results), formatErrors(errors)].filter(Boolean).join("\n\n"),
    references: results.map(externalReference),
    pages: [],
    items: results.map((result, index) => externalResultToRetrievedItem(result, index)),
    errorCount: errors.length,
  }
}

async function buildHistoricalObservations(args: {
  projectPath: string
  references: MessageReference[]
  llmConfig: LlmConfig
}): Promise<ToolObservation[]> {
  const refs = dedupeReferences(args.references).slice(0, 10)
  if (refs.length === 0) return []
  const observations: ToolObservation[] = []
  const wikiRefs = refs.filter((ref) => ref.kind !== "external" && ref.path && args.projectPath)
  if (wikiRefs.length > 0) observations.push(await buildHistoricalWikiObservation(args.projectPath, wikiRefs, args.llmConfig))
  const externalRefs = refs.filter((ref) => ref.kind === "external")
  if (externalRefs.length > 0) observations.push(buildHistoricalExternalObservation(externalRefs))
  return observations.filter((obs) => obs.items.length > 0)
}

async function buildHistoricalWikiObservation(
  projectPath: string,
  refs: MessageReference[],
  llmConfig: LlmConfig,
): Promise<ToolObservation> {
  const results: SearchResult[] = refs.slice(0, 5).map((ref, index) => ({
    path: normalizeReferencePath(projectPath, ref.path),
    title: ref.title,
    snippet: ref.snippet ?? "Previously cited local wiki page.",
    titleMatch: false,
    score: 1 / (index + 1),
    images: [],
  }))
  const pages = await materializePages(projectPath, results, Math.min(computeContextBudget(llmConfig.maxContextSize).pageBudget, 18_000), 5000)
  return {
    tool: "wiki_search",
    query: "recent local references",
    content: formatWikiObservation("Recent local retrieval history", pages, results),
    references: pages.map((page) => ({ title: page.title, path: `${projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem(projectPath, page, "history", "history", 0.75)),
    errorCount: 0,
  }
}

function buildHistoricalExternalObservation(refs: MessageReference[]): ToolObservation {
  const results: WebSearchResult[] = refs.slice(0, 8).map((ref) => ({
    title: ref.title,
    url: ref.url ?? ref.path,
    snippet: ref.snippet ?? "",
    source: ref.source ?? "external",
  }))
  return {
    tool: "external_search",
    query: "recent external references",
    content: `# Recent external retrieval history\n\n${formatExternalSearchContext(results)}`,
    references: refs,
    pages: [],
    items: results.map((result, index) => externalResultToRetrievedItem(result, index, "history")),
    errorCount: 0,
  }
}

async function collectSearchResults(
  projectPath: string,
  queries: string[],
  searchWikiImpl: typeof searchWiki,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const query of queries.slice(0, 3)) {
    throwIfAborted(signal)
    for (const result of await searchWikiImpl(projectPath, query)) {
      throwIfAborted(signal)
      const key = normalizePath(result.path)
      if (seen.has(key)) continue
      seen.add(key)
      results.push(result)
      if (results.length >= limit) return results
    }
  }
  return results
}

function collectGraphResults(projectPath: string, base: SearchResult[], graph: ReturnType<typeof buildRetrievalGraph> extends Promise<infer T> ? T : never): SearchResult[] {
  const candidates = new Map<string, { title: string; path: string; relevance: number }>()
  const hitPaths = new Set(base.slice(0, 6).map((item) => normalizePath(item.path)))
  for (const result of base.slice(0, 6)) {
    const nodeId = getFileName(result.path).replace(/\.md$/, "")
    for (const { node, relevance } of getRelatedNodes(nodeId, graph, 5)) {
      if (relevance < 1.5 || hitPaths.has(normalizePath(node.path))) continue
      const path = normalizePath(node.path)
      const current = candidates.get(path)
      if (!current || relevance > current.relevance) {
        candidates.set(path, {
          title: node.title,
          path: path.startsWith(`${projectPath}/`) ? path : `${projectPath}/${path.replace(/^\/+/, "")}`,
          relevance,
        })
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.relevance - a.relevance).slice(0, 8).map((item) => ({
    path: item.path,
    title: item.title,
    snippet: `Graph relevance ${item.relevance.toFixed(2)}`,
    titleMatch: false,
    score: item.relevance,
    images: [],
  }))
}

async function materializePages(
  projectPath: string,
  results: SearchResult[],
  pageBudget: number,
  maxPageSize: number,
  signal?: AbortSignal,
): Promise<PageEntry[]> {
  let usedChars = 0
  const pages: PageEntry[] = []
  for (const [index, result] of results.entries()) {
    throwIfAborted(signal)
    if (usedChars >= pageBudget) break
    const page = await readSearchResultPage(projectPath, result, index, maxPageSize, signal)
    if (!page || usedChars + page.content.length > pageBudget) continue
    usedChars += page.content.length
    pages.push(page)
  }
  return pages
}

async function readSearchResultPage(
  projectPath: string,
  result: SearchResult,
  index: number,
  maxPageSize: number,
  signal?: AbortSignal,
): Promise<PageEntry | null> {
  try {
    throwIfAborted(signal)
    const raw = await readFile(result.path)
    throwIfAborted(signal)
    return {
      title: result.title,
      path: getRelativePath(result.path, projectPath),
      content: trimForBudget(raw, maxPageSize),
      priority: index,
    }
  } catch {
    return null
  }
}

function buildFinalMessages(args: {
  project: ChatAgentProject | null
  text: string
  historyMessages: LLMMessage[]
  observations: ToolObservation[]
  retrievedContext: RetrievedContext
  directAnswerHint?: string
  projectContext?: ProjectPromptContext
}): LLMMessage[] {
  const hasTools = args.retrievedContext.itemCount > 0
  const localRefs = args.retrievedContext.references.filter((ref) => ref.kind !== "external")
  const pageList = localRefs.map((ref, index) => `[${index + 1}] ${ref.title} (${ref.path})`).join("\n")
  const system = hasTools
    ? [
        "You are a knowledgeable wiki assistant. Answer using the retrieved context below and conversation history.",
        "If the observations are insufficient, say what is missing instead of inventing facts.",
        "Keep subject boundaries strict: do not apply a claim about one subject to another subject just because they share keywords.",
        "Use [[wikilink]] syntax for local wiki pages when relevant.",
        "When a sentence or bullet uses retrieved context, include an inline citation immediately after that claim.",
        "Cite local context blocks with [1], [2]. Cite external context blocks with [E1], [E2].",
        "At the VERY END of your response, add a hidden comment listing which local page numbers you used:",
        "  <!-- cited: 1, 3 -->",
        args.project ? `Project: ${args.project.name}` : "",
        args.projectContext?.purpose ? `## Wiki Purpose\n${args.projectContext.purpose}` : "",
        args.projectContext?.overview ? `## Wiki Overview\n${args.projectContext.overview}` : "",
        args.projectContext?.index ? `## Wiki Index\n${args.projectContext.index}` : "",
        pageList ? `## Page List\n${pageList}` : "",
        args.retrievedContext.contextText,
        buildLanguageDirective(args.text),
      ].filter(Boolean).join("\n\n")
    : [
        args.project ? `You are a wiki assistant for the project "${args.project.name}".` : "You are a helpful assistant.",
        "Answer directly from the conversation. Do not claim that you searched the wiki or external sources.",
        args.directAnswerHint ? `Possible answer direction: ${args.directAnswerHint}` : "",
        buildLanguageReminder(args.text),
      ].filter(Boolean).join("\n")
  return addLanguageReminderToLastUser([{ role: "system", content: system }, ...args.historyMessages], args.text)
}

function buildRetrievedContext(observations: ToolObservation[], query: string, llmConfig: LlmConfig): RetrievedContext {
  const items = fuseRetrievedItems(observations.flatMap((obs) => obs.items), query)
  const budget = Math.max(8_000, Math.min(computeContextBudget(llmConfig.maxContextSize).pageBudget, MAX_TOOL_CONTEXT_CHARS))
  const blocks: string[] = []
  const references: MessageReference[] = []
  const pages: { title: string; path: string }[] = []
  let used = 0
  let localIndex = 0
  let externalIndex = 0
  for (const item of items) {
    const isExternal = item.reference.kind === "external"
    const refId = isExternal ? `E${++externalIndex}` : `${++localIndex}`
    const maxItemChars = isExternal ? 1800 : 6500
    const content = trimForBudget(item.content || item.snippet, Math.min(maxItemChars, Math.max(800, budget - used)))
    if (!content.trim()) continue
    const block = contextBlock(refId, item, content)
    if (used + block.length > budget && blocks.length > 0) break
    used += block.length
    blocks.push(block)
    references.push(item.reference)
    if (item.page) pages.push(item.page)
  }
  return {
    contextText: blocks.length > 0 ? `## Retrieved Context\n${blocks.join("\n\n---\n\n")}` : buildEmptyRetrievalStatus(observations),
    references: dedupeReferences(references),
    pages,
    itemCount: blocks.length || observations.length,
  }
}

function contextBlock(refId: string, item: RetrievedItem, content: string): string {
  return [
    `<context id="${refId}" source="${escapeContextAttr(item.source)}" kind="${item.kind}" title="${escapeContextAttr(item.title)}" path="${escapeContextAttr(item.url ?? item.path)}">`,
    content,
    "</context>",
  ].join("\n")
}

function buildEmptyRetrievalStatus(observations: ToolObservation[]): string {
  if (observations.length === 0) return ""
  return [
    "## Retrieved Context",
    observations.map((obs, index) => [
      `<context id="status-${index + 1}" source="${obs.tool}" kind="status" title="Retrieval status" path="">`,
      `Query: ${obs.query}`,
      obs.content || "(no results)",
      "</context>",
    ].join("\n")).join("\n\n---\n\n"),
  ].join("\n")
}

async function readProjectRoutingContext(projectPath: string, query: string, llmConfig: LlmConfig): Promise<ProjectPromptContext> {
  const { indexBudget } = computeContextBudget(llmConfig.maxContextSize)
  const [purpose, overview, rawIndex] = await Promise.all([
    readFile(`${projectPath}/purpose.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/overview.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/index.md`).catch(() => ""),
  ])
  return {
    purpose: trimForBudget(purpose, 2500),
    overview: trimForBudget(overview, Math.min(7000, Math.max(2500, Math.floor(indexBudget * 0.4)))),
    index: trimRelevantIndex(rawIndex, query, Math.min(5000, Math.max(1800, Math.floor(indexBudget * 0.35)))),
  }
}

async function readProjectPromptContext(projectPath: string, query: string, llmConfig: LlmConfig): Promise<ProjectPromptContext> {
  const { indexBudget } = computeContextBudget(llmConfig.maxContextSize)
  const [rawIndex, purpose, overview] = await Promise.all([
    readFile(`${projectPath}/wiki/index.md`).catch(() => ""),
    readFile(`${projectPath}/purpose.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/overview.md`).catch(() => ""),
  ])
  return {
    purpose,
    overview,
    index: rawIndex.length <= indexBudget ? rawIndex : trimRelevantIndex(rawIndex, query, indexBudget),
  }
}

function trimRelevantIndex(rawIndex: string, query: string, maxChars: number): string {
  if (!rawIndex.trim()) return ""
  if (rawIndex.length <= maxChars) return rawIndex
  const tokens = tokenizeIndexQuery(query)
  const lines = rawIndex.split("\n")
  const keptLines: string[] = []
  let keptSize = 0
  for (const line of lines) {
    const isHeader = line.startsWith("#")
    const lower = line.toLowerCase()
    const isRelevant = tokens.length === 0 || tokens.some((token) => lower.includes(token))
    if (!isHeader && !isRelevant) continue
    if (keptSize + line.length + 1 > maxChars) continue
    keptLines.push(line)
    keptSize += line.length + 1
  }
  return keptLines.length > 0
    ? `${keptLines.join("\n")}\n\n[...index trimmed to routing-relevant entries...]`
    : `${rawIndex.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n[...index truncated...]`
}

function formatProjectContextForRouting(context?: ProjectPromptContext): string {
  if (!context || (!context.purpose.trim() && !context.overview.trim() && !context.index.trim())) {
    return "Project context: none"
  }
  return [
    "Project context for routing:",
    context.purpose.trim() ? `## Project Purpose\n${context.purpose.trim()}` : "",
    context.overview.trim() ? `## Current Wiki Overview\n${context.overview.trim()}` : "",
    context.index.trim() ? `## Wiki Index Signals\n${context.index.trim()}` : "",
  ].filter(Boolean).join("\n\n")
}

function formatHistory(messages: LLMMessage[], limit: number, maxChars: number): string {
  const text = messages.slice(-limit).map((msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n")
    return `${msg.role}: ${content.slice(0, maxChars)}`
  }).join("\n\n")
  return text ? `Recent conversation:\n${text}` : "Recent conversation: none"
}

function formatObservations(title: string, observations: ToolObservation[], maxChars: number): string {
  if (observations.length === 0) return `${title}: none`
  return [
    `${title}:`,
    observations.map((obs, index) => [
      `Observation ${index + 1}: ${obs.tool}`,
      `Query: ${obs.query}`,
      obs.content.slice(0, maxChars),
    ].join("\n")).join("\n\n---\n\n"),
  ].join("\n")
}

function hasLocalObservation(observations: ToolObservation[]): boolean {
  return observations.some((obs) => obs.tool !== "external_search")
}

function flattenFileTree(nodes: FileNode[], prefix: string): string[] {
  const out: string[] = []
  const walk = (items: FileNode[], base: string) => {
    for (const node of items) {
      const rel = `${base}/${node.name}`.replace(/\/+/g, "/")
      if (node.is_dir && node.children) walk(node.children, rel)
      if (!node.is_dir) out.push(rel)
    }
  }
  walk(nodes, prefix)
  return out.sort((a, b) => a.localeCompare(b))
}

function normalizeProjectRelativePath(input: string): string {
  const normalized = normalizePath(input.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^\.\//, ""))
    .replace(/^\/+/, "")
    .replace(/^.*?\/(wiki|raw\/sources)\//, "$1/")
  if (!normalized || normalized.includes("\0")) return ""
  if (normalized.split("/").some((part) => part === ".." || part.startsWith("."))) return ""
  return normalized
}

function isReadableProjectTextPath(rel: string): boolean {
  const lower = rel.toLowerCase()
  if (!lower.startsWith("wiki/") && !lower.startsWith("raw/sources/") && lower !== "purpose.md" && lower !== "schema.md") return false
  return /\.(md|mdx|txt|json|yaml|yml|csv|tsv|log)$/i.test(lower) || lower === "purpose.md" || lower === "schema.md"
}

function pageToRetrievedItem(
  projectPath: string,
  page: PageEntry,
  kind: Extract<RetrievedItemKind, "wiki" | "graph" | "history">,
  source: string,
  score: number,
): RetrievedItem {
  const absolutePath = `${projectPath}/${page.path}`
  return {
    id: absolutePath,
    kind,
    source,
    title: page.title,
    path: absolutePath,
    snippet: page.content.slice(0, 400),
    content: page.content,
    score,
    reference: { title: page.title, path: absolutePath, kind: "wiki" },
    page: { title: page.title, path: absolutePath },
  }
}

function externalResultToRetrievedItem(
  result: WebSearchResult,
  index: number,
  kind: Extract<RetrievedItemKind, "external" | "history"> = "external",
): RetrievedItem {
  return {
    id: result.url || `${result.source}:${result.title}:${index}`,
    kind,
    source: result.source,
    title: result.title,
    path: result.url,
    url: result.url,
    snippet: result.snippet,
    content: result.snippet,
    score: 1 / (index + 1),
    reference: externalReference(result),
  }
}

function externalReference(result: WebSearchResult): MessageReference {
  return {
    title: result.title,
    path: result.url,
    kind: "external",
    source: result.source,
    url: result.url,
    snippet: result.snippet,
  }
}

function appendUniqueExternalResults(
  out: WebSearchResult[],
  seen: Set<string>,
  batch: WebSearchResult[],
  limit: number,
): void {
  for (const result of batch) {
    const key = (result.url || `${result.source}:${result.title}:${result.snippet}`).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(result)
    if (out.length >= limit) break
  }
}

function fuseRetrievedItems(items: RetrievedItem[], query: string): RetrievedItem[] {
  const tokens = tokenizeIndexQuery(query)
  const merged = new Map<string, RetrievedItem>()
  for (const item of items) {
    const ranked = { ...item, score: rankRetrievedItem(item, tokens) }
    const key = `${ranked.reference.kind ?? "wiki"}:${ranked.url || ranked.path || ranked.id}`.toLowerCase()
    const existing = merged.get(key)
    if (!existing || ranked.score > existing.score || ranked.content.length > existing.content.length) {
      merged.set(key, ranked)
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
}

function rankRetrievedItem(item: RetrievedItem, tokens: string[]): number {
  const sourceWeight = item.kind === "wiki" ? 1 : item.kind === "graph" ? 0.88 : item.kind === "external" ? 0.92 : 0.78
  const text = `${item.title}\n${item.snippet}\n${item.path}`.toLowerCase()
  const overlap = tokens.reduce((score, token) => score + (text.includes(token) ? 0.12 : 0), 0)
  return sourceWeight + Math.max(0, Math.min(1, item.score)) + overlap
}

function searchScoreForPage(page: PageEntry, results: SearchResult[]): number {
  const normalized = normalizePath(page.path)
  return results.find((result) => normalizePath(result.path).endsWith(normalized))?.score ?? 1 / (page.priority + 1)
}

function normalizeReferencePath(projectPath: string, path: string): string {
  const normalized = normalizePath(path)
  if (normalized.startsWith(`${projectPath}/`)) return normalized
  return `${projectPath}/${normalized.replace(/^\/+/, "")}`
}

function tokenizeIndexQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, 20)
}

function addLanguageReminderToLastUser(messages: LLMMessage[], text: string): LLMMessage[] {
  const reminder = buildLanguageReminder(text)
  if (!reminder) return messages
  const lastIdx = [...messages].reverse().findIndex((msg) => msg.role === "user")
  if (lastIdx < 0) return messages
  const idx = messages.length - 1 - lastIdx
  const target = messages[idx]
  if (!target || target.role !== "user") return messages
  const content = typeof target.content === "string"
    ? `[${reminder}]\n\n${target.content}`
    : addTextPrefix(target.content, `[${reminder}]\n\n`)
  return [...messages.slice(0, idx), { ...target, content }, ...messages.slice(idx + 1)]
}

function addTextPrefix(content: Exclude<LLMMessage["content"], string>, prefix: string): LLMMessage["content"] {
  const blocks = [...content]
  const firstTextIdx = blocks.findIndex((block) => block.type === "text")
  if (firstTextIdx >= 0) {
    const block = blocks[firstTextIdx]
    if (block.type === "text") blocks[firstTextIdx] = { type: "text", text: `${prefix}${block.text}` }
    return blocks
  }
  return [{ type: "text", text: prefix }, ...blocks]
}

function formatWikiObservation(title: string, pages: PageEntry[], snippets: SearchResult[]): string {
  const pageText = pages.map((page, index) => [
    `### [${index + 1}] ${page.title}`,
    `Path: ${page.path}`,
    "",
    page.content,
  ].join("\n")).join("\n\n---\n\n")
  const snippetText = snippets.slice(0, 8).map((result, index) => [
    `- ${index + 1}. ${result.title}`,
    `  Path: ${result.path}`,
    `  Snippet: ${result.snippet}`,
  ].join("\n")).join("\n")
  return [`# ${title}`, pageText, snippetText ? `## Search snippets\n${snippetText}` : ""].filter(Boolean).join("\n\n")
}

function formatExternalSearchContext(results: WebSearchResult[]): string {
  return results.map((result, index) => [
    `### [E${index + 1}] ${result.title}`,
    `Source: ${result.source}`,
    `URL: ${result.url}`,
    "",
    result.snippet,
  ].join("\n")).join("\n\n---\n\n")
}

function formatErrors(errors: string[]): string {
  return errors.length > 0 ? `Errors:\n${errors.map((err) => `- ${err}`).join("\n")}` : ""
}

function dedupeReferences(refs: MessageReference[]): MessageReference[] {
  const seen = new Set<string>()
  const out: MessageReference[] = []
  for (const ref of refs) {
    const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

function trimForBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[...truncated...]`
}

function escapeContextAttr(value: string): string {
  return value.replace(/[<>"&]/g, (char) => {
    switch (char) {
      case "<": return "&lt;"
      case ">": return "&gt;"
      case "\"": return "&quot;"
      case "&": return "&amp;"
      default: return char
    }
  })
}

function step(
  steps: ChatAgentStep[],
  type: ChatAgentStep["type"],
  patch: Omit<ChatAgentStep, "id" | "type">,
): ChatAgentStep {
  return { id: `step-${steps.length + 1}`, type, ...patch }
}

function emitToolCall(args: {
  tool: ChatAgentToolDefinition
  queries: string[]
  steps: ChatAgentStep[]
  onEvent?: (event: ChatAgentEvent) => void
}): void {
  const query = args.queries.join(" | ")
  args.steps.push(step(args.steps, "tool_call", {
    tool: args.tool.name,
    query,
    message: args.tool.label,
    status: "running",
  }))
  args.onEvent?.({ stage: "tool_call", tool: args.tool.name, query, message: args.tool.label, status: "running" })
  args.onEvent?.({ stage: args.tool.stage, tool: args.tool.name, query, message: args.tool.label, status: "running" })
}

function emitToolResult(args: {
  tool: ChatAgentToolDefinition
  observation: ToolObservation
  steps: ChatAgentStep[]
  onEvent?: (event: ChatAgentEvent) => void
}): void {
  const count = args.observation.references.length
  const status = args.observation.errorCount && count === 0 ? "error" : "success"
  const message = count > 0
    ? `${args.tool.label}: ${count} result${count === 1 ? "" : "s"}`
    : args.observation.errorCount
      ? `${args.tool.label}: failed`
      : `${args.tool.label}: no results`
  args.steps.push(step(args.steps, "tool_result", {
    tool: args.tool.name,
    query: args.observation.query,
    message,
    count,
    status,
  }))
  args.onEvent?.({ stage: "tool_result", tool: args.tool.name, query: args.observation.query, message, count, status })
}

async function collectChatText(
  llmConfig: LlmConfig,
  messages: LLMMessage[],
  streamChatImpl: typeof streamChat,
  signal?: AbortSignal,
  overrides?: Parameters<typeof streamChat>[4],
): Promise<string> {
  let out = ""
  let error: Error | null = null
  await streamChatImpl(
    llmConfig,
    messages,
    {
      onToken: (token) => { out += token },
      onReasoningToken: () => {},
      onDone: () => {},
      onError: (err) => { error = err },
    },
    signal,
    { ...overrides, reasoning: overrides?.reasoning ?? { mode: "off" } },
  )
  if (error) throw error
  throwIfAborted(signal)
  return out
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("Chat request aborted")
  err.name = "AbortError"
  throw err
}
