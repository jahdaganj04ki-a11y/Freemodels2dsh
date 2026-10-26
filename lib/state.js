/**
 * Pure state shape and transitions for the plugin's credential grant payload.
 *
 * Everything in this module is dependency-free and synchronous so the entire
 * settings behavior (validation, revision checks, redaction) is unit-testable
 * without a Harness runtime. lib/storage.js binds these transitions to the
 * credential service's serialized read-modify-write seam.
 *
 * @module freemodels2dsh/state
 */

import { randomUUID } from 'node:crypto'
import { getProvider, defaultModelsFor } from './catalog.js'
import { SWITCH_MODES, isSwitchMode, forgetAccount, describeStatuses } from './rotation.js'

export const STORE_SCOPE = 'freemodels2dsh'
export const STORE_RECORD = 'configuration'

const MAX_ACCOUNTS_PER_PROVIDER = 20
const MAX_KEY_LENGTH = 4096
const MAX_LABEL_LENGTH = 80

export class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function emptyState() {
  return { revision: 0, providers: {} }
}

function ensureProvider(state, providerId) {
  const provider = getProvider(providerId)
  if (!provider) throw new StoreError('UNKNOWN_PROVIDER', `Unknown free provider "${providerId}".`)
  if (!state.providers[providerId]) {
    state.providers[providerId] = {
      switchMode: SWITCH_MODES.ON_ERROR,
      manualAccountId: null,
      accounts: [],
      models: null,
    }
  }
  return provider
}

function validKey(value) {
  return typeof value === 'string' && value.trim().length >= 8 && value.trim().length <= MAX_KEY_LENGTH
    && !/[\s\p{C}]/u.test(value.trim())
}

function validLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_LABEL_LENGTH
}

function newAccountId(existing) {
  const taken = new Set(existing.map(account => account.id))
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `acc-${randomUUID().slice(0, 8)}`
    if (!taken.has(id)) return id
  }
  throw new StoreError('ID_COLLISION', 'Could not allocate an account id; try again.', 503)
}

function accountSnapshot(account) {
  const key = String(account.apiKey ?? '')
  return {
    id: account.id,
    label: account.label,
    enabled: Boolean(account.enabled),
    hasKey: key.length > 0,
    keyHint: key.length >= 4 ? `…${key.slice(-4)}` : '',
    ...(account.accountId ? { accountId: account.accountId } : {}),
    createdAt: account.createdAt,
  }
}

/** Client-safe state: no API key values, only presence and a 4-char hint. */
export function redactState(state, runtime) {
  const providers = {}
  for (const [providerId, providerState] of Object.entries(state.providers)) {
    const statuses = runtime ? describeStatuses(runtime, providerId, providerState.accounts) : {}
    providers[providerId] = {
      switchMode: providerState.switchMode,
      manualAccountId: providerState.manualAccountId,
      models: providerState.models,
      accounts: providerState.accounts.map(account => ({
        ...accountSnapshot(account),
        status: statuses[account.id] ?? null,
      })),
    }
  }
  return { revision: state.revision, providers }
}

function clone(state) {
  return structuredClone(state)
}

/** Pure state transitions; each returns a new top-level state. */
export const transitions = {
  addAccount(state, input) {
    if (!input || typeof input !== 'object') throw new StoreError('BAD_INPUT', 'Invalid account input.')
    const next = clone(state)
    const provider = ensureProvider(next, input.providerId)
    const current = next.providers[input.providerId]
    if (current.accounts.length >= MAX_ACCOUNTS_PER_PROVIDER) {
      throw new StoreError('TOO_MANY', `A provider supports at most ${MAX_ACCOUNTS_PER_PROVIDER} accounts.`)
    }
    const label = validLabel(input.label) ? input.label.trim() : `Account ${current.accounts.length + 1}`
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    if (!validKey(apiKey)) throw new StoreError('BAD_KEY', 'Enter a valid API key (8–4096 characters, no whitespace or control characters).')
    const account = {
      id: newAccountId(current.accounts),
      label,
      apiKey,
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    if (provider.accountIdField) {
      const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
      if (!provider.accountIdField.pattern.test(accountId)) {
        throw new StoreError('BAD_ACCOUNT_ID', 'Enter the 32-character Cloudflare Account ID.')
      }
      account.accountId = accountId
    }
    current.accounts.push(account)
    if (!current.manualAccountId) current.manualAccountId = account.id
    next.revision += 1
    return next
  },

  removeAccount(state, input) {
    const next = clone(state)
    const current = next.providers[input?.providerId]
    if (!current) throw new StoreError('UNKNOWN_PROVIDER', 'This provider is not configured.')
    const before = current.accounts.length
    current.accounts = current.accounts.filter(account => account.id !== input.accountId)
    if (current.accounts.length === before) throw new StoreError('UNKNOWN_ACCOUNT', 'The account does not exist.')
    if (current.manualAccountId === input.accountId) {
      current.manualAccountId = current.accounts[0]?.id ?? null
    }
    next.revision += 1
    return next
  },

  toggleAccount(state, input) {
    const next = clone(state)
    const current = next.providers[input?.providerId]
    const account = current?.accounts.find(item => item.id === input.accountId)
    if (!account) throw new StoreError('UNKNOWN_ACCOUNT', 'The account does not exist.')
    account.enabled = Boolean(input.enabled)
    next.revision += 1
    return next
  },

  selectAccount(state, input) {
    const next = clone(state)
    const current = next.providers[input?.providerId]
    const account = current?.accounts.find(item => item.id === input.accountId)
    if (!account) throw new StoreError('UNKNOWN_ACCOUNT', 'The account does not exist.')
    if (!account.enabled) throw new StoreError('ACCOUNT_DISABLED', 'Enable the account before selecting it.')
    current.manualAccountId = account.id
    next.revision += 1
    return next
  },

  setSwitchMode(state, input) {
    const next = clone(state)
    const current = next.providers[input?.providerId]
    if (!current) throw new StoreError('UNKNOWN_PROVIDER', 'This provider is not configured.')
    if (!isSwitchMode(input.mode)) throw new StoreError('BAD_MODE', 'Choose a supported account switching mode.')
    current.switchMode = input.mode
    next.revision += 1
    return next
  },

  setModels(state, input) {
    const next = clone(state)
    const provider = ensureProvider(next, input?.providerId)
    if (!Array.isArray(input.models) || input.models.length === 0) {
      throw new StoreError('NO_MODELS', 'Fetch at least one model before saving.')
    }
    const models = []
    const seen = new Set()
    for (const raw of input.models.slice(0, 200)) {
      if (!raw || typeof raw.id !== 'string' || !/^[\w][\w.:/@-]{0,199}$/u.test(raw.id)) continue
      if (seen.has(raw.id)) continue
      seen.add(raw.id)
      models.push({
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name.slice(0, 120) : raw.id,
        contextWindow: Number.isInteger(raw.contextWindow) && raw.contextWindow > 0
          ? raw.contextWindow
          : defaultModelsFor(provider.id)[0]?.contextWindow ?? 32768,
        maxTokens: Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : 8192,
      })
    }
    if (models.length === 0) throw new StoreError('NO_MODELS', 'The discovery response contained no usable models.')
    next.providers[provider.id].models = models
    next.revision += 1
    return next
  },

  resetModels(state, input) {
    const next = clone(state)
    const current = next.providers[input?.providerId]
    if (!current) throw new StoreError('UNKNOWN_PROVIDER', 'This provider is not configured.')
    current.models = null
    next.revision += 1
    return next
  },
}

/**
 * Drop runtime bookkeeping for an account that was removed, keeping the
 * in-memory rotation maps aligned with the durable state.
 */
export function cleanupRuntime(runtime, providerId, accountId) {
  if (runtime) forgetAccount(runtime, providerId, accountId)
}
