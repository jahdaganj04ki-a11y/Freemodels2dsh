import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeCatalog, normalizeApiBase } from '../lib/catalog.js'
import { check, doctor, sync } from '../lib/setup.js'
import { patchModelIds } from '../lib/patch.js'
import { startUpstream } from './helpers.mjs'

const PAYLOAD = {
  data: [
    { id: 'coding-router-preview', name: 'Arena Coding Router', context_length: 1000000, max_completion_tokens: 128000, modalities: { text: true, image: true } },
    { id: 'arena-direct-1', display_name: 'Arena Direct One', context_window: 200000 },
  ],
}

test('normalizeCatalog handles the field spellings Arena may use', () => {
  const models = normalizeCatalog(PAYLOAD)
  assert.deepEqual(models.map(model => model.id), ['coding-router-preview', 'arena-direct-1'])
  assert.equal(models[0].contextWindow, 1_000_000)
  assert.equal(models[0].maxTokens, 128_000)
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[1].name, 'Arena Direct One')
  assert.equal(models[1].contextWindow, 200_000)
  assert.deepEqual(normalizeCatalog(null), [])
})

test('normalizeApiBase insists on https and strips trailing slashes', () => {
  assert.equal(normalizeApiBase('https://api.arena.ai/v1/'), 'https://api.arena.ai/v1')
  assert.throws(() => normalizeApiBase('http://api.arena.ai/v1'), /https/)
  assert.throws(() => normalizeApiBase(''), /required/)
})

test('check() reports the models the key can use', async () => {
  const upstream = await startUpstream(() => ({ body: PAYLOAD }))
  try {
    const { models } = await check({ apiBase: upstream.apiBase, apiKey: 'arena-test-key' })
    assert.deepEqual(models.map(model => model.id), ['coding-router-preview', 'arena-direct-1'])
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer arena-test-key')
  } finally {
    await upstream.close()
  }
})

test('sync() writes a patch whose model list follows the catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-sync-'))
  const patchPath = join(directory, 'cordis.patch.yml')
  const upstream = await startUpstream(() => ({ body: PAYLOAD }))
  try {
    const result = await sync({ apiBase: upstream.apiBase, apiKey: 'arena-test-key', patchPath })
    assert.equal(result.written, true)
    const written = await readFile(patchPath, 'utf8')
    assert.deepEqual(patchModelIds(written), ['coding-router-preview', 'arena-direct-1'])
    assert.match(written, new RegExp(`baseURL: ${upstream.apiBase}`))
    assert.match(written, /apiKeyEnv: ARENA_API_KEY/)
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('sync() with --dry-run returns the patch without touching the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-dry-'))
  const patchPath = join(directory, 'cordis.patch.yml')
  const upstream = await startUpstream(() => ({ body: PAYLOAD }))
  try {
    const result = await sync({ apiBase: upstream.apiBase, apiKey: 'k', patchPath, dryRun: true })
    assert.equal(result.written, false)
    assert.match(result.yaml, /- id: coding-router-preview/)
    await assert.rejects(readFile(patchPath, 'utf8'))
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('sync() fails loudly when Arena rejects the key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-reject-'))
  const upstream = await startUpstream(() => ({ status: 401, body: { error: { message: 'invalid token' } } }))
  try {
    await assert.rejects(
      sync({ apiBase: upstream.apiBase, apiKey: 'bad-key', patchPath: join(directory, 'p.yml') }),
      /HTTP 401/
    )
    await assert.rejects(readFile(join(directory, 'p.yml'), 'utf8'))
  } finally {
    await upstream.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('doctor() explains the three states: no patch, no key, healthy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-doctor-'))
  const patchPath = join(directory, 'cordis.patch.yml')
  try {
    const empty = doctor({ patchPath, loadKeyResult: { key: null, error: null } })
    assert.equal(empty.healthy, false)
    assert.deepEqual(empty.findings.map(finding => finding.code), ['patch_missing', 'key_missing'])
    assert.match(empty.findings[0].hint, /--sync/)

    const upstream = await startUpstream(() => ({ body: PAYLOAD }))
    try {
      await sync({ apiBase: upstream.apiBase, apiKey: 'k', patchPath })
    } finally {
      await upstream.close()
    }
    const healthy = doctor({ patchPath, loadKeyResult: { key: 'arena-key-123456', source: 'file' } })
    assert.equal(healthy.healthy, true)
    const codes = healthy.findings.map(finding => finding.code)
    assert.deepEqual(codes, ['patch_model_count', 'key_present'])
    assert.match(healthy.findings[1].message, /key file/)

    const missingKey = doctor({ patchPath, loadKeyResult: { key: null, error: 'no key' } })
    assert.equal(missingKey.healthy, false)
    assert.equal(missingKey.findings.some(finding => finding.code === 'key_missing'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('doctor() warns about a stale route key and a missing credential reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-doctor2-'))
  const patchPath = join(directory, 'cordis.patch.yml')
  const { writeFile } = await import('node:fs/promises')
  try {
    await writeFile(patchPath, '- insert:\n    - id: x\n      name: y\n      config:\n        providers:\n          myarena:\n            models:\n              - id: m1\n')
    const report = doctor({ patchPath, loadKeyResult: { key: 'arena-key-123456', source: 'env' } })
    const codes = report.findings.map(finding => finding.code)
    assert.ok(codes.includes('route_key'))
    assert.ok(codes.includes('patch_credential'))
    assert.equal(report.healthy, true, 'warnings alone do not block')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
