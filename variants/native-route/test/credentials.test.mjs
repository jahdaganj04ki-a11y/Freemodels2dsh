import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultKeyFile, loadKey, maskKey, normalizeKey, writeKeyFile } from '../lib/credentials.js'

test('normalizeKey accepts plain and Bearer-prefixed keys, rejects unsafe values', () => {
  assert.equal(normalizeKey(' arena-abc-123456 '), 'arena-abc-123456')
  assert.equal(normalizeKey('Bearer arena-abc-123456'), 'arena-abc-123456')
  assert.equal(normalizeKey('short'), null)
  assert.equal(normalizeKey('has space'), null)
  assert.equal(normalizeKey('quote"inside-value'), null)
  assert.equal(normalizeKey(undefined), null)
})

test('maskKey hides the middle of the key', () => {
  assert.equal(maskKey('arena-abcdefghijklmnop'), 'aren…mnop')
  assert.equal(maskKey('tiny'), '***')
  assert.equal(maskKey(null), null)
})

test('loadKey prefers the environment and reports its source', () => {
  const result = loadKey({ env: { ARENA_API_KEY: 'env-key-123456789' }, readFile: () => 'file-key-123456789' })
  assert.equal(result.key, 'env-key-123456789')
  assert.equal(result.source, 'env')
})

test('loadKey falls back to the key file', () => {
  const result = loadKey({ env: {}, keyFile: join('C:\\x', 'arena.key'), readFile: () => 'file-key-123456789\n' })
  assert.equal(result.key, 'file-key-123456789')
  assert.equal(result.source, 'file')
})

test('loadKey distinguishes "no key yet" from "broken key"', () => {
  const missing = loadKey({ env: {}, keyFile: join(tmpdir(), 'nope', 'arena.key') })
  assert.equal(missing.key, null)
  assert.equal(missing.error, null)

  const broken = loadKey({ env: { ARENA_API_KEY: 'not a key' } })
  assert.equal(broken.key, null)
  assert.match(broken.error, /ARENA_API_KEY/)

  const unreadable = loadKey({
    env: {},
    keyFile: 'C:\\x\\arena.key',
    readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  })
  assert.match(unreadable.error, /unreadable/)
})

test('defaultKeyFile targets the per-user location on Windows', () => {
  assert.equal(
    defaultKeyFile({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }),
    join('C:\\Users\\t\\AppData\\Local', 'freemodels2dsh', 'arena.key')
  )
  assert.equal(defaultKeyFile({ FREEMODELS_KEY_FILE: 'D:\\keys\\a.key' }), 'D:\\keys\\a.key')
})

test('writeKeyFile writes a normalized key with 0600 permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-key-'))
  const keyFile = join(directory, 'sub', 'arena.key')
  try {
    writeKeyFile(keyFile, 'Bearer arena-written-123456')
    assert.equal((await readFile(keyFile, 'utf8')).trim(), 'arena-written-123456')
    if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600)
    assert.throws(() => writeKeyFile(keyFile, '   '), /empty or contains/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
