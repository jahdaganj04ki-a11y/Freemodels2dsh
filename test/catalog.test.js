import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS, getProvider, getProviderByRoute, allRoutes,
  resolveBaseUrl, resolveNativeBaseUrl, filterDiscovery, defaultModelsFor,
} from '../lib/catalog.js'

test('catalog contains exactly the eight curated no-card cloud providers', () => {
  assert.deepEqual(PROVIDERS.map(provider => provider.id), [
    'openrouter', 'gemini', 'groq', 'mistral', 'nvidia', 'cloudflare', 'cohere', 'featherless',
  ])
  for (const provider of PROVIDERS) {
    assert.match(provider.route, /^fm-/u, `${provider.id} route must use the fm- namespace`)
    assert.match(provider.baseUrl, /^https:\/\//u, `${provider.id} must use HTTPS`)
    assert.ok(provider.defaultModels.length > 0, `${provider.id} needs default models`)
    assert.ok(provider.freeNote.length > 20, `${provider.id} needs a free-tier note`)
    assert.match(provider.signupUrl, /^https:\/\//u)
    assert.match(provider.docsUrl, /^https:\/\//u)
  }
  assert.equal(new Set(allRoutes()).size, PROVIDERS.length, 'routes must be unique')
  assert.equal(getProvider('nope'), undefined)
  assert.equal(getProviderByRoute('fm-groq').id, 'groq')
})

test('excluded providers are absent', () => {
  const ids = PROVIDERS.map(provider => provider.id)
  for (const banned of ['github', 'cerebras', 'sambanova', 'huggingface', 'ollama', 'lmstudio', 'llamacpp']) {
    assert.ok(!ids.some(id => id.includes(banned)), `${banned} must not be present`)
  }
})

test('resolveBaseUrl expands the Cloudflare account id template and validates it', () => {
  const cloudflare = getProvider('cloudflare')
  const account = { accountId: 'a'.repeat(32) }
  assert.equal(
    resolveBaseUrl(cloudflare, account),
    `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`,
  )
  assert.throws(() => resolveBaseUrl(cloudflare, { accountId: 'too-short' }), /account id/u)
  assert.throws(() => resolveBaseUrl(cloudflare, {}), /account id/u)

  const groq = getProvider('groq')
  assert.equal(resolveBaseUrl(groq, {}), groq.baseUrl)
  assert.equal(
    resolveNativeBaseUrl(cloudflare, account),
    `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}`,
  )
  assert.equal(resolveNativeBaseUrl(groq, {}), groq.baseUrl)
})

test('OpenRouter discovery keeps only zero-priced :free rows', () => {
  const provider = getProvider('openrouter')
  const payload = { data: [
    { id: 'vendor/model:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'vendor/model:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'vendor/paid:free', pricing: { prompt: '0.0001', completion: '0' } },
    { id: 'vendor/paid', pricing: { prompt: '0.1', completion: '0.2' } },
    null,
  ] }
  const models = filterDiscovery(provider, payload)
  assert.deepEqual(models.map(model => model.id), ['vendor/model:free'])
  assert.equal(models[0].contextWindow, 32768)
  assert.equal(models[0].maxTokens, 8192)
})

test('Gemini discovery allowlists flash/gemma and rejects pro/omni families', () => {
  const provider = getProvider('gemini')
  const payload = { data: [
    { id: 'gemini-3.8-flash' }, { id: 'gemma-4' }, { id: 'gemini-2.5-pro' },
    { id: 'gemini-2.0-flash-exp' }, { id: 'veo-3-image' }, { id: '' },
  ] }
  assert.deepEqual(
    filterDiscovery(provider, payload).map(model => model.id),
    ['gemini-3.8-flash', 'gemma-4', 'gemini-2.0-flash-exp'],
  )
})

test('Groq discovery drops inactive and non-chat rows', () => {
  const provider = getProvider('groq')
  const payload = { data: [
    { id: 'openai/gpt-oss-120b', active: true, type: 'chat' },
    { id: 'vendor/retired', active: false, type: 'chat' },
    { id: 'vendor/whisper', active: true, type: 'audio' },
    { id: 'vendor/plain' },
  ] }
  assert.deepEqual(
    filterDiscovery(provider, payload).map(model => model.id),
    ['openai/gpt-oss-120b', 'vendor/plain'],
  )
})

test('Mistral discovery only confirms curated free families', () => {
  const provider = getProvider('mistral')
  const payload = { data: [
    { id: 'open-mistral-nemo' }, { id: 'ministral-latest' }, { id: 'codestral-latest' },
    { id: 'mistral-large-latest' }, { id: 'mistral-small-2503' },
  ] }
  assert.deepEqual(
    filterDiscovery(provider, payload).map(model => model.id),
    ['open-mistral-nemo', 'ministral-latest', 'codestral-latest', 'mistral-small-2503'],
  )
})

test('NVIDIA discovery requires vendor-prefixed chat ids', () => {
  const provider = getProvider('nvidia')
  const payload = { data: [
    { id: 'meta/llama-3.3-70b-instruct' }, { id: 'bad id' }, { id: 'plain' },
  ] }
  assert.deepEqual(filterDiscovery(provider, payload).map(model => model.id), ['meta/llama-3.3-70b-instruct'])
})

test('Cloudflare discovery reads the native result array and keeps @cf text models', () => {
  const provider = getProvider('cloudflare')
  const payload = { result: [
    { id: '@cf/meta/llama-3.3-70b', task: { name: 'Text Generation' } },
    { id: '@cf/black-forest-labs/flux', task: { name: 'Text-to-Image' } },
    { id: 'vendor/no-prefix', task: { name: 'Text Generation' } },
  ] }
  assert.deepEqual(filterDiscovery(provider, payload).map(model => model.id), ['@cf/meta/llama-3.3-70b'])
})

test('Cohere and Featherless discovery follow their free-tier rules', () => {
  const cohere = getProvider('cohere')
  assert.deepEqual(
    filterDiscovery(cohere, { data: [{ id: 'command-r-plus' }, { id: 'embed-english-v3' }] }).map(m => m.id),
    ['command-r-plus'],
  )

  const featherless = getProvider('featherless')
  const payload = { data: [
    { id: 'meta-llama/Llama-3.3-70B-Instruct', available: true, tier: 'free' },
    { id: 'org/Busy-Model', available: false, tier: 'free' },
    { id: 'org/Paid-Model', available: true, tier: 'paid' },
    { id: 'org/No-Tier', available: true },
  ] }
  assert.deepEqual(
    filterDiscovery(featherless, payload).map(model => model.id),
    ['meta-llama/Llama-3.3-70B-Instruct', 'org/No-Tier'],
  )
})

test('filterDiscovery tolerates malformed payloads and filter throws', () => {
  const provider = getProvider('groq')
  assert.deepEqual(filterDiscovery(provider, undefined), [])
  assert.deepEqual(filterDiscovery(provider, {}), [])
  const throwing = { filter: () => { throw new Error('boom') } }
  assert.deepEqual(filterDiscovery({ ...provider, discovery: throwing }, { data: [{ id: 'x' }] }), [])
})

test('defaultModelsFor returns detached copies', () => {
  const models = defaultModelsFor('groq')
  assert.equal(models.length, getProvider('groq').defaultModels.length)
  models[0].id = 'mutated'
  assert.notEqual(defaultModelsFor('groq')[0].id, 'mutated')
  assert.throws(() => defaultModelsFor('unknown'))
})
