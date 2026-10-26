/**
 * Minimal leveled logger.
 *
 * The gateway runs in three places (DSH Desktop's harness process, a standalone
 * `node bin/arena-gateway.mjs`, and tests) so the logger stays a plain function
 * factory with a pluggable sink. Nothing here writes to stdout by itself: the
 * caller decides where lines go, which keeps harness.log and terminal output
 * from contradicting each other.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

export function createLogger({ level = 'info', sink = line => console.log(line), prefix = 'freemodels-arena' } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info
  const write = (name, message, fields) => {
    if (LEVELS[name] > threshold) return
    const suffix = fields && Object.keys(fields).length > 0
      ? ' ' + Object.entries(fields)
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(' ')
      : ''
    sink(`${new Date().toISOString()} ${name.padEnd(5)} [${prefix}] ${message}${suffix}`)
  }
  return {
    level,
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
    child: (childPrefix, extra = {}) => createLogger({ level, prefix: `${prefix}:${childPrefix}`, sink, ...extra }),
  }
}

/** True for loggers created by {@link createLogger}; used by tests and the CLI. */
export function isLogger(value) {
  return Boolean(value) && typeof value.info === 'function' && typeof value.error === 'function'
}

function formatValue(value) {
  if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
