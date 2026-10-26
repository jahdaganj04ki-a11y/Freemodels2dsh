import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { patchModelIds, patchRouteKeys, renderRoutePatch, scalar } from '../lib/patch.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const MODELS = [
  { id: 'coding-router-preview', name: 'Arena Coding Router', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'] },
  { id: 'arena-direct-1', name: 'Arena: Direct "One"', contextWindow: 200_000 },
  { id: 'plain' },
]

test('renderRoutePatch emits a valid llm-pi-ai route with the key reference', () => {
  const yaml = renderRoutePatch({ models: MODELS, generatedAt: '2026-10-26T00:00:00.000Z' })
  assert.match(yaml, /^- insert:$/m)
  assert.match(yaml, /^ {4}- id: arena-plugin$/m)
  assert.match(yaml, /^ {4}- id: freemodels-arena-route$/m)
  assert.match(yaml, /^ {6}name: '@deepseek-ai\/dsh-llm-pi-ai'$/m)
  assert.match(yaml, /^ {10}arena:$/m)
  assert.match(yaml, /^ {12}api: openai-completions$/m)
  assert.match(yaml, /^ {12}baseURL: https:\/\/api\.arena\.ai\/v1$/m)
  assert.match(yaml, /^ {12}apiKeyEnv: ARENA_API_KEY$/m)
  // The key itself must never appear anywhere.
  assert.equal(/apiKey:/.test(yaml), false)
  assert.deepEqual(patchModelIds(yaml), ['coding-router-preview', 'arena-direct-1', 'plain'])
  assert.deepEqual(patchRouteKeys(yaml), ['arena'])
})

test('renderRoutePatch quotes names that are not plain YAML scalars', () => {
  const yaml = renderRoutePatch({ models: MODELS })
  assert.match(yaml, /name: "Arena: Direct \\"One\\""/)
  // Names with spaces are quoted so the YAML stays unambiguous.
  assert.match(yaml, /- id: coding-router-preview\n {16}name: "Arena Coding Router"/)
  // The id equals the name for `plain`, so the redundant name line is dropped.
  assert.match(yaml, /- id: plain\n/)
})

test('renderRoutePatch carries capacities and modalities', () => {
  const yaml = renderRoutePatch({ models: MODELS })
  assert.match(yaml, /contextWindow: 1000000/)
  assert.match(yaml, /maxTokens: 128000/)
  assert.match(yaml, /input: \[text, image\]/)
})

test('renderRoutePatch refuses empty catalogs, bad ids and bad route keys', () => {
  assert.throws(() => renderRoutePatch({ models: [] }), /without models/)
  assert.throws(() => renderRoutePatch({}), /without models/)
  assert.throws(() => renderRoutePatch({ models: [{ name: 'no id' }] }), /without an id/)
  assert.throws(() => renderRoutePatch({ models: MODELS, route: 'Arena.Route' }), /lowercase identifier/)
})

test('scalar only leaves unambiguous identifiers unquoted', () => {
  assert.equal(scalar('arena'), 'arena')
  assert.equal(scalar('coding-router-preview'), 'coding-router-preview')
  assert.equal(scalar('has space'), '"has space"')
  assert.equal(scalar('a:b'), '"a:b"')
  assert.equal(scalar('5numbers'), '"5numbers"')
})

test('the shipped cordis.patch.yml matches the generator contract', () => {
  const shipped = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(shipped, /name: dsh-freemodels-arena-native/)
  assert.match(shipped, /apiKeyEnv: ARENA_API_KEY/)
  assert.deepEqual(patchModelIds(shipped), ['coding-router-preview'])
  assert.deepEqual(patchRouteKeys(shipped), ['arena'])

  // Regenerating with the shipped model reproduces the same model block, so a
  // `--sync` cannot silently change the structure.
  const regenerated = renderRoutePatch({ models: [MODELS[0]] })
  assert.deepEqual(patchModelIds(regenerated), patchModelIds(shipped))
  assert.deepEqual(patchRouteKeys(regenerated), patchRouteKeys(shipped))
})
