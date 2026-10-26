import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreeModelsAdapter, configurableEntries, allAdapterRoutes } from '../lib/adapter.js'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createRuntime } from '../lib/rotation.js'
import { getProvider } from '../lib/catalog.js'
import { CODES } from '../lib/errors.js'

const encoder = new TextEncoder()

function sseResponse(events, init = {}) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

const successEvents = [
  { choices: [{ delta: { content: 'Hello ' } }] },
  { choices: [{ delta: { content: 'world' } }] },
  { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
]

function stateFor(providerId, accounts, overrides = {}) {
  return {
    revision: 1,
    providers: {
      [providerId]: {
        switchMode: 'on-error',
        manualAccountId: accounts[0]?.id ?? null,
        accounts,
        models: null,
        ...overrides,
      },
    },
  }
}

const groqAccount = (id, apiKey) => ({
  id, label: id, apiKey, enabled: true, createdAt: '2026-10-26T00:00:00.000Z',
})

function makeAdapter(state) {
  const runtime = createRuntime()
  const store = { read: async () => state }
  return { adapter: new FreeModelsAdapter(store, runtime), runtime }
}

const streamOptions = (provider = 'fm-groq', model = 'openai/gpt-oss-120b') => ({
  provider,
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})

const collect = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('adapter registers one route per catalog provider with unique fm- keys', () => {
  assert.equal(allAdapterRoutes().length, 8)
  const entries = configurableEntries('freemodels2dsh')
  assert.equal(entries.length, 8)
  assert.deepEqual(entries[0], {
    provider: 'fm-openrouter',
    displayName: getProvider('openrouter').name,
    settingsNs: 'freemodels2dsh',
    settingsPath: ['providers', 'openrouter'],
    defaultBaseURL: getProvider('openrouter').baseUrl,
  })
})

test('listModels is empty when unconfigured or no account is usable', async () => {
  const empty = makeAdapter({ revision: 0, providers: {} })
  assert.deepEqual(await empty.adapter.listModels('fm-groq'), [])

  const disabled = makeAdapter(stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')], {
    accounts: [{ ...groqAccount('a', 'sk-groq-aaaaaaaa'), enabled: false }],
  }))
  assert.deepEqual(await disabled.adapter.listModels('fm-groq'), [])
})

test('listModels advertises the built-in free models on the adapter route', async () => {
  const state = stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')])
  const { adapter } = makeAdapter(state)
  const models = await adapter.listModels('fm-groq')
  assert.equal(models.length, getProvider('groq').defaultModels.length)
  assert.equal(models[0].provider, 'fm-groq')
  assert.deepEqual(models[0].inputModalities, ['text'])
})

test('resolveModel returns capacities and rejects unknown models', async () => {
  const state = stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')])
  const { adapter } = makeAdapter(state)
  const info = await adapter.resolveModel('fm-groq', 'openai/gpt-oss-120b')
  assert.equal(info.context.contextWindow, 131072)
  assert.equal(info.defaultMaxTokens, 32768)
  await assert.rejects(
    adapter.resolveModel('fm-groq', 'paid/model'),
    error => error instanceof LlmError && error.code === CODES.UNKNOWN_MODEL,
  )
  await assert.rejects(() => adapter.listModels('fm-nope'), error => error.code === 'NO_ADAPTER')
})

test('stream succeeds in manual mode and sends the OpenAI wire request', async (t) => {
  const state = stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')], { switchMode: 'manual' })
  const { adapter } = makeAdapter(state)
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return sseResponse(successEvents)
  }
  const chunks = await collect(adapter.stream(streamOptions()))
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-groq-aaaaaaaa')
  assert.ok(calls[0].init.headers['user-agent'].length > 0, 'attribution user-agent must be present')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'openai/gpt-oss-120b')
  assert.equal(body.stream, true)
})

test('on-error mode switches accounts after an auth failure and cools the bad key', async (t) => {
  const state = stateFor('groq', [
    groqAccount('a', 'sk-groq-aaaaaaaa'),
    groqAccount('b', 'sk-groq-bbbbbbbb'),
  ])
  const { adapter, runtime } = makeAdapter(state)
  const usedKeys = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, init) => {
    usedKeys.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer sk-groq-aaaaaaaa') {
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
    }
    return sseResponse(successEvents)
  }
  const chunks = await collect(adapter.stream(streamOptions()))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(usedKeys, ['Bearer sk-groq-aaaaaaaa', 'Bearer sk-groq-bbbbbbbb'])
  assert.ok(runtime.cooldowns.get('groq:a') > Date.now())
  assert.equal(runtime.statuses.get('groq:b').state, 'ok')

  // The cooled account is now skipped: the next call leads with account b.
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer sk-groq-bbbbbbbb')
    return sseResponse(successEvents)
  }
  await collect(adapter.stream(streamOptions()))
})

test('manual mode never switches and surfaces the first failure', async (t) => {
  const state = stateFor('groq', [
    groqAccount('a', 'sk-groq-aaaaaaaa'),
    groqAccount('b', 'sk-groq-bbbbbbbb'),
  ], { switchMode: 'manual' })
  const { adapter } = makeAdapter(state)
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    calls.push(init.headers.authorization)
    return new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
  }
  await assert.rejects(
    collect(adapter.stream(streamOptions())),
    error => error instanceof LlmError && error.code === CODES.RATE_LIMIT,
  )
  assert.deepEqual(calls, ['Bearer sk-groq-aaaaaaaa'])
})

test('round-robin rotates the leading account across requests', async (t) => {
  const state = stateFor('groq', [
    groqAccount('a', 'sk-groq-aaaaaaaa'),
    groqAccount('b', 'sk-groq-bbbbbbbb'),
  ], { switchMode: 'round-robin' })
  const { adapter } = makeAdapter(state)
  const leaders = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, init) => {
    leaders.push(init.headers.authorization)
    return sseResponse(successEvents)
  }
  await collect(adapter.stream(streamOptions()))
  await collect(adapter.stream(streamOptions()))
  assert.deepEqual(leaders, ['Bearer sk-groq-aaaaaaaa', 'Bearer sk-groq-bbbbbbbb'])
})

test('a failure after content started is not retried on another account', async (t) => {
  const state = stateFor('groq', [
    groqAccount('a', 'sk-groq-aaaaaaaa'),
    groqAccount('b', 'sk-groq-bbbbbbbb'),
  ])
  const { adapter } = makeAdapter(state)
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => {
    calls.push(1)
    let pulled = false
    const body = new ReadableStream({
      pull(controller) {
        if (!pulled) {
          pulled = true
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`))
        } else {
          controller.error(new Error('connection reset'))
        }
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  await assert.rejects(collect(adapter.stream(streamOptions())), error => error instanceof LlmError)
  assert.equal(calls.length, 1)
})

test('Cloudflare requests expand the per-account account id into the URL', async (t) => {
  const accounts = [
    { id: 'a', label: 'a', apiKey: 'cf-token-1111', accountId: 'a'.repeat(32), enabled: true },
    { id: 'b', label: 'b', apiKey: 'cf-token-2222', accountId: 'b'.repeat(32), enabled: true },
  ]
  const state = stateFor('cloudflare', accounts, { switchMode: 'manual', manualAccountId: 'b' })
  const { adapter } = makeAdapter(state)
  const seen = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    seen.push({ url, key: init.headers.authorization })
    return sseResponse(successEvents)
  }
  await collect(adapter.stream(streamOptions('fm-cloudflare', '@cf/openai/gpt-oss-120b')))
  assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/ai/v1/chat/completions`)
  assert.equal(seen[0].key, 'Bearer cf-token-2222')
})

test('missing or unusable accounts fail with MISSING_CREDENTIAL', async () => {
  const unconfigured = makeAdapter({ revision: 0, providers: {} })
  await assert.rejects(
    collect(unconfigured.adapter.stream(streamOptions())),
    error => error.code === CODES.NO_ACCOUNT,
  )

  const allCooling = makeAdapter(stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')]))
  allCooling.runtime.cooldowns.set('groq:a', Date.now() + 60_000)
  await assert.rejects(
    collect(allCooling.adapter.stream(streamOptions())),
    error => error.code === CODES.NO_ACCOUNT,
  )
})

test('aborted requests surface ABORTED and never attempt another account', async (t) => {
  const state = stateFor('groq', [
    groqAccount('a', 'sk-groq-aaaaaaaa'),
    groqAccount('b', 'sk-groq-bbbbbbbb'),
  ])
  const { adapter, runtime } = makeAdapter(state)
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => {
    calls.push(1)
    return new Response(new ReadableStream({
      start(controller) {
        controller.error(new DOMException('aborted', 'AbortError'))
      },
    }), { status: 200 })
  }
  const signal = AbortSignal.abort()
  await assert.rejects(
    collect(adapter.stream({ ...streamOptions(), signal })),
    error => error.code === CODES.ABORTED,
  )
  assert.equal(calls.length, 1)
  // Cancellations are not account faults: no cooldown and no error status.
  assert.equal(runtime.cooldowns.size, 0)
  assert.equal(runtime.statuses.size, 0)
})
