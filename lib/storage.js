/**
 * Durable plugin state, stored as one owner-scoped grant record in the Harness
 * credential service (the same seam dsh-image-generation uses): accounts and
 * API keys never travel through ordinary settings documents, and every commit
 * emits credentials/record-updated, which refreshes the browser model catalog.
 *
 * This module only binds the pure transitions in lib/state.js to the
 * serialized read-modify-write credential seam.
 *
 * @module freemodels2dsh/storage
 */

import { credentialKey } from '@deepseek-ai/dsh-credentials'
import {
  STORE_SCOPE, STORE_RECORD, StoreError, emptyState, redactState, transitions, cleanupRuntime,
} from './state.js'

export { StoreError, redactState, emptyState, transitions } from './state.js'

export const KEY = credentialKey(STORE_SCOPE, STORE_RECORD)

/**
 * Bind the transitions to the credential service with optimistic revision
 * checks and Cordis-fiber disposal semantics.
 */
export function createStore(ctx, runtime) {
  const credentials = ctx.credentials
  if (!credentials) throw new Error('freemodels2dsh: no credentials service is mounted; mount dsh-credentials-local')

  async function read() {
    const record = await credentials.readRecord(KEY)
    if (!record) return emptyState()
    if (record.kind !== 'grant' || !record.payload || typeof record.payload.revision !== 'number') {
      ctx.logger.warn('freemodels2dsh: stored record has an unknown shape; starting from an empty state')
      return emptyState()
    }
    return record.payload
  }

  async function commit(input, transition, afterCommit) {
    const expected = Number(input?.revision)
    if (!Number.isSafeInteger(expected)) throw new StoreError('BAD_REVISION', 'Missing settings revision; reload the settings.')
    await credentials.modifyRecord(KEY, async record => {
      const latest = record?.kind === 'grant' && record.payload ? record.payload : emptyState()
      if (latest.revision !== expected) {
        throw new StoreError('CONFLICT', 'The settings changed in another window. Reload and retry.', 409)
      }
      const next = transition(latest, input)
      if (afterCommit) afterCommit(next)
      return { kind: 'grant', payload: next }
    })
  }

  return {
    KEY,
    read,
    async describe() {
      return redactState(await read(), runtime)
    },
    async addAccount(input) {
      await commit(input, transitions.addAccount)
      return read()
    },
    async removeAccount(input) {
      await commit(input, transitions.removeAccount, () => {
        cleanupRuntime(runtime, input.providerId, input.accountId)
      })
      return read()
    },
    async toggleAccount(input) {
      await commit(input, transitions.toggleAccount)
      return read()
    },
    async selectAccount(input) {
      await commit(input, transitions.selectAccount)
      return read()
    },
    async setSwitchMode(input) {
      await commit(input, transitions.setSwitchMode)
      return read()
    },
    async setModels(input) {
      await commit(input, transitions.setModels)
      return read()
    },
    async resetModels(input) {
      await commit(input, transitions.resetModels)
      return read()
    },
  }
}
