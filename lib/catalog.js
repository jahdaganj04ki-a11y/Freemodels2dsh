/**
 * Model catalog handling for the Arena gateway.
 *
 * Arena's OpenAI-compatible gateway exposes `GET {base}/models`. Field names
 * beyond `id` are not guaranteed, so the normalizer accepts the common spellings
 * (OpenAI, AI-SDK, LiteLLM and Arena's own docs all differ slightly) and simply
 * omits what it cannot find. A catalog that cannot be fetched degrades to the
 * last known good copy on disk and finally to {@link FALLBACK_MODELS}, so a DSH
 * model picker never goes empty because of a network hiccup.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  FALLBACK_MODELS,
} from './defaults.js'

const NAME_KEYS = ['display_name', 'displayName', 'name', 'label', 'title']
const CONTEXT_KEYS = ['context_window', 'context_length', 'contextWindow', 'contextLength', 'max_context_tokens', 'maxContextTokens', 'context']
const MAX_TOKENS_KEYS = ['max_completion_tokens', 'max_output_tokens', 'max_tokens', 'maxTokens', 'output_tokens', 'completion_tokens']
const INPUT_KEYS = ['input_modalities', 'inputModalities', 'modalities', 'input']
const CREATED_KEYS = ['created', 'created_at', 'createdAt']

function numbersFrom(value) {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'number' && Number.isFinite(item) && item > 0)
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return [value]
  return []
}

function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstPositiveInteger(source, keys) {
  for (const key of keys) {
    const candidates = numbersFrom(source[key])
    if (candidates.length > 0) return Math.trunc(Math.max(...candidates))
  }
  return undefined
}

function normalizeInput(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null
      ? Object.entries(value).filter(([, enabled]) => enabled === true).map(([name]) => name)
      : []
  const kept = list
    .filter(item => typeof item === 'string')
    .map(item => item.toLowerCase())
    .filter(item => item === 'text' || item === 'image' || item === 'audio' || item === 'video' || item === 'pdf')
  return kept.length > 0 ? [...new Set(kept)] : undefined
}

function pickEntries(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of ['data', 'models', 'items', 'results']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

/**
 * Normalizes an upstream `/models` payload into the gateway's internal shape.
 * Unknown entries are dropped rather than guessed at; duplicates keep the first
 * occurrence so an upstream ordering (usually newest/most useful first) wins.
 *
 * @param {unknown} payload
 * @returns {{id: string, name: string, contextWindow?: number, maxTokens?: number, input?: string[], created?: number}[]}
 */
export function normalizeModels(payload) {
  const entries = pickEntries(payload)
  const seen = new Set()
  const models = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const id = firstString(entry, ['id', 'model', 'slug', 'name_key'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model = {
      id,
      name: firstString(entry, NAME_KEYS) ?? id,
    }
    const contextWindow = firstPositiveInteger(entry, CONTEXT_KEYS)
    if (contextWindow) model.contextWindow = contextWindow
    const maxTokens = firstPositiveInteger(entry, MAX_TOKENS_KEYS)
    if (maxTokens) model.maxTokens = maxTokens
    const input = normalizeInput(
      INPUT_KEYS.map(key => entry[key]).find(value => value !== undefined)
    )
    if (input) model.input = input
    const created = numbersFrom(entry.created ?? entry.created_at ?? entry.createdAt)[0]
    if (created) model.created = Math.trunc(created)
    models.push(model)
  }
  return models
}

/** Maps internal entries to the OpenAI `/models` response shape and back. */
export function toOpenAIList(models, { created = Math.trunc(Date.now() / 1000) } = {}) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      object: 'model',
      created: model.created ?? created,
      owned_by: 'arena',
      name: model.name,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      ...(model.maxTokens ? { max_completion_tokens: model.maxTokens } : {}),
      ...(model.input ? { input_modalities: model.input } : {}),
    })),
  }
}

/**
 * Fetches the live catalog.
 *
 * @param {object} options
 * @param {string} options.apiBase OpenAI-compatible base URL, e.g. `https://api.arena.ai/v1`.
 * @param {string | null} [options.apiKey]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{models: object[], source: 'upstream', fetchedAt: number}>}
 */
export async function fetchUpstreamCatalog(options) {
  const {
    apiBase,
    apiKey,
    fetchImpl = fetch,
    signal,
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  } = options
  if (!apiKey) throw new Error('no Arena API key is configured')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('catalog request timed out')), timeoutMs)
  if (timer.unref) timer.unref()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const url = new URL(`${apiBase.replace(/\/+$/, '')}/models`)
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await safeErrorDetail(response)
      throw new Error(`Arena returned HTTP ${response.status} for GET /models${detail ? ` (${detail})` : ''}`)
    }
    const payload = await response.json()
    const models = normalizeModels(payload)
    if (models.length === 0) throw new Error('Arena returned an empty model catalog')
    return { models, source: 'upstream', fetchedAt: Date.now() }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function safeErrorDetail(response) {
  try {
    const text = (await response.text()).slice(0, 400)
    if (!text) return ''
    try {
      const parsed = JSON.parse(text)
      return String(parsed?.error?.message ?? parsed?.message ?? text).slice(0, 300)
    } catch {
      return text.replace(/\s+/g, ' ').slice(0, 300)
    }
  } catch {
    return ''
  }
}

/** Reads a previously persisted catalog; never throws. */
export function readCatalogCache(file) {
  if (!file) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed?.models)) return null
    const models = normalizeModels(parsed.models)
    if (models.length === 0) return null
    return { models, fetchedAt: Number(parsed.fetchedAt) || 0 }
  } catch {
    return null
  }
}

/** Persists a catalog best-effort: an unwritable cache is not an error. */
export function writeCatalogCache(file, { models, fetchedAt }) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, fetchedAt, models }, null, 2)}\n`)
      renameSync(temporary, file)
    } finally {
      rmSync(temporary, { force: true })
    }
  } catch {
    // Best effort only.
  }
}

/**
 * Full resolution order: upstream → disk cache → built-in fallback.
 *
 * @returns {Promise<{models: object[], source: 'upstream' | 'cache' | 'fallback', fetchedAt: number, stale: boolean, error: string | null}>}
 */
export async function resolveCatalog(options) {
  const { cacheFile, fetchImpl, logger, signal, timeoutMs, ttlMs = 0, now = Date.now() } = options
  const cached = readCatalogCache(cacheFile)
  if (cached && ttlMs > 0 && now - cached.fetchedAt < ttlMs) {
    return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt, stale: false, error: null }
  }
  try {
    const fresh = await fetchUpstreamCatalog({ ...options, fetchImpl, signal, timeoutMs })
    writeCatalogCache(cacheFile, fresh)
    return { ...fresh, stale: false, error: null }
  } catch (error) {
    const message = error?.message ?? String(error)
    logger?.warn('model catalog unavailable', { reason: message })
    if (cached) {
      return { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt, stale: true, error: message }
    }
    return {
      models: FALLBACK_MODELS.map(model => ({ ...model, input: model.input ? [...model.input] : undefined })),
      source: 'fallback',
      fetchedAt: 0,
      stale: true,
      error: message,
    }
  }
}

/** Case-insensitive allowlist check; an empty allowlist means "everything". */
export function isModelAllowed(modelId, allowlist) {
  if (!allowlist || allowlist.length === 0) return true
  const needle = String(modelId ?? '').toLowerCase()
  return allowlist.some(entry => String(entry).toLowerCase() === needle)
}

/** Parses a comma-separated allowlist (`FREEMODELS_ARENA_MODELS`). */
export function parseAllowlist(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}
