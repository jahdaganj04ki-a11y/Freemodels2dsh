/**
 * freemodels2dsh — free-tier cloud LLM providers for DSH Desktop.
 *
 * Server entry. Registers one LlmAdapter for every curated free route, the
 * configurable-provider directory used by the Models settings page, and the
 * HTTP endpoints consumed by the plugin settings tab. All durable state lives
 * in one owner-scoped credential grant record (see lib/storage.js).
 *
 * @module freemodels2dsh
 */

import z from '@deepseek-ai/schemastery'
import {
  PROVIDERS, getProvider, filterDiscovery, resolveBaseUrl, resolveNativeBaseUrl,
} from './lib/catalog.js'
import { createStore, StoreError, redactState } from './lib/storage.js'
import { createRuntime } from './lib/rotation.js'
import { FreeModelsAdapter, configurableEntries, allAdapterRoutes } from './lib/adapter.js'
import { getJson } from './lib/wire.js'

export const name = 'freemodels2dsh'
export const inject = ['llm', 'credentials', 'connection']
export const Config = z.object({})

const API_PREFIX = '/api/freemodels2dsh'
const MAX_BODY_BYTES = 32 * 1024
const DISCOVERY_TIMEOUT_MS = 20_000

async function readJson(request) {
  const chunks = []
  let bytes = 0
  // requestBody: 'buffered' gives a Request with a body reader available.
  const reader = request.body?.getReader?.()
  if (!reader) return {}
  while (true) {
    request.signal?.throwIfAborted?.()
    const part = await reader.read()
    if (part.done) break
    bytes += part.value.byteLength
    if (bytes > MAX_BODY_BYTES) throw new StoreError('TOO_LARGE', 'The request body is too large.', 413)
    chunks.push(part.value)
  }
  const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer())
  if (text.length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new StoreError('BAD_JSON', 'The request body is not valid JSON.')
  }
}

function errorBody(error) {
  if (error instanceof StoreError) {
    return { status: error.status, body: { code: error.code, error: error.message } }
  }
  const code = error?.code ?? 'UNAVAILABLE'
  const status = Number.isInteger(error?.status) ? error.status : 502
  return { status, body: { code, error: String(error?.message ?? 'The free-model service is unavailable.') } }
}

/** Public, secret-free provider metadata for the settings UI. */
function catalogView() {
  return PROVIDERS.map(def => ({
    id: def.id,
    route: def.route,
    name: def.name,
    signupUrl: def.signupUrl,
    docsUrl: def.docsUrl,
    freeNote: def.freeNote,
    requiresAccountId: Boolean(def.accountIdField),
    keyless: Boolean(def.keyless),
    defaultModels: def.defaultModels.map(model => ({ ...model })),
  }))
}

/** First enabled account that can call the provider (key-bearing, or anonymous on a keyless route). */
function usableAccountFor(def, providerState) {
  return providerState?.accounts.find(item => item.enabled && (item.apiKey || def.keyless))
}

/** Absolute discovery URL for a provider and the account that owns the call. */
function discoveryUrlFor(def, account) {
  const root = def.discovery.nativePath
    ? resolveNativeBaseUrl(def, account)
    : resolveBaseUrl(def, account)
  return `${root.replace(/\/+$/u, '')}${def.discovery.nativePath ?? def.discovery.path}`
}

export function apply(ctx) {
  const runtime = createRuntime()
  const store = createStore(ctx, runtime)
  // ctx.get keeps the dependency optional: a profile without the durable
  // attachment service still mounts, and only vision requests are affected.
  const adapter = new FreeModelsAdapter(store, runtime, () => ctx.get?.('attachments'))

  ctx.llm.registerAdapter(allAdapterRoutes(), adapter)
  ctx.llm.registerConfigurableProviders(configurableEntries(name))

  const withCatalog = state => ({ ...state, catalog: catalogView() })

  const json = async (run) => {
    try {
      return Response.json(await run(), { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      ctx.logger.info('freemodels2dsh: request failed; code=%s', error?.code ?? 'UNKNOWN')
      const { status, body } = errorBody(error)
      return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  const register = (suffix, methods, handler) => ctx.connection.fetch.register({
    path: `${API_PREFIX}.${suffix}`,
    methods,
    requestBody: 'buffered',
    fetch: handler,
  })

  register('state', ['GET'], () => json(async () => withCatalog(await store.describe())))

  const mutation = method => async request => json(async () => {
    const input = await readJson(request)
    const state = await store[method](input)
    return withCatalog(redactState(state, runtime))
  })

  register('account-add', ['POST'], mutation('addAccount'))
  register('account-remove', ['POST'], mutation('removeAccount'))
  register('account-toggle', ['POST'], mutation('toggleAccount'))
  register('account-select', ['POST'], mutation('selectAccount'))
  register('switch-mode', ['POST'], mutation('setSwitchMode'))
  register('models-reset', ['POST'], mutation('resetModels'))

  register('models-refresh', ['POST'], async request => json(async () => {
    const input = await readJson(request)
    const def = getProvider(input.providerId)
    if (!def) throw new StoreError('UNKNOWN_PROVIDER', 'Unknown free provider.')
    const state = await store.read()
    const providerState = state.providers[input.providerId]
    const account = usableAccountFor(def, providerState)
    if (!account) throw new StoreError('NO_ACCOUNT', 'Add and enable an account for this provider first.')
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    const url = discoveryUrlFor(def, account)
    const payload = await getJson({
      url, apiKey: account.apiKey?.trim() ?? '', extraHeaders: def.extraHeaders ?? {}, signal,
    })
    const models = filterDiscovery(def, payload)
    if (models.length === 0) {
      throw new StoreError('NO_MODELS', 'The endpoint returned no free models for this account.')
    }
    const next = await store.setModels({ revision: input.revision, providerId: input.providerId, models })
    return withCatalog(redactState(next, runtime))
  }))

  register('models-refresh-all', ['POST'], async request => json(async () => {
    const input = await readJson(request)
    const state = await store.read()
    const targets = PROVIDERS.filter(def => usableAccountFor(def, state.providers[def.id]))
    if (targets.length === 0) {
      throw new StoreError('NO_ACCOUNT', 'Add and enable an account for at least one provider first.')
    }
    // Every provider refreshes independently; one failing route must not
    // discard the discoveries that succeeded.
    const settled = await Promise.all(targets.map(async def => {
      const account = usableAccountFor(def, state.providers[def.id])
      const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
      try {
        const payload = await getJson({
          url: discoveryUrlFor(def, account),
          apiKey: account.apiKey?.trim() ?? '',
          extraHeaders: def.extraHeaders ?? {},
          signal,
        })
        const models = filterDiscovery(def, payload)
        if (models.length === 0) {
          return { providerId: def.id, error: { code: 'NO_MODELS', message: 'The endpoint returned no free models.' } }
        }
        return { providerId: def.id, models }
      } catch (error) {
        return {
          providerId: def.id,
          error: { code: error?.code ?? 'UNAVAILABLE', message: String(error?.message ?? 'refresh failed') },
        }
      }
    }))
    const items = settled.filter(entry => !entry.error)
    const failed = settled.filter(entry => entry.error).map(entry => ({ providerId: entry.providerId, ...entry.error }))
    if (items.length === 0) {
      throw new StoreError('NO_MODELS', 'Every provider refresh failed; check the accounts and try again.')
    }
    const next = await store.setModelsBatch({ revision: Number(input.revision), items })
    return {
      ...withCatalog(redactState(next, runtime)),
      refresh: { updated: items.map(entry => entry.providerId), failed },
    }
  }))

  register('account-test', ['POST'], async request => json(async () => {
    const input = await readJson(request)
    const def = getProvider(input.providerId)
    if (!def) throw new StoreError('UNKNOWN_PROVIDER', 'Unknown free provider.')
    const state = await store.read()
    const providerState = state.providers[input.providerId]
    const account = providerState?.accounts.find(
      item => item.id === input.accountId && (item.apiKey || def.keyless),
    )
    if (!account) throw new StoreError('UNKNOWN_ACCOUNT', 'The account does not exist or has no API key.')
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    const url = discoveryUrlFor(def, account)
    await getJson({
      url, apiKey: account.apiKey?.trim() ?? '', extraHeaders: def.extraHeaders ?? {}, signal,
    })
    return { ok: true }
  }))

  ctx.logger.info('freemodels2dsh: mounted %d free provider routes', allAdapterRoutes().length)
}
