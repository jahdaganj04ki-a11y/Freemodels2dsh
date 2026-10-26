/** Minimal @deepseek-ai/dsh-credentials surface used by lib/storage.js. */
const SEGMENT = /^[a-z][a-z0-9-]*$/u

export function credentialKey(scope, id) {
  for (const segment of [scope, id]) {
    if (!SEGMENT.test(segment)) throw new TypeError(`credential key segment "${segment}" is invalid`)
  }
  return `${scope}/${id}`
}

export function credentialRef(value) {
  return value
}

export default { credentialKey, credentialRef }
