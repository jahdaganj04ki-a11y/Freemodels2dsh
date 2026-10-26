/**
 * Key handling for the native-route variant.
 *
 * This variant has no proxy, so *some* component must hand the key to the
 * harness' own llm-pi-ai adapter. That happens through a credential reference
 * (`apiKeyEnv: ARENA_API_KEY`), i.e. the environment of the harness process — the
 * key is never written into a profile, a patch file, a session or a transcript.
 *
 * Resolution order:
 *   1. `ARENA_API_KEY` already in the environment (e.g. set as a Windows user
 *      environment variable by the setup script, inherited by DSH Desktop).
 *   2. The key file (`FREEMODELS_KEY_FILE`, default
 *      `%LOCALAPPDATA%\freemodels2dsh\arena.key` on Windows).
 *
 * Kept dependency-free and synchronous: the plugin injects the value during
 * `apply()`, before the first request can be built.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const KEY_ENV = 'ARENA_API_KEY'
export const KEY_FILE_ENV = 'FREEMODELS_KEY_FILE'

export function defaultKeyFile(env = process.env) {
  if (env[KEY_FILE_ENV]) return env[KEY_FILE_ENV]
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'freemodels2dsh', 'arena.key')
  const home = env.USERPROFILE || env.HOME || homedir()
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'freemodels2dsh', 'arena.key')
}

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
  return key.length <= 10 ? '***' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * @returns {{key: string | null, source: 'env' | 'file' | null, keyFile: string, error: string | null}}
 */
export function loadKey({ env = process.env, keyFile, readFile } = {}) {
  const file = keyFile ?? defaultKeyFile(env)
  const read = readFile ?? ((path, encoding) => readFileSync(path, encoding))

  const fromEnv = normalizeKey(env[KEY_ENV])
  if (fromEnv) return { key: fromEnv, source: 'env', keyFile: file, error: null }
  if (env[KEY_ENV]) return { key: null, source: null, keyFile: file, error: `${KEY_ENV} is set but unusable` }

  try {
    const fromFile = normalizeKey(read(file, 'utf8'))
    return fromFile
      ? { key: fromFile, source: 'file', keyFile: file, error: null }
      : { key: null, source: null, keyFile: file, error: `key file ${file} holds no usable key` }
  } catch (error) {
    if (error?.code === 'ENOENT') return { key: null, source: null, keyFile: file, error: null }
    return { key: null, source: null, keyFile: file, error: `key file ${file} unreadable (${error?.code ?? 'error'})` }
  }
}

export function writeKeyFile(keyFile, key) {
  const normalized = normalizeKey(key)
  if (!normalized) throw new Error('The Arena key is empty or contains characters that cannot be sent as a header')
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
    // Windows: ACLs are set by the setup script.
  }
  return keyFile
}
