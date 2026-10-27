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

function makeAdapter(state, attachmentResolver) {
  const runtime = createRuntime()
  const store = { read: async () => state }
  return { adapter: new FreeModelsAdapter(store, runtime, attachmentResolver), runtime }
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
  assert.equal(allAdapterRoutes().length, 10)
  const entries = configurableEntries('freemodels2dsh')
  assert.equal(entries.length, 10)
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
  assert.equal(info.defaultMaxTokens, 65536)
  assert.deepEqual(info.inputModalities, ['text'])
  assert.ok(info.reasoning, 'reasoning models on effort-capable providers advertise efforts')
  assert.deepEqual(info.reasoning.efforts.map(entry => entry.id), ['low', 'medium', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'medium')
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

test('vision models advertise image modality and a 1 MiB image request target', async () => {
  const state = stateFor('zai', [groqAccount('a', 'z.ai-key-000000')])
  const { adapter } = makeAdapter(state)
  const models = await adapter.listModels('fm-zai')
  const vision = models.find(model => model.id === 'glm-4.6v-flash')
  assert.deepEqual(vision.inputModalities, ['text', 'image'])
  const info = await adapter.resolveModel('fm-zai', 'glm-4.6v-flash')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  // GLM thinking exists, but Z.ai does not speak the OpenAI effort field.
  assert.equal(info.reasoning, undefined)
  const target = adapter.imageRequestTarget('fm-zai', 'glm-4.6v-flash', { width: 4000, height: 3000, bytes: 5_000_000 })
  assert.deepEqual(target, { width: 4000, height: 3000, maxBytes: 1_048_576 })
})

test('vision streams resolve images through the attachment service into data URIs', async (t) => {
  const state = stateFor('zai', [groqAccount('a', 'z.ai-key-000000')])
  const attachments = {
    async readImageRequest(ref) {
      return { data: new Uint8Array([9, 8, 7]), mediaType: ref.mediaType ?? 'image/png', bytes: 3 }
    },
  }
  const { adapter } = makeAdapter(state, () => attachments)
  const bodies = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return sseResponse(successEvents)
  }
  const options = {
    provider: 'fm-zai',
    model: 'glm-4.6v-flash',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 99, width: 8, height: 8 } },
    ] }],
  }
  await collect(adapter.stream(options))
  const parts = bodies[0].messages[0].content
  assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' })
  assert.equal(parts[1].type, 'image_url')
  assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,CQgH')
  assert.equal(bodies[0].reasoning_effort, undefined, 'Z.ai never receives reasoning_effort')
})

test('text-only routes keep placeholder text and never touch the attachment service', async (t) => {
  const state = stateFor('groq', [groqAccount('a', 'sk-groq-aaaaaaaa')])
  const attachments = { async readImageRequest() { throw new Error('unexpected image read') } }
  const { adapter } = makeAdapter(state, () => attachments)
  const bodies = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return sseResponse(successEvents)
  }
  await collect(adapter.stream({
    provider: 'fm-groq',
    model: 'openai/gpt-oss-120b',
    reasoningEffort: 'low',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'hi' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 9, width: 4, height: 4 } },
    ] }],
  }))
  assert.match(bodies[0].messages[0].content, /text-only/u)
  assert.equal(bodies[0].reasoning_effort, 'low', 'effort-capable providers forward the field')
})

test('a missing attachment service makes vision requests fail as UNSUPPORTED_CONTENT', async () => {
  const state = stateFor('zai', [groqAccount('a', 'z.ai-key-000000')])
  const { adapter } = makeAdapter(state) // no resolver
  await assert.rejects(
    collect(adapter.stream({
      provider: 'fm-zai',
      model: 'glm-4.6v-flash',
      messages: [{ role: 'user', content: [
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 9, width: 4, height: 4 } },
      ] }],
    })),
    error => error instanceof LlmError && error.code === CODES.UNSUPPORTED_CONTENT,
  )
})

test('Kilo anonymous accounts stream without an Authorization header', async (t) => {
  const state = stateFor('kilo', [
    { id: 'anon', label: 'Anonymous 1', apiKey: '', enabled: true, createdAt: '2026-10-27T00:00:00.000Z' },
  ])
  const { adapter } = makeAdapter(state)
  const models = await adapter.listModels('fm-kilo')
  assert.ok(models.length > 0)
  assert.deepEqual(models[0].provider, 'fm-kilo')
  const calls = []
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return sseResponse(successEvents)
  }
  await collect(adapter.stream({
    provider: 'fm-kilo',
    model: 'kilo-auto/free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(calls[0].url, 'https://api.kilo.ai/api/gateway/chat/completions')
  assert.equal(calls[0].init.headers.authorization, undefined)
  assert.equal(JSON.parse(calls[0].init.body).model, 'kilo-auto/free')

  // A keyed Kilo account on the same provider still sends its bearer token.
  const keyed = stateFor('kilo', [groqAccount('a', 'sk-kilo-00000000')])
  const keyedAdapter = makeAdapter(keyed).adapter
  globalThis.fetch = async (_url, init) => {
    calls.push({ init })
    return sseResponse(successEvents)
  }
  await collect(keyedAdapter.stream({
    provider: 'fm-kilo',
    model: 'kilo-auto/free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  assert.equal(calls.at(-1).init.headers.authorization, 'Bearer sk-kilo-00000000')
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
