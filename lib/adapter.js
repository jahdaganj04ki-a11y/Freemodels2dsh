/**
 * Harness LlmAdapter for the curated free-tier routes.
 *
 * One adapter instance owns every fm-* route. Each request reads the latest
 * stored state, resolves the ordered account candidates from the rotation
 * policy, and streams through the OpenAI Chat Completions wire. Account
 * switching happens only before the first content chunk, so a failure mid-
 * reply can never duplicate output.
 *
 * @module freemodels2dsh/adapter
 */

import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import {
  PROVIDERS, getProviderByRoute, resolveBaseUrl,
} from './catalog.js'
import {
  planCandidates, shouldSwitch, noteFailure, noteSuccess, advanceRoundRobin,
  usableAccounts, SWITCH_MODES,
} from './rotation.js'
import { buildRequestBody, streamChat, MAX_IMAGE_BYTES } from './wire.js'
import { CODES } from './errors.js'

const REASONING_EFFORTS = Object.freeze([
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
])

function toLlmError(error, provider) {
  if (error instanceof LlmError) return error
  const code = error?.code ?? CODES.UNKNOWN
  const message = error?.message ?? 'The provider request failed.'
  return new LlmError(`freemodels2dsh/${provider}: ${message}`, code, {
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.retryAfterMs ? { providerRetryAfterMs: error.retryAfterMs } : {}),
    cause: error instanceof Error ? error : undefined,
  })
}

function modelsFor(providerDef, providerState) {
  const discovered = providerState?.models
  return Array.isArray(discovered) && discovered.length > 0 ? discovered : providerDef.defaultModels
}

function modalities(model) {
  return model.vision ? ['text', 'image'] : ['text']
}

export class FreeModelsAdapter extends LlmAdapter {
  constructor(store, runtime, attachmentResolver) {
    super()
    this.store = store
    this.runtime = runtime
    // Lazily-resolved AttachmentStore. The service is host-provided and may
    // be absent in stripped profiles; vision routes fail per-request then.
    this.attachmentResolver = typeof attachmentResolver === 'function' ? attachmentResolver : null
  }

  /**
   * Target handed to the Harness offload planner. Its maxBytes must match the
   * budget wire.js passes to attachments.readImageRequest exactly.
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: MAX_IMAGE_BYTES }
  }

  providerInfo(provider) {
    const def = getProviderByRoute(provider)
    return { id: provider, name: def?.name ?? provider }
  }

  #def(provider) {
    const def = getProviderByRoute(provider)
    if (!def) throw new LlmError(`freemodels2dsh does not own provider "${provider}"`, 'NO_ADAPTER')
    return def
  }

  async #stateFor(providerId) {
    const state = await this.store.read()
    return state.providers[providerId]
  }

  async listModels(provider) {
    const def = this.#def(provider)
    let providerState
    try {
      providerState = await this.#stateFor(def.id)
    } catch (error) {
      // A storage fault must not break the whole model catalog; the route
      // simply reports no models until the next refresh.
      return []
    }
    const usable = providerState
      ? usableAccounts(providerState, this.runtime, def.id, Date.now())
      : []
    if (usable.length === 0) return []
    return modelsFor(def, providerState).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: modalities(model),
    }))
  }

  #modelRecord(def, providerState, modelId) {
    const known = modelsFor(def, providerState).find(entry => entry.id === modelId)
    if (!known) {
      throw new LlmError(
        `freemodels2dsh: provider "${def.id}" has no configured free model "${modelId}"`,
        CODES.UNKNOWN_MODEL,
      )
    }
    return known
  }

  async resolveModel(provider, model) {
    const def = this.#def(provider)
    const providerState = await this.#stateFor(def.id)
    const known = this.#modelRecord(def, providerState, model)
    const info = {
      provider,
      id: known.id,
      name: known.name,
      inputModalities: modalities(known),
      context: { contextWindow: known.contextWindow },
      defaultMaxTokens: known.maxTokens,
    }
    // Only advertise the effort selector where the provider's OpenAI layer
    // actually accepts reasoning_effort; other routes still stream reasoning
    // content when the model thinks, without a request-side control.
    if (known.reasoning && def.reasoningEffort) {
      info.reasoning = {
        efforts: REASONING_EFFORTS.map(effort => ({ ...effort })),
        defaultEffort: 'medium',
      }
    }
    return info
  }

  async prepareCall(provider, model) {
    // Freeze the resolved metadata for this call; the stream closure re-reads
    // only the account/rotation state, which is exactly what may rotate.
    const info = await this.resolveModel(provider, model)
    return {
      model: info,
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    const def = this.#def(options.provider)
    const providerState = await this.#stateFor(def.id)
    if (!providerState) {
      throw new LlmError(
        `freemodels2dsh: provider "${def.id}" has no accounts; add an API key in Settings > Plugins > Free Models`,
        CODES.NO_ACCOUNT,
      )
    }

    const now = Date.now()
    const usable = usableAccounts(providerState, this.runtime, def.id, now)
    if (usable.length === 0) {
      throw new LlmError(`freemodels2dsh: no enabled, non-cooled account for "${def.id}"`, CODES.NO_ACCOUNT)
    }
    const candidates = planCandidates(providerState, this.runtime, def.id, now)
    if (candidates.length === 0) {
      throw new LlmError(
        `freemodels2dsh: the selected manual account for "${def.id}" is disabled or cooling down`,
        CODES.NO_ACCOUNT,
      )
    }
    if (providerState.switchMode === SWITCH_MODES.ROUND_ROBIN) {
      advanceRoundRobin(this.runtime, def.id, usable.length)
    }

    const modelRecord = this.#modelRecord(def, providerState, options.model)
    let body
    try {
      body = await buildRequestBody(options, options.model, {
        supportsVision: Boolean(modelRecord.vision),
        attachments: this.attachmentResolver ? this.attachmentResolver() : undefined,
        reasoningEffortSupported: Boolean(def.reasoningEffort),
      })
    } catch (error) {
      throw toLlmError(error, def.id)
    }
    const headers = { ...attributionHeaders(), ...(def.extraHeaders ?? {}) }
    let lastError
    let attempt = 0

    for (const account of candidates) {
      attempt += 1
      let baseUrl
      try {
        baseUrl = resolveBaseUrl(def, account)
      } catch (error) {
        throw toLlmError({ code: CODES.INVALID_REQUEST, message: error.message }, def.id)
      }
      const url = `${baseUrl.replace(/\/+$/u, '')}/chat/completions`
      let emitted = false
      try {
        const generator = streamChat({
          url,
          apiKey: account.apiKey.trim(),
          extraHeaders: headers,
          body,
          signal: options.signal,
        })
        while (true) {
          const next = await generator.next()
          if (next.done) break
          emitted = true
          yield next.value
        }
        noteSuccess(this.runtime, def.id, account)
        return
      } catch (error) {
        const llmError = toLlmError(error, def.id)
        // A user/host cancellation is not an account fault: do not cool the
        // account down or paint it as failed in the settings UI.
        if (options.signal?.aborted && llmError.code === CODES.ABORTED) throw llmError
        noteFailure(this.runtime, def.id, account, llmError.code, llmError.failure?.providerRetryAfterMs)
        // Once content has been emitted the request cannot be replayed without
        // duplicating an answer, and manual mode never switches automatically.
        if (emitted || attempt >= candidates.length || !shouldSwitch(providerState, llmError.code)) {
          throw llmError
        }
        lastError = llmError
      }
    }
    throw lastError ?? new LlmError(`freemodels2dsh: every account for "${def.id}" failed`, CODES.UNKNOWN)
  }
}

/** Directory entries for the host configurable-provider registry. */
export function configurableEntries(pluginName) {
  return PROVIDERS.map(def => ({
    provider: def.route,
    displayName: def.name,
    settingsNs: pluginName,
    settingsPath: ['providers', def.id],
    defaultBaseURL: def.baseUrl,
  }))
}

/** The full route list, registered once at plugin mount. */
export function allAdapterRoutes() {
  return PROVIDERS.map(def => def.route)
}
