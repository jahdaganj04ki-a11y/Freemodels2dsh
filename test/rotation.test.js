import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SWITCH_MODES, createRuntime, usableAccounts, planCandidates, shouldSwitch,
  noteFailure, noteSuccess, advanceRoundRobin, describeStatuses, forgetAccount,
} from '../lib/rotation.js'
import { CODES } from '../lib/errors.js'

const account = (id, extra = {}) => ({ id, apiKey: `sk-test-${id}`, enabled: true, ...extra })

function providerState(overrides = {}) {
  const accounts = overrides.accounts ?? [account('a'), account('b'), account('c')]
  return {
    switchMode: SWITCH_MODES.ON_ERROR,
    manualAccountId: accounts[0]?.id ?? null,
    accounts,
    models: null,
    ...overrides,
  }
}

test('usableAccounts requires enabled, keyed, and non-cooling accounts', () => {
  const runtime = createRuntime()
  const state = providerState({ accounts: [
    account('a'),
    account('b', { enabled: false }),
    account('c', { apiKey: '   ' }),
  ] })
  assert.deepEqual(usableAccounts(state, runtime, 'groq', 0).map(item => item.id), ['a'])

  noteFailure(runtime, 'groq', state.accounts[0], CODES.RATE_LIMIT, undefined, 1_000)
  assert.deepEqual(usableAccounts(state, runtime, 'groq', 1_000).map(item => item.id), [])
  // Expired cooldowns are lazily swept and the account serves again.
  assert.deepEqual(usableAccounts(state, runtime, 'groq', 62_000).map(item => item.id), ['a'])
})

test('keyless providers accept enabled accounts without a stored key', () => {
  const runtime = createRuntime()
  const state = providerState({ accounts: [
    { id: 'anon', apiKey: '', enabled: true },
    account('keyed'),
  ] })
  // Normal providers still reject the keyless account.
  assert.deepEqual(usableAccounts(state, runtime, 'groq', 0).map(item => item.id), ['keyed'])
  // Kilo's anonymous free pool accepts both, stored order preserved.
  assert.deepEqual(usableAccounts(state, runtime, 'kilo', 0).map(item => item.id), ['anon', 'keyed'])
  const disabled = providerState({ accounts: [{ id: 'anon', apiKey: '', enabled: false }] })
  assert.deepEqual(usableAccounts(disabled, runtime, 'kilo', 0), [])
})

test('manual mode plans exactly the selected account', () => {
  const runtime = createRuntime()
  const state = providerState({ switchMode: SWITCH_MODES.MANUAL, manualAccountId: 'b' })
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['b'])

  noteFailure(runtime, 'groq', account('b'), CODES.QUOTA, undefined, 1_000)
  assert.deepEqual(planCandidates(state, runtime, 'groq', 1_000), [])
})

test('manual mode never auto-switches even for switchable codes', () => {
  const state = providerState({ switchMode: SWITCH_MODES.MANUAL })
  assert.equal(shouldSwitch(state, CODES.QUOTA), false)
  assert.equal(shouldSwitch(state, CODES.RATE_LIMIT), false)
})

test('on-error mode leads with the active account and keeps the rest as fallbacks', () => {
  const runtime = createRuntime()
  const state = providerState({ manualAccountId: 'b' })
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['b', 'c', 'a'])

  const firstLed = providerState({ manualAccountId: 'a' })
  assert.deepEqual(planCandidates(firstLed, runtime, 'groq').map(item => item.id), ['a', 'b', 'c'])
  assert.equal(shouldSwitch(state, CODES.QUOTA), true)
  assert.equal(shouldSwitch(state, CODES.INVALID_REQUEST), false)
})

test('round-robin rotates the candidate start by the per-provider cursor', () => {
  const runtime = createRuntime()
  const state = providerState({ switchMode: SWITCH_MODES.ROUND_ROBIN })
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['a', 'b', 'c'])
  advanceRoundRobin(runtime, 'groq', 3)
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['b', 'c', 'a'])
  advanceRoundRobin(runtime, 'groq', 3)
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['c', 'a', 'b'])
  advanceRoundRobin(runtime, 'groq', 3)
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['a', 'b', 'c'])
  // A single usable account never needs a cursor.
  advanceRoundRobin(runtime, 'mistral', 1)
  assert.equal(runtime.rrCursors.get('mistral'), undefined)
})

test('round-robin skips cooling accounts and wraps the cursor against the usable count', () => {
  const runtime = createRuntime()
  const state = providerState({ switchMode: SWITCH_MODES.ROUND_ROBIN })
  noteFailure(runtime, 'groq', account('b'), CODES.SERVER, undefined, 1_000)
  // Cursor 1 over the reduced usable list [a, c] starts at c.
  runtime.rrCursors.set('groq', 1)
  assert.deepEqual(planCandidates(state, runtime, 'groq', 1_000).map(item => item.id), ['c', 'a'])
})

test('noteFailure records cooldown and status; noteSuccess clears them', () => {
  const runtime = createRuntime()
  const acc = account('a')
  noteFailure(runtime, 'groq', acc, CODES.AUTH, undefined, 5_000)
  const afterFailure = describeStatuses(runtime, 'groq', [acc], 5_000)
  assert.equal(afterFailure.a.state, 'error')
  assert.equal(afterFailure.a.cooling, true)
  assert.equal(afterFailure.a.cooldownRemainingMs, 15 * 60_000)

  noteSuccess(runtime, 'groq', acc, 6_000)
  const afterSuccess = describeStatuses(runtime, 'groq', [acc], 6_000)
  assert.equal(afterSuccess.a.state, 'ok')
  assert.equal(afterSuccess.a.cooling, false)
  assert.equal(runtime.cooldowns.get('groq:a'), undefined)
})

test('non-cooling failures still surface an error status', () => {
  const runtime = createRuntime()
  const acc = account('a')
  noteFailure(runtime, 'groq', acc, CODES.INVALID_REQUEST)
  const status = describeStatuses(runtime, 'groq', [acc])
  assert.equal(status.a.state, 'error')
  assert.equal(status.a.cooling, false)
  assert.deepEqual(describeStatuses(runtime, 'groq', []), {})
})

test('forgetAccount removes every trace of a deleted account', () => {
  const runtime = createRuntime()
  const acc = account('a')
  noteFailure(runtime, 'groq', acc, CODES.QUOTA)
  forgetAccount(runtime, 'groq', 'a')
  assert.deepEqual(describeStatuses(runtime, 'groq', [acc]), {})
  assert.equal(runtime.cooldowns.get('groq:a'), undefined)
})

test('unknown switch modes fall back to on-error semantics', () => {
  const runtime = createRuntime()
  const state = providerState({ switchMode: 'mystery' })
  assert.deepEqual(planCandidates(state, runtime, 'groq').map(item => item.id), ['a', 'b', 'c'])
})
