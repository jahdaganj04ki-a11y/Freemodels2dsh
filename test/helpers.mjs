import http from 'node:http'

/**
 * Starts a fake Arena endpoint. `handler(request, body)` returns
 * `{status?, headers?, body?}` where `body` may be a string, an object (JSON) or
 * an async generator of strings for streaming responses.
 */
export async function startUpstream(handler) {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? safeJson(raw) : null
    calls.push({ method: request.method, url: request.url, headers: request.headers, body, raw })

    let result
    try {
      result = (await handler({ request, body, raw, calls })) ?? {}
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message } }))
      return
    }

    const status = result.status ?? 200
    const headers = { 'content-type': 'application/json', ...(result.headers ?? {}) }
    if (typeof result.body === 'object' && result.body !== null && !result.body[Symbol.asyncIterator]) {
      response.writeHead(status, headers)
      response.end(JSON.stringify(result.body))
      return
    }
    if (typeof result.body === 'string') {
      response.writeHead(status, headers)
      response.end(result.body)
      return
    }
    if (result.body && typeof result.body[Symbol.asyncIterator] === 'function') {
      response.writeHead(status, headers)
      for await (const chunk of result.body) response.write(chunk)
      response.end()
      return
    }
    response.writeHead(status, headers)
    response.end()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    calls,
    apiBase: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const MODELS_PAYLOAD = {
  object: 'list',
  data: [
    { id: 'coding-router-preview', object: 'model', name: 'Arena Coding Router', context_length: 1000000, max_completion_tokens: 128000, modalities: { text: true, image: true } },
    { id: 'arena-direct-1', object: 'model', display_name: 'Arena Direct One', context_window: 200000, max_output_tokens: 64000, input_modalities: ['text'] },
  ],
}
