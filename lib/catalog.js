/**
 * Curated free-tier provider catalog.
 *
 * Every provider in this file meets the plugin's inclusion rule: its chat
 * models can be called in Germany with a self-registered account and an API
 * key, on a permanently free tier or free allotment, without storing a
 * payment method. Providers that switched to card-gated trials (Cerebras,
 * SambaNova), retired their free API (GitHub Models), or stopped granting
 * free-account credits (Hugging Face Inference Providers) are deliberately
 * absent. Free-tier facts were last reviewed in October 2026; the model
 * allowlists are best-effort snapshots and each provider dialog can refresh
 * them live with "Fetch available models".
 *
 * This module is dependency-free so the selection and parsing logic stays
 * unit-testable without a Harness runtime.
 *
 * @module freemodels2dsh/catalog
 */

/** Fallback capacities when an endpoint does not disclose them. */
export const DEFAULT_CONTEXT_WINDOW = 32768
export const DEFAULT_MAX_TOKENS = 8192

/** Normalize one raw model row coming from a provider's /models endpoint. */
function modelEntry(id, raw = {}) {
  const capacity = (...candidates) => {
    for (const candidate of candidates) {
      if (Number.isInteger(candidate) && candidate > 0) return candidate
    }
  }
  return {
    id: String(id),
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : String(id),
    contextWindow: capacity(raw.contextWindow, raw.context_window, raw.context_length,
      raw.max_input_tokens, raw.limit?.context) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: capacity(raw.maxTokens, raw.max_output_tokens, raw.max_tokens,
      raw.limit?.output, raw.max_completion_length) ?? DEFAULT_MAX_TOKENS,
  }
}

const textModel = (id, name, contextWindow, maxTokens) => ({ id, name, contextWindow, maxTokens })

/**
 * The supported free providers, in display order. `route` is the Harness
 * adapter route key; the `fm-` prefix keeps it disjoint from routes the
 * built-in pi-ai adapter already owns (for example `openrouter`).
 */
export const PROVIDERS = Object.freeze([
  {
    id: 'openrouter',
    route: 'fm-openrouter',
    name: 'OpenRouter Free Models',
    signupUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/limits',
    baseUrl: 'https://openrouter.ai/api/v1',
    accountIdField: null,
    keyPattern: /^sk-or-/u,
    freeNote: 'Only model IDs ending in :free with zero pricing are listed. The base free allowance is 50 requests/day and 20 RPM without any purchase.',
    defaultModels: [
      textModel('deepseek/deepseek-r1:free', 'DeepSeek R1 (Free)', 131072, 32768),
      textModel('meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B Instruct (Free)', 131072, 32768),
      textModel('google/gemini-2.0-flash-exp:free', 'Gemini 2.0 Flash Experimental (Free)', 1048576, 32768),
    ],
    discovery: {
      path: '/models',
      // OpenRouter publishes pricing per model; a free model carries the
      // :free suffix and zero prompt/completion prices.
      filter: row => {
        const id = String(row?.id ?? '')
        const price = row?.pricing ?? {}
        const freePrice = Number(price.prompt) === 0 && Number(price.completion) === 0
        return id.endsWith(':free') && freePrice
      },
    },
  },
  {
    id: 'gemini',
    route: 'fm-gemini',
    name: 'Google AI Studio (Gemini Free Tier)',
    signupUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    accountIdField: null,
    keyPattern: /^AIza/u,
    freeNote: 'Flash and Flash-Lite families plus Gemma are free of charge on the free tier with a Google account; Pro, Omni and image models are paid and stay unlisted. Enabling billing on the Google Cloud project removes the free tier.',
    defaultModels: [
      textModel('gemini-3.8-flash', 'Gemini 3.8 Flash (Free)', 1048576, 65536),
      textModel('gemini-3.6-flash', 'Gemini 3.6 Flash (Free)', 1048576, 65536),
      textModel('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite (Free)', 1048576, 65536),
      textModel('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite (Free)', 1048576, 65536),
    ],
    discovery: {
      path: '/models',
      // The OpenAI-compatible listing names every model the key can see, so
      // the free family has to be filtered explicitly.
      filter: row => {
        const id = String(row?.id ?? '').toLowerCase()
        if (id.length === 0) return false
        if (/(^|-)(pro|omni|nano|image|live|tts|embedding)/u.test(id)) return false
        return /(^|-)flash(-|$)|(^|-)gemma/u.test(id)
      },
    },
  },
  {
    id: 'groq',
    route: 'fm-groq',
    name: 'Groq Free Tier',
    signupUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/rate-limits',
    baseUrl: 'https://api.groq.com/openai/v1',
    accountIdField: null,
    keyPattern: /^gsk_/u,
    freeNote: 'Production chat models on a free key share the developer-tier limits (around 30 RPM and 1,000 requests/day per model). No payment method is required.',
    defaultModels: [
      textModel('openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 131072, 32768),
      textModel('openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)', 131072, 32768),
      textModel('qwen/qwen3-27b', 'Qwen3 27B (Groq)', 131072, 32768),
    ],
    discovery: {
      path: '/models',
      filter: row => row?.active !== false && (row?.type === undefined || String(row.type).toLowerCase().includes('chat')),
    },
  },
  {
    id: 'mistral',
    route: 'fm-mistral',
    name: 'Mistral La Plateforme (Free Mode)',
    signupUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api/',
    baseUrl: 'https://api.mistral.ai/v1',
    accountIdField: null,
    // Mistral keys are opaque 32-character strings with no stable prefix.
    keyPattern: null,
    freeNote: 'Every account starts in Free mode without a credit card (SMS verification only). The listing is restricted to the families free keys can actually call; paid-only models are never offered.',
    defaultModels: [
      textModel('open-mistral-nemo', 'Mistral Nemo (Free)', 128000, 32768),
      textModel('ministral-latest', 'Ministral (Free)', 128000, 32768),
      textModel('codestral-latest', 'Codestral (Free)', 256000, 32768),
    ],
    discovery: {
      path: '/models',
      // /models names the whole catalog including paid models, so discovery
      // may only confirm the curated free families rather than adopt rows.
      allowlist: /^(open-mistral-nemo|ministral|codestral|mistral-small)(-|$)/u,
      filter: row => {
        const id = String(row?.id ?? '')
        return /^(open-mistral-nemo|ministral|codestral|mistral-small)(-|$)/u.test(id)
      },
    },
  },
  {
    id: 'nvidia',
    route: 'fm-nvidia',
    name: 'NVIDIA build (Free Endpoints)',
    signupUrl: 'https://build.nvidia.com/settings/api-keys',
    docsUrl: 'https://docs.api.nvidia.com/',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    accountIdField: null,
    keyPattern: /^nvapi-/u,
    freeNote: 'Models tagged "Free Endpoint" on build.nvidia.com are rate-limited (roughly 40 RPM per model) and need no payment method. The free key is for prototyping and development, not production.',
    defaultModels: [
      textModel('meta/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct (NVIDIA)', 131072, 32768),
      textModel('deepseek-ai/deepseek-r1', 'DeepSeek R1 (NVIDIA)', 131072, 32768),
      textModel('qwen/qwen2.5-coder-32b-instruct', 'Qwen2.5 Coder 32B (NVIDIA)', 131072, 32768),
      textModel('mistralai/mistral-small-24b-instruct-2501', 'Mistral Small 24B (NVIDIA)', 131072, 32768),
    ],
    discovery: {
      path: '/models',
      // The integrate catalog is itself the free-endpoint catalog for a
      // developer key; only vendor-prefixed chat entries are useful here.
      filter: row => /^[\w.-]+\/[\w.-]+$/u.test(String(row?.id ?? '')),
    },
  },
  {
    id: 'cloudflare',
    route: 'fm-cloudflare',
    name: 'Cloudflare Workers AI (Free Allocation)',
    signupUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    // The account id is part of the endpoint, therefore it lives on each account.
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    nativeBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}',
    accountIdField: {
      key: 'accountId',
      pattern: /^[a-f0-9]{32}$/u,
    },
    keyPattern: null,
    freeNote: 'The Workers Free plan includes 10,000 Neurons per day (reset at 00:00 UTC) with no card on file. Each account needs its Cloudflare Account ID in addition to the API token. Some frontier models require a paid plan and are not part of the curated list.',
    defaultModels: [
      textModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B FP8 (Workers AI)', 32768, 8192),
      textModel('@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (Workers AI)', 131072, 16384),
      textModel('@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B (Workers AI)', 262144, 16384),
      textModel('@cf/zai-org/glm-4.7-flash', 'GLM 4.7 Flash (Workers AI)', 131072, 16384),
    ],
    discovery: {
      // The native model catalog is a GET REST resource, not mirrored under
      // /ai/v1 (the POST-only /ai/models/search would require a request body).
      nativePath: '/ai/models',
      filter: row => {
        const id = String(row?.id ?? '')
        const task = String(row?.task?.name ?? row?.task ?? '').toLowerCase()
        // Exact family match: "Text-to-Image" also contains the word "text".
        return id.startsWith('@cf/') && (task.includes('text generation') || task.length === 0)
      },
    },
  },
  {
    id: 'cohere',
    route: 'fm-cohere',
    name: 'Cohere Trial Key',
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/rate-limits',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    accountIdField: null,
    keyPattern: null,
    freeNote: 'A free trial key is created at signup with no card: 1,000 API calls/month and 20 chat RPM, for evaluation and non-commercial use.',
    defaultModels: [
      textModel('command-r-plus', 'Command R+ (Trial)', 131072, 16384),
      textModel('command-r', 'Command R (Trial)', 131072, 16384),
      textModel('command-r7b-12-2024', 'Command R7B (Trial)', 131072, 16384),
    ],
    discovery: {
      path: '/models',
      filter: row => /^command/u.test(String(row?.id ?? '')),
    },
  },
  {
    id: 'featherless',
    route: 'fm-featherless',
    name: 'Featherless.ai Free Tier',
    signupUrl: 'https://featherless.ai/settings/account',
    docsUrl: 'https://featherless.ai/docs/pricing/',
    baseUrl: 'https://api.featherless.ai/v1',
    accountIdField: null,
    keyPattern: null,
    freeNote: 'Free-tier inference with queued requests and no payment method. Only models marked free and currently available are listed.',
    defaultModels: [
      textModel('meta-llama/Llama-3.3-70B-Instruct', 'Llama 3.3 70B Instruct (Featherless)', 131072, 32768),
      textModel('Qwen/Qwen2.5-72B-Instruct', 'Qwen2.5 72B Instruct (Featherless)', 131072, 32768),
    ],
    discovery: {
      path: '/models',
      filter: row => {
        if (row?.available === false) return false
        const tier = String(row?.tier ?? '').toLowerCase()
        const tiers = Array.isArray(row?.tiers) ? row.tiers.map(item => String(item).toLowerCase()) : []
        const isFree = tier === 'free' || tiers.includes('free') || tier.length === 0
        return isFree && /^[\w.-]+\/[\w.-]+$/u.test(String(row?.id ?? ''))
      },
    },
  },
])

const PROVIDER_BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]))
const PROVIDER_BY_ROUTE = new Map(PROVIDERS.map(provider => [provider.route, provider]))

export function getProvider(id) {
  return PROVIDER_BY_ID.get(id)
}

export function getProviderByRoute(route) {
  return PROVIDER_BY_ROUTE.get(route)
}

export function allRoutes() {
  return PROVIDERS.map(provider => provider.route)
}

/** Resolve the request base URL, expanding the Cloudflare account-id template. */
export function resolveBaseUrl(provider, account = {}) {
  if (provider.accountIdField) {
    const accountId = String(account.accountId ?? '').trim()
    if (!provider.accountIdField.pattern.test(accountId)) {
      throw new Error(`provider "${provider.id}" requires a valid 32-character account id`)
    }
    return provider.baseUrl.replace('{accountId}', accountId)
  }
  return provider.baseUrl
}

/** Resolve the native (non-OpenAI) base URL for providers that need one. */
export function resolveNativeBaseUrl(provider, account = {}) {
  if (!provider.nativeBaseUrl) return resolveBaseUrl(provider, account)
  const accountId = String(account.accountId ?? '').trim()
  return provider.nativeBaseUrl.replace('{accountId}', accountId)
}

/**
 * Convert a raw /models payload into the plugin's model shape, applying the
 * provider's free-tier filter. Unknown or malformed rows are skipped rather
 * than failing the whole refresh.
 */
export function filterDiscovery(provider, payload) {
  const rows = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.result) ? payload.result
      : Array.isArray(payload) ? payload : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    let keep
    try {
      keep = provider.discovery.filter(row)
    } catch {
      keep = false
    }
    if (!keep) continue
    const id = String(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    models.push(modelEntry(id, row))
  }
  return models
}

/** The static free-model snapshot a provider starts with. */
export function defaultModelsFor(providerId) {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`unknown provider "${providerId}"`)
  return provider.defaultModels.map(model => ({ ...model }))
}
