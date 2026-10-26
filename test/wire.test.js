import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toOpenAiMessages, toOpenAiTools, buildRequestBody, parseSse,
  ChunkBuilder, streamChat, getJson,
} from '../lib/wire.js'
import { CODES } from '../lib/errors.js'

function sseResponse(events, init = {}) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  })
}

function textEvent(content) {
  return { choices: [{ delta: { content } }] }
}

const collect = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('toOpenAiMessages serializes roles and drops reasoning and binary blocks', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [
      { type: 'text', text: 'hello' },
      { type: 'image', url: 'x' },
    ] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'hidden thought' },
      { type: 'text', text: 'hi there' },
    ] },
  ]
  const out = toOpenAiMessages(messages)
  assert.deepEqual(out, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello\n\n[image attachment omitted: this free model route is text-only]' },
    { role: 'assistant', content: 'hi there' },
  ])
  assert.equal(out[2].tool_calls, undefined)
})

test('assistant tool calls and tool results survive the conversion', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q":1}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] },
  ]
  const out = toOpenAiMessages(messages)
  assert.deepEqual(out[0], {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
  })
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'call-1', content: 'result' })
})

test('toOpenAiTools omits deferred tools', () => {
  assert.equal(toOpenAiTools(undefined), undefined)
  assert.equal(toOpenAiTools([{ name: 'later', deferLoading: true }]), undefined)
  const tools = toOpenAiTools([{ name: 'ready', description: 'd', parameters: { type: 'object' } }])
  assert.equal(tools[0].function.name, 'ready')
})

test('buildRequestBody maps harness options to the OpenAI wire shape', () => {
  const body = buildRequestBody({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    temperature: 0.2,
    maxTokens: 128,
    stop: ['END'],
    tools: [{ name: 'ready', parameters: {} }],
  }, 'model-id')
  assert.equal(body.model, 'model-id')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 128)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.tools[0].function.name, 'ready')
  assert.equal(body.tool_choice, 'auto')
})

test('a standalone system option is prepended only when no system message exists', () => {
  const withSystem = buildRequestBody({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'be terse',
  }, 'm')
  assert.equal(withSystem.messages[0].role, 'system')
  const duplicated = buildRequestBody({
    messages: [
      { role: 'developer', content: [{ type: 'text', text: 'existing' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    system: 'be terse',
  }, 'm')
  assert.equal(duplicated.messages.length, 2)
  assert.equal(duplicated.messages[0].content, 'existing')
})

test('parseSse yields JSON frames, tolerates malformed lines, and honors [DONE]', async () => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of [
        'data: {"a":1}\n\n',
        ': heartbeat\n\ndata: not-json\n\n',
        'data: {"b":2}\r\n\r\ndata: [DONE]\n\ndata: {"c":3}\n\n',
      ]) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  const events = await collect(parseSse(stream))
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }])
})

test('ChunkBuilder emits the full block payload on block-end', () => {
  const builder = new ChunkBuilder()
  const start = builder.push(textEvent('Hello '))
  assert.deepEqual(start, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hello ' },
  ])
  builder.push(textEvent('world'))
  const finish = builder.finish({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  assert.deepEqual(finish, [
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('ChunkBuilder assembles reasoning, tool calls, and finish reasons', () => {
  const builder = new ChunkBuilder()
  builder.push({ choices: [{ delta: { reasoning_content: 'think ' } }] })
  builder.push({ choices: [{ delta: { reasoning_content: 'more' } }] })
  builder.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-9', function: { name: 'f', arguments: '{' } }] } }] })
  builder.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] })
  const finish = builder.finish({ choices: [{ finish_reason: 'tool_calls' }] })
  const blockEnds = finish.filter(chunk => chunk.type === 'block-end')
  assert.equal(blockEnds[0].block.text, 'think more')
  assert.deepEqual(blockEnds[1].block, { type: 'tool-call', id: 'call-9', name: 'f', arguments: '{}' })
  assert.deepEqual(finish.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })

  const lengthBuilder = new ChunkBuilder()
  lengthBuilder.push(textEvent('x'))
  assert.equal(lengthBuilder.finish({ choices: [{ finish_reason: 'length' }] }).at(-1).reason.kind, 'max-tokens')
})

test('in-band error frames are thrown', () => {
  const builder = new ChunkBuilder()
  assert.throws(() => builder.push({ error: { message: 'boom' } }), /boom/u)
})

test('streamChat sends attribution headers and yields the harness chunk sequence', async () => {
  const seen = { calls: [] }
  const fetchImpl = async (url, init) => {
    seen.calls.push({ url, init })
    return sseResponse([textEvent('Hello '), textEvent('world'), {
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 5 },
    }])
  }
  const chunks = await collect(streamChat({
    url: 'https://example.test/v1/chat/completions',
    apiKey: 'sk-secret',
    extraHeaders: { 'user-agent': 'freemodels2dsh-test/1.0' },
    body: { model: 'm', stream: true },
    fetchImpl,
  }))
  assert.equal(seen.calls[0].url, 'https://example.test/v1/chat/completions')
  assert.equal(seen.calls[0].init.headers.authorization, 'Bearer sk-secret')
  assert.equal(seen.calls[0].init.headers['user-agent'], 'freemodels2dsh-test/1.0')
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.at(-1).type, 'finish')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(end.block.text, 'Hello world')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 1, outputTokens: 2, totalTokens: 5,
  })
})

test('streamChat classifies non-2xx responses with the bounded error body', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { message: 'rate limit', code: 'rate_limit_exceeded' } }),
    { status: 429, headers: { 'retry-after': '15', 'content-type': 'application/json' } },
  )
  await assert.rejects(
    collect(streamChat({ url: 'https://example.test', apiKey: 'k', body: {}, fetchImpl })),
    error => error.code === CODES.RATE_LIMIT && error.retryAfterMs === 15_000,
  )
})

test('streamChat turns transport failures into classified errors', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(
    collect(streamChat({ url: 'https://example.test', apiKey: 'k', body: {}, fetchImpl })),
    error => error.code === CODES.TRANSPORT,
  )
})

test('streamChat aborts promptly when the signal aborts', async () => {
  const controller = new AbortController()
  const stream = new ReadableStream({
    pull(c) {
      controller.abort()
      c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
    },
  })
  const fetchImpl = async () => new Response(stream, { status: 200 })
  await assert.rejects(
    collect(streamChat({ url: 'https://example.test', apiKey: 'k', body: {}, signal: controller.signal, fetchImpl })),
    error => error.code === CODES.ABORTED,
  )
})

test('getJson parses successful discovery payloads and classifies failures', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer k')
    return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })
  }
  const payload = await getJson({ url: 'https://example.test/models', apiKey: 'k', fetchImpl })
  assert.deepEqual(payload, { data: [{ id: 'm' }] })

  const failing = async () => new Response('nope', { status: 401 })
  await assert.rejects(
    getJson({ url: 'https://example.test/models', apiKey: 'k', fetchImpl: failing }),
    error => error.code === CODES.AUTH,
  )
})
