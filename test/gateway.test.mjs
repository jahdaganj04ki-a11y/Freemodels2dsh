import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createArenaGateway } from '../lib/gateway.js'
import { createLogger } from '../lib/log.js'
import { MODELS_PAYLOAD, startUpstream } from './helpers.mjs'

const silentLogger = createLogger({ level: 'error', sink: () => {} })

async function withGateway(options, run) {
  const upstream = options.upstream
  const gatewayOptions = { ...options.gateway }
  if (gatewayOptions.apiKey === null) {
    // Explicit "no key" must not silently fall back to an ARENA_API_KEY that
    // happens to be set in the developer's environment.
    gatewayOptions.getApiKey = () => null
    delete gatewayOptions.apiKey
  }
  const gateway = createArenaGateway({
    logger: silentLogger,
    apiBase: upstream.apiBase,
    cacheFile: null,
    ...gatewayOptions,
  })
  const info = await gateway.start({ port: 0 })
  try {
    await run({ gateway, upstream, baseUrl: `http://127.0.0.1:${info.port}` })
  } finally {
    await gateway.stop()
    await upstream.close()
  }
}

test('GET /v1/models normalizes Arena metadata and sends the key upstream', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/models`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-freemodels-gateway')?.startsWith('v'), true)
    const payload = await response.json()
    assert.equal(payload.object, 'list')
    assert.deepEqual(payload.data.map(model => model.id), ['coding-router-preview', 'arena-direct-1'])
    const router = payload.data[0]
    assert.equal(router.name, 'Arena Coding Router')
    assert.equal(router.context_window, 1000000)
    assert.equal(router.max_completion_tokens, 128000)
    assert.deepEqual(router.input_modalities, ['text', 'image'])
    assert.equal(router.owned_by, 'arena')

    const upstreamCall = upstream.calls.find(call => call.url === '/v1/models')
    assert.equal(upstreamCall.headers.authorization, 'Bearer arena-test-key')
  })
})

test('GET /v1/models falls back to a usable catalog when Arena fails', async () => {
  const upstream = await startUpstream(() => ({ status: 503, body: { error: { message: 'down' } } }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/models`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.data.map(model => model.id), ['coding-router-preview'])
  })
})

test('GET /v1/models is served from the on-disk cache without a key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-test-'))
  const cacheFile = join(directory, 'catalog.json')
  const first = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  try {
    await withGateway({ upstream: first, gateway: { apiKey: 'arena-test-key', cacheFile } }, async ({ baseUrl }) => {
      assert.equal((await (await fetch(`${baseUrl}/v1/models`)).json()).data.length, 2)
    })
    const offline = await startUpstream(() => ({ status: 500, body: { error: { message: 'offline' } } }))
    await withGateway({ upstream: offline, gateway: { apiKey: null, cacheFile } }, async ({ baseUrl }) => {
      const payload = await (await fetch(`${baseUrl}/v1/models`)).json()
      assert.deepEqual(payload.data.map(model => model.id), ['coding-router-preview', 'arena-direct-1'])
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('POST /v1/chat/completions forwards the request and injects the Arena key', async () => {
  const upstream = await startUpstream(() => ({
    body: { id: 'chatcmpl-1', object: 'chat.completion', model: 'coding-router-preview', choices: [{ index: 0, message: { role: 'assistant', content: 'hallo' }, finish_reason: 'stop' }] },
  }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-token-should-be-ignored' },
      body: JSON.stringify({ model: 'coding-router-preview', messages: [{ role: 'user', content: 'Hi' }] }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.choices[0].message.content, 'hallo')

    const call = upstream.calls.find(entry => entry.url === '/v1/chat/completions')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.authorization, 'Bearer arena-test-key')
    assert.equal(call.headers['user-agent'], 'dsh-freemodels-arena/0.1.0')
    assert.deepEqual(call.body, { model: 'coding-router-preview', messages: [{ role: 'user', content: 'Hi' }] })
  })
})

test('streaming responses are passed through untouched', async () => {
  async function* stream() {
    yield 'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\n'
    yield 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
    yield 'data: [DONE]\n\n'
  }
  const upstream = await startUpstream(() => ({ headers: { 'content-type': 'text/event-stream' }, body: stream() }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-router-preview', stream: true, messages: [] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const text = await response.text()
    assert.equal(text, 'data: {"choices":[{"delta":{"content":"Hal"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n')
    assert.equal(upstream.calls.at(-1).headers.accept, 'text/event-stream')
  })
})

test('a missing Arena key fails with an actionable 503', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: null } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-router-preview', messages: [] }),
    })
    assert.equal(response.status, 503)
    const payload = await response.json()
    assert.equal(payload.error.code, 'arena_key_missing')
    assert.match(payload.error.hint, /ARENA_API_KEY/)
    // The catalog warm-up may still hit /v1/models; no chat request may leave.
    assert.equal(upstream.calls.filter(call => call.url.includes('chat')).length, 0)
  })
})

test('upstream auth errors are normalized and never leak the key', async () => {
  const upstream = await startUpstream(() => ({ status: 401, body: { error: { message: 'invalid token', type: 'authentication_error' } } }))
  await withGateway({ upstream, gateway: { apiKey: 'super-secret-arena-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-router-preview', messages: [] }),
    })
    assert.equal(response.status, 401)
    const text = await response.text()
    assert.equal(text.includes('super-secret-arena-key'), false)
    const payload = JSON.parse(text)
    assert.equal(payload.error.message, 'invalid token')
    assert.equal(payload.error.type, 'authentication_error')
    assert.match(payload.error.hint, /Arena rejected the key/)
  })
})

test('retryable upstream statuses are retried', async () => {
  let attempts = 0
  const upstream = await startUpstream(() => {
    attempts += 1
    if (attempts === 1) return { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'slow down' } } }
    return { body: { id: 'chatcmpl-2', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] } }
  })
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key', maxRetries: 2 } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-router-preview', messages: [] }),
    })
    assert.equal(response.status, 200)
    assert.equal(attempts, 2)
  })
})

test('model allowlists reject unknown models before any upstream call', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key', allowlist: ['coding-router-preview'] } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    })
    assert.equal(response.status, 404)
    const payload = await response.json()
    assert.equal(payload.error.code, 'model_not_found')
    assert.match(payload.error.hint, /coding-router-preview/)
    assert.equal(upstream.calls.filter(call => call.url.includes('chat')).length, 0)
  })
})

test('a configured local token is required for API calls', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key', token: 'local-token' } }, async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/v1/models`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'invalid_api_key')

    const authorized = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'Bearer local-token' } })
    assert.equal(authorized.status, 200)

    // Health and the status page never require the token: they are the
    // diagnostics a user needs when the token itself is the problem.
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/`)).status, 200)
  })
})

test('/health reports upstream, key and catalog state', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/health`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.upstream, upstream.apiBase)
    assert.equal(payload.key.present, true)
    assert.equal(payload.key.masked.includes('test'), false)
    assert.equal(payload.baseUrl.startsWith('http://127.0.0.1:'), true)
    assert.equal(payload.tokenRequired, false)
  })
})

test('invalid JSON and unknown routes produce OpenAI-shaped errors', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key' } }, async ({ baseUrl }) => {
    const badJson = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(badJson.status, 400)
    assert.equal((await badJson.json()).error.code, 'invalid_json')

    const missingModel = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    assert.equal(missingModel.status, 400)
    assert.equal((await missingModel.json()).error.code, 'model_required')

    const unknown = await fetch(`${baseUrl}/v1/embeddings`, { method: 'POST' })
    assert.equal(unknown.status, 404)
    assert.equal((await unknown.json()).error.code, 'not_found')

    const wrongMethod = await fetch(`${baseUrl}/v1/chat/completions`)
    assert.equal(wrongMethod.status, 405)
    assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed')
  })
})

test('the gateway refuses non-loopback hosts and plain-http upstreams', () => {
  assert.throws(() => createArenaGateway({ apiBase: 'http://127.0.0.1:1/v1', host: '0.0.0.0' }), /loopback/)
  assert.throws(() => createArenaGateway({ apiBase: 'https://api.arena.ai/v1', host: '192.168.0.5' }), /loopback/)
  assert.throws(() => createArenaGateway({ apiBase: 'http://arena.example.com/v1' }), /https/)
  assert.throws(() => createArenaGateway({ apiBase: 'not-a-url' }), /valid URL/)
})

test('trailing slashes on the upstream base are tolerated', async () => {
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  await withGateway({ upstream, gateway: { apiKey: 'arena-test-key', apiBase: `${upstream.apiBase}/` } }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/models`)
    assert.equal(response.status, 200)
    assert.equal(upstream.calls[0].url, '/v1/models')
  })
})
