import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODES, classifyHttpError, classifyNetworkError, cooldownMs,
  isSwitchable, parseErrorBody,
} from '../lib/errors.js'

const headers = (retryAfter) => new Headers(retryAfter ? { 'retry-after': retryAfter } : {})

test('HTTP status classification maps to the Harness taxonomy', () => {
  assert.equal(classifyHttpError(401, '{}', headers()).code, CODES.AUTH)
  assert.equal(classifyHttpError(403, '{}', headers()).code, CODES.AUTH)
  assert.equal(classifyHttpError(402, '{}', headers()).code, CODES.QUOTA)
  assert.equal(classifyHttpError(429, '{}', headers()).code, CODES.RATE_LIMIT)
  assert.equal(classifyHttpError(500, '{}', headers()).code, CODES.SERVER)
  assert.equal(classifyHttpError(503, '{}', headers()).code, CODES.SERVER)
  assert.equal(classifyHttpError(404, '{}', headers()).code, CODES.UNKNOWN_MODEL)
  assert.equal(classifyHttpError(418, '{}', headers()).code, CODES.UNKNOWN)
})

test('400 responses distinguish context overflow from generic bad requests', () => {
  const context = classifyHttpError(400, JSON.stringify({ error: { message: 'context length exceeded' } }), headers())
  assert.equal(context.code, CODES.CONTEXT_WINDOW)
  const generic = classifyHttpError(400, JSON.stringify({ error: { message: 'invalid parameter' } }), headers())
  assert.equal(generic.code, CODES.INVALID_REQUEST)
})

test('quota wording inside other statuses is detected from the body', () => {
  const error = classifyHttpError(400, JSON.stringify({ error: { code: 'insufficient_quota' } }), headers())
  assert.equal(error.code, CODES.QUOTA)
})

test('Retry-After is parsed as seconds or HTTP date and capped', () => {
  const seconds = classifyHttpError(429, '{}', headers('30'))
  assert.equal(seconds.retryAfterMs, 30_000)
  const date = new Date(Date.now() + 5_000).toUTCString()
  const parsed = classifyHttpError(429, '{}', headers(date))
  assert.ok(parsed.retryAfterMs >= 3_000 && parsed.retryAfterMs <= 7_000)
  const huge = classifyHttpError(429, '{}', headers('99999'))
  assert.equal(huge.retryAfterMs, 3_600_000)
})

test('malformed JSON bodies still classify without throwing', () => {
  const error = classifyHttpError(401, '<html>nope</html>', headers())
  assert.equal(error.code, CODES.AUTH)
  assert.match(error.message, /HTTP 401/u)
})

test('network failures split abort, timeout, and transport', () => {
  const abortedSignal = AbortSignal.abort()
  assert.equal(classifyNetworkError(new Error('aborted'), abortedSignal).code, CODES.ABORTED)
  const timeoutError = new Error('The operation timed out')
  timeoutError.name = 'AbortError'
  assert.equal(classifyNetworkError(timeoutError, undefined).code, CODES.TIMEOUT)
  assert.equal(classifyNetworkError(new TypeError('fetch failed'), undefined).code, CODES.TRANSPORT)
})

test('cooldown table matches the rotation policy', () => {
  assert.equal(cooldownMs(CODES.RATE_LIMIT), 60_000)
  assert.equal(cooldownMs(CODES.RATE_LIMIT, 5_000), 5_000)
  assert.equal(cooldownMs(CODES.QUOTA), 30 * 60_000)
  assert.equal(cooldownMs(CODES.ACCOUNT_QUOTA), 30 * 60_000)
  assert.equal(cooldownMs(CODES.AUTH), 15 * 60_000)
  assert.equal(cooldownMs(CODES.SERVER), 10_000)
  assert.equal(cooldownMs(CODES.TRANSPORT), 15_000)
  assert.equal(cooldownMs(CODES.INVALID_REQUEST), 0)
})

test('switchable codes drive account rotation; request errors do not', () => {
  for (const code of [CODES.AUTH, CODES.QUOTA, CODES.ACCOUNT_QUOTA, CODES.RATE_LIMIT, CODES.SERVER, CODES.TRANSPORT, CODES.TIMEOUT]) {
    assert.ok(isSwitchable(code), `${code} should be switchable`)
  }
  for (const code of [CODES.INVALID_REQUEST, CODES.UNKNOWN_MODEL, CODES.CONTEXT_WINDOW, CODES.ABORTED]) {
    assert.ok(!isSwitchable(code), `${code} should not be switchable`)
  }
})

test('parseErrorBody returns undefined for non-JSON input', () => {
  assert.equal(parseErrorBody(''), undefined)
  assert.equal(parseErrorBody('not json'), undefined)
  assert.deepEqual(parseErrorBody('{"a":1}'), { a: 1 })
})
