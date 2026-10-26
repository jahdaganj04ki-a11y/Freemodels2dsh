/**
 * Minimal model-catalog fetch for the native-route variant.
 *
 * Unlike the gateway variant there is no cache and no fallback: the catalog is
 * only read (a) by the setup CLI while generating the route patch and (b) once at
 * plugin start for a log line. The harness itself does not need it.
 */
export const DEFAULT_API_BASE = 'https://api.arena.ai/v1'
const DISCOVERY_TIMEOUT_MS = 15_000

function pick(payload) {
  if (Array.isArray(payload)) return payload
  for (const key of ['data', 'models', 'items']) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  return []
}

function positive(...values) {
  for (const value of values) {
    const number = Array.isArray(value) ? Number(value[0]) : Number(value)
    if (Number.isFinite(number) && number > 0) return Math.trunc(number)
  }
  return undefined
}

function modalities(entry) {
  const raw = entry.input_modalities ?? entry.inputModalities ?? entry.modalities ?? entry.input
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw).filter(([, enabled]) => enabled === true).map(([name]) => name)
      : []
  const kept = [...new Set(list
    .filter(item => typeof item === 'string')
    .map(item => item.toLowerCase())
    .filter(item => ['text', 'image', 'audio', 'video', 'pdf'].includes(item)))]
  return kept.length > 0 ? kept : undefined
}

/** Normalizes Arena's `/models` payload into the fields the route patch uses. */
export function normalizeCatalog(payload) {
  const seen = new Set()
  const models = []
  for (const entry of pick(payload)) {
    if (!entry || typeof entry !== 'object') continue
    const id = entry.id ?? entry.model ?? entry.slug
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue
    seen.add(id)
    const model = { id: id.trim() }
    const name = entry.display_name ?? entry.displayName ?? entry.name ?? entry.label
    if (typeof name === 'string' && name.trim()) model.name = name.trim()
    const contextWindow = positive(entry.context_window, entry.context_length, entry.contextWindow, entry.max_context_tokens)
    if (contextWindow) model.contextWindow = contextWindow
    const maxTokens = positive(entry.max_completion_tokens, entry.max_output_tokens, entry.max_tokens, entry.maxTokens)
    if (maxTokens) model.maxTokens = maxTokens
    const input = modalities(entry)
    if (input) model.input = input
    models.push(model)
  }
  return models
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])

export function normalizeApiBase(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  if (!text) throw new Error('An Arena API base URL is required')
  const url = new URL(text)
  if (url.protocol === 'https:') return text
  // Anything that holds the key must be TLS; a loopback stand-in (tests, a local
  // proxy on the same machine) is the one deliberate exception.
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname.replace(/^\[|\]$/g, ''))) return text
  throw new Error('The Arena API base URL must use https (http is only allowed for loopback)')
}

/**
 * @returns {Promise<{models: object[], fetchedAt: number}>}
 */
export async function fetchCatalog({ apiBase = DEFAULT_API_BASE, apiKey, fetchImpl = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS, signal } = {}) {
  if (!apiKey) throw new Error('No Arena API key available')
  const base = normalizeApiBase(apiBase)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  if (timer.unref) timer.unref()
  const forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Arena answered HTTP ${response.status} for GET /models${await detail(response)}`)
    const models = normalizeCatalog(await response.json())
    if (models.length === 0) throw new Error('Arena returned an empty model catalog')
    return { models, fetchedAt: Date.now() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

async function detail(response) {
  try {
    const text = (await response.text()).slice(0, 300).replace(/\s+/g, ' ')
    return text ? ` (${text})` : ''
  } catch {
    return ''
  }
}
