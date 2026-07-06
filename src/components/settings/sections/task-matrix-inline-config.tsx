import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore, type EmbeddingConfig, type MultimodalConfig } from "@/stores/wiki-store"
import {
  dropLegacyVectorTable,
  embedAllPages,
  getEmbeddingCount,
  getLastEmbeddingError,
  legacyVectorRowCount,
} from "@/lib/embedding"
import { runtimeDerivedMarkerReconcileTerminalJobs } from "@/commands/runtime-db"
import { testEmbeddingConnection, testEmbeddingFunction, type ProviderTestResult } from "@/lib/connection-tests"
import { persistSetting } from "@/lib/store-helpers"

type ReindexState =
  | { kind: "idle" }
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; count: number }

type TestState =
  | { kind: "idle" }
  | { kind: "running"; label: string }
  | { kind: "done"; result: ProviderTestResult }

const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "host",
  "content-length",
  "origin",
  "x-goog-api-key",
])
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_~0-9A-Za-z-]+$/

const PROVIDER_OPTIONS: Array<{ value: MultimodalConfig["provider"]; label: string }> = [
  { value: "custom", label: "Custom (OpenAI-compat)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google (Gemini)" },
  { value: "azure", label: "Azure OpenAI" },
  { value: "ollama", label: "Ollama" },
]

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}

function headersToText(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
}

function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!name || !value || !HTTP_HEADER_NAME_RE.test(name) || RESERVED_HEADER_NAMES.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useInlinePersistMessage() {
  const { t } = useTranslation()
  const [message, setMessage] = useState<string | null>(null)

  const saved = useCallback(() => {
    setMessage(t("settings.sections.modelConfig.taskMatrix.inlineSaved"))
  }, [t])

  const failed = useCallback((error: unknown) => {
    setMessage(t("settings.sections.modelConfig.taskMatrix.inlineSaveFailed", { message: errorMessage(error) }))
  }, [t])

  return { message, saved, failed }
}

export function EmbeddingInlineConfig() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  const setEmbeddingConfig = useWikiStore((s) => s.setEmbeddingConfig)
  const { message, saved, failed } = useInlinePersistMessage()

  const [chunkCount, setChunkCount] = useState<number | null>(null)
  const [legacyCount, setLegacyCount] = useState<number>(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [reindex, setReindex] = useState<ReindexState>({ kind: "idle" })
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })
  const [headersText, setHeadersText] = useState<string>(() => headersToText(embeddingConfig.extraHeaders))
  const [legacyDropped, setLegacyDropped] = useState(false)

  const refreshStats = useCallback(async (isStale: () => boolean = () => false) => {
    if (!project) return
    try {
      const [chunks, legacy] = await Promise.all([
        getEmbeddingCount(project.path),
        legacyVectorRowCount(project.path),
      ])
      if (isStale()) return
      setChunkCount(chunks)
      setLegacyCount(legacy)
    } catch {
      if (isStale()) return
      setChunkCount(null)
    }
    if (isStale()) return
    setLastError(getLastEmbeddingError())
  }, [project])

  useEffect(() => {
    let cancelled = false
    void refreshStats(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [refreshStats])

  function persistEmbedding(patch: Partial<EmbeddingConfig>) {
    const prev = useWikiStore.getState().embeddingConfig
    const next = { ...prev, ...patch }
    void persistSetting(
      prev,
      next,
      setEmbeddingConfig,
      async (value) => {
        const { saveEmbeddingConfig } = await import("@/lib/project-store")
        await saveEmbeddingConfig(value)
      },
      () => useWikiStore.getState().embeddingConfig,
      { onError: failed },
    ).then((ok) => {
      if (ok) saved()
    })
  }

  const handleReindex = useCallback(async () => {
    if (!project) return
    setReindex({ kind: "running", done: 0, total: 0 })
    const count = await embedAllPages(project.path, embeddingConfig, (done, total) => {
      setReindex({ kind: "running", done, total })
    }, { clearExisting: true })
    try {
      await runtimeDerivedMarkerReconcileTerminalJobs({})
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
    }
    setReindex({ kind: "done", count })
    await refreshStats()
  }, [project, embeddingConfig, refreshStats])

  const handleDropLegacy = useCallback(async () => {
    if (!project) return
    await dropLegacyVectorTable(project.path)
    setLegacyCount(0)
    setLegacyDropped(true)
  }, [project])

  async function runEmbeddingTest(kind: "connection" | "function") {
    setTestState({
      kind: "running",
      label: kind === "connection"
        ? t("settings.sections.embedding.testingConnection")
        : t("settings.sections.embedding.testingFunction"),
    })
    const result = kind === "connection"
      ? await testEmbeddingConnection(embeddingConfig)
      : await testEmbeddingFunction(embeddingConfig)
    setTestState({ kind: "done", result })
    setLastError(getLastEmbeddingError())
  }

  const showLegacyMigration =
    legacyCount > 0 && (chunkCount === null || chunkCount === 0)

  return (
    <div className="space-y-4 rounded-md border bg-background p-3" data-testid="task-matrix-inline-embedding">
      <div>
        <h4 className="text-sm font-semibold">{t("settings.sections.embedding.title")}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.embedding.description")}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <div className="text-sm font-medium">{t("settings.sections.embedding.enableLabel")}</div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.embedding.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => persistEmbedding({ enabled: !embeddingConfig.enabled })}
          aria-pressed={embeddingConfig.enabled}
          data-testid="embedding-inline-enabled"
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            embeddingConfig.enabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              embeddingConfig.enabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {embeddingConfig.enabled && (
        <>
          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.endpoint")}</Label>
            <Input
              value={embeddingConfig.endpoint}
              onChange={(e) => persistEmbedding({ endpoint: e.target.value })}
              placeholder="http://127.0.0.1:1234/v1/embeddings"
              data-testid="embedding-inline-endpoint"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.endpointHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.apiKey")}</Label>
            <Input
              type="password"
              value={embeddingConfig.apiKey}
              onChange={(e) => persistEmbedding({ apiKey: e.target.value })}
              placeholder={t("settings.sections.embedding.apiKeyPlaceholder")}
              data-testid="embedding-inline-api-key"
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.model")}</Label>
            <Input
              value={embeddingConfig.model}
              onChange={(e) => persistEmbedding({ model: e.target.value })}
              placeholder="e.g. text-embedding-qwen3-embedding-0.6b or gemini-embedding-001"
              data-testid="embedding-inline-model"
            />
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.outputDimensionality")}</Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={embeddingConfig.outputDimensionality ?? ""}
              onChange={(e) => persistEmbedding({ outputDimensionality: parsePositiveInteger(e.target.value) })}
              placeholder="768"
              data-testid="embedding-inline-output-dimensionality"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.outputDimensionalityHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.sections.embedding.extraHeaders")}</Label>
            <textarea
              value={headersText}
              onChange={(e) => {
                const text = e.target.value
                setHeadersText(text)
                persistEmbedding({ extraHeaders: parseHeadersText(text) })
              }}
              placeholder={"X-Model-Provider-Id: siliconflow\nX-Custom-Header: value"}
              rows={3}
              data-testid="embedding-inline-extra-headers"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.extraHeadersHint")}
            </p>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.chunking")}
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.maxChunkChars")}</Label>
              <Input
                type="number"
                min={200}
                step={100}
                value={embeddingConfig.maxChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  persistEmbedding({ maxChunkChars: v === "" ? undefined : Number(v) })
                }}
                placeholder="1000"
                data-testid="embedding-inline-max-chunk-chars"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.maxChunkCharsHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("settings.sections.embedding.overlapChunkChars")}</Label>
              <Input
                type="number"
                min={0}
                step={50}
                value={embeddingConfig.overlapChunkChars ?? ""}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  persistEmbedding({ overlapChunkChars: v === "" ? undefined : Number(v) })
                }}
                placeholder="200"
                data-testid="embedding-inline-overlap-chunk-chars"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.overlapChunkCharsHint")}
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">
                {t("settings.sections.embedding.providerTests")}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.sections.embedding.providerTestsHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runEmbeddingTest("connection")}
                disabled={testState.kind === "running"}
                data-testid="embedding-inline-test-connection"
              >
                {t("settings.sections.embedding.testConnection")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runEmbeddingTest("function")}
                disabled={testState.kind === "running"}
                data-testid="embedding-inline-test-function"
              >
                {t("settings.sections.embedding.testFunction")}
              </Button>
            </div>
            {testState.kind === "running" && (
              <p className="text-xs text-muted-foreground">{testState.label}</p>
            )}
            {testState.kind === "done" && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  testState.result.ok
                    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/40 bg-destructive/5 text-destructive"
                }`}
              >
                {testState.result.message}
              </div>
            )}
          </div>

          {showLegacyMigration && (
            <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <div className="text-sm font-medium text-destructive">
                {t("settings.sections.embedding.legacyPromptTitle")}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.legacyPromptBody", { count: legacyCount })}
              </p>
            </div>
          )}

          <div className="space-y-3 rounded-md border p-3">
            <div className="text-sm font-medium">
              {t("settings.sections.embedding.statsHeading")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.embedding.chunkCount", { count: chunkCount ?? 0 })}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReindex}
                disabled={reindex.kind === "running" || !project}
                data-testid="embedding-inline-reindex"
              >
                {reindex.kind === "running"
                  ? t("settings.sections.embedding.reindexing", {
                      done: reindex.done,
                      total: reindex.total,
                    })
                  : t("settings.sections.embedding.reindexAll")}
              </Button>

              {legacyCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDropLegacy}
                  disabled={!project}
                  data-testid="embedding-inline-drop-legacy"
                >
                  {t("settings.sections.embedding.dropLegacy")}
                </Button>
              )}
            </div>

            {reindex.kind === "done" && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.reindexDone", { count: reindex.count })}
              </p>
            )}

            {legacyDropped && (
              <p className="text-xs text-muted-foreground">
                {t("settings.sections.embedding.dropLegacyDone")}
              </p>
            )}

            {lastError && (
              <div className="space-y-1">
                <div className="text-xs font-medium">
                  {t("settings.sections.embedding.lastErrorHeading")}
                </div>
                <pre className="max-h-32 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">
                  {lastError}
                </pre>
              </div>
            )}
          </div>
        </>
      )}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}

export function MultimodalInlineConfig() {
  const { t } = useTranslation()
  const multimodalConfig = useWikiStore((s) => s.multimodalConfig)
  const setMultimodalConfig = useWikiStore((s) => s.setMultimodalConfig)
  const { message, saved, failed } = useInlinePersistMessage()

  function persistMultimodal(patch: Partial<MultimodalConfig>) {
    const prev = useWikiStore.getState().multimodalConfig
    const next = { ...prev, ...patch }
    void persistSetting(
      prev,
      next,
      setMultimodalConfig,
      async (value) => {
        const { saveMultimodalConfig } = await import("@/lib/project-store")
        await saveMultimodalConfig(value)
      },
      () => useWikiStore.getState().multimodalConfig,
      { onError: failed },
    ).then((ok) => {
      if (ok) saved()
    })
  }

  return (
    <div className="space-y-4 rounded-md border bg-background p-3" data-testid="task-matrix-inline-vision">
      <div>
        <h4 className="text-sm font-semibold">{t("settings.sections.multimodal.title")}</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.sections.multimodal.description")}
        </p>
      </div>

      <div
        className={`flex items-center justify-between rounded-md border-2 p-3 transition-colors ${
          multimodalConfig.enabled
            ? "border-primary/40 bg-primary/5"
            : "border-border bg-background"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("settings.sections.multimodal.enableLabel")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t("settings.sections.multimodal.enableHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => persistMultimodal({ enabled: !multimodalConfig.enabled })}
          role="switch"
          aria-checked={multimodalConfig.enabled}
          aria-label={t("settings.sections.multimodal.enableLabel")}
          data-testid="multimodal-inline-enabled"
          className="ml-3 flex shrink-0 items-center gap-2"
        >
          <span
            className={`text-xs font-semibold ${
              multimodalConfig.enabled ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {multimodalConfig.enabled
              ? t("settings.sections.multimodal.stateOn")
              : t("settings.sections.multimodal.stateOff")}
          </span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              multimodalConfig.enabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                multimodalConfig.enabled ? "translate-x-4.5" : "translate-x-0.5"
              }`}
            />
          </span>
        </button>
      </div>

      {multimodalConfig.enabled && (
        <>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t("settings.sections.multimodal.useMainLabel")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("settings.sections.multimodal.useMainHint")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => persistMultimodal({ useMainLlm: !multimodalConfig.useMainLlm })}
              role="switch"
              aria-checked={multimodalConfig.useMainLlm}
              aria-label={t("settings.sections.multimodal.useMainLabel")}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                multimodalConfig.useMainLlm ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  multimodalConfig.useMainLlm ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>

          {!multimodalConfig.useMainLlm && (
            <div className="space-y-4 rounded-md border p-3">
              <div className="text-sm font-medium">
                {t("settings.sections.multimodal.dedicatedHeading")}
              </div>

              <div className="space-y-2">
                <Label>{t("settings.sections.multimodal.provider")}</Label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={multimodalConfig.provider}
                  onChange={(e) =>
                    persistMultimodal({ provider: e.target.value as MultimodalConfig["provider"] })
                  }
                  data-testid="multimodal-inline-provider"
                >
                  {PROVIDER_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {multimodalConfig.provider === "ollama" && (
                <div className="space-y-2">
                  <Label>{t("settings.sections.multimodal.ollamaUrl")}</Label>
                  <Input
                    value={multimodalConfig.ollamaUrl}
                    onChange={(e) => persistMultimodal({ ollamaUrl: e.target.value })}
                    placeholder="http://localhost:11434"
                  />
                </div>
              )}

              {(multimodalConfig.provider === "custom" || multimodalConfig.provider === "azure") && (
                <div className="space-y-2">
                  <Label>
                    {multimodalConfig.provider === "azure"
                      ? t("settings.sections.multimodal.azureEndpoint")
                      : t("settings.sections.multimodal.customEndpoint")}
                  </Label>
                  <Input
                    value={multimodalConfig.customEndpoint}
                    onChange={(e) => persistMultimodal({ customEndpoint: e.target.value })}
                    placeholder={
                      multimodalConfig.provider === "azure"
                        ? "https://your-resource.openai.azure.com"
                        : "http://localhost:1234/v1"
                    }
                    data-testid="multimodal-inline-endpoint"
                  />
                  <p className="text-xs text-muted-foreground">
                    {multimodalConfig.provider === "azure"
                      ? t("settings.sections.multimodal.azureEndpointHint")
                      : t("settings.sections.multimodal.customEndpointHint")}
                  </p>
                </div>
              )}

              {multimodalConfig.provider === "azure" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t("settings.sections.multimodal.azureApiVersion")}</Label>
                    <Input
                      value={multimodalConfig.azureApiVersion ?? "2024-10-21"}
                      onChange={(e) => persistMultimodal({ azureApiVersion: e.target.value })}
                      placeholder="2024-10-21"
                      data-testid="multimodal-inline-azure-api-version"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("settings.sections.multimodal.azureApiVersionHint")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("settings.sections.multimodal.azureModelFamily")}</Label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      value={multimodalConfig.azureModelFamily ?? "auto"}
                      onChange={(e) => persistMultimodal({ azureModelFamily: e.target.value as MultimodalConfig["azureModelFamily"] })}
                      data-testid="multimodal-inline-azure-model-family"
                    >
                      <option value="auto">{t("settings.sections.multimodal.azureModelFamilyAuto")}</option>
                      <option value="gpt5">{t("settings.sections.multimodal.azureModelFamilyGpt5")}</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.sections.multimodal.azureModelFamilyHint")}
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <Label>{t("settings.sections.multimodal.apiKey")}</Label>
                <Input
                  type="password"
                  value={multimodalConfig.apiKey}
                  onChange={(e) => persistMultimodal({ apiKey: e.target.value })}
                  placeholder={t("settings.sections.multimodal.apiKeyPlaceholder")}
                  data-testid="multimodal-inline-api-key"
                />
              </div>

              <div className="space-y-2">
                <Label>
                  {multimodalConfig.provider === "azure"
                    ? t("settings.sections.multimodal.azureDeployment")
                    : t("settings.sections.multimodal.model")}
                </Label>
                <Input
                  value={multimodalConfig.model}
                  onChange={(e) => persistMultimodal({ model: e.target.value })}
                  placeholder="e.g. Qwen2.5-VL-7B-Instruct, claude-3-5-sonnet-latest, gemini-2.5-flash"
                  data-testid="multimodal-inline-model"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.sections.multimodal.modelHint")}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-md border p-3">
            <Label>{t("settings.sections.multimodal.concurrency")}</Label>
            <Input
              type="number"
              min={1}
              max={16}
              step={1}
              value={multimodalConfig.concurrency}
              onChange={(e) => {
                const n = Number(e.target.value)
                persistMultimodal({ concurrency: Number.isFinite(n) ? n : 4 })
              }}
              data-testid="multimodal-inline-concurrency"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.sections.multimodal.concurrencyHint")}
            </p>
          </div>

          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {t("settings.sections.multimodal.costHeading")}
            </div>
            <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
              <li>{t("settings.sections.multimodal.costPoint1")}</li>
              <li>{t("settings.sections.multimodal.costPoint2")}</li>
              <li>{t("settings.sections.multimodal.costPoint3")}</li>
              <li>{t("settings.sections.multimodal.costPoint4")}</li>
            </ul>
          </div>
        </>
      )}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}
