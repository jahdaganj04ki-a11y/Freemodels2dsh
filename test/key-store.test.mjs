import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defaultKeyFile, maskKey, normalizeKey, resolveApiKey, writeKeyFile } from '../lib/key-store.js'

test('normalizeKey trims, unwraps Bearer and rejects unusable values', () => {
  assert.equal(normalizeKey('  arena-abc-123456  '), 'arena-abc-123456')
  assert.equal(normalizeKey('Bearer arena-abc-123456'), 'arena-abc-123456')
  assert.equal(normalizeKey('short'), null)
  assert.equal(normalizeKey('has space inside'), null)
  assert.equal(normalizeKey('quote"inside-value'), null)
  assert.equal(normalizeKey(''), null)
  assert.equal(normalizeKey(undefined), null)
  assert.equal(normalizeKey('x'.repeat(5000)), null)
})

test('maskKey never reveals the middle of the key', () => {
  assert.equal(maskKey('arena-abcdefghijklmnop'), 'aren…mnop')
  assert.equal(maskKey('short'), '***')
  assert.equal(maskKey(null), null)
})

test('resolveApiKey prefers the environment over the key file', () => {
  const resolved = resolveApiKey({
    env: { ARENA_API_KEY: 'env-key-123456789', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    readFile: () => 'file-key-123456789',
  })
  assert.equal(resolved.key, 'env-key-123456789')
  assert.equal(resolved.source, 'env')
})

test('resolveApiKey falls back to the key file and reports a readable path', () => {
  let requested = null
  const resolved = resolveApiKey({
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    readFile: path => {
      requested = path
      return `${'file-key-123456789'}\n`
    },
  })
  assert.equal(resolved.key, 'file-key-123456789')
  assert.equal(resolved.source, 'file')
  assert.equal(requested, join('C:\\Users\\test\\AppData\\Local', 'freemodels2dsh', 'arena.key'))
})

test('a missing key file is not an error, a broken key is reported', () => {
  const missing = resolveApiKey({ env: {}, keyFile: join(tmpdir(), 'does-not-exist', 'arena.key') })
  assert.equal(missing.key, null)
  assert.equal(missing.error, null)

  const invalidEnv = resolveApiKey({ env: { ARENA_API_KEY: 'not a key' } })
  assert.equal(invalidEnv.key, null)
  assert.match(invalidEnv.error, /ARENA_API_KEY/)

  const brokenFile = resolveApiKey({ env: {}, keyFile: 'C:\\x\\arena.key', readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } })
  assert.equal(brokenFile.key, null)
  assert.match(brokenFile.error, /could not be read/)
})

test('defaultKeyFile picks a per-user location on Windows and elsewhere', () => {
  assert.equal(
    defaultKeyFile({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local', APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }),
    join('C:\\Users\\t\\AppData\\Local', 'freemodels2dsh', 'arena.key')
  )
  assert.equal(
    defaultKeyFile({ HOME: '/home/t', XDG_CONFIG_HOME: '/home/t/.config' }),
    join('/home/t/.config', 'freemodels2dsh', 'arena.key')
  )
  assert.equal(defaultKeyFile({ FREEMODELS_KEY_FILE: '/tmp/custom.key' }), '/tmp/custom.key')
})

test('writeKeyFile stores a normalized key with owner-only permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-key-'))
  const keyFile = join(directory, 'nested', 'arena.key')
  try {
    writeKeyFile(keyFile, 'Bearer arena-written-123456')
    assert.equal((await readFile(keyFile, 'utf8')).trim(), 'arena-written-123456')
    if (process.platform !== 'win32') {
      const mode = (await stat(keyFile)).mode & 0o777
      assert.equal(mode, 0o600)
    }
    assert.throws(() => writeKeyFile(keyFile, '  '), /invalid characters/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
