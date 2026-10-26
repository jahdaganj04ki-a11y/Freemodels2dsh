import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Lifecycle test for the Cordis half of the plugin. It fakes the two context
 * members the plugin uses (`logger`, `effect`), which is deliberate: the plugin
 * promises to depend on nothing else, so this test fails loudly if someone adds
 * a dependency on another harness service.
 */
test('apply() starts the gateway in an effect and stops it on dispose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freemodels-plugin-'))
  const port = 19000 + Math.floor(Math.random() * 500)
  const previous = {
    key: process.env.ARENA_API_KEY,
    port: process.env.FREEMODELS_GATEWAY_PORT,
    catalog: process.env.FREEMODELS_CATALOG_FILE,
  }
  process.env.ARENA_API_KEY = 'plugin-lifecycle-key-123456'
  process.env.FREEMODELS_GATEWAY_PORT = String(port)
  process.env.FREEMODELS_CATALOG_FILE = join(directory, 'catalog.json')

  const lines = []
  let disposer = null
  const ctx = {
    logger: {
      info: (...args) => lines.push(args.join(' ')),
      warn: (...args) => lines.push(`warn ${args.join(' ')}`),
      error: (...args) => lines.push(`error ${args.join(' ')}`),
    },
    effect: callback => {
      disposer = callback()
    },
  }

  try {
    const plugin = await import('../index.js')
    assert.equal(plugin.name, 'dsh-freemodels-arena')
    assert.equal(typeof plugin.apply, 'function')
    plugin.apply(ctx)
    assert.equal(typeof disposer, 'function', 'apply() must register exactly one effect')

    let health = null
    for (let attempt = 0; attempt < 50 && !health; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
      } catch {
        health = null
      }
    }
    assert.ok(health, 'gateway did not start')
    assert.equal(health.upstream, 'https://api.arena.ai/v1')
    assert.equal(health.key.present, true)

    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()
    assert.ok(models.data.length >= 1)

    await disposer()
    await new Promise(resolve => setTimeout(resolve, 200))
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`), 'gateway kept listening after dispose')
  } finally {
    restore('ARENA_API_KEY', previous.key)
    restore('FREEMODELS_GATEWAY_PORT', previous.port)
    restore('FREEMODELS_CATALOG_FILE', previous.catalog)
    await rm(directory, { recursive: true, force: true })
  }
})

test('FREEMODELS_DISABLE=1 keeps the plugin inert', async () => {
  const previousDisable = process.env.FREEMODELS_DISABLE
  const lines = []
  let effects = 0
  process.env.FREEMODELS_DISABLE = '1'
  try {
    const plugin = await import('../index.js?disabled')
    plugin.apply({
      logger: { info: (...args) => lines.push(args.join(' ')), warn: () => {}, error: () => {} },
      effect: () => { effects += 1 },
    })
    assert.equal(effects, 0)
    assert.match(lines.join('\n'), /disabled/)
  } finally {
    restore('FREEMODELS_DISABLE', previousDisable)
  }
})

function restore(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
