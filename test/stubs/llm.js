/**
 * Minimal @deepseek-ai/dsh-llm surface used by lib/adapter.js. The real
 * package adds registry machinery and deep validation; the adapter tests only
 * need the base class, the typed error, and attribution headers.
 */
export class LlmAdapter {}

export class LlmError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'LlmError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
    })
  }
}

export function attributionHeaders() {
  return { 'user-agent': 'freemodels2dsh-test/1.0 (+harness-stub)' }
}

export default { LlmAdapter, LlmError, attributionHeaders }
