/**
 * Where the Arena API key lives.
 *
 * Rules, in order of precedence:
 *   1. `ARENA_API_KEY` in the process environment (inherited by DSH Desktop when
 *      it is set as a user environment variable on Windows).
 *   2. A key file: `FREEMODELS_KEY_FILE`, else a per-user path
 *      (`%LOCALAPPDATA%\freemodels2dsh\arena.key` on Windows).
 *
 * The key never lands in DSH's profile settings, session logs or the gateway's
 * own configuration: the gateway is the only component that reads it and the
 * only component that talks to Arena.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const KEY_ENV = 'ARENA_API_KEY'
export const KEY_FILE_ENV = 'FREEMODELS_KEY_FILE'

/** Per-user default location for the key file. */
export function defaultKeyFile(env = process.env) {
  if (env[KEY_FILE_ENV]) return env[KEY_FILE_ENV]
  const home = env.USERPROFILE || env.HOME || homedir()
  if (env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, 'freemodels2dsh', 'arena.key')
  }
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  return join(configHome, 'freemodels2dsh', 'arena.key')
}

/**
 * Key shape check. Arena keys are opaque bearer tokens; the check only rejects
 * values that cannot be sent as an HTTP header safely, plus obvious copy/paste
 * accidents (quotes, `Bearer ` prefix, whitespace).
 */
export function normalizeKey(raw) {
  if (typeof raw !== 'string') return null
  let key = raw.trim()
  if (!key) return null
  if (/^bearer\s+/i.test(key)) key = key.replace(/^bearer\s+/i, '').trim()
  if (key.length < 8 || key.length > 4096) return null
  if (/[\s\u0000-\u001f\u007f"]/u.test(key)) return null
  return key
}

export function maskKey(key) {
  if (!key) return null
  if (key.length <= 10) return '***'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * Resolves the key without throwing: the gateway must start even when no key is
 * configured so that `/health` and the status page can explain what is missing.
 *
 * @param {{env?: NodeJS.ProcessEnv, keyFile?: string, readFile?: (path: string, encoding: string) => string}} options
 * @returns {{key: string | null, source: 'env' | 'file' | null, keyFile: string, error: string | null}}
 */
export function resolveApiKey(options = {}) {
  const env = options.env ?? process.env
  const keyFile = options.keyFile ?? defaultKeyFile(env)
  const readFile = options.readFile ?? ((path, encoding) => readFileSync(path, encoding))

  const fromEnv = normalizeKey(env[KEY_ENV])
  if (fromEnv) return { key: fromEnv, source: 'env', keyFile, error: null }
  if (env[KEY_ENV]) {
    return { key: null, source: null, keyFile, error: `${KEY_ENV} is set but is not a usable key` }
  }

  try {
    const fromFile = normalizeKey(readFile(keyFile, 'utf8'))
    if (fromFile) return { key: fromFile, source: 'file', keyFile, error: null }
    return { key: null, source: null, keyFile, error: `key file ${keyFile} does not contain a usable key` }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { key: null, source: null, keyFile, error: null }
    return { key: null, source: null, keyFile, error: `key file ${keyFile} could not be read (${error?.code ?? 'error'})` }
  }
}

/** Atomically writes the key file with owner-only permissions where supported. */
export function writeKeyFile(keyFile, key) {
  const normalized = normalizeKey(key)
  if (!normalized) throw new Error('The supplied Arena API key is empty or contains invalid characters')
  mkdirSync(dirname(keyFile), { recursive: true })
  const temporary = `${keyFile}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${normalized}\n`, { mode: 0o600 })
    renameSync(temporary, keyFile)
  } finally {
    rmSync(temporary, { force: true })
  }
  try {
    chmodSync(keyFile, 0o600)
  } catch {
    // Windows ACLs are managed by the installer script; chmod is best effort.
  }
  return keyFile
}
