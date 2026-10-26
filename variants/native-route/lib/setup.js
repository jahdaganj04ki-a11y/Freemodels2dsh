/**
 * Setup logic behind `bin/arena-setup.mjs`, kept separate so it is testable
 * without a terminal.
 *
 * Three operations:
 *   check({apiBase, apiKey})        – is the key valid, which models does it get?
 *   sync({..., patchPath})         – regenerate the route patch from the catalog
 *   doctor({..., patchPath})       – compare patch, environment and Arena
 */
import { readFileSync } from 'node:fs'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fetchCatalog } from './catalog.js'
import { patchModelIds, patchRouteKeys, renderRoutePatch } from './patch.js'

export async function check({ apiBase, apiKey, fetchImpl, signal } = {}) {
  const { models, fetchedAt } = await fetchCatalog({ apiBase, apiKey, fetchImpl, signal })
  return { models, fetchedAt }
}

/**
 * Writes the route patch. Returns the text even for a dry run so the CLI can
 * print it.
 */
export async function sync({
  apiBase,
  apiKey,
  fetchImpl,
  patchPath,
  dryRun = false,
  displayName = 'Arena',
  route = 'arena',
  signal,
} = {}) {
  const { models, fetchedAt } = await check({ apiBase, apiKey, fetchImpl, signal })
  const yaml = renderRoutePatch({ models, baseURL: apiBase, displayName, route, generatedAt: new Date(fetchedAt).toISOString() })
  if (!dryRun) {
    if (!patchPath) throw new Error('sync() needs a patchPath')
    writeFileAtomically(patchPath, yaml)
  }
  return { models, yaml, fetchedAt, written: !dryRun, patchPath }
}

/**
 * Explains why a native route might not answer, without changing anything.
 * `healthy` is false only for problems the user has to fix.
 */
export function doctor({ patchPath, loadKeyResult, env = process.env } = {}) {
  const findings = []
  const push = (level, code, message, hint) => findings.push({ level, code, message, ...(hint ? { hint } : {}) })

  let patch = null
  try {
    patch = readFileSync(patchPath, 'utf8')
  } catch (error) {
    push('error', 'patch_missing', `No route patch at ${patchPath}`, 'Run: node bin/arena-setup.mjs --sync')
  }
  if (patch) {
    const ids = patchModelIds(patch)
    if (ids.length === 0) push('error', 'patch_empty', 'The route patch declares no models', 'Regenerate it with --sync')
    else push('ok', 'patch_model_count', `Route patch declares ${ids.length} model(s)`, undefined)
    if (!/apiKeyEnv: ARENA_API_KEY/.test(patch)) {
      push('warn', 'patch_credential', 'The route patch does not reference ARENA_API_KEY', 'Use the generated patch or add apiKeyEnv: ARENA_API_KEY')
    }
    for (const key of patchRouteKeys(patch)) {
      if (key !== 'arena') push('warn', 'route_key', `Route key is "${key}", not "arena"`, 'Keep the docs in sync if you renamed it')
    }
  }

  if (loadKeyResult?.key) {
    push('ok', 'key_present', `Arena key present (${loadKeyResult.source === 'env' ? 'environment' : 'key file'}, ${mask(loadKeyResult.key)})`)
  } else {
    push('error', 'key_missing', loadKeyResult?.error ?? 'No Arena API key found', 'Run: node bin/arena-setup.mjs  (or scripts\\set-arena-key.ps1)')
  }

  if (env.ARENA_API_KEY && loadKeyResult?.source !== 'env') {
    push('warn', 'env_mismatch', 'ARENA_API_KEY is set but did not resolve', 'Check it for whitespace or quotes')
  }

  return {
    findings,
    healthy: findings.every(finding => finding.level !== 'error'),
  }
}

function mask(key) {
  return key.length <= 10 ? '***' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

function writeFileAtomically(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, text)
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}
