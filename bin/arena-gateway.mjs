#!/usr/bin/env node
/**
 * Standalone entry point for the Arena gateway.
 *
 * Use this when DSH Desktop's plugin path is not available (for example while
 * testing, or with a plain `dsh web` install): start the gateway in one terminal
 * and add `http://127.0.0.1:8787/v1` as an OpenAI-compatible provider in DSH.
 *
 *   node bin/arena-gateway.mjs --port 8787
 *   node bin/arena-gateway.mjs --check          # verify key + list models
 *   node bin/arena-gateway.mjs --set-key ARENA_KEY_HERE
 */
import { createArenaGateway } from '../lib/gateway.js'
import { createLogger } from '../lib/log.js'
import { defaultKeyFile, maskKey, resolveApiKey, writeKeyFile } from '../lib/key-store.js'
import { fetchUpstreamCatalog, parseAllowlist } from '../lib/catalog.js'
import { DEFAULT_API_BASE, DEFAULT_PORT, PLUGIN_NAME, VERSION } from '../lib/defaults.js'

const HELP = `${PLUGIN_NAME} ${VERSION} — local OpenAI-compatible gateway for Arena

Usage: node bin/arena-gateway.mjs [options]

Options:
  --port <n>          Loopback port (default ${DEFAULT_PORT}, env FREEMODELS_GATEWAY_PORT)
  --api-base <url>    Arena base URL (default ${DEFAULT_API_BASE}, env ARENA_API_BASE)
  --key-file <path>   Key file (default ${defaultKeyFile()})
  --catalog-file <p>  Catalog cache file (default next to the key file)
  --token <secret>    Require this bearer token from local clients
  --models <ids>      Comma separated model allowlist
  --log-level <l>     error | warn | info | debug (default info)
  --check             Validate the key against Arena and print the model list, then exit
  --set-key <key>     Store the key in the key file and exit
  --print-config      Print the base URL to paste into DSH, then exit
  --help, --version   Show this help or the version
`

function parseArgs(argv) {
  const options = { args: {} }
  const takesValue = new Set(['--port', '--api-base', '--key-file', '--catalog-file', '--token', '--models', '--log-level', '--set-key'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    if (argument === '--help' || argument === '-h') { options.args.help = true; continue }
    if (argument === '--version' || argument === '-v') { options.args.version = true; continue }
    if (argument === '--check') { options.args.check = true; continue }
    if (argument === '--print-config') { options.args.printConfig = true; continue }
    if (!takesValue.has(argument)) throw new Error(`Unknown option: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Option ${argument} needs a value`)
    options.args[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  return options.args
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }

  if (args.help) { console.log(HELP); return }
  if (args.version) { console.log(`${PLUGIN_NAME} ${VERSION}`); return }

  const keyFile = args.keyFile || defaultKeyFile()
  const logger = createLogger({ level: args.logLevel || process.env.FREEMODELS_LOG || 'info' })

  if (args.setKey) {
    writeKeyFile(keyFile, args.setKey)
    console.log(`Key stored in ${keyFile} (${maskKey(args.setKey)}).`)
    return
  }

  const apiBase = args.apiBase || process.env.ARENA_API_BASE || DEFAULT_API_BASE
  const resolvedKey = resolveApiKey({ keyFile })
  if (resolvedKey.error) console.warn(`Warning: ${resolvedKey.error}`)
  const apiKey = resolvedKey.key

  if (args.printConfig) {
    const port = Number(args.port || process.env.FREEMODELS_GATEWAY_PORT || DEFAULT_PORT)
    console.log(JSON.stringify({
      provider: 'Arena',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: args.token || '(beliebig, wenn kein lokales Token gesetzt ist)',
      health: `http://127.0.0.1:${port}/health`,
    }, null, 2))
    return
  }

  if (args.check) {
    if (!apiKey) {
      console.error(`No Arena API key found. Set ARENA_API_KEY or run: node bin/arena-gateway.mjs --set-key <key>`)
      process.exitCode = 1
      return
    }
    try {
      const catalog = await fetchUpstreamCatalog({ apiBase, apiKey })
      console.log(`OK — Arena answered with ${catalog.models.length} models:`)
      for (const model of catalog.models) {
        const context = model.contextWindow ? ` (ctx ${model.contextWindow.toLocaleString('de-DE')})` : ''
        console.log(`  - ${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ''}${context}`)
      }
    } catch (error) {
      console.error(`Key check failed: ${error?.message ?? error}`)
      process.exitCode = 1
    }
    return
  }

  const port = Number(args.port || process.env.FREEMODELS_GATEWAY_PORT || DEFAULT_PORT)
  const gateway = createArenaGateway({
    apiBase,
    port,
    keyFile,
    token: args.token || process.env.FREEMODELS_GATEWAY_TOKEN || null,
    allowlist: parseAllowlist(args.models || process.env.FREEMODELS_ARENA_MODELS || ''),
    cacheFile: args.catalogFile || null,
    logger,
  })

  try {
    const info = await gateway.start()
    const status = gateway.status()
    console.log('')
    console.log(`  ${PLUGIN_NAME} ${VERSION} — Arena gateway`)
    console.log(`  Provider-Basis-URL : ${info.url}`)
    console.log(`  Status-Seite       : http://127.0.0.1:${info.port}/`)
    console.log(`  Health             : http://127.0.0.1:${info.port}/health`)
    console.log(`  Arena-Endpunkt     : ${apiBase}`)
    console.log(`  API-Key            : ${status.key.present ? status.key.masked : `fehlt (${keyFile})`}`)
    console.log(`  Lokales Token      : ${status.tokenRequired ? 'erforderlich' : 'nicht gesetzt'}`)
    console.log('')
    console.log('  In DSH Desktop: Einstellungen → Modelle → Provider hinzufügen')
    console.log(`  Base-URL ${info.url} eintragen, Modellliste laden, Modell auswählen.`)
    console.log('  Beenden mit Strg+C.')
    console.log('')
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the other process or pass --port <n>.`)
    } else {
      console.error(`Gateway could not start: ${error?.message ?? error}`)
    }
    process.exitCode = 1
    return
  }

  let closing = false
  const shutdown = async signal => {
    if (closing) return
    closing = true
    logger.info('shutting down', { signal })
    await gateway.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', error => logger.error('unhandled rejection', { reason: error?.message ?? String(error) }))
}

main().catch(error => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
