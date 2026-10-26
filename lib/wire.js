/**
 * OpenAI Chat Completions wire protocol: Harness message serialization, SSE
 * parsing, and translation into the Harness StreamChunk vocabulary.
 *
 * Every curated provider speaks this protocol (Cloudflare through its
 * OpenAI-compatible /ai/v1 surface). The module is dependency-free and uses
 * standard Web Fetch/ReadableStream primitives so it runs unchanged inside
 * the Harness Node runtime and in unit tests with fakes.
 *
 * @module freemodels2dsh/wire
 */

import { classifyHttpError, classifyNetworkError, CODES } from './errors.js'

const MAX_ERROR_BYTES = 64 * 1024

export async function readBounded(response, maxBytes) {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw new Error('response exceeded the size bound')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
  const out = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function blockText(block) {
  if (block?.type === 'text' && typeof block.text === 'string') return block.text
  // Free-tier routes are declared text-only; image and file references reach
  // the model as deterministic handle text instead of binary content.
  if (block?.type === 'image') return '[image attachment omitted: this free model route is text-only]'
  if (block?.type === 'file') return '[file attachment omitted: this free model route is text-only]'
  return ''
}

function joinedText(blocks) {
  return blocks.map(blockText).filter(Boolean).join('\n\n')
}

/**
 * Convert Harness request messages into OpenAI chat messages. Assistant
 * reasoning blocks are not part of the OpenAI wire vocabulary and are
 * dropped; tool calls and tool results are preserved.
 */
export function toOpenAiMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = joinedText(message.content)
      if (text.length > 0) out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'user') {
      const text = joinedText(message.content)
      if (text.length > 0) out.push({ role: 'user', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n\n')
      const toolCalls = content.length ? [] : message.content
        .filter(block => block.type === 'tool-call')
        .map(block => ({
          id: String(block.id),
          type: 'function',
          function: { name: block.name, arguments: String(block.arguments ?? '{}') },
        }))
      const entry = { role: 'assistant', content: content || null }
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      out.push(entry)
      continue
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        content: joinedText(message.content) || '(no output)',
      })
    }
  }
  return out
}

/** Serialize the tools array, omitting tools whose loading is still deferred. */
export function toOpenAiTools(tools) {
  const active = (tools ?? []).filter(tool => tool?.deferLoading !== true)
  if (active.length === 0) return undefined
  return active.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

export function buildRequestBody(options, modelId) {
  const messages = toOpenAiMessages(options.messages)
  // One-shot callers may pass the system prompt separately instead of as a
  // leading message; loop-built requests always embed it, so no duplicate is
  // inserted when a system/developer message is already present.
  const hasSystem = messages.some(message => message.role === 'system')
  if (typeof options.system === 'string' && options.system.trim().length > 0 && !hasSystem) {
    messages.unshift({ role: 'system', content: options.system.trim() })
  }
  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = toOpenAiTools(options.tools)
  if (tools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  return body
}

/** Parse one SSE byte stream into plain event-data objects, line by line. */
export async function* parseSse(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const part = await reader.read()
      if (part.done) return
      buffer += decoder.decode(part.value, { stream: true })
      const lines = buffer.split(/\r?\n/u)
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        if (payload.length === 0) continue
        try {
          yield JSON.parse(payload)
        } catch {
          // A provider heartbeat or malformed frame must not kill the stream.
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
}

/**
 * Accumulate OpenAI streaming deltas and emit the Harness StreamChunk
 * sequence. Block indexes are assigned by first appearance and stay stable
 * for the whole response.
 */
export class ChunkBuilder {
  constructor() {
    this.indexes = new Map() // block key -> harness block index
    this.emittedStart = new Set()
    this.toolCalls = new Map() // provider tool index -> accumulated call
    this.text = ''
    this.reasoning = ''
    this.nextIndex = 0
  }

  indexFor(key, blockType) {
    if (!this.indexes.has(key)) {
      this.indexes.set(key, this.nextIndex)
      this.nextIndex += 1
    }
    const index = this.indexes.get(key)
    if (!this.emittedStart.has(index)) {
      this.emittedStart.add(index)
      this.chunks.push({ type: 'block-start', index, blockType })
    }
    return index
  }

  push(event) {
    this.chunks = []
    const choice = event?.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        const index = this.indexFor('reasoning', 'reasoning')
        this.reasoning += delta.reasoning_content
        this.chunks.push({ type: 'reasoning-delta', index, text: delta.reasoning_content })
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        const index = this.indexFor('text', 'text')
        this.text += delta.content
        this.chunks.push({ type: 'text-delta', index, text: delta.content })
      }
      for (const call of delta.tool_calls ?? []) {
        const providerIndex = call.index ?? 0
        const key = `tool:${providerIndex}`
        const index = this.indexFor(key, 'tool-call')
        const accumulated = this.toolCalls.get(providerIndex) ?? {
          id: '', name: '', arguments: '',
        }
        if (call.id) accumulated.id = call.id
        if (call.function?.name) accumulated.name = call.function.name
        if (typeof call.function?.arguments === 'string') accumulated.arguments += call.function.arguments
        this.toolCalls.set(providerIndex, accumulated)
        this.chunks.push({
          type: 'tool-call-delta',
          index,
          ...(accumulated.id ? { id: accumulated.id } : {}),
          ...(accumulated.name ? { name: accumulated.name } : {}),
          argumentsDelta: String(call.function?.arguments ?? ''),
        })
      }
    }
    // Some providers surface failures as an in-band error frame.
    if (event?.error) {
      const message = typeof event.error === 'string' ? event.error : (event.error.message ?? 'provider stream error')
      throw Object.assign(new Error(message), { inBand: true, providerError: event.error })
    }
    return this.chunks
  }

  /** Finish open blocks and translate the terminal finish reason. */
  finish(event) {
    const out = []
    const usage = event?.usage
    if (usage && (Number.isFinite(usage.prompt_tokens) || Number.isFinite(usage.completion_tokens))) {
      out.push({
        type: 'usage',
        usage: {
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
          ...Number.isFinite(usage.total_tokens) ? { totalTokens: Number(usage.total_tokens) } : {},
          ...Number.isFinite(usage.reasoning_tokens) ? { reasoningTokens: Number(usage.reasoning_tokens) } : {},
        },
      })
    }
    // Close blocks in index order so consumers see matching start/end pairs.
    for (const [key, index] of [...this.indexes.entries()].sort((a, b) => a[1] - b[1])) {
      if (key === 'text') {
        // block-end is first-close-wins in the Harness assembler, so carry the
        // fully accumulated text rather than an empty payload.
        out.push({ type: 'block-end', index, block: { type: 'text', text: this.text } })
      } else if (key === 'reasoning') {
        out.push({ type: 'block-end', index, block: { type: 'reasoning', text: this.reasoning } })
      } else if (key.startsWith('tool:')) {
        const providerIndex = Number(key.slice(5))
        const call = this.toolCalls.get(providerIndex) ?? { id: '', name: '', arguments: '' }
        out.push({
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: String(call.id || `call-${providerIndex}`),
            name: String(call.name || ''),
            arguments: call.arguments.length > 0 ? call.arguments : '{}',
          },
        })
      }
    }
    const reason = String(event?.choices?.[0]?.finish_reason ?? 'stop')
    if (reason === 'length') out.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    else if (reason === 'tool_calls' || reason === 'function_call') out.push({ type: 'finish', reason: { kind: 'tool-calls' } })
    else out.push({ type: 'finish', reason: { kind: 'stop' } })
    return out
  }
}

/**
 * Execute one streaming chat completion against one account.
 *
 * @yields StreamChunk
 * @throws LlmError-shaped plain error carrying a Harness taxonomy `code`.
 */
export async function* streamChat({ url, apiKey, extraHeaders, body, signal, fetchImpl = fetch }) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw classifyNetworkError(error, signal)
  }

  if (!response.ok) {
    const bytes = await readBounded(response, MAX_ERROR_BYTES).catch(() => new Uint8Array(0))
    const text = new TextDecoder().decode(bytes)
    throw classifyHttpError(response.status, text, response.headers)
  }
  if (!response.body) {
    throw { code: CODES.EMPTY_RESPONSE, message: 'The provider returned an empty response body.' }
  }

  const builder = new ChunkBuilder()
  let terminal
  try {
    for await (const event of parseSse(response.body, signal)) {
      if (event?.choices?.[0]?.finish_reason) terminal = event
      const chunks = builder.push(event)
      for (const chunk of chunks) yield chunk
    }
  } catch (error) {
    // In-band provider error frames keep their own diagnosis; transport drops
    // and aborts arrive here rather than at fetch time and need classification.
    if (error?.inBand) throw { code: CODES.SERVER, message: error.message }
    throw classifyNetworkError(error, signal)
  }
  // Providers that omit a terminal frame still need a well-formed finish.
  for (const chunk of builder.finish(terminal ?? { choices: [{ finish_reason: 'stop' }] })) {
    yield chunk
  }
}

/**
 * One bounded GET request used for model discovery and key validation.
 * @returns parsed JSON body.
 */
export async function getJson({ url, apiKey, extraHeaders, signal, fetchImpl = fetch, maxBytes = 4 * 1024 * 1024 }) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(extraHeaders ?? {}),
      },
    })
  } catch (error) {
    throw classifyNetworkError(error, signal)
  }
  const bytes = await readBounded(response, maxBytes)
  const text = new TextDecoder().decode(bytes)
  if (!response.ok) throw classifyHttpError(response.status, text, response.headers)
  try {
    return JSON.parse(text)
  } catch {
    throw { code: CODES.UNKNOWN, message: 'The provider returned an invalid JSON response.' }
  }
}
