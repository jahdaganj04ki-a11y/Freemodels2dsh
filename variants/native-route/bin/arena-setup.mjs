#!/usr/bin/env node
/**
 * Setup CLI for the native-route variant.
 *
 *   node bin/arena-setup.mjs               interaktiv: Key speichern, prüfen, Patch erzeugen
 *   node bin/arena-setup.mjs --sync        Katalog von Arena holen und Patch neu schreiben
 *   node bin/arena-setup.mjs --check       Key prüfen, Modelle auflisten
 *   node bin/arena-setup.mjs --doctor      Diagnose ohne Änderungen
 *   node bin/arena-setup.mjs --dry-run     Patch anzeigen statt schreiben
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { loadKey, defaultKeyFile, maskKey, writeKeyFile } from '../lib/credentials.js'
import { DEFAULT_API_BASE, normalizeApiBase } from '../lib/catalog.js'
import { check, doctor, sync } from '../lib/setup.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const PATCH_PATH = join(PACKAGE_ROOT, 'cordis.patch.yml')

const HELP = `dsh-freemodels-arena-native — Arena nativ in DSH Desktop (ohne Gateway)

Aufruf: node bin/arena-setup.mjs [Optionen]

Optionen:
  --key <key>          Arena-Key direkt übergeben (sonst verdeckte Abfrage)
  --key-file <pfad>    Key-Datei (Standard: ${defaultKeyFile()})
  --api-base <url>     Arena-Base-URL (Standard: ${DEFAULT_API_BASE})
  --sync               Modellkatalog von Arena holen und cordis.patch.yml neu schreiben
  --check              Key prüfen und Modelle auflisten
  --doctor             Nur Diagnose ausgeben
  --dry-run            Patch nur anzeigen, nicht schreiben
  --yes                Nicht nachfragen (für Skripte)
  --help, --version
`

function parseArgs(argv) {
  const options = {}
  const valued = new Set(['--key', '--key-file', '--api-base'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (valued.has(argument)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`)
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
      index += 1
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true
  }
  return options
}

/** Reads a line from the terminal without echoing it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Error('No terminal available. Pass --key <key> instead.'))
      return
    }
    const rl = createInterface({ input: stdin, output: process.stdout, terminal: true })
    const onData = () => {
      // Keep the prompt on one line: redraw it and swallow the typed characters.
      process.stdout.write(`\r${question}`)
    }
    stdin.on('data', onData)
    rl.question(question, answer => {
      stdin.off('data', onData)
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

function askYesNo(question, defaultYes = true) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) return resolve(defaultYes)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${question} [${defaultYes ? 'J/n' : 'j/N'}] `, answer => {
      rl.close()
      const text = answer.trim().toLowerCase()
      resolve(text === '' ? defaultYes : text === 'j' || text === 'ja' || text === 'y' || text === 'yes')
    })
  })
}

function printModels(models) {
  for (const model of models) {
    const facts = [
      model.contextWindow ? `ctx ${model.contextWindow.toLocaleString('de-DE')}` : null,
      model.maxTokens ? `out ${model.maxTokens.toLocaleString('de-DE')}` : null,
      model.input && model.input.length > 1 ? model.input.join('/') : null,
    ].filter(Boolean)
    const label = model.name && model.name !== model.id ? ` — ${model.name}` : ''
    console.log(`   • ${model.id}${label}${facts.length ? `  (${facts.join(', ')})` : ''}`)
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (options.help) { console.log(HELP); return }
  if (options.version) {
    const { readFileSync } = await import('node:fs')
    console.log(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version)
    return
  }

  const apiBase = normalizeApiBase(options.apiBase || process.env.ARENA_API_BASE || DEFAULT_API_BASE)
  const keyFile = options.keyFile || defaultKeyFile()

  if (options.doctor) {
    const report = doctor({ patchPath: PATCH_PATH, loadKeyResult: loadKey({ keyFile }) })
    for (const finding of report.findings) {
      const prefix = { ok: 'OK  ', warn: 'WARN', error: 'FEHL' }[finding.level] ?? '    '
      console.log(`${prefix} ${finding.message}`)
      if (finding.hint) console.log(`     → ${finding.hint}`)
    }
    console.log('')
    console.log(report.healthy ? 'Diagnose: keine blockierenden Probleme.' : 'Diagnose: siehe FEHL-Zeilen oben.')
    if (!report.healthy) process.exitCode = 1
    return
  }

  if (options.check) {
    const resolved = loadKey({ keyFile })
    if (!resolved.key) {
      console.error(`Kein Arena-Key gefunden (${resolved.error ?? `weder ARENA_API_KEY noch ${keyFile}`}).`)
      process.exitCode = 1
      return
    }
    const { models } = await check({ apiBase, apiKey: resolved.key })
    console.log(`OK — Arena kennt ${models.length} Modelle für diesen Key:`)
    printModels(models)
    return
  }

  if (options.sync) {
    const resolved = loadKey({ keyFile })
    if (!resolved.key) {
      console.error(`Kein Arena-Key gefunden (${resolved.error ?? `weder ARENA_API_KEY noch ${keyFile}`}).`)
      process.exitCode = 1
      return
    }
    const result = await sync({ apiBase, apiKey: resolved.key, patchPath: PATCH_PATH, dryRun: Boolean(options.dryRun) })
    if (options.dryRun) {
      console.log(result.yaml)
      return
    }
    console.log(`Route-Patch geschrieben: ${PATCH_PATH}`)
    console.log(`${result.models.length} Modelle übernommen:`)
    printModels(result.models)
    console.log('')
    console.log('DSH Desktop neu starten, damit das Profil den Patch liest.')
    return
  }

  /* ---------------- interaktiver Ablauf ---------------- */

  console.log('')
  console.log(' freemodels2dsh — native Route (Variante ohne Gateway)')
  console.log(' ---------------------------------------------------')

  let key = options.key
  const existing = loadKey({ keyFile })
  if (!key && existing.key) {
    console.log(` Vorhandener Key gefunden (${existing.source === 'env' ? 'Umgebung' : 'Datei'}, ${maskKey(existing.key)}).`)
    if (!options.yes && !(await askYesNo(' Key ersetzen?', false))) {
      key = existing.key
    }
  }
  if (!key) {
    key = await askHidden(' Arena-API-Key (Eingabe bleibt unsichtbar): ')
  }
  if (!key) throw new Error('Kein Key eingegeben.')

  console.log('')
  console.log(' Prüfe Key gegen Arena ...')
  let models
  try {
    ({ models } = await check({ apiBase, apiKey: key }))
  } catch (error) {
    console.error(` FEHL: ${error?.message ?? error}`)
    console.error(' Der Key wird nicht gespeichert. Häufige Ursachen:')
    console.error('   • Key kopiert unvollständig oder abgelaufen (platform.arena.ai/dashboard/keys)')
    console.error('   • Netzwerk/Proxy blockiert api.arena.ai')
    process.exitCode = 1
    return
  }
  console.log(` OK — ${models.length} Modelle verfügbar:`)
  printModels(models)

  const keyPath = writeKeyFile(keyFile, key)
  console.log('')
  console.log(` Key gespeichert: ${keyPath}`)

  const result = await sync({ apiBase, apiKey: key, patchPath: PATCH_PATH })
  console.log(` Route-Patch geschrieben: ${PATCH_PATH} (${result.models.length} Modelle)`)

  console.log('')
  console.log(' Nächste Schritte:')
  console.log('   1. DSH Desktop vollständig beenden und neu starten.')
  console.log('   2. Modellwähler öffnen — unter „Arena" stehen die Modelle aus dem Patch.')
  console.log('   3. Bei Problemen: node bin/arena-setup.mjs --doctor')
  console.log('')
  if (!process.env.ARENA_API_KEY) {
    console.log(' Hinweis: Der Key liegt nur in der Key-Datei. Das Plugin setzt ihn beim Start')
    console.log(' in die Prozessumgebung des Harness — er landet in keiner Konfiguration.')
    console.log('')
  }
}

main().catch(error => {
  console.error(error?.message ?? String(error))
  process.exitCode = 1
})
