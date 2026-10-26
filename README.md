# Freemodels2dsh

A [DSH Desktop](https://github.com/dataelement/dsh-desktop) plugin that brings
together **free cloud LLM providers** — every model it lists is usable in
Germany with a self-registered account, an API key, and **no payment method
and no stored card**. Local runtimes (Ollama, LM Studio, llama.cpp, …) are not
part of this plugin; every request goes to a hosted provider.

It adds one settings tab, **Free Models**, with:

- **9 curated free providers** and only the models their free tiers can call.
- **Vision models** where the free tier actually accepts image input: user
  images are projected through DSH Desktop's durable attachment service into
  standard OpenAI `image_url` parts, downscaled to a 1 MiB request budget;
  text-only routes keep deterministic placeholder text instead.
- **Reasoning/thinking models** with streamed reasoning blocks; providers
  whose OpenAI layer understands `reasoning_effort` expose the effort
  selector in the model metadata, the others simply display their thinking.
- **Multiple accounts per provider**, each with its own key (Cloudflare
  accounts also carry their 32-character Account ID).
- A per-provider account window (click a provider row) supporting
  **add / remove / enable / disable**, connection tests, and live model-list
  refresh. Vision and reasoning capabilities are shown as tags per model.
- Three account switching policies:
  - **Manual** — only the account you select is ever used.
  - **On error / quota** — the active account leads; invalid keys, exhausted
    quota, rate limits, and server errors automatically fall through to the
    next usable account. Switching happens before any content is streamed, so
    an answer is never duplicated.
  - **Round robin** — every new request rotates to the next usable account.
- Automatic per-account **cooldowns** (rate limit, quota, auth, transport
  failures) so exhausted keys are skipped instead of retried blindly.

## Included providers

Free-tier facts were last reviewed in **October 2026**. Limits change; the
per-provider **Fetch available models** button re-discovers the current free
list at any time, and each dialog links to the provider's limits page.

| Provider | Route | Free tier (no card) |
| --- | --- | --- |
| OpenRouter Free Models | `fm-openrouter` | `:free`, zero-priced models; 50 requests/day and 20 RPM on the base allowance (1,000/day after any lifetime top-up) |
| Google AI Studio (Gemini) | `fm-gemini` | Flash / Flash-Lite / Gemma families, roughly 10–15 RPM and up to 1,500 requests/day |
| Groq | `fm-groq` | ~30 RPM and 1,000 requests/day per model |
| Mistral La Plateforme | `fm-mistral` | Free mode by default (SMS verification, one phone number per account) |
| NVIDIA build | `fm-nvidia` | Free endpoints, ~40 RPM per model, prototyping terms |
| Cloudflare Workers AI | `fm-cloudflare` | 10,000 Neurons/day, hard stop, reset at 00:00 UTC; needs API token **and** Account ID |
| Cohere | `fm-cohere` | Trial key: 1,000 calls/month, 20 chat RPM, non-commercial evaluation |
| Featherless.ai | `fm-featherless` | Free-tier inference with queued requests |
| Z.ai (Zhipu GLM) | `fm-zai` | GLM-4.5-Flash and GLM-4.6V-Flash permanently free on the general OpenAI-compatible endpoint; the vision flash model accepts `image_url` input |

### Vision and reasoning support

| Provider | Vision models on the free tier | Reasoning | `reasoning_effort` field |
| --- | --- | --- | --- |
| OpenRouter | yes (e.g. Nemotron Super VL, Gemma, omni `:free` rows) | yes | yes |
| Gemini | yes — every curated Flash/Gemma family | yes (Flash) | yes (mapped to thinking level) |
| Groq | no — free chat lineup is text-only since August 2026 | yes | yes |
| Mistral | only dated vision builds (e.g. `ministral-3b-2512`) when the free key admits them | no | no |
| NVIDIA | yes — Super VL, Llama 3.2 Vision, omni endpoints | yes | yes |
| Cloudflare | Gemma 4 A4B and Kimi K2.6 builds | yes (GPT-OSS, Gemma) | no |
| Cohere | Command A+ and Command A Vision trial models | no | no |
| Featherless | vision-flagged free models when available | model-dependent | no |
| Z.ai | GLM-4.6V-Flash | yes (`reasoning_content`) | no — Z.ai uses its own `thinking` field on a different endpoint contract |

### IDE/CLI-bound free models

The 2026-10 review also covered free models exposed inside IDEs and CLIs
(Hermes Agent, Qoder, ZCode, OpenCode Zen/Go). None of them can be offered
as working plugin routes:

- **Qoder / ZCode / OpenCode Zen** — free models are OAuth-entitled to the
  vendor's own application; external API calls are blocked (OpenCode Zen
  returns HTTP 403 outside its app since 2026-09-17), and no stable public
  key-based contract exists.
- **Hermes Agent** — a client, not a provider; its relay rejects third-party
  callers.
- **OpenCode Go** — paid subscription only.
- **Z.ai** — the IDE coding plan (`/api/coding/paas/v4`, the Anthropic-style
  endpoint) is coding-scenarios-only and explicitly not interchangeable with
  the general API, so the plugin uses the documented general endpoint
  `https://api.z.ai/api/paas/v4` instead, where GLM flash models are free.
- **Moonshot/Kimi, MiniMax direct APIs** — no card-free free tier (Kimi
  requires a $1 top-up); MiniMax models remain reachable through their free
  NVIDIA NIM route, which the plugin already includes.

Deliberately excluded:

- **GitHub Models** — free API retired on 2026-07-30.
- **Cerebras** — free tier ended 2026-07-16; paid trial requires a card.
- **SambaNova** — requires a payment method since October 2026.
- **Hugging Face Inference Providers** — free accounts no longer receive
  inference credits (since 2026-10-07).
- Any provider or model whose only free offering requires billing details,
  and every local model runtime (Ollama, LM Studio, llama.cpp, …).

### Known verification caveats

Free-tier contracts drift; these points cannot be proven from inside the
build environment and should be re-checked with real keys on Windows:

- **Cloudflare** vision through the OpenAI shim: native docs show image
  input via a separate `image` parameter; `image_url` acceptance on
  `/ai/v1/chat/completions` needs a live confirmation.
- **NVIDIA** free-endpoint allowance may be framed as evaluation credits
  rather than a permanent free tier.
- **Mistral** free keys return 429 on some catalog ids; the curated list is
  restricted to families free keys have been observed to answer.
- **Z.ai** no-card eligibility and starter-credit terms for new German
  accounts should be confirmed at signup.

## Install (Windows, DSH Desktop)

1. Build the package:

   ```powershell
   npm install
   npm run pack:plugin
   ```

   This produces `freemodels2dsh-1.1.0.tgz`.

2. Install it into the profile DSH Desktop drives (the reserved `web`
   profile — never use `desktop`, which the harness rejects) with the DSH CLI
   bundled alongside DSH Desktop:

   ```powershell
   dsh plugin --profile web add C:\absolute\path\to\freemodels2dsh-1.1.0.tgz
   ```

   A folder path works too while developing. If your DSH Desktop build offers
   local `.tgz` installation in its plugin/workbench management UI, that entry
   point is equivalent.

3. Restart DSH Desktop (or use its plugin reload action). Open
   **Settings → Plugins → Free Models**.

4. Click a provider, paste an API key (for Cloudflare also the Account ID),
   choose a switching policy, and use **Test connection**. The provider's free
   models appear in the model picker as soon as at least one account is
   enabled.

## How it works

```
index.js          Cordis plugin: adapter/directory registration, HTTP endpoints
client.js         Settings tab + per-provider account modal (React, host primitives)
lib/catalog.js    Curated providers, base URLs, free-tier discovery filters
lib/state.js      Pure settings state, validation, transitions, redaction
lib/storage.js    Binds the state to one grant record in dsh-credentials
lib/rotation.js   Candidate planning, cooldowns, round-robin cursor, UI statuses
lib/wire.js       OpenAI Chat Completions wire, image data-URI projection, SSE parser, Harness chunks
lib/adapter.js    LlmAdapter: multi-account streaming with failover, vision metadata
lib/errors.js     Provider-neutral Harness error taxonomy and cooldown table
```

- Each provider owns a unique `fm-<id>` adapter route, so the plugin cannot
  collide with built-in provider routes.
- All providers are called through their OpenAI-compatible
  `chat/completions` surface (Cloudflare via `/ai/v1`) with streaming and
  usage reporting; Cloudflare's native `/ai/models` REST resource is used
  for discovery. On vision routes, non-offloaded user images are read once
  per attachment through the host attachment service (`readImageRequest`,
  1 MiB cap) and inlined as base64 `image_url` parts; if the attachment
  service is unavailable the request fails cleanly with
  `UNSUPPORTED_CONTENT` instead of sending a broken image reference.
- All accounts, keys, and settings are stored in **one owner-scoped grant
  record** through `@deepseek-ai/dsh-credentials` — the same secret seam the
  first-party plugins use. The browser only ever sees redacted data (key
  presence plus a four-character hint), and writes use an optimistic revision
  check, so concurrent settings windows cannot silently overwrite each other.
- Failures are classified into the Harness LLM error taxonomy
  (`INVALID_CREDENTIAL`, `QUOTA`, `RATE_LIMIT`, `SERVER`, `TRANSPORT`, …),
  which drives both in-call failover and the cooldown shown in the UI.

## Endpoints

All endpoints live under `/api/freemodels2dsh.*`, accept bounded JSON bodies,
and never echo API keys:

`state` (GET), `account-add`, `account-remove`, `account-toggle`,
`account-select`, `switch-mode`, `account-test`, `models-refresh`,
`models-reset`.

## Development

```powershell
npm test          # 95 node:test cases, no Harness install required
npm run pack:plugin
```

The test suite runs without the Harness peer packages: a small ESM loader
(`test/hooks.mjs`, `test/loader.mjs`) maps the `@deepseek-ai/*` specifiers to
minimal stubs under `test/stubs/`. The production code itself imports the real
peer packages.

## Privacy

- API keys leave the machine only as `Authorization` headers sent to the
  selected provider's official API endpoint.
- Keys are never logged, never included in client responses, and are not part
  of ordinary settings documents.
- Removing an account deletes its key and all runtime status for it.

## License

[MIT](./LICENSE)
