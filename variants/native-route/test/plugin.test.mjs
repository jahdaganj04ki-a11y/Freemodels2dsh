import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The plugin half of this variant has two observable jobs:
 *   1. put the key into `process.env.ARENA_API_KEY` for this process only,
 *   2. log a useful warning instead of throwing when something is missing.
 * Both are asserted here with a fake Cordis context (logger + effect), which also
 * proves the plugin depends on nothing else.
 */
async function withTempKey(contents, run) {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-native-plugin-'))
  const keyFile = join(directory, 'arena.key')
  if (contents !== null) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(keyFile, contents)
  }
  const previous = {
    key: process.env.ARENA_API_KEY,
    file: process.env.FREEMODELS_KEY_FILE,
    disable: process.env.FREEMODELS_DISABLE,
    base: process.env.ARENA_API_BASE,
  }
  delete process.env.ARENA_API_KEY
  process.env.FREEMODELS_KEY_FILE = keyFile
  process.env.ARENA_API_BASE = 'http://127.0.0.1:1/v1'
  delete process.env.FREEMODELS_DISABLE
  try {
    await run({ keyFile })
  } finally {
    for (const [name, value] of [['ARENA_API_KEY', previous.key], ['FREEMODELS_KEY_FILE', previous.file], ['FREEMODELS_DISABLE', previous.disable], ['ARENA_API_BASE', previous.base]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
}

function fakeContext() {
  const lines = []
  const disposers = []
  const record = level => (message, fields) => lines.push({ level, message, fields })
  return {
    lines,
    disposers,
    context: {
      logger: { info: record('info'), warn: record('warn'), error: record('error') },
      effect: callback => {
        disposers.push(callback())
      },
    },
  }
}

test('apply() injects the key from the key file into the process environment', async () => {
  await withTempKey('arena-file-key-123456\n', async () => {
    const { apply, name } = await import('../index.js')
    assert.equal(name, 'dsh-freemodels-arena-native')
    const { context, lines, disposers } = fakeContext()
    apply(context)

    assert.equal(process.env.ARENA_API_KEY, 'arena-file-key-123456')
    const info = lines.find(line => line.level === 'info' && /key loaded/.test(line.message))
    assert.ok(info, 'expected a "key loaded" log line')
    assert.equal(info.fields.source, 'file')
    assert.match(info.fields.key, /^aren…\d{4}$/, 'the logged key must be masked')
    assert.equal(info.fields.key.includes('file-key'), false)
    assert.equal(disposers.length, 1, 'a disposer must exist so the probe can be aborted')
    assert.equal(typeof disposers[0], 'function')
  })
})

test('apply() keeps an already exported key untouched', async () => {
  await withTempKey(null, async () => {
    process.env.ARENA_API_KEY = 'arena-env-key-123456'
    const { apply } = await import('../index.js')
    const { context, lines } = fakeContext()
    apply(context)
    assert.equal(process.env.ARENA_API_KEY, 'arena-env-key-123456')
    assert.equal(lines.find(line => /key loaded/.test(line.message)).fields.source, 'env')
  })
})

test('apply() warns instead of throwing when no key exists', async () => {
  await withTempKey(null, async () => {
    const { apply } = await import('../index.js')
    const { context, lines } = fakeContext()
    assert.doesNotThrow(() => apply(context))
    const warning = lines.find(line => line.level === 'warn' && /no Arena key/.test(line.message))
    assert.ok(warning, 'expected a warning about the missing key')
    assert.match(warning.fields.expected, /ARENA_API_KEY/)
    assert.match(warning.fields.remedy, /arena-setup/)
    assert.equal(process.env.ARENA_API_KEY, undefined)
  })
})

test('apply() stays inert with FREEMODELS_DISABLE=1', async () => {
  await withTempKey('arena-file-key-123456\n', async () => {
    process.env.FREEMODELS_DISABLE = '1'
    const { apply } = await import('../index.js')
    const { context, lines, disposers } = fakeContext()
    apply(context)
    assert.equal(lines.length, 1)
    assert.match(lines[0].message, /disabled/)
    assert.equal(disposers.length, 0)
    assert.equal(process.env.ARENA_API_KEY, undefined)
  })
})

test('the reachability probe logs a warning when Arena is unreachable', async () => {
  await withTempKey('arena-file-key-123456\n', async () => {
    const { apply } = await import('../index.js')
    const { context, lines } = fakeContext()
    apply(context)
    // api.arena.ai is replaced by a closed loopback port, so the probe must fail fast.
    for (let attempt = 0; attempt < 40 && !lines.some(line => /not reachable/.test(line.message)); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const warning = lines.find(line => /not reachable/.test(line.message))
    assert.ok(warning, `expected an unreachable warning, got: ${JSON.stringify(lines)}`)
    assert.match(warning.message, /not reachable/)
  })
})
