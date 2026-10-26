import http from 'node:http'

/** Starts a loopback stand-in for `api.arena.ai` and records every request. */
export async function startUpstream(handler) {
  const calls = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: chunks.length ? safeJson(Buffer.concat(chunks).toString('utf8')) : null,
    })
    const result = (await handler({ request, calls })) ?? {}
    response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    calls,
    apiBase: `http://127.0.0.1:${port}/v1`,
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
