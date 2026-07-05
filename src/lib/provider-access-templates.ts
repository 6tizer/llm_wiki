import type {
  RuntimeProfileApiMode,
  RuntimeProfileAuthStyle,
} from "@/commands/runtime-db"

export type ProviderAccessTemplateGroup =
  | "intl-official"
  | "cn-official"
  | "cloud"
  | "local"
  | "gateway"

export type ProviderAccessTemplateAgentSupport = "anthropic-compat" | "none"

export interface ProviderAccessTemplate {
  id: string
  group: ProviderAccessTemplateGroup
  displayName: string
  websiteUrl: string
  apiKeyUrl?: string
  endpoint: string
  endpointCandidates?: string[]
  apiMode: RuntimeProfileApiMode
  authStyle: RuntimeProfileAuthStyle
  defaultModelId: string
  agentSupport: ProviderAccessTemplateAgentSupport
  agentSdkModelId?: string
  suggestedTaskFamilies: string[]
  notes?: string
}

const MODEL_TASKS = ["chat", "ingest", "review", "synthesis", "taxonomy"]
const AGENT_TASKS = [...MODEL_TASKS, "agent"]

function anthropicCompat(
  patch: Omit<ProviderAccessTemplate, "agentSupport" | "apiMode" | "suggestedTaskFamilies"> & {
    apiMode?: RuntimeProfileApiMode
    suggestedTaskFamilies?: string[]
  },
): ProviderAccessTemplate {
  return {
    apiMode: "anthropic-messages",
    agentSupport: "anthropic-compat",
    agentSdkModelId: patch.agentSdkModelId ?? patch.defaultModelId,
    suggestedTaskFamilies: patch.suggestedTaskFamilies ?? AGENT_TASKS,
    ...patch,
  }
}

function modelCallOnly(
  patch: Omit<ProviderAccessTemplate, "agentSupport" | "suggestedTaskFamilies"> & {
    suggestedTaskFamilies?: string[]
  },
): ProviderAccessTemplate {
  return {
    agentSupport: "none",
    suggestedTaskFamilies: patch.suggestedTaskFamilies ?? MODEL_TASKS,
    ...patch,
  }
}

/** Built-in provider access templates for the SPEC-13 quick connect wizard. */
export const PROVIDER_ACCESS_TEMPLATES: ProviderAccessTemplate[] = [
  anthropicCompat({
    id: "anthropic",
    group: "intl-official",
    displayName: "Anthropic",
    websiteUrl: "https://www.anthropic.com",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    endpoint: "https://api.anthropic.com",
    authStyle: "x-api-key",
    defaultModelId: "claude-sonnet-4-6",
  }),
  modelCallOnly({
    id: "openai",
    group: "intl-official",
    displayName: "OpenAI",
    websiteUrl: "https://openai.com",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    endpoint: "https://api.openai.com/v1",
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    defaultModelId: "gpt-5.5",
  }),
  modelCallOnly({
    id: "google-gemini",
    group: "intl-official",
    displayName: "Google Gemini",
    websiteUrl: "https://ai.google.dev",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    apiMode: "google-generate-content",
    authStyle: "x-api-key",
    defaultModelId: "gemini-3.5-flash",
  }),
  anthropicCompat({
    id: "deepseek",
    group: "cn-official",
    displayName: "DeepSeek",
    websiteUrl: "https://www.deepseek.com",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    endpoint: "https://api.deepseek.com/anthropic",
    authStyle: "bearer",
    defaultModelId: "deepseek-v4-pro",
  }),
  anthropicCompat({
    id: "zhipu-glm",
    group: "cn-official",
    displayName: "智谱 GLM",
    websiteUrl: "https://bigmodel.cn",
    apiKeyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    endpoint: "https://open.bigmodel.cn/api/anthropic",
    authStyle: "bearer",
    defaultModelId: "glm-5.1",
  }),
  anthropicCompat({
    id: "kimi",
    group: "cn-official",
    displayName: "Kimi",
    websiteUrl: "https://moonshot.cn",
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    endpoint: "https://api.moonshot.cn/anthropic",
    authStyle: "bearer",
    defaultModelId: "kimi-k2.7-code",
  }),
  anthropicCompat({
    id: "minimax",
    group: "cn-official",
    displayName: "MiniMax",
    websiteUrl: "https://www.minimaxi.com",
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    endpoint: "https://api.minimaxi.com/anthropic",
    authStyle: "bearer",
    defaultModelId: "MiniMax-M2.7",
  }),
  anthropicCompat({
    id: "dashscope",
    group: "cn-official",
    displayName: "阿里百炼",
    websiteUrl: "https://bailian.console.aliyun.com",
    apiKeyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    endpoint: "https://dashscope.aliyuncs.com/apps/anthropic",
    authStyle: "bearer",
    defaultModelId: "qwen-coder-plus",
  }),
  anthropicCompat({
    id: "volcengine-ark",
    group: "cn-official",
    displayName: "字节火山方舟",
    websiteUrl: "https://www.volcengine.com/product/ark",
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    endpoint: "https://ark.cn-beijing.volces.com/api/compatible",
    authStyle: "bearer",
    defaultModelId: "doubao-seed-2-1-pro-260628",
  }),
  anthropicCompat({
    id: "baidu-qianfan",
    group: "cn-official",
    displayName: "百度千帆",
    websiteUrl: "https://qianfan.cloud.baidu.com",
    apiKeyUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    endpoint: "https://qianfan.baidubce.com/anthropic/coding",
    authStyle: "bearer",
    defaultModelId: "qianfan-code-latest",
  }),
  anthropicCompat({
    id: "stepfun",
    group: "cn-official",
    displayName: "阶跃 StepFun",
    websiteUrl: "https://platform.stepfun.com",
    apiKeyUrl: "https://platform.stepfun.com/account-info/interface-key",
    endpoint: "https://api.stepfun.com/step_plan",
    authStyle: "bearer",
    defaultModelId: "step-3.5-flash-2603",
  }),
  anthropicCompat({
    id: "longcat",
    group: "cn-official",
    displayName: "美团 LongCat",
    websiteUrl: "https://longcat.chat",
    apiKeyUrl: "https://longcat.chat",
    endpoint: "https://api.longcat.chat/anthropic",
    authStyle: "bearer",
    defaultModelId: "LongCat-2.0",
  }),
  anthropicCompat({
    id: "ant-ling",
    group: "cn-official",
    displayName: "蚂蚁百灵",
    websiteUrl: "https://www.tbox.cn",
    apiKeyUrl: "https://www.tbox.cn",
    endpoint: "https://api.tbox.cn/api/anthropic",
    authStyle: "bearer",
    defaultModelId: "Ling-2.5-1T",
  }),
  anthropicCompat({
    id: "xiaomi-mimo",
    group: "cn-official",
    displayName: "小米 MiMo",
    websiteUrl: "https://www.xiaomimimo.com",
    apiKeyUrl: "https://www.xiaomimimo.com",
    endpoint: "https://api.xiaomimimo.com/anthropic",
    authStyle: "bearer",
    defaultModelId: "mimo-v2.5-pro",
  }),
  anthropicCompat({
    id: "kuaishou-kat-coder",
    group: "cn-official",
    displayName: "快手 KAT-Coder",
    websiteUrl: "https://vanchin.streamlake.ai",
    apiKeyUrl: "https://vanchin.streamlake.ai",
    endpoint: "https://vanchin.streamlake.ai/api/gateway/v1/endpoints/{ENDPOINT_ID}/claude-code-proxy",
    authStyle: "bearer",
    defaultModelId: "KAT-Coder-Pro V1",
    notes: "端点中的 {ENDPOINT_ID} 需要替换为控制台里的实际 endpoint id。",
  }),
  anthropicCompat({
    id: "aws-bedrock",
    group: "cloud",
    displayName: "AWS Bedrock",
    websiteUrl: "https://aws.amazon.com/bedrock",
    apiKeyUrl: "https://console.aws.amazon.com/bedrock",
    endpoint: "https://bedrock-runtime.us-east-1.amazonaws.com",
    authStyle: "none",
    defaultModelId: "anthropic.claude-sonnet-4-6",
    notes: "高级：需要 AWS 凭证族，运行时会使用本机 AWS credential chain。向导内测试不支持 SigV4，预期失败，请创建后以实际任务验证。",
  }),
  modelCallOnly({
    id: "azure-openai",
    group: "cloud",
    displayName: "Azure OpenAI",
    websiteUrl: "https://azure.microsoft.com/products/ai-services/openai-service",
    apiKeyUrl: "https://portal.azure.com",
    endpoint: "https://your-resource.openai.azure.com/openai/deployments/your-deployment",
    apiMode: "openai-chat-completions",
    authStyle: "api-key",
    defaultModelId: "gpt-5.5",
    notes: "将 endpoint 中的 resource 和 deployment 替换为 Azure OpenAI 部署值。",
  }),
  modelCallOnly({
    id: "ollama",
    group: "local",
    displayName: "Ollama",
    websiteUrl: "https://ollama.com",
    apiKeyUrl: "https://ollama.com",
    endpoint: "http://localhost:11434",
    endpointCandidates: ["http://localhost:11434"],
    apiMode: "openai-chat-completions",
    authStyle: "none",
    defaultModelId: "llama3.1",
  }),
  modelCallOnly({
    id: "lm-studio",
    group: "local",
    displayName: "LM Studio",
    websiteUrl: "https://lmstudio.ai",
    apiKeyUrl: "https://lmstudio.ai",
    endpoint: "http://localhost:1234/v1",
    endpointCandidates: ["http://localhost:1234/v1"],
    apiMode: "openai-chat-completions",
    authStyle: "none",
    defaultModelId: "local-model",
  }),
  anthropicCompat({
    id: "openrouter",
    group: "gateway",
    displayName: "OpenRouter",
    websiteUrl: "https://openrouter.ai",
    apiKeyUrl: "https://openrouter.ai/keys",
    endpoint: "https://openrouter.ai/api",
    authStyle: "bearer",
    defaultModelId: "anthropic/claude-sonnet-5",
  }),
  anthropicCompat({
    id: "newapi",
    group: "gateway",
    displayName: "NewAPI/自定义网关",
    websiteUrl: "https://github.com/Calcium-Ion/new-api",
    apiKeyUrl: "https://github.com/Calcium-Ion/new-api",
    endpoint: "https://your-newapi.example.com/anthropic",
    authStyle: "bearer",
    defaultModelId: "claude-sonnet-4-6",
    notes: "将 endpoint 替换为你的 Anthropic-compatible 网关地址；agent 可用性以测试结果为准。",
  }),
  modelCallOnly({
    id: "custom",
    group: "gateway",
    displayName: "完全自定义",
    websiteUrl: "https://example.com",
    apiKeyUrl: "https://example.com",
    endpoint: "https://your-provider.example.com/v1",
    apiMode: "openai-chat-completions",
    authStyle: "bearer",
    defaultModelId: "custom-model",
    notes: "按实际供应商修改 endpoint、model 和鉴权方式；首发仅自动创建 model-call profile。",
  }),
]

/** Finds a provider access template by id. */
export function providerAccessTemplateById(id: string): ProviderAccessTemplate | undefined {
  return PROVIDER_ACCESS_TEMPLATES.find((template) => template.id === id)
}
