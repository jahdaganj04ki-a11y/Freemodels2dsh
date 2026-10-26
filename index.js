/**
 * Host half of the freemodels2dsh plugin for DSH Desktop (DeepSeek Harness).
 *
 * DSH Desktop bundles a Harness runtime; this plugin starts the Arena gateway
 * inside that runtime, so Arena models can be used in DSH without installing
 * Node.js separately and without keeping a terminal window open.
 *
 * It intentionally declares no npm dependencies and no Cordis `Config` schema:
 * a community plugin that only uses `ctx.logger` and `ctx.effect` keeps working
 * across DSH/Harness upgrades. Everything the user can tune is read from
 * environment variables (see README).
 *
 * The plugin does *not* register an LLM route by itself. The route lives in the
 * profile's model settings (Settings → Models), which is the surface DeepSeek
 * Harness owns; see cordis.patch.arena-route.example.yml for the optional,
 * declarative variant.
 */
import { dirname, join } from 'node:path'
import { createArenaGateway } from './lib/gateway.js'
import { createLogger } from './lib/log.js'
import { defaultKeyFile, resolveApiKey } from './lib/key-store.js'
import { DEFAULT_PORT, PLUGIN_NAME, VERSION } from './lib/defaults.js'

export const name = PLUGIN_NAME

function envFlag(value) {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim())
}

function defaultCacheFile(env = process.env) {
  try {
    return join(dirname(defaultKeyFile(env)), 'catalog.json')
  } catch {
    return null
  }
}

/**
 * Cordis entry point. `apply` is synchronous: the gateway start is kicked off in
 * an effect so a slow or unreachable Arena endpoint can never delay Harness
 * boot, and the effect's disposer stops the server when the plugin is disabled,
 * the profile reloads, or DSH Desktop quits.
 */
export function apply(ctx) {
  if (envFlag(process.env.FREEMODELS_DISABLE)) {
    ctx.logger?.info?.('%s: disabled through FREEMODELS_DISABLE', PLUGIN_NAME)
    return
  }

  const logger = createLogger({
    level: process.env.FREEMODELS_LOG || 'info',
    prefix: PLUGIN_NAME,
    sink: line => {
      // Harness owns harness.log; the sink keeps our lines in the same file and
      // in `dsh` terminal output without a second logging stack.
      if (typeof ctx.logger?.info === 'function') ctx.logger.info('%s', line)
      else console.log(line)
    },
  })

  const port = Number(process.env.FREEMODELS_GATEWAY_PORT || DEFAULT_PORT)
  const gateway = createArenaGateway({
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    cacheFile: process.env.FREEMODELS_CATALOG_FILE || defaultCacheFile(),
    logger,
  })

  ctx.effect(() => {
    let disposed = false

    gateway.start()
      .then(info => {
        if (disposed) return gateway.stop()
        const keyInfo = resolveApiKey()
        logger.info('Arena gateway ready', { baseUrl: info.url, port: info.port, version: VERSION })
        if (!keyInfo.key) {
          logger.warn('no Arena API key configured; requests will fail until one is set', {
            expected: `ARENA_API_KEY environment variable or ${keyInfo.keyFile}`,
          })
        }
        logger.info('register this base URL as an OpenAI-compatible provider in Settings > Models', { baseUrl: info.url })
      })
      .catch(error => {
        if (disposed) return
        if (error?.code === 'EADDRINUSE') {
          logger.error('gateway port is already in use; another instance or program owns it', {
            port,
            remedy: 'close the other process or set FREEMODELS_GATEWAY_PORT and update the provider base URL',
          })
          return
        }
        logger.error('Arena gateway failed to start', { reason: error?.message ?? String(error) })
      })

    return () => {
      disposed = true
      return gateway.stop().catch(error => logger.debug('gateway shutdown failed', { reason: error?.message }))
    }
  })
}
