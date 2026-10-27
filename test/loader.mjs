/** Resolve Harness peer specifiers to test stubs; everything else resolves normally. */
const STUBS = {
  '@deepseek-ai/dsh-credentials': new URL('./stubs/credentials.js', import.meta.url),
  '@deepseek-ai/dsh-llm': new URL('./stubs/llm.js', import.meta.url),
  '@deepseek-ai/schemastery': new URL('./stubs/schemastery.js', import.meta.url),
}

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier]
  if (stub) return { url: stub.href, shortCircuit: true }
  return nextResolve(specifier, context)
}
