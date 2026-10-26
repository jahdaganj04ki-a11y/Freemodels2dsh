import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'
import { PROVIDERS } from '../lib/catalog.js'

const { name: pluginName, inject, apply } = plugin

function fakeCredentials() {
  let record
  return {
    async readRecord() { return record },
    async modifyRecord(_key, mutate) {
      record = await mutate(record)
      return record
    },
  }
}

function mockContext() {
  const routes = new Map()
  const adapters = new Map()
  const directory = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    credentials: fakeCredentials(),
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return { replace() {} }
      },
      registerConfigurableProviders(entries) {
        for (const entry of entries) directory.set(entry.provider, entry)
        return { replace() {} }
      },
    },
    connection: {
      fetch: {
        register(spec) { routes.set(spec.path, spec) },
      },
    },
  }
  return { ctx, routes, adapters, directory }
}

async function call(routes, suffix, init = {}) {
  const spec = routes.get(`/api/freemodels2dsh.${suffix}`)
  assert.ok(spec, `route ${suffix} must be registered`)
  const request = new Request(`http://harness.local/api/freemodels2dsh.${suffix}`, {
    method: init.method ?? 'POST',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    headers: { 'content-type': 'application/json' },
  })
  return spec.fetch(request)
}

const API_KEY = 'sk-groq-1234567890abcdef'

test('plugin metadata declares the required Cordis injections', () => {
  assert.equal(pluginName, 'freemodels2dsh')
  assert.deepEqual(inject, ['llm', 'credentials', 'connection'])
})

test('apply registers one adapter route and one directory entry per catalog provider', async () => {
  const harness = mockContext()
  apply(harness.ctx)
  assert.equal(harness.adapters.size, PROVIDERS.length)
  assert.equal(harness.directory.size, PROVIDERS.length)
  const adapter = harness.adapters.get('fm-groq')
  for (const provider of PROVIDERS) {
    assert.equal(harness.adapters.get(provider.route), adapter, 'one adapter instance owns every route')
  }
  const groqEntry = harness.directory.get('fm-groq')
  assert.equal(groqEntry.displayName, PROVIDERS.find(provider => provider.id === 'groq').name)
  assert.equal(groqEntry.settingsNs, 'freemodels2dsh')
  assert.deepEqual(groqEntry.settingsPath, ['providers', 'groq'])
})

test('settings endpoint starts empty and carries the secret-free catalog', async () => {
  const harness = mockContext()
  apply(harness.ctx)
  const response = await call(harness.routes, 'state', { method: 'GET' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.revision, 0)
  assert.deepEqual(body.providers, {})
  assert.equal(body.catalog.length, PROVIDERS.length)
  assert.ok(body.catalog.every(entry => entry.defaultModels.length > 0))
  assert.equal(JSON.stringify(body).includes('apiKey'), false)
})

test('account lifecycle over HTTP: add, toggle, select, remove', async () => {
  const harness = mockContext()
  apply(harness.ctx)

  const bad = await call(harness.routes, 'account-add', { body: { revision: 0, providerId: 'groq', apiKey: 'short' } })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).code, 'BAD_KEY')

  const added = await call(harness.routes, 'account-add', {
    body: { revision: 0, providerId: 'groq', label: 'main', apiKey: API_KEY },
  })
  assert.equal(added.status, 200)
  const addedBody = await added.json()
  assert.equal(addedBody.revision, 1)
  const account = addedBody.providers.groq.accounts[0]
  assert.equal(account.hasKey, true)
  assert.equal(account.apiKey, undefined)
  assert.equal(account.keyHint, `…${API_KEY.slice(-4)}`)

  // Rejected transitions never commit, so the revision only moves on success.
  const toggled = await call(harness.routes, 'account-toggle', {
    body: { revision: addedBody.revision, providerId: 'groq', accountId: account.id, enabled: false },
  })
  const toggledBody = await toggled.json()
  assert.equal(toggledBody.providers.groq.accounts[0].enabled, false)

  const selectRejected = await call(harness.routes, 'account-select', {
    body: { revision: toggledBody.revision, providerId: 'groq', accountId: account.id },
  })
  assert.equal(selectRejected.status, 400)
  assert.equal((await selectRejected.json()).code, 'ACCOUNT_DISABLED')

  const reenabled = await call(harness.routes, 'account-toggle', {
    body: { revision: toggledBody.revision, providerId: 'groq', accountId: account.id, enabled: true },
  })
  const reenabledBody = await reenabled.json()
  assert.equal(reenabledBody.providers.groq.accounts[0].enabled, true)

  const removed = await call(harness.routes, 'account-remove', {
    body: { revision: reenabledBody.revision, providerId: 'groq', accountId: account.id },
  })
  const removedBody = await removed.json()
  assert.equal(removedBody.revision, reenabledBody.revision + 1)
  assert.equal(removedBody.providers.groq.accounts.length, 0)
})

test('stale revisions fail with 409 and leave the record untouched', async () => {
  const harness = mockContext()
  apply(harness.ctx)
  await call(harness.routes, 'account-add', { body: { revision: 0, providerId: 'groq', apiKey: API_KEY } })
  const conflict = await call(harness.routes, 'switch-mode', {
    body: { revision: 0, providerId: 'groq', mode: 'manual' },
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).code, 'CONFLICT')
})

test('model refresh persists only free models returned by the discovery endpoint', async (t) => {
  const harness = mockContext()
  apply(harness.ctx)
  await call(harness.routes, 'account-add', { body: { revision: 0, providerId: 'groq', apiKey: API_KEY } })

  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const requested = []
  globalThis.fetch = async (url, init) => {
    requested.push({ url, init })
    return new Response(JSON.stringify({ data: [
      { id: 'openai/gpt-oss-120b', active: true, type: 'chat', context_window: 131072, max_tokens: 32768 },
      { id: 'vendor/whisper', active: true, type: 'audio' },
    ] }), { status: 200 })
  }

  const response = await call(harness.routes, 'models-refresh', { body: { revision: 1, providerId: 'groq' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.providers.groq.models.map(model => model.id), ['openai/gpt-oss-120b'])
  assert.equal(body.providers.groq.models[0].contextWindow, 131072)
  assert.equal(requested[0].url, 'https://api.groq.com/openai/v1/models')
  assert.equal(requested[0].init.headers.authorization, `Bearer ${API_KEY}`)

  const reset = await call(harness.routes, 'models-reset', { body: { revision: 2, providerId: 'groq' } })
  assert.equal((await reset.json()).providers.groq.models, null)
})

test('account test reports provider failures through the error envelope', async (t) => {
  const harness = mockContext()
  apply(harness.ctx)
  const added = await call(harness.routes, 'account-add', { body: { revision: 0, providerId: 'groq', apiKey: API_KEY } })
  const accountId = (await added.json()).providers.groq.accounts[0].id

  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response('{}', { status: 401 })

  const failed = await call(harness.routes, 'account-test', { body: { providerId: 'groq', accountId } })
  assert.equal(failed.status, 401)
  assert.equal((await failed.json()).code, 'INVALID_CREDENTIAL')

  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  const ok = await call(harness.routes, 'account-test', { body: { providerId: 'groq', accountId } })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true })
})

test('the registered adapter streams a full chat call against the stored account', async (t) => {
  const harness = mockContext()
  apply(harness.ctx)
  await call(harness.routes, 'account-add', { body: { revision: 0, providerId: 'groq', apiKey: API_KEY } })
  const adapter = harness.adapters.get('fm-groq')

  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'fm-groq',
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('oversized bodies are rejected', async () => {
  const harness = mockContext()
  apply(harness.ctx)
  const spec = harness.routes.get('/api/freemodels2dsh.account-add')
  const request = new Request('http://harness.local/api/freemodels2dsh.account-add', {
    method: 'POST',
    body: JSON.stringify({ revision: 0, providerId: 'groq', apiKey: 'x'.repeat(40_000) }),
  })
  const response = await spec.fetch(request)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'TOO_LARGE')
})
