/**
 * Shared defaults for the Arena gateway and the DSH Desktop plugin.
 *
 * Everything here is deliberately boring and dependency-free so that the
 * package can be installed into a DeepSeek Harness profile (or run standalone)
 * without pulling a single npm package.
 */

export const PLUGIN_NAME = 'dsh-freemodels-arena'
export const VERSION = '0.1.0'

/** The gateway only ever binds to loopback: it holds the Arena API key. */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

/** Arena's documented OpenAI-compatible gateway (see docs/technik.md). */
export const DEFAULT_API_BASE = 'https://api.arena.ai/v1'

/** Header the gateway adds to responses so callers can see which build is running. */
export const GATEWAY_HEADER = 'x-freemodels-gateway'

/**
 * Catalog served when Arena cannot be reached (offline, invalid key, outage).
 * The coding router is the model Arena's own setup documentation uses, so it is
 * the safest single entry to keep a picker usable.
 */
export const FALLBACK_MODELS = Object.freeze([
  Object.freeze({
    id: 'coding-router-preview',
    name: 'Arena Coding Router',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: Object.freeze(['text', 'image']),
  }),
])

/** Model ids that are always allowed even if Arena reports a smaller catalog. */
export const FALLBACK_MODEL_IDS = Object.freeze(FALLBACK_MODELS.map(model => model.id))

/** Bounds that keep a broken client from exhausting the gateway. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024
export const MAX_ERROR_BYTES = 64 * 1024
export const MAX_UPSTREAM_JSON_BYTES = 32 * 1024 * 1024

/** Catalog freshness. Arena's model list changes rarely; ten minutes is plenty. */
export const DEFAULT_CATALOG_TTL_MS = 10 * 60 * 1000
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 180_000
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_RETRIES = 2
