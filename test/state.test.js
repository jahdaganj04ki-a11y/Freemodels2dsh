import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyState, StoreError, redactState, transitions,
} from '../lib/state.js'
import { createRuntime } from '../lib/rotation.js'

const KEY = 'sk-valid-key-1234567890'

function addProvider(state, providerId = 'groq', extra = {}) {
  return transitions.addAccount(state, { revision: state.revision, providerId, label: 'primary', apiKey: KEY, ...extra })
}

test('addAccount validates input and seeds provider defaults', () => {
  const next = addProvider(emptyState())
  assert.equal(next.revision, 1)
  const groq = next.providers.groq
  assert.equal(groq.switchMode, 'on-error')
  assert.equal(groq.accounts.length, 1)
  assert.equal(groq.manualAccountId, groq.accounts[0].id)
  assert.match(groq.accounts[0].id, /^acc-/u)
  assert.equal(groq.accounts[0].enabled, true)
  assert.ok(groq.accounts[0].createdAt)

  const second = transitions.addAccount(next, { revision: next.revision, providerId: 'groq', apiKey: `${KEY}-second` })
  assert.equal(second.providers.groq.accounts.length, 2)
  // The first account remains the manual selection when more are added.
  assert.equal(second.providers.groq.manualAccountId, groq.accounts[0].id)
})

test('addAccount rejects unknown providers, bad keys, and whitespace', () => {
  assert.throws(
    () => transitions.addAccount(emptyState(), { revision: 0, providerId: 'nope', apiKey: KEY }),
    error => error instanceof StoreError && error.code === 'UNKNOWN_PROVIDER',
  )
  for (const badKey of ['short', 'has space-inside-key', '', '']) {
    assert.throws(
      () => transitions.addAccount(emptyState(), { revision: 0, providerId: 'groq', apiKey: badKey }),
      error => error.code === 'BAD_KEY',
    )
  }
  assert.throws(
    () => transitions.addAccount(emptyState(), { revision: 0, providerId: 'groq', apiKey: 'x'.repeat(5000) }),
    error => error.code === 'BAD_KEY',
  )
})

test('keyless providers accept an anonymous account without an API key', () => {
  const anonymous = transitions.addAccount(emptyState(), {
    revision: 0, providerId: 'kilo', label: '', apiKey: '',
  })
  const account = anonymous.providers.kilo.accounts[0]
  assert.equal(account.apiKey, '')
  assert.equal(account.enabled, true)
  assert.match(account.label, /Anonymous/u)

  // A real key still works on the same keyless provider.
  const keyed = transitions.addAccount(anonymous, {
    revision: anonymous.revision, providerId: 'kilo', apiKey: KEY,
  })
  assert.equal(keyed.providers.kilo.accounts.length, 2)
  assert.equal(keyed.providers.kilo.accounts[1].apiKey, KEY)

  // A key-bearing provider must not gain the keyless exception.
  assert.throws(
    () => transitions.addAccount(emptyState(), { revision: 0, providerId: 'groq', apiKey: '' }),
    error => error.code === 'BAD_KEY',
  )
})

test('Cloudflare accounts require a 32-hex account id', () => {
  assert.throws(
    () => addProvider(emptyState(), 'cloudflare'),
    error => error.code === 'BAD_ACCOUNT_ID',
  )
  const next = addProvider(emptyState(), 'cloudflare', { accountId: 'f'.repeat(32) })
  assert.equal(next.providers.cloudflare.accounts[0].accountId, 'f'.repeat(32))
  assert.throws(
    () => addProvider(emptyState(), 'cloudflare', { accountId: 'g'.repeat(32) }),
    error => error.code === 'BAD_ACCOUNT_ID',
  )
})

test('addAccount falls back to a generated label and enforces the account cap', () => {
  let state = emptyState()
  state = transitions.addAccount(state, { revision: 0, providerId: 'groq', apiKey: `${KEY}-0` })
  assert.equal(state.providers.groq.accounts[0].label, 'Account 1')
  for (let i = state.providers.groq.accounts.length; i < 20; i += 1) {
    state = transitions.addAccount(state, { revision: state.revision, providerId: 'groq', apiKey: `${KEY}-${i}` })
  }
  assert.throws(
    () => transitions.addAccount(state, { revision: state.revision, providerId: 'groq', apiKey: `${KEY}-overflow` }),
    error => error.code === 'TOO_MANY',
  )
})

test('removeAccount reselects the manual account and reports unknown ids', () => {
  let state = addProvider(emptyState())
  const firstId = state.providers.groq.accounts[0].id
  state = transitions.addAccount(state, { revision: state.revision, providerId: 'groq', label: 'second', apiKey: `${KEY}-2` })
  const secondId = state.providers.groq.accounts[1].id

  state = transitions.removeAccount(state, { revision: state.revision, providerId: 'groq', accountId: firstId })
  assert.equal(state.providers.groq.accounts.length, 1)
  assert.equal(state.providers.groq.manualAccountId, secondId)

  state = transitions.removeAccount(state, { revision: state.revision, providerId: 'groq', accountId: secondId })
  assert.equal(state.providers.groq.manualAccountId, null)
  assert.throws(
    () => transitions.removeAccount(state, { revision: state.revision, providerId: 'groq', accountId: secondId }),
    error => error.code === 'UNKNOWN_ACCOUNT',
  )
})

test('toggle, select, and switch-mode transitions validate their targets', () => {
  let state = addProvider(emptyState())
  const id = state.providers.groq.accounts[0].id
  state = transitions.toggleAccount(state, { revision: state.revision, providerId: 'groq', accountId: id, enabled: false })
  assert.equal(state.providers.groq.accounts[0].enabled, false)

  assert.throws(
    () => transitions.selectAccount(state, { revision: state.revision, providerId: 'groq', accountId: id }),
    error => error.code === 'ACCOUNT_DISABLED',
  )
  state = transitions.toggleAccount(state, { revision: state.revision, providerId: 'groq', accountId: id, enabled: true })
  state = transitions.selectAccount(state, { revision: state.revision, providerId: 'groq', accountId: id })
  assert.equal(state.providers.groq.manualAccountId, id)

  state = transitions.setSwitchMode(state, { revision: state.revision, providerId: 'groq', mode: 'round-robin' })
  assert.equal(state.providers.groq.switchMode, 'round-robin')
  assert.throws(
    () => transitions.setSwitchMode(state, { revision: state.revision, providerId: 'groq', mode: 'random' }),
    error => error.code === 'BAD_MODE',
  )
})

test('setModels validates rows and resetModels restores the built-in list', () => {
  let state = addProvider(emptyState())
  state = transitions.setModels(state, {
    revision: state.revision,
    providerId: 'groq',
    models: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS', contextWindow: 131072, maxTokens: 32768 },
      { id: 'openai/gpt-oss-120b' },
      { id: 'bad id' },
      null,
    ],
  })
  assert.equal(state.providers.groq.models.length, 1)
  assert.equal(state.providers.groq.models[0].contextWindow, 131072)
  // Capability flags are persisted alongside the discovered row.
  state = transitions.setModels(state, {
    revision: state.revision,
    providerId: 'groq',
    models: [
      { id: 'openai/gpt-oss-120b', contextWindow: 131072, maxTokens: 32768, reasoning: true },
      { id: 'vendor/vl-chat', vision: true, reasoning: 'yes' },
    ],
  })
  assert.deepEqual(state.providers.groq.models.map(model => [model.vision, model.reasoning]), [
    [false, true],
    [true, true],
  ])

  const fallback = transitions.setModels(emptyState(), {
    revision: 0,
    providerId: 'groq',
    models: [{ id: 'openai/gpt-oss-20b' }],
  })
  assert.equal(fallback.providers.groq.models[0].contextWindow, 131072)
  assert.equal(fallback.providers.groq.models[0].maxTokens, 8192)

  assert.throws(
    () => transitions.setModels(state, { revision: state.revision, providerId: 'groq', models: [] }),
    error => error.code === 'NO_MODELS',
  )
  state = transitions.resetModels(state, { revision: state.revision, providerId: 'groq' })
  assert.equal(state.providers.groq.models, null)
})

test('setModelsBatch commits several providers in one revision and skips empty batches', () => {
  let state = addProvider(emptyState(), 'groq')
  state = transitions.addAccount(state, { revision: state.revision, providerId: 'zai', apiKey: KEY })
  const before = state.revision
  state = transitions.setModelsBatch(state, {
    revision: before,
    items: [
      { providerId: 'groq', models: [{ id: 'openai/gpt-oss-20b', vision: false, reasoning: true }] },
      { providerId: 'zai', models: [
        { id: 'glm-4.6v-flash', vision: true, reasoning: true },
        { id: 'bad id' },
      ] },
      // Unknown provider and an empty discovery are ignored.
      { providerId: 'nope', models: [{ id: 'x' }] },
      { providerId: 'groq', models: [] },
    ],
  })
  assert.equal(state.revision, before + 1)
  assert.deepEqual(state.providers.groq.models.map(m => m.id), ['openai/gpt-oss-20b'])
  assert.deepEqual(state.providers.zai.models.map(m => [m.id, m.vision]), [['glm-4.6v-flash', true]])

  assert.throws(
    () => transitions.setModelsBatch(emptyState(), { revision: 0, items: [{ providerId: 'groq', models: [] }] }),
    error => error.code === 'NO_MODELS',
  )
  assert.throws(
    () => transitions.setModelsBatch(state, { revision: state.revision, items: [] }),
    error => error.code === 'NO_MODELS',
  )
})

test('redactState never exposes key material and merges runtime statuses', () => {
  const state = addProvider(emptyState())
  const runtime = createRuntime()
  const redacted = redactState(state, runtime)
  const account = redacted.providers.groq.accounts[0]
  assert.equal(account.hasKey, true)
  assert.equal(account.keyHint, `…${KEY.slice(-4)}`)
  assert.equal(JSON.stringify(redacted).includes(KEY), false)
  assert.equal(account.status, null)

  const withoutRuntime = redactState(state)
  assert.equal(withoutRuntime.providers.groq.accounts[0].status, null)
})

test('every transition returns a new state without mutating the previous one', () => {
  const initial = emptyState()
  const next = addProvider(initial)
  assert.equal(initial.revision, 0)
  assert.equal(initial.providers.groq, undefined)
  assert.notEqual(next, initial)
})
