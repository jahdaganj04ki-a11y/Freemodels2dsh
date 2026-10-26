# Freemodels2dsh

A [DSH Desktop](https://github.com/dataelement/dsh-desktop) plugin that brings
together **free cloud LLM providers** — every model it lists is usable in
Germany with a self-registered account, an API key, and **no payment method
and no stored card**. Local runtimes (Ollama, LM Studio, llama.cpp, …) are not
part of this plugin; every request goes to a hosted provider.

It adds one settings tab, **Free Models**, with:

- **8 curated free providers** and only the models their free tiers can call.
- **Multiple accounts per provider**, each with its own key (Cloudflare
  accounts also carry their 32-character Account ID).
- A per-provider account window (click a provider row) supporting
  **add / remove / enable / disable**, connection tests, and live model-list
  refresh.
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

Deliberately excluded:

- **GitHub Models** — free API retired on 2026-07-30.
- **Cerebras** — free tier ended 2026-07-16; paid trial requires a card.
- **SambaNova** — requires a payment method since October 2026.
- **Hugging Face Inference Providers** — free accounts no longer receive
  inference credits (since 2026-10-07).
- Any provider or model whose only free offering requires billing details,
  and every local model runtime.

## Install (Windows, DSH Desktop)

1. Build the package:

   ```powershell
   npm install
   npm run pack:plugin
   ```

   This produces `freemodels2dsh-1.0.0.tgz`.

2. Install it into the profile DSH Desktop drives (the reserved `web`
   profile — never use `desktop`, which the harness rejects) with the DSH CLI
   bundled alongside DSH Desktop:

   ```powershell
   dsh plugin --profile web add C:\absolute\path\to\freemodels2dsh-1.0.0.tgz
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
lib/wire.js       OpenAI Chat Completions wire, SSE parser, Harness chunks
lib/adapter.js    LlmAdapter: multi-account streaming with failover
lib/errors.js     Provider-neutral Harness error taxonomy and cooldown table
```

- Each provider owns a unique `fm-<id>` adapter route, so the plugin cannot
  collide with built-in provider routes.
- All providers are called through their OpenAI-compatible
  `chat/completions` surface (Cloudflare via `/ai/v1`) with streaming and
  usage reporting; Cloudflare's native `/ai/models` is used for discovery.
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
npm test          # 80+ node:test cases, no Harness install required
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
