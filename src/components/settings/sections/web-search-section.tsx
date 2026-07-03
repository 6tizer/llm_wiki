import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeAnyTxtConfig } from "@/lib/anytxt-search";
import { persistSetting } from "@/lib/store-helpers";
import {
	resolveSearchConfig,
	SEARXNG_CATEGORY_OPTIONS,
	SERPAPI_ENGINE_OPTIONS,
} from "@/lib/web-search";
import {
	type AnyTxtConfig,
	type DeepResearchSource,
	type SearchApiConfig,
	type SearchProvider,
	type SearchProviderOverride,
	useWikiStore,
} from "@/stores/wiki-store";

const SEARCH_PROVIDERS = [
	{
		id: "ollama",
		label: "Ollama",
		hint: "Ollama Web Search API",
		keyPlaceholder: "Enter your Ollama API key (ollama.com)",
		needsApiKey: true,
	},
	{
		id: "tavily",
		label: "Tavily",
		hint: "General web search for Deep Research",
		keyPlaceholder: "Enter your Tavily API key (tavily.com)",
		needsApiKey: true,
	},
	{
		id: "serpapi",
		label: "SerpApi",
		hint: "Google, Bing, DuckDuckGo, Scholar, News, Images, Videos, YouTube",
		keyPlaceholder: "Enter your SerpApi API key (serpapi.com)",
		needsApiKey: true,
	},
	{
		id: "searxng",
		label: "SearXNG",
		hint: "Self-hosted metasearch via the SearXNG JSON API",
		urlPlaceholder: "https://search.example.com",
		needsApiKey: false,
	},
	{
		id: "exa",
		label: "Exa",
		hint: "AI-powered web search with full page content for Deep Research",
		keyPlaceholder: "Enter your Exa API key (exa.ai)",
		needsApiKey: true,
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		hint: "Web search with optional Firecrawl API key",
		keyPlaceholder: "Optional Firecrawl API key (firecrawl.dev)",
		needsApiKey: true,
		apiKeyOptional: true,
	},
] as const;

function SaveFailedBadge({
	id,
	errorId,
	errorMessage,
	t,
}: {
	id: string;
	errorId: string | null;
	errorMessage: string | null;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	if (errorId !== id || !errorMessage) return null;
	return (
		<span
			className="shrink-0 text-[10px] text-destructive"
			title={t("settings.sections.webSearch.saveFailedTitle", { message: errorMessage })}
		>
			{t("settings.sections.webSearch.saveFailedBadge")}
		</span>
	);
}

export function WebSearchSection() {
	const { t } = useTranslation();
	const searchApiConfig = useWikiStore((s) => s.searchApiConfig);
	const setSearchApiConfig = useWikiStore((s) => s.setSearchApiConfig);
	const resolvedConfig = resolveSearchConfig(searchApiConfig);
	const anyTxtConfig = normalizeAnyTxtConfig(resolvedConfig.anyTxt);
	const anyTxtFilterDir = resolvedConfig.anyTxt?.filterDir ?? "";
	const showBroadAnyTxtWarning = isBroadAnyTxtFilterDir(anyTxtFilterDir);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [savedId, setSavedId] = useState<string | null>(null);
	const [errorId, setErrorId] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	async function saveSearchConfig(next: SearchApiConfig) {
		const { saveSearchApiConfig } = await import("@/lib/project-store");
		await saveSearchApiConfig(next);
	}

	async function persistNext(id: string, next: SearchApiConfig): Promise<boolean> {
		const ok = await persistSetting(
			searchApiConfig,
			next,
			setSearchApiConfig,
			saveSearchConfig,
			() => useWikiStore.getState().searchApiConfig,
			{
				onError: (error) => {
					setErrorId(id);
					setErrorMessage(error instanceof Error ? error.message : String(error));
				},
			},
		);
		if (ok) setErrorId((cur) => (cur === id ? null : cur));
		return ok;
	}

	function updateProvider(
		id: Exclude<SearchProvider, "none">,
		patch: SearchProviderOverride,
	) {
		const currentConfigs = resolvedConfig.providerConfigs ?? {};
		const merged = { ...(currentConfigs[id] ?? {}), ...patch };
		const nextConfigs = { ...currentConfigs, [id]: merged };
		const next = resolveSearchConfig({
			...resolvedConfig,
			providerConfigs: nextConfigs,
		});
		void persistNext(id, next).then((ok) => {
			if (!ok) return;
			setSavedId(id);
			setTimeout(() => setSavedId((cur) => (cur === id ? null : cur)), 1500);
		});
	}

	function toggleActive(id: Exclude<SearchProvider, "none">) {
		const nextProvider = resolvedConfig.provider === id ? "none" : id;
		void persistNext(
			id,
			resolveSearchConfig({ ...resolvedConfig, provider: nextProvider }),
		);
	}

	function updateDeepResearchSource(deepResearchSource: DeepResearchSource) {
		void persistNext(
			"deepResearchSource",
			resolveSearchConfig({ ...resolvedConfig, deepResearchSource }),
		);
	}

	function updateAnyTxt(patch: AnyTxtConfig) {
		const next = resolveSearchConfig({
			...resolvedConfig,
			anyTxt: {
				...anyTxtConfig,
				...patch,
			},
		});
		void persistNext("anytxt", next).then((ok) => {
			if (!ok) return;
			setSavedId("anytxt");
			setTimeout(
				() => setSavedId((cur) => (cur === "anytxt" ? null : cur)),
				1500,
			);
		});
	}

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-xl font-semibold">
					{t("settings.sections.webSearch.title")}
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{t("settings.sections.webSearch.description")}
				</p>
			</div>

			<div className="space-y-2 rounded-lg border p-3">
				<div>
					<Label>{t("settings.sections.webSearch.deepResearchSources")}</Label>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("settings.sections.webSearch.deepResearchSourcesHint")}
					</p>
				</div>
				<div className="grid gap-2 sm:grid-cols-3">
					{(
						[
							["web", t("settings.sections.webSearch.sourceWeb")],
							["anytxt", t("settings.sections.webSearch.sourceAnyTxt")],
							["both", t("settings.sections.webSearch.sourceBoth")],
						] as const
					).map(([value, label]) => (
						<button
							key={value}
							type="button"
							onClick={() => updateDeepResearchSource(value)}
							className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
								(resolvedConfig.deepResearchSource ?? "web") === value
									? "border-primary bg-primary text-primary-foreground"
									: "border-border hover:bg-accent"
							}`}
						>
							{label}
						</button>
					))}
				</div>
				{errorId === "deepResearchSource" && errorMessage && (
					<p className="text-xs text-destructive">
						{t("settings.sections.webSearch.saveFailedTitle", { message: errorMessage })}
					</p>
				)}
			</div>

      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>{t("settings.sections.webSearch.anyTxtTitle")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.sections.webSearch.anyTxtDescription")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedId === "anytxt" && (
              <span className="text-[10px] text-emerald-600">
                {t("settings.sections.webSearch.savedBadge")}
              </span>
            )}
            <SaveFailedBadge id="anytxt" errorId={errorId} errorMessage={errorMessage} t={t} />
            {anyTxtConfig.enabled && (
              <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                {t("settings.sections.webSearch.activeBadge")}
              </span>
            )}
            <button
              type="button"
              onClick={() => updateAnyTxt({ enabled: !anyTxtConfig.enabled })}
              className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                anyTxtConfig.enabled
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
              }`}
              aria-label={anyTxtConfig.enabled ? t("settings.sections.webSearch.deactivate") : t("settings.sections.webSearch.activate")}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
                  anyTxtConfig.enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtEndpoint")}</Label>
            <Input
              value={anyTxtConfig.endpoint}
              onChange={(e) => updateAnyTxt({ endpoint: e.target.value })}
              placeholder="http://127.0.0.1:9920"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtLimit")}</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={anyTxtConfig.limit}
              onChange={(e) => {
                const value = e.target.value.trim()
                updateAnyTxt({ limit: value ? Number(value) : undefined })
              }}
              placeholder="20"
            />
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtFilterDir")}</Label>
            <Input
              value={anyTxtFilterDir}
              onChange={(e) => updateAnyTxt({ filterDir: e.target.value })}
              placeholder={t("settings.sections.webSearch.anyTxtFilterDirPlaceholder")}
            />
            {showBroadAnyTxtWarning && (
              <p className="text-xs text-destructive">
                {t("settings.sections.webSearch.anyTxtBroadDirWarning")}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("settings.sections.webSearch.anyTxtFilterExt")}</Label>
            <Input
              value={anyTxtConfig.filterExt}
              onChange={(e) => updateAnyTxt({ filterExt: e.target.value })}
              placeholder="*"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.webSearch.anyTxtHint")}
        </p>
      </div>

			<div className="space-y-2">
				<Label>{t("settings.sections.webSearch.webProviders")}</Label>
				{SEARCH_PROVIDERS.map((provider) => {
					const override = resolvedConfig.providerConfigs?.[provider.id];
					const isActive = resolvedConfig.provider === provider.id;
					const providerLabel =
						provider.id === "firecrawl"
							? t("settings.sections.webSearch.firecrawlLabel")
							: provider.label;
					const providerHint =
						provider.id === "firecrawl"
							? t("settings.sections.webSearch.firecrawlHint")
							: provider.hint;
					const hasConfig =
						provider.id === "searxng"
							? !!override?.searXngUrl
							: !!override?.apiKey;
					const isExpanded = !!expanded[provider.id];
					return (
						<div
							key={provider.id}
							className={`rounded-lg border transition-colors ${
								isActive ? "border-primary/60 bg-primary/5" : "border-border"
							}`}
						>
							<div className="flex items-center gap-3 px-3 py-2.5">
								<button
									type="button"
									onClick={() =>
										setExpanded((prev) => ({
											...prev,
											[provider.id]: !prev[provider.id],
										}))
									}
									className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
									title={
										isExpanded
											? t("settings.sections.webSearch.collapse")
											: t("settings.sections.webSearch.expand")
									}
								>
									{isExpanded ? (
										<ChevronDown className="h-4 w-4" />
									) : (
										<ChevronRight className="h-4 w-4" />
									)}
								</button>

								<button
									type="button"
									onClick={() =>
										setExpanded((prev) => ({
											...prev,
											[provider.id]: !prev[provider.id],
										}))
									}
									className="min-w-0 flex-1 text-left"
								>
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">
											{providerLabel}
										</span>
										{hasConfig && !isActive && (
											<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
												{t("settings.sections.webSearch.configuredBadge")}
											</span>
										)}
										{isActive && (
											<span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
												{t("settings.sections.webSearch.activeBadge")}
											</span>
										)}
										{savedId === provider.id && (
											<span className="shrink-0 text-[10px] text-emerald-600">
												{t("settings.sections.webSearch.savedBadge")}
											</span>
										)}
										<SaveFailedBadge id={provider.id} errorId={errorId} errorMessage={errorMessage} t={t} />
									</div>
									<div className="mt-0.5 truncate text-xs text-muted-foreground">
										{providerHint}
									</div>
								</button>

								<button
									type="button"
									onClick={() => toggleActive(provider.id)}
									className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
										isActive
											? "border-primary bg-primary"
											: "border-muted-foreground/30 bg-muted-foreground/20 hover:bg-muted-foreground/30"
									}`}
									aria-label={
										isActive
											? t("settings.sections.webSearch.deactivate")
											: t("settings.sections.webSearch.activate")
									}
								>
									<span
										className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-transform ${
											isActive ? "translate-x-4" : "translate-x-0.5"
										}`}
									/>
								</button>
							</div>

							{isExpanded && (
								<div className="space-y-4 border-t bg-background/50 px-4 py-3">
									{provider.needsApiKey ? (
										<div className="space-y-2">
											<Label>
												{provider.id === "firecrawl"
													? t("settings.sections.webSearch.firecrawlApiKey")
													: t("settings.apiKey")}
											</Label>
											<Input
												type="password"
												value={override?.apiKey ?? ""}
												onChange={(e) =>
													updateProvider(provider.id, {
														apiKey: e.target.value,
													})
												}
												placeholder={
													provider.id === "firecrawl"
														? t("settings.sections.webSearch.firecrawlKeyPlaceholder")
														: provider.keyPlaceholder
												}
											/>
											{provider.id === "firecrawl" && (
												<p className="text-xs text-muted-foreground">
													{t("settings.sections.webSearch.firecrawlOptionalHint")}
												</p>
											)}
											{provider.id === "ollama" && (
												<p className="text-xs text-muted-foreground">
													{t("settings.sections.webSearch.ollamaHint")}
												</p>
											)}
										</div>
									) : (
										<div className="space-y-2">
											<Label>
												{t("settings.sections.webSearch.instanceUrl")}
											</Label>
											<Input
												value={
													override?.searXngUrl ??
													resolvedConfig.searXngUrl ??
													""
												}
												onChange={(e) =>
													updateProvider("searxng", {
														searXngUrl: e.target.value,
													})
												}
												placeholder={provider.urlPlaceholder}
											/>
											<p className="text-xs text-muted-foreground">
												{t("settings.sections.webSearch.searxngJsonHint")}
											</p>
										</div>
									)}

									{provider.id === "serpapi" && (
										<SerpApiEnginePicker
											value={
												override?.serpApiEngine ??
												resolvedConfig.serpApiEngine ??
												"google"
											}
											onChange={(serpApiEngine) =>
												updateProvider("serpapi", { serpApiEngine })
											}
										/>
									)}

									{provider.id === "searxng" && (
										<SearXngCategoryPicker
											value={
												override?.searXngCategories ??
												resolvedConfig.searXngCategories ?? ["general"]
											}
											onChange={(searXngCategories) =>
												updateProvider("searxng", { searXngCategories })
											}
										/>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function isBroadAnyTxtFilterDir(value: string): boolean {
	const trimmed = value.trim().replace(/\\/g, "/");
	if (!trimmed) return false;
	if (trimmed === "/" || trimmed === "~") return true;
	if (/^\/\/[^/]+\/[^/]+\/?$/.test(trimmed)) return true;
	if (/^[A-Za-z]:\/?$/.test(trimmed)) return true;
	return /^\/(?:Users|home|Volumes|mnt|media)?\/?$/.test(trimmed);
}

function SearXngCategoryPicker({
	value,
	onChange,
}: {
	value: string[];
	onChange: (value: string[]) => void;
}) {
	const { t } = useTranslation();
	const selected = value.length > 0 ? value : ["general"];

	function toggle(category: string) {
		const next = selected.includes(category)
			? selected.filter((item) => item !== category)
			: [...selected, category];
		onChange(next.length > 0 ? next : ["general"]);
	}

	return (
		<div className="space-y-2">
			<Label>{t("settings.sections.webSearch.searchCategories")}</Label>
			<div className="flex flex-wrap gap-1.5">
				{SEARXNG_CATEGORY_OPTIONS.map((category) => (
					<button
						key={category.value}
						type="button"
						onClick={() => toggle(category.value)}
						className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
							selected.includes(category.value)
								? "border-primary bg-primary text-primary-foreground"
								: "border-border hover:bg-accent"
						}`}
						title={category.hint}
					>
						{category.label}
					</button>
				))}
			</div>
			<p className="text-xs text-muted-foreground">
				{t("settings.sections.webSearch.searxngCategoriesHint")}
			</p>
		</div>
	);
}

function SerpApiEnginePicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const { t } = useTranslation();
	const isCustom =
		value.length > 0 && !SERPAPI_ENGINE_OPTIONS.some((e) => e.value === value);

	return (
		<div className="space-y-2">
			<Label>{t("settings.sections.webSearch.searchEngine")}</Label>
			<div className="flex flex-wrap gap-1.5">
				{SERPAPI_ENGINE_OPTIONS.map((engine) => (
					<button
						key={engine.value}
						type="button"
						onClick={() => onChange(engine.value)}
						className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
							value === engine.value
								? "border-primary bg-primary text-primary-foreground"
								: "border-border hover:bg-accent"
						}`}
						title={engine.hint}
					>
						{engine.label}
					</button>
				))}
			</div>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={t("settings.sections.webSearch.customSerpApiPlaceholder")}
			/>
			{isCustom && (
				<p className="text-xs text-muted-foreground">
					{t("settings.sections.webSearch.customSerpApiHint")}
				</p>
			)}
		</div>
	);
}
