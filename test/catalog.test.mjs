import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isModelAllowed,
  normalizeModels,
  parseAllowlist,
  readCatalogCache,
  resolveCatalog,
  toOpenAIList,
  writeCatalogCache,
} from '../lib/catalog.js'
import { MODELS_PAYLOAD, startUpstream } from './helpers.mjs'

test('normalizeModels accepts the common OpenAI/AI-SDK/LiteLLM spellings', () => {
  const models = normalizeModels({
    data: [
      { id: 'a', name: 'A', context_length: 1000, max_tokens: 100 },
      { id: 'b', display_name: 'B', context_window: 2000, max_output_tokens: 200, input_modalities: ['text', 'image'] },
      { id: 'c', label: 'C', context: 3000, modalities: { text: true, audio: false } },
      { model: 'd', title: 'D' },
      { id: 'a', name: 'duplicate' },
      { nothing: true },
      null,
    ],
  })
  assert.deepEqual(models.map(model => model.id), ['a', 'b', 'c', 'd'])
  assert.equal(models[0].contextWindow, 1000)
  assert.equal(models[0].maxTokens, 100)
  assert.equal(models[1].name, 'B')
  assert.deepEqual(models[1].input, ['text', 'image'])
  assert.equal(models[2].contextWindow, 3000)
  assert.deepEqual(models[2].input, ['text'])
})


test('normalizeModels reads bare arrays and empty payloads', () => {
  assert.deepEqual(normalizeModels([{ id: 'x' }]).map(model => model.id), ['x'])
  assert.deepEqual(normalizeModels({}), [])
  assert.deepEqual(normalizeModels(null), [])
})

test('toOpenAIList produces the OpenAI list shape', () => {
  const list = toOpenAIList(normalizeModels(MODELS_PAYLOAD), { created: 123 })
  assert.equal(list.object, 'list')
  assert.equal(list.data[0].object, 'model')
  assert.equal(list.data[0].created, 123)
  assert.equal(list.data[0].owned_by, 'arena')
})

test('allowlists are case-insensitive and empty means everything', () => {
  assert.equal(isModelAllowed('Coding-Router-Preview', ['coding-router-preview']), true)
  assert.equal(isModelAllowed('other', ['coding-router-preview']), false)
  assert.equal(isModelAllowed('anything', []), true)
  assert.equal(isModelAllowed('anything', null), true)
  assert.deepEqual(parseAllowlist(' a , b,,'), ['a', 'b'])
  assert.deepEqual(parseAllowlist(undefined), [])
})

test('resolveCatalog prefers upstream, then the cache file, then built-ins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-catalog-'))
  const cacheFile = join(directory, 'catalog.json')
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  try {
    const live = await resolveCatalog({ apiBase: upstream.apiBase, apiKey: 'k', cacheFile, ttlMs: 60_000 })
    assert.equal(live.source, 'upstream')
    assert.equal(live.models.length, 2)
    assert.equal(readCatalogCache(cacheFile)?.models.length, 2)

    // Within the TTL the cache wins without another upstream call.
    const callsBefore = upstream.calls.length
    const cached = await resolveCatalog({ apiBase: upstream.apiBase, apiKey: 'k', cacheFile, ttlMs: 60_000 })
    assert.equal(cached.source, 'cache')
    assert.equal(upstream.calls.length, callsBefore)

    // Upstream failure falls back to the last good copy.
    const stale = await resolveCatalog({ apiBase: `http://127.0.0.1:1/v1`, apiKey: 'k', cacheFile })
    assert.equal(stale.source, 'cache')
    assert.equal(stale.stale, true)
    assert.ok(stale.error)

    // No cache and no upstream: built-in fallback keeps the picker usable.
    const fallback = await resolveCatalog({ apiBase: `http://127.0.0.1:1/v1`, apiKey: 'k', cacheFile: join(directory, 'missing.json') })
    assert.equal(fallback.source, 'fallback')
    assert.deepEqual(fallback.models.map(model => model.id), ['coding-router-preview'])
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an expired cache is refreshed from upstream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-catalog-'))
  const cacheFile = join(directory, 'catalog.json')
  writeCatalogCache(cacheFile, { models: [{ id: 'old-model', name: 'old-model' }], fetchedAt: Date.now() - 3_600_000 })
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  try {
    const result = await resolveCatalog({ apiBase: upstream.apiBase, apiKey: 'k', cacheFile, ttlMs: 60_000 })
    assert.equal(result.source, 'upstream')
    assert.deepEqual(result.models.map(model => model.id), ['coding-router-preview', 'arena-direct-1'])
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unwritable cache location is not fatal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-catalog-'))
  const upstream = await startUpstream(() => ({ body: MODELS_PAYLOAD }))
  try {
    const result = await resolveCatalog({
      apiBase: upstream.apiBase,
      apiKey: 'k',
      cacheFile: join(directory, 'nested', 'deeper', 'catalog.json'),
    })
    assert.equal(result.source, 'upstream')
    assert.equal(readCatalogCache(join(directory, 'nested', 'deeper', 'catalog.json'))?.models.length, 2)
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})
