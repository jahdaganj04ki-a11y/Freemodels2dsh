/**
 * Pure multi-account selection and rotation logic.
 *
 * The Harness adapter owns no scheduling policy of its own; this module turns
 * the stored provider configuration and the in-memory runtime state (cooldowns,
 * round-robin cursors, per-account status) into one ordered candidate list per
 * request. Keeping it dependency-free makes every mode unit-testable.
 *
 * @module freemodels2dsh/rotation
 */

import { cooldownMs, isSwitchable } from './errors.js'
import { getProvider } from './catalog.js'

export const SWITCH_MODES = Object.freeze({
  MANUAL: 'manual',
  ON_ERROR: 'on-error',
  ROUND_ROBIN: 'round-robin',
})

const ALL_MODES = new Set(Object.values(SWITCH_MODES))

export function isSwitchMode(value) {
  return ALL_MODES.has(value)
}

/** Create the empty runtime bookkeeping block. */
export function createRuntime() {
  return {
    // key: `${providerId}:${accountId}` -> epoch milliseconds until which the account is skipped
    cooldowns: new Map(),
    // key: providerId -> next round-robin position
    rrCursors: new Map(),
    // key: `${providerId}:${accountId}` -> status snapshot for the settings UI
    statuses: new Map(),
  }
}

function accountKey(providerId, accountId) {
  return `${providerId}:${accountId}`
}

function hasKey(providerId, account) {
  // Keyless gateways serve their free pool without any stored secret.
  if (getProvider(providerId)?.keyless) return true
  return typeof account.apiKey === 'string' && account.apiKey.trim().length > 0
}

/**
 * Accounts allowed to serve right now: enabled, carrying a key, and not in
 * cooldown. Stored order is preserved so the UI order is the rotation order.
 */
export function usableAccounts(providerState, runtime, providerId, now) {
  const accounts = Array.isArray(providerState?.accounts) ? providerState.accounts : []
  return accounts.filter(account => {
    if (!account?.enabled || !hasKey(providerId, account)) return false
    const until = runtime.cooldowns.get(accountKey(providerId, account.id))
    if (typeof until === 'number' && until > now) return false
    if (until !== undefined && until <= now) runtime.cooldowns.delete(accountKey(providerId, account.id))
    return true
  })
}

/**
 * Build the ordered candidate list for one model call.
 *
 * - manual: exactly the manually selected account, or nothing when it cannot serve.
 * - on-error: the active (manual or first) account first, then every other usable one.
 * - round-robin: the usable list rotated by a per-provider cursor.
 *
 * @returns {Array<object>} account objects in try order; empty means "no account can serve".
 */
export function planCandidates(providerState, runtime, providerId, now = Date.now()) {
  const mode = ALL_MODES.has(providerState?.switchMode) ? providerState.switchMode : SWITCH_MODES.ON_ERROR
  const usable = usableAccounts(providerState, runtime, providerId, now)
  if (usable.length === 0) return []

  if (mode === SWITCH_MODES.MANUAL) {
    const selected = usable.find(account => account.id === providerState.manualAccountId)
    return selected ? [selected] : []
  }

  if (mode === SWITCH_MODES.ROUND_ROBIN) {
    const cursor = runtime.rrCursors.get(providerId) ?? 0
    const start = ((cursor % usable.length) + usable.length) % usable.length
    const rotated = [...usable.slice(start), ...usable.slice(0, start)]
    return rotated
  }

  // on-error: active account leads, remaining accounts are fallbacks.
  const activeIndex = usable.findIndex(account => account.id === providerState.manualAccountId)
  if (activeIndex <= 0) return usable
  return [...usable.slice(activeIndex), ...usable.slice(0, activeIndex)]
}

/**
 * Whether, given the configured mode, a failed first attempt may fall through
 * to the next candidate. Manual mode never switches automatically.
 */
export function shouldSwitch(providerState, code) {
  if (providerState?.switchMode === SWITCH_MODES.MANUAL) return false
  return isSwitchable(code)
}

/**
 * Record a failed attempt: cool the account down when the failure class calls
 * for it and expose the status in the settings dialog.
 */
export function noteFailure(runtime, providerId, account, code, retryAfterMs, now = Date.now()) {
  const key = accountKey(providerId, account.id)
  const wait = cooldownMs(code, retryAfterMs, now)
  if (wait > 0) runtime.cooldowns.set(key, now + wait)
  runtime.statuses.set(key, {
    state: 'error',
    code,
    at: now,
    cooldownUntil: wait > 0 ? now + wait : undefined,
  })
}

/** Record a successful call and clear any residual cooldown. */
export function noteSuccess(runtime, providerId, account, now = Date.now()) {
  const key = accountKey(providerId, account.id)
  runtime.cooldowns.delete(key)
  runtime.statuses.set(key, { state: 'ok', at: now })
}

/** Advance the round-robin cursor after a request was handed out. */
export function advanceRoundRobin(runtime, providerId, usableCount) {
  if (usableCount <= 1) return
  const next = ((runtime.rrCursors.get(providerId) ?? 0) + 1) % usableCount
  runtime.rrCursors.set(providerId, next)
}

/** Redacted status snapshot for one provider, safe to send to the browser. */
export function describeStatuses(runtime, providerId, accounts, now = Date.now()) {
  const result = {}
  for (const account of accounts ?? []) {
    const key = accountKey(providerId, account.id)
    const cooldownUntil = runtime.cooldowns.get(key)
    const status = runtime.statuses.get(key)
    if (!status && cooldownUntil === undefined) continue
    result[account.id] = {
      ...(status ?? { state: 'error' }),
      ...(typeof cooldownUntil === 'number' && cooldownUntil > now
        ? { cooling: true, cooldownRemainingMs: cooldownUntil - now }
        : { cooling: false }),
    }
  }
  return result
}

/** Forget runtime state for an account that was removed. */
export function forgetAccount(runtime, providerId, accountId) {
  const key = accountKey(providerId, accountId)
  runtime.cooldowns.delete(key)
  runtime.statuses.delete(key)
}
