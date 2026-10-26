import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, KEY } from '../lib/storage.js'
import { StoreError } from '../lib/state.js'
import { createRuntime } from '../lib/rotation.js'
import { CODES } from '../lib/errors.js'

function fakeCredentials() {
  let record
  const writes = []
  return {
    writes,
    async readRecord() { return record },
    async modifyRecord(key, mutate) {
      const next = await mutate(record)
      if (next !== undefined) {
        record = next
        writes.push(key)
      }
      return record
    },
  }
}

function fakeCtx(credentials) {
  return {
    credentials,
    logger: { warn() {}, info() {}, error() {} },
  }
}

const API_KEY = 'sk-valid-key-1234567890'

test('credential key uses the owner-scoped grant grammar', () => {
  assert.equal(KEY, 'freemodels2dsh/configuration')
})

test('store starts empty and round-trips an account through a grant record', async () => {
  const credentials = fakeCredentials()
  const store = createStore(fakeCtx(credentials), createRuntime())
  assert.deepEqual(await store.describe(), { revision: 0, providers: {} })

  await store.addAccount({ revision: 0, providerId: 'groq', label: 'main', apiKey: API_KEY })
  const described = await store.describe()
  assert.equal(described.revision, 1)
  assert.equal(described.providers.groq.accounts[0].hasKey, true)
  assert.equal(JSON.stringify(described).includes(API_KEY), false)

  const raw = await credentials.readRecord()
  assert.equal(raw.kind, 'grant')
  assert.equal(raw.payload.providers.groq.accounts[0].apiKey, API_KEY)
  assert.equal(credentials.writes.length, 1)
})

test('stale revisions are rejected with a 409 conflict without writing', async () => {
  const credentials = fakeCredentials()
  const store = createStore(fakeCtx(credentials), createRuntime())
  await store.addAccount({ revision: 0, providerId: 'groq', apiKey: API_KEY })

  await assert.rejects(
    store.setSwitchMode({ revision: 0, providerId: 'groq', mode: 'manual' }),
    error => error instanceof StoreError && error.code === 'CONFLICT' && error.status === 409,
  )
  const state = await store.read()
  assert.equal(state.providers.groq.switchMode, 'on-error')
})

test('missing revisions are rejected', async () => {
  const store = createStore(fakeCtx(fakeCredentials()), createRuntime())
  await assert.rejects(
    store.addAccount({ providerId: 'groq', apiKey: API_KEY }),
    error => error.code === 'BAD_REVISION',
  )
})

test('removing an account also forgets its runtime status', async () => {
  const runtime = createRuntime()
  const store = createStore(fakeCtx(fakeCredentials()), runtime)
  await store.addAccount({ revision: 0, providerId: 'groq', apiKey: API_KEY })
  const accountId = (await store.read()).providers.groq.accounts[0].id
  runtime.statuses.set(`groq:${accountId}`, { state: 'error', code: CODES.QUOTA, at: 1 })
  runtime.cooldowns.set(`groq:${accountId}`, 99_999_999_999)

  await store.removeAccount({ revision: 1, providerId: 'groq', accountId })
  assert.equal(runtime.statuses.has(`groq:${accountId}`), false)
  assert.equal(runtime.cooldowns.has(`groq:${accountId}`), false)
})

test('model discovery results and resets are persisted with revisions', async () => {
  const store = createStore(fakeCtx(fakeCredentials()), createRuntime())
  await store.addAccount({ revision: 0, providerId: 'groq', apiKey: API_KEY })
  await store.setModels({
    revision: 1, providerId: 'groq',
    models: [{ id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', contextWindow: 131072, maxTokens: 32768 }],
  })
  let state = await store.read()
  assert.equal(state.providers.groq.models[0].id, 'openai/gpt-oss-20b')
  assert.equal(state.revision, 2)

  await store.resetModels({ revision: 2, providerId: 'groq' })
  state = await store.read()
  assert.equal(state.providers.groq.models, null)
})

test('a malformed stored record falls back to an empty state', async () => {
  const credentials = fakeCredentials()
  credentials.readRecord = async () => ({ kind: 'api-key', key: 'legacy' })
  const store = createStore(fakeCtx(credentials), createRuntime())
  assert.deepEqual(await store.read(), { revision: 0, providers: {} })
})

test('creating a store without the credentials service fails fast', () => {
  assert.throws(() => createStore({ logger: { warn() {} } }, createRuntime()), /credentials service/u)
})
