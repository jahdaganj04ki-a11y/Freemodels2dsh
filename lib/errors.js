/**
 * Provider-neutral failure classification for free-tier providers.
 *
 * Codes follow the Harness LLM taxonomy (see @deepseek-ai/dsh-llm error
 * constants) so the built-in retry plugin and the model UI understand them.
 * This module is dependency-free and fully unit-tested.
 *
 * @module freemodels2dsh/errors
 */

/** Stable codes used across the plugin. */
export const CODES = Object.freeze({
  AUTH: 'INVALID_CREDENTIAL',
  QUOTA: 'QUOTA',
  ACCOUNT_QUOTA: 'ACCOUNT_QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'TRANSPORT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONTEXT_WINDOW: 'CONTEXT_WINDOW_EXCEEDED',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  ABORTED: 'ABORTED',
  NO_ACCOUNT: 'MISSING_CREDENTIAL',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNKNOWN: 'PI_AI_ERROR',
})

/**
 * Failures that justify trying another account inside one adapter call,
 * before any content has been streamed.
 */
const SWITCHABLE = new Set([
  CODES.AUTH,
  CODES.QUOTA,
  CODES.ACCOUNT_QUOTA,
  CODES.RATE_LIMIT,
  CODES.SERVER,
  CODES.TRANSPORT,
  CODES.TIMEOUT,
])

export function isSwitchable(code) {
  return SWITCHABLE.has(code)
}

const QUOTA_PATTERN = /\b(?:insufficient[_\s-]*(?:quota|balance|credits?)|quota[_\s-]*(?:exceeded|exhausted|reached)|usage[_\s-]*limit[_\s-]*(?:exceeded|reached)|balance[_\s-]*(?:exhausted|depleted)|credits?[_\s-]*(?:exhausted|depleted|used[_\s-]*up)|out[_\s-]*of[_\s-]*(?:credits?|quota))/iu
const CONTEXT_PATTERN = /(?:context[_\s-]*(?:length|window)[_\s-]*(?:exceed|overflow|limit)|maximum[_\s-]*context|prompt[_\s-]*is[_\s-]*too[_\s-]*(?:long|large))/iu
const RATE_LIMIT_PATTERN = /\b(?:rate[_\s-]*limit|too[_\s-]*many[_\s-]*requests|requests?[_\s-]*per[_\s-]*(?:minute|day|hour)|rpm|rpd)\b/iu

/** Parse a bounded provider error body without throwing on malformed JSON. */
export function parseErrorBody(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function joinDetail(status, body, text) {
  const parts = [`HTTP ${status}`]
  const error = body?.error
  const code = error?.code ?? body?.code
  const type = error?.type ?? body?.type
  const message = error?.message ?? body?.message
  if (typeof code === 'string') parts.push(`code=${code}`)
  if (typeof type === 'string') parts.push(`type=${type}`)
  if (typeof message === 'string') parts.push(message.slice(0, 300))
  else if (text) parts.push(text.slice(0, 200))
  return parts.join('; ')
}

function readRetryAfter(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 3600) * 1000
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 3600_000)
  return undefined
}

/**
 * Classify a non-2xx provider response.
 * @returns {{code: string, message: string, status: number, retryAfterMs?: number}}
 */
export function classifyHttpError(status, text, headers) {
  const body = parseErrorBody(text)
  const detail = joinDetail(status, body, text)
  const providerCode = String(body?.error?.code ?? body?.code ?? '').toLowerCase()
  const combined = `${providerCode} ${typeof text === 'string' ? text.slice(0, 2000) : ''}`
  const retryAfterMs = readRetryAfter(headers)

  if (status === 401 || status === 403) {
    return { code: CODES.AUTH, message: `The API key was rejected (${detail}).`, status, retryAfterMs }
  }
  if (status === 402 || QUOTA_PATTERN.test(combined)) {
    return { code: CODES.QUOTA, message: `The account quota or credit balance is exhausted (${detail}).`, status, retryAfterMs }
  }
  if (status === 429 || RATE_LIMIT_PATTERN.test(combined)) {
    return { code: CODES.RATE_LIMIT, message: `The provider rate limit was hit (${detail}).`, status, retryAfterMs }
  }
  if (status === 404) {
    return { code: CODES.UNKNOWN_MODEL, message: `The model or endpoint is not available (${detail}).`, status }
  }
  if (status === 400) {
    if (CONTEXT_PATTERN.test(combined)) {
      return { code: CODES.CONTEXT_WINDOW, message: `The request exceeds the model context window (${detail}).`, status }
    }
    return { code: CODES.INVALID_REQUEST, message: `The provider rejected the request parameters (${detail}).`, status }
  }
  if (status >= 500) {
    return { code: CODES.SERVER, message: `The provider failed with a server error (${detail}).`, status, retryAfterMs }
  }
  return { code: CODES.UNKNOWN, message: `The provider returned an unexpected error (${detail}).`, status, retryAfterMs }
}

/**
 * Classify a fetch-level failure (no HTTP response arrived).
 */
export function classifyNetworkError(error, signal) {
  if (signal?.aborted) {
    return { code: CODES.ABORTED, message: 'The request was aborted.' }
  }
  const name = error?.name ?? ''
  if (name === 'AbortError') {
    return signal?.aborted
      ? { code: CODES.ABORTED, message: 'The request was aborted.' }
      : { code: CODES.TIMEOUT, message: 'The provider request timed out.' }
  }
  if (name === 'TimeoutError' || /timed?[_\s-]*out/iu.test(String(error?.message ?? ''))) {
    return { code: CODES.TIMEOUT, message: 'The provider request timed out.' }
  }
  return {
    code: CODES.TRANSPORT,
    message: `The provider could not be reached: ${String(error?.message ?? error).slice(0, 200)}`,
  }
}

/**
 * Cooldown applied to an account after a failure, so rotation skips it for a
 * while instead of hammering an exhausted key.
 */
export function cooldownMs(code, retryAfterMs, now = Date.now()) {
  switch (code) {
    case CODES.RATE_LIMIT:
      return retryAfterMs ?? 60_000
    case CODES.QUOTA:
    case CODES.ACCOUNT_QUOTA:
      return 30 * 60_000
    case CODES.AUTH:
      return 15 * 60_000
    case CODES.SERVER:
      return 10_000
    case CODES.TRANSPORT:
    case CODES.TIMEOUT:
      return 15_000
    default:
      return 0
  }
}

/** Human-readable status for the settings UI. */
export function describeCode(code) {
  switch (code) {
    case CODES.AUTH: return 'invalid key'
    case CODES.QUOTA:
    case CODES.ACCOUNT_QUOTA: return 'quota exhausted'
    case CODES.RATE_LIMIT: return 'rate limited'
    case CODES.SERVER: return 'provider server error'
    case CODES.TIMEOUT: return 'request timeout'
    case CODES.TRANSPORT: return 'connection failed'
    case CODES.UNKNOWN_MODEL: return 'model unavailable'
    case CODES.INVALID_REQUEST: return 'request rejected'
    case CODES.CONTEXT_WINDOW: return 'context window exceeded'
    case CODES.UNSUPPORTED_CONTENT: return 'image input unsupported'
    case CODES.EMPTY_RESPONSE: return 'empty response'
    case CODES.ABORTED: return 'cancelled'
    default: return 'error'
  }
}
