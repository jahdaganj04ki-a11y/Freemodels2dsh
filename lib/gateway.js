/**
 * Arena gateway — a loopback-only, OpenAI-compatible proxy in front of Arena's
 * API gateway.
 *
 * Why a proxy instead of pointing DeepSeek Harness (DSH) straight at
 * `https://api.arena.ai/v1`?
 *
 *  - The Arena key stays out of DSH's profile settings, session logs and
 *    transcripts; only this process reads it.
 *  - `/v1/models` keeps working from a cached catalog when Arena is slow or
 *    unreachable, and it normalizes the model metadata DSH needs.
 *  - Retries, timeouts, request ids and readable errors happen in one place that
 *    DSH's `harness.log` can show.
 *  - Local clients stay on loopback: nothing listens on the network.
 *
 * The module has no npm dependencies so it can run inside DSH Desktop's bundled
 * runtime without installing anything.
 */
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DEFAULT_API_BASE,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_HOST,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  GATEWAY_HEADER,
  MAX_ERROR_BYTES,
  MAX_REQUEST_BYTES,
  MAX_UPSTREAM_JSON_BYTES,
  PLUGIN_NAME,
  VERSION,
} from './defaults.js'
import { isModelAllowed, parseAllowlist, resolveCatalog, toOpenAIList } from './catalog.js'
import { createLogger, isLogger } from './log.js'
import { maskKey, resolveApiKey } from './key-store.js'

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

class GatewayError extends Error {
  constructor(status, code, message, { type = 'invalid_request_error', hint } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.type = type
    this.hint = hint
  }
}

/**
 * Builds a gateway instance. Nothing is bound until {@link start} is called, so
 * tests can call {@link handleRequest} directly.
 *
 * @param {object} [options]
 * @param {string} [options.apiBase] Arena base URL including `/v1`.
 * @param {string | null} [options.apiKey] Explicit key; otherwise resolved from env / key file.
 * @param {() => string | null} [options.getApiKey] Dynamic key accessor (re-read per request).
 * @param {string} [options.host] Must stay loopback; network hosts are rejected.
 * @param {number} [options.port] 0 picks a free port.
 * @param {string | null} [options.token] Optional local bearer token clients must send.
 * @param {string[]} [options.allowlist] Optional model id allowlist.
 * @param {string | null} [options.cacheFile] Where the last good catalog is cached.
 * @param {number} [options.catalogTtlMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxRetries]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {object} [options.logger]
 */
export function createArenaGateway(options = {}) {
  const {
    apiBase = process.env.ARENA_API_BASE || DEFAULT_API_BASE,
    host = process.env.FREEMODELS_GATEWAY_HOST || DEFAULT_HOST,
    port = Number(process.env.FREEMODELS_GATEWAY_PORT || DEFAULT_PORT),
    token = process.env.FREEMODELS_GATEWAY_TOKEN || null,
    allowlist = parseAllowlist(process.env.FREEMODELS_ARENA_MODELS),
    cacheFile = process.env.FREEMODELS_CATALOG_FILE || null,
    catalogTtlMs = DEFAULT_CATALOG_TTL_MS,
    requestTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    fetchImpl = globalThis.fetch,
    logger: suppliedLogger,
  } = options

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createArenaGateway requires a fetch implementation (Node.js 18+)')
  }
  if (!isLoopbackHost(host)) {
    throw new Error(`refusing to listen on ${host}: the Arena gateway only binds to loopback (127.0.0.1)`)
  }
  const normalizedApiBase = normalizeApiBase(apiBase)
  const logger = isLogger(suppliedLogger)
    ? suppliedLogger
    : createLogger({ level: process.env.FREEMODELS_LOG || 'info' })

  const explicitKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : null
  const getApiKey = typeof options.getApiKey === 'function'
    ? options.getApiKey
    : () => {
        if (explicitKey) return explicitKey
        const resolved = resolveApiKey({ keyFile: options.keyFile })
        return resolved.key
      }

  const state = {
    startedAt: null,
    requests: 0,
    failures: 0,
    lastError: null,
    catalog: null,
    catalogAt: 0,
    catalogSource: 'unknown',
    catalogError: null,
    catalogInflight: null,
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      logger.error('unhandled gateway error', { reason: error?.message ?? String(error) })
      if (!response.headersSent) sendError(response, error)
      else response.destroy()
    })
  })
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    logger.debug('client error', { reason: error?.message })
  })

  async function currentCatalog({ refresh = false } = {}) {
    const now = Date.now()
    const fresh = state.catalog && !refresh && now - state.catalogAt < catalogTtlMs
    if (fresh) return { models: state.catalog, source: state.catalogSource, fetchedAt: state.catalogAt }
    if (state.catalogInflight) return state.catalogInflight

    const run = (async () => {
      const result = await resolveCatalog({
        apiBase: normalizedApiBase,
        apiKey: getApiKey(),
        cacheFile,
        ttlMs: catalogTtlMs,
        fetchImpl,
        logger,
      })
      state.catalog = filterModels(result.models, allowlist)
      state.catalogAt = result.fetchedAt || Date.now()
      state.catalogSource = result.source
      state.catalogError = result.error
      if (result.source === 'fallback') state.catalogAt = Date.now()
      return { models: state.catalog, source: state.catalogSource, fetchedAt: state.catalogAt }
    })()

    state.catalogInflight = run
    try {
      return await run
    } finally {
      state.catalogInflight = null
    }
  }

  function status() {
    const key = getApiKey()
    return {
      name: PLUGIN_NAME,
      version: VERSION,
      ok: Boolean(key),
      listening: server.listening,
      address: server.listening ? describeAddress(server.address()) : null,
      baseUrl: server.listening ? baseUrlFor(server.address()) : null,
      upstream: normalizedApiBase,
      key: key ? { present: true, masked: maskKey(key) } : { present: false },
      tokenRequired: Boolean(token),
      allowlist: allowlist.length > 0 ? allowlist : null,
      catalog: {
        models: state.catalog?.length ?? 0,
        source: state.catalogSource,
        fetchedAt: state.catalogAt ? new Date(state.catalogAt).toISOString() : null,
        error: state.catalogError,
      },
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      uptimeSeconds: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
      requests: state.requests,
      failures: state.failures,
      lastError: state.lastError,
    }
  }

  async function handleRequest(request, response) {
    const startedAt = performance.now()
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`
    response.setHeader(GATEWAY_HEADER, `v${VERSION}`)
    response.setHeader('x-request-id', requestId)

    const url = new URL(request.url ?? '/', 'http://loopback')
    const path = normalizePath(url.pathname)

    try {
      if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
        return sendHtml(response, statusPage(status()))
      }
      if (request.method === 'GET' && (path === '/health' || path === '/healthz')) {
        return sendJson(response, 200, status())
      }
      if (request.method === 'GET' && path === '/v1/status') {
        return sendJson(response, 200, status())
      }
      if (path === '/v1/models' || path === '/models') {
        if (request.method !== 'GET') throw methodNotAllowed('GET')
        requireLocalAuth(request)
        const catalog = await currentCatalog({ refresh: url.searchParams.get('refresh') === '1' })
        return sendJson(response, 200, toOpenAIList(catalog.models))
      }
      if (path === '/v1/chat/completions' || path === '/chat/completions') {
        if (request.method !== 'POST') throw methodNotAllowed('POST')
        requireLocalAuth(request)
        await proxyChatCompletions(request, response, { startedAt, requestId })
        return
      }
      throw new GatewayError(404, 'not_found', `No route for ${request.method} ${url.pathname}`, {
        hint: 'Available: GET /health, GET /v1/models, POST /v1/chat/completions',
      })
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        logger.warn('request failed after headers were sent', { requestId, reason: error?.message })
        response.destroy()
        return
      }
      state.failures += 1
      state.lastError = { at: new Date().toISOString(), requestId, message: error?.message ?? String(error) }
      logger.warn('request rejected', { requestId, status: error?.status ?? 500, reason: error?.message })
      sendError(response, error)
    } finally {
      if (path !== '/health' && path !== '/healthz') {
        state.requests += 1
        logger.debug('request finished', {
          requestId,
          method: request.method,
          path,
          status: response.statusCode,
          ms: Math.round(performance.now() - startedAt),
        })
      }
    }
  }

  function requireLocalAuth(request) {
    if (!token) return
    const header = request.headers.authorization ?? ''
    const supplied = /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? ''
    if (supplied !== token) {
      throw new GatewayError(401, 'invalid_api_key', 'The local gateway token is missing or wrong', {
        type: 'authentication_error',
        hint: 'FREEMODELS_GATEWAY_TOKEN is set; use it as the API key in DSH.',
      })
    }
  }

  async function proxyChatCompletions(request, response, { startedAt, requestId }) {
    const apiKey = getApiKey()
    if (!apiKey) {
      throw new GatewayError(503, 'arena_key_missing', 'No Arena API key is configured for the gateway', {
        type: 'configuration_error',
        hint: 'Set ARENA_API_KEY (user environment variable) or run scripts/set-arena-key.ps1, then restart DSH Desktop.',
      })
    }

    const raw = await readRequestBody(request)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new GatewayError(400, 'invalid_json', 'The request body is not valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GatewayError(400, 'invalid_body', 'The request body must be a JSON object')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) throw new GatewayError(400, 'model_required', 'The request must name a model')
    if (!isModelAllowed(model, allowlist)) {
      throw new GatewayError(404, 'model_not_found', `Model ${model} is not allowed by this gateway`, {
        hint: allowlist.length > 0 ? `Allowed: ${allowlist.join(', ')}` : undefined,
      })
    }
    const wantsStream = body.stream === true
    const upstreamUrl = `${normalizedApiBase}/chat/completions`
    const clientAbort = new AbortController()
    const onClientGone = () => {
      if (!response.writableFinished) clientAbort.abort(new Error('client disconnected'))
    }
    request.once('aborted', onClientGone)
    response.once('close', onClientGone)
    const timeout = setTimeout(() => clientAbort.abort(new Error('upstream timeout')), requestTimeoutMs)
    if (timeout.unref) timeout.unref()

    logger.info('forwarding chat completion', { requestId, model, stream: wantsStream })

    try {
      const upstream = await fetchWithRetry(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: wantsStream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': `${PLUGIN_NAME}/${VERSION}`,
          ...(request.headers['x-arena-workspace'] ? { 'x-arena-workspace': String(request.headers['x-arena-workspace']) } : {}),
        },
        body: JSON.stringify(body),
        signal: clientAbort.signal,
      })

      if (!upstream.ok) {
        const detail = await readErrorDetail(upstream)
        throw new GatewayError(
          upstream.status,
          detail.code ?? 'upstream_error',
          detail.message ?? `Arena returned HTTP ${upstream.status}`,
          { type: detail.type ?? 'upstream_error', hint: hintForUpstreamStatus(upstream.status) }
        )
      }

      const contentType = upstream.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.flushHeaders?.()
        await pipeline(Readable.fromWeb(upstream.body), response)
        logger.info('stream finished', { requestId, model, ms: Math.round(performance.now() - startedAt) })
        return
      }

      const text = await readBounded(upstream, MAX_UPSTREAM_JSON_BYTES)
      response.writeHead(200, { 'content-type': contentType || 'application/json' })
      response.end(text)
      logger.info('completion finished', { requestId, model, ms: Math.round(performance.now() - startedAt) })
    } finally {
      clearTimeout(timeout)
      request.off('aborted', onClientGone)
      response.off('close', onClientGone)
    }
  }

  async function fetchWithRetry(url, init) {
    let attempt = 0
    for (;;) {
      let response
      try {
        response = await fetchImpl(url, init)
      } catch (error) {
        if (init.signal?.aborted) throw abortError(error, init.signal)
        if (attempt >= maxRetries) throw new GatewayError(502, 'upstream_unreachable', `Arena could not be reached: ${error?.message ?? error}`, { type: 'upstream_error' })
        await sleepFor(retryDelay(attempt, null))
        attempt += 1
        continue
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) return response
      const delay = retryDelay(attempt, response.headers.get('retry-after'))
      // Drain the discarded body so the socket can be reused.
      await response.arrayBuffer().catch(() => {})
      logger.warn('retrying upstream request', { status: response.status, attempt: attempt + 1, delay })
      if (init.signal?.aborted) throw abortError(new Error('aborted'), init.signal)
      await sleepFor(delay)
      attempt += 1
    }
  }

  function abortError(error, signal) {
    const reason = signal?.reason
    if (reason?.message === 'upstream timeout') {
      return new GatewayError(504, 'upstream_timeout', 'Arena did not answer in time', { type: 'upstream_error' })
    }
    if (reason?.message === 'client disconnected') {
      return new GatewayError(499, 'client_closed_request', 'The client closed the request')
    }
    return new GatewayError(502, 'upstream_aborted', `The Arena request was aborted: ${reason?.message ?? error?.message ?? 'unknown reason'}`, { type: 'upstream_error' })
  }

  /**
   * Binds the server.
   * @param {{port?: number, host?: string}} [overrides]
   */
  function start(overrides = {}) {
    const listenPort = overrides.port ?? port
    const listenHost = overrides.host ?? host
    if (!isLoopbackHost(listenHost)) throw new Error(`refusing to listen on ${listenHost}: loopback only`)
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        state.startedAt ??= Date.now()
        const address = server.address()
        logger.info('gateway listening', { url: baseUrlFor(address) })
        // Warm the catalog so /health and the first model-picker call answer
        // immediately. Failures are logged by resolveCatalog and never fatal.
        void currentCatalog().catch(() => {})
        resolve({ port: address.port, host: address.address, url: baseUrlFor(address) })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ port: listenPort, host: listenHost, exclusive: true })
    })
  }

  function stop() {
    return new Promise(resolve => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return {
    server,
    handleRequest,
    start,
    stop,
    status,
    currentCatalog,
    refreshCatalog: () => currentCatalog({ refresh: true }),
    config: { apiBase: normalizedApiBase, host, port, catalogTtlMs, requestTimeoutMs, maxRetries, allowlist },
  }
}

/* ------------------------------------------------------------------ helpers */

function normalizeApiBase(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  if (!text) throw new Error('An Arena API base URL is required')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error(`Arena API base URL is not a valid URL: ${text}`)
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('The Arena API base URL must use https (http is only allowed for a loopback replacement)')
  }
  return text
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

export function isLoopbackHost(hostname) {
  const value = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1'
}

function filterModels(models, allowlist) {
  if (!allowlist || allowlist.length === 0) return models
  const filtered = models.filter(model => isModelAllowed(model.id, allowlist))
  return filtered.length > 0 ? filtered : models
}

function describeAddress(address) {
  if (!address || typeof address === 'string') return address ?? null
  return `${address.address}:${address.port}`
}

function baseUrlFor(address) {
  if (!address || typeof address === 'string') return null
  const host = address.family === 'IPv6' || String(address.address).includes(':') ? '[::1]' : '127.0.0.1'
  return `http://${host}:${address.port}/v1`
}

function methodNotAllowed(allowed) {
  return new GatewayError(405, 'method_not_allowed', `Use ${allowed} for this endpoint`, { type: 'invalid_request_error' })
}

function retryDelay(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 5_000)
  }
  return Math.min(400 * 2 ** attempt, 4_000)
}

function sleepFor(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (timer.unref) timer.unref()
  })
}

function hintForUpstreamStatus(status) {
  if (status === 401 || status === 403) {
    return 'Arena rejected the key. Check ARENA_API_KEY and whether the key may use this model and client.'
  }
  if (status === 404) return 'Arena does not serve this model for your key. Check the model id in the DSH model picker.'
  if (status === 429) return 'Arena is rate limiting this key. Retry later or lower parallel requests.'
  if (status >= 500) return 'Arena had a server-side problem. Retry in a moment.'
  return undefined
}

async function readRequestBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      throw new GatewayError(413, 'request_too_large', `The request body exceeds ${MAX_REQUEST_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readBounded(response, limit) {
  const buffer = Buffer.from(await response.arrayBuffer())
  return buffer.length > limit ? buffer.subarray(0, limit) : buffer
}

async function readErrorDetail(response) {
  let text = ''
  try {
    text = (await readBounded(response, MAX_ERROR_BYTES)).toString('utf8')
  } catch {
    return {}
  }
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error ?? parsed
    return {
      message: typeof error?.message === 'string' ? error.message : undefined,
      type: typeof error?.type === 'string' ? error.type : undefined,
      code: typeof error?.code === 'string' ? error.code : undefined,
    }
  } catch {
    return { message: text.replace(/\s+/g, ' ').slice(0, 500) }
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  response.end(html)
}

function sendError(response, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  const payload = {
    error: {
      message: error?.message ?? 'Unexpected gateway error',
      type: error?.type ?? 'gateway_error',
      code: error?.code ?? 'gateway_error',
      ...(error?.hint ? { hint: error.hint } : {}),
    },
  }
  sendJson(response, status, payload)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

/** Small status page: the one place a user can confirm the gateway is healthy. */
function statusPage(info) {
  const rows = [
    ['Version', `${info.version}`],
    ['Arena-Endpunkt', info.upstream],
    ['API-Key', info.key.present ? `vorhanden (${info.key.masked})` : 'fehlt – siehe README'],
    ['Basis-URL für DSH', info.baseUrl ?? 'nicht verbunden'],
    ['Lokales Token', info.tokenRequired ? 'erforderlich' : 'nicht gesetzt'],
    ['Modellkatalog', `${info.catalog.models} Modelle (${info.catalog.source})`],
    ['Laufzeit', `${info.uptimeSeconds} s`],
    ['Anfragen', `${info.requests} (${info.failures} Fehler)`],
  ]
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>freemodels2dsh – Arena-Gateway</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:2.5rem 1.25rem;background:#f6f6f7;color:#111}
main{max-width:46rem;margin:0 auto;background:#fff;border:1px solid #e2e2e6;border-radius:14px;padding:1.75rem 2rem}
h1{font-size:1.35rem;margin:0 0 .25rem}
p.lead{margin:.25rem 0 1.5rem;color:#555}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.45rem .25rem;border-bottom:1px solid #eee;vertical-align:top}
th{width:13rem;color:#555;font-weight:500}
code{background:#f1f1f4;padding:.15rem .4rem;border-radius:6px;font-size:.9em}
.badge{display:inline-block;padding:.15rem .55rem;border-radius:999px;font-size:.78rem;font-weight:600}
.ok{background:#e6f4ea;color:#146c2e}.bad{background:#fce8e6;color:#a50e0e}
footer{margin-top:1.5rem;color:#666;font-size:.85rem}
@media (prefers-color-scheme:dark){
body{background:#101012;color:#eee}main{background:#18181b;border-color:#2a2a30}
p.lead,th,footer{color:#a1a1aa}code{background:#26262b}th,td{border-color:#2a2a30}
.ok{background:#12301c;color:#7ee2a0}.bad{background:#3a1414;color:#ff9a92}}
</style></head>
<body><main>
<h1>freemodels2dsh <span class="badge ${info.ok ? 'ok' : 'bad'}">${info.ok ? 'bereit' : 'Key fehlt'}</span></h1>
<p class="lead">Lokales, OpenAI-kompatibles Gateway zu Arena. Läuft ausschließlich auf 127.0.0.1.</p>
<table>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
<p class="lead" style="margin-top:1.5rem">In DSH Desktop unter <strong>Einstellungen → Modelle</strong> als Provider eintragen:<br>
<code>${escapeHtml(info.baseUrl ?? 'http://127.0.0.1:8787/v1')}</code></p>
<footer>Health: <code>/health</code> · Modelle: <code>/v1/models</code> · Chat: <code>POST /v1/chat/completions</code></footer>
</main></body></html>`
}

export { GatewayError }
