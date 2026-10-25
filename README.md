# dsh-opencode

One live **OpenCode** provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The harness ships a frozen OpenCode model catalogue inside its pi-ai adapter, and
each configured pi-ai route can name exactly one wire protocol — so a mixed
OpenCode catalogue either cannot grow, or needs one provider per interface. This
plugin does it properly:

* it registers **one provider of its own** (`opencode-live`, display name
  "OpenCode") whose adapter serves every imported model, whatever protocol that
  model speaks (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages);
* it adds an **import dialog** to Settings → Models that reads the live
  OpenCode Zen / Zen Go catalogue, prefills each model's interface and context
  window from the shipped pi-ai catalogue or models.dev, and asks the user to
  pick an interface only for models no metadata describes;
* it **always sends `x-opencode-session`**. OpenCode Go rejects inference
  without it (`400 MissingSessionID`), including requests the harness makes
  without a session id.

After an import the shipped `opencode` / `opencode-go` routes are retired
(`retireShipped`, default on), so the picker shows exactly one OpenCode group.

## Install

```
plugin_manager(action: "install_bundle", target: "<absolute path to this repository>")
```

The plugin depends on `@earendil-works/pi-ai` (the same library the harness
uses); `install_bundle` installs it into the profile. `application: applied`
means the plugin is live. The Host row is `include:opencode`; after editing the
plugin's own code reinstall it (`remove_bundle`, then `install_bundle`) so the
replaced modules load.

Credential: store an OpenCode API key under `OPENCODE_API_KEY` or
`OPENCODE_GO_API_KEY` (Models page or environment). The catalogue listing is
public, so import also works without a key; requests then fail until one is
stored.

## Use

1. **Settings → Models → OpenCode** (the plugin's own provider card).
2. Press **Проверить модели / Fetch models**.
3. Every model appears with its interface and context window prefilled. Models
   whose interface could not be determined require a choice (presets: OpenAI Chat
   Completions / OpenAI Responses / Anthropic Messages) and a context window
   (default 262144) before the import button unlocks. Uncheck anything you do
   not want.
4. Press **Импортировать выбранные / Import selected**. Imported models are
   **enabled** by default; the card then shows *Импортировано N · включено M* and a
   manage list where every model can be switched on or off. Only enabled models
   are offered by the provider, so the picker stays exactly as long as you want
   it to be. The manage list has a **search by name or id** field, a **source
   filter** (All / Go / Zen) and a per-model source badge, so you can see whether
   an enabled model is routed through the OpenCode Go subscription or through
   Zen — and curate one family at a time: *Enable all / Disable all* act on the
   rows currently visible. Each model also has a **gear button**: it opens an
   inline editor for **context window**, **max output tokens** and **interface**.
   Empty fields reset that value, and **Reset to defaults** restores everything
   from the catalogue statement captured at import time (`defaults`); the editor
   shows those defaults next to the inputs. The manager's **Apply** saves the
   enabled set; the gear editor has its own Apply / Reset. Both apply live.
5. Disabling a model keeps it imported (its metadata and interface stay stored),
   so re-enabling it later needs no re-import.

`GET /opencode/status` (also shown in the card) reports the last import, the
stored and enabled model counts, the live registration state, and a capability
probe of the first enabled model.

## How it works

| Piece | What it does |
|---|---|
| `lib/catalogue.js` | Fetches both gateways, deduplicates by id (first target wins), filters internal ids, resolves each model: shipped pi-ai catalogue → models.dev → unresolved (dialog asks). Google Generative AI models are omitted: no configured pi-ai route can serve that protocol. |
| `lib/adapter.js` | The plugin's LLM adapter: one provider route, mixed protocols. Streaming is delegated to pi-ai's shipped OpenCode provider, so per-model protocol dispatch, compatibility quirks and the session-header wrapper are reused. Converts the harness conversation to a pi-ai context and the pi-ai event stream back to harness StreamChunks. |
| `lib/import-store.js` | Validates the dialog's selection, fills missing endpoints from the gateway + protocol preset, and diffs it against the stored catalogue (imported / updated / removed). |
| `lib/plugin.js` | Registers the adapter and the configurable-provider directory entry, applies imports through the settings seam, retires the shipped routes, and serves `/opencode/catalogue`, `/opencode/import`, `/opencode/status`. |
| `client.js` | The Models-card import wizard (RU/EN). |

Protocol presets are matched while fetching: the shipped catalogue states a
model's protocol authoritatively, models.dev supplies it for ids newer than the
installed release, and a small fallback table covers the gateway's unlisted
models that no public catalogue describes (`qwen3.7-max` → Anthropic Messages,
1M context / 64k output; `omen-alpha` → OpenAI Chat Completions, 500k / 128k —
sourced from OpenCode's Go documentation and community Go catalogues). Only a
genuinely unknown id reaches the dialog's interface picker; every prefilled
value can still be overridden or reset per model with the gear editor.

## Configuration

All fields are optional and live; `models` is written by the import dialog.

```yaml
- id: opencode
  name: dsh-opencode
  config:
    provider: opencode-live       # route id the plugin registers (needs a reload to change)
    displayName: OpenCode         # name shown in the picker
    targets: [opencode-go, opencode]  # gateways read; first wins duplicate ids
    apiKeyEnv: OPENCODE_API_KEY   # credential reference
    targetApiKeyEnv:              # per-gateway references
      opencode: OPENCODE_API_KEY
      opencode-go: OPENCODE_GO_API_KEY
    sessionHeader: x-opencode-session
    sessionId: dsh-opencode       # value sent in that header
    forceSessionHeader: true      # send it on every request
    includeFree: true             # keep `-free` variants
    exclude: []                   # model-id substrings to hide
    retireShipped: true           # remove shipped opencode routes after import
    endpoints:
      opencode: https://opencode.ai/zen
      opencode-go: https://opencode.ai/zen/go
    catalogueUrl: https://models.dev/api.json
    catalogueTimeoutMs: 90000
    cacheDir: ""                  # empty: <profile>/.dsh-opencode
    timeoutMs: 15000
    models: []                    # imported store (dialog-managed; rows carry `enabled` and `defaults`)
```

## Host API

Same-origin, cookie-authenticated routes:

- `GET /opencode/catalogue?refresh=1` →
  `{ ok, fetched, resolved, models, unknown, presets, warnings }`; a model row is
  `{ id, name, api|null, apiLabel|null, baseURL|null, contextWindow|null,
  maxTokens|null, input, source, resolved, suggestedApi }`.
- `POST /opencode/import` body `{ models: [{ id, name, api, baseURL?,
  contextWindow?, maxTokens?, input?, source?, enabled? }] }` →
  `{ ok, imported, updated, removed, total, enabled, skipped, retired,
  registered, models, importedAt }`. A new row is enabled unless it states
  `enabled: false`; a previously disabled id stays disabled.
- `POST /opencode/enabled` body `{ enabled: string[] }` — the exact set of model
  ids that should be offered by the provider →
  `{ ok, enabled, disabled, total }`. Everything imported but not listed becomes
  disabled; nothing is deleted.
- `POST /opencode/model` — per-model settings. `{ id, reset: true }` restores the
  context window, output cap and interface captured in the row's `defaults`;
  `{ id, contextWindow?, maxTokens?, api? }` sets overrides, where `null` resets
  one field to its default (an interface change rewrites `baseURL` from the
  gateway root). Returns `{ ok, model }` with the row in status shape.
- `GET /opencode/status` → provider state, the full stored model list with
  `source`, `enabled`, effective `contextWindow` / `maxTokens` and the `defaults`
  snapshot, `stored` / `enabledCount`, registered provider ids, a resolved sample
  of the first enabled model, and the last import.

## Verification

- `npm test` — 48 unit tests, no network.
- Live probe of the adapter (one provider, three protocols, real OpenCode Go
  key): OpenAI Chat Completions (`glm-5.2`), Anthropic Messages
  (`claude-haiku-5-5`) and OpenAI Responses (`gpt-6-luna`) all streamed
  successfully with `x-opencode-session` on every request.

## Known limitations

- The shipped Models page lists every dormant pi-ai catalog provider in its
  add-provider picker. After the shipped OpenCode routes are retired, the plugin
  card removes the retired ids (`opencode`, `opencode-go`) from those provider
  selects, so OpenCode is offered exactly once. That is a DOM-level adjustment of
  another plugin's picker — the page offers dormant catalog providers regardless
  of which adapter owns them, and it has no extension point for filtering them.
- Image content in history is rejected with `UNSUPPORTED_CONTENT` for now.
- Google Generative AI models are omitted (pi-ai's OpenCode provider exposes
  that protocol, but a configured route and the harness adapter do not).
- Duplicate ids across gateways resolve to the first entry in `targets`.
- The authenticated Zen listing is entitlement-filtered; the import mirrors what
  the account can call.

## License

Apache-2.0. See [LICENSE](LICENSE).
