# dsh-opencode

One live **OpenCode** provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The harness ships a frozen OpenCode model catalogue inside its pi-ai adapter, and
each configured pi-ai route can name exactly one wire protocol — so a mixed
OpenCode catalogue either cannot grow, or needs one provider per interface. This
plugin does it properly:

* it registers **one provider of its own** (`opencode-live`, display name
  "OpenCode") whose adapter serves every imported model, whatever protocol that
  model speaks (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages,
  Google Generative AI);
* it adds an **import dialog** to Settings → Models that reads the live
  OpenCode Zen / Zen Go catalogue, prefills each model's interface and context
  window from the shipped pi-ai catalogue or models.dev, and asks the user to
  pick an interface only for models no metadata describes;
* it **routes each conversation by its session**. A request that carries a
  harness session id is routed by that id (pi-ai's OpenCode wrapper adds
  `x-opencode-session`), so each conversation gets its own gateway routing key;
  a sessionless call falls back to the configured `sessionId` value, which
  OpenCode Go requires (`400 MissingSessionID`), and `forceSessionHeader: false`
  suppresses even that fallback;
* it **forwards images**. A chat attachment is stored by the harness as a
  durable reference; the adapter projects it into the exact request version the
  model receives (resized inside a pixel budget, re-encoded inside a byte
  budget) and sends the bytes in that protocol's image form (an OpenAI image
  part, an Anthropic image block or a Google inline data part), with a stable
  model-facing handle beside it.

After an import the shipped `opencode` / `opencode-go` routes are retired
(`retireShipped`, default on), so the picker shows exactly one OpenCode group.

## Install

```
plugin_manager(action: "install_bundle", target: "<absolute path to this repository>")
```

The plugin targets DeepSeek Harness 0.2.2-rc.1 (`engines.dsh` is
`>=0.2.2-rc.1 <0.3.0-0`). It depends on `@earendil-works/pi-ai` (the same library
the harness uses); `install_bundle` installs it into the profile. The dependency
is pinned to the versions that release ships — pi-ai 1.3.0 and schemastery
~3.19.0 — because the plugin imports pi-ai directly and resolves its own copy
from this checkout: the host's bundled upgrade does not reach it without the
bump. `application: applied` means the plugin is live. The Host row is
`include:opencode`; after editing the plugin's own code reinstall it
(`remove_bundle`, then `install_bundle`) so the replaced modules load.

Credential: store an OpenCode API key under `OPENCODE_API_KEY` or
`OPENCODE_GO_API_KEY` (Models page or environment). The catalogue listing is
public, so import also works without a key; requests then fail until one is
stored.

## Use

1. **Settings → Models → OpenCode** (the plugin's own provider card).
2. Press **Проверить модели / Fetch models**.
3. Every model appears with its interface and context window prefilled. Models
   whose interface could not be determined require a choice (presets: OpenAI Chat
   Completions / OpenAI Responses / Anthropic Messages / Google Generative AI)
   and a context window (default 1000000) before the import button unlocks.
   Uncheck anything you do not want.
4. Press **Импортировать выбранные / Import selected**. Imported models are
   **enabled** by default; the card then shows *Импортировано N · включено M* and a
   manage list where every model can be switched on or off. Only enabled models
   are offered by the provider, so the picker stays exactly as long as you want
   it to be. The manage list has a **search by name or id** field, a **source
   filter** (All / Go / Zen) and a per-model source badge, so you can see whether
   an enabled model is routed through the OpenCode Go subscription or through
   Zen — and curate one family at a time: *Enable all / Disable all* act on the
   rows currently visible. Each model also has a **gear button**: it opens an
   inline editor for **context window**, **max output tokens**, **interface** and
   **input types** (**Text** / **Image** checkboxes; at least one is required).
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
| `lib/catalogue.js` | Fetches both gateways, deduplicates by id (first target wins), filters internal ids, resolves each model: shipped pi-ai catalogue → models.dev → unresolved (dialog asks). Gemini models such as `gemini-4-argon` resolve to Google Generative AI like any other protocol instead of being dropped. |
| `lib/adapter.js` | The plugin's LLM adapter: one provider route, mixed protocols. Streaming is delegated to pi-ai's shipped OpenCode provider, so per-model protocol dispatch, compatibility quirks and the session-header wrapper are reused. Converts the harness conversation to a pi-ai context and the pi-ai event stream back to harness StreamChunks; a response whose final tool-call arguments did not parse is refused with `MALFORMED_RESPONSE` instead of running a tool with empty `{}` arguments. |
| `lib/images.js` | Image projection for that adapter: turns durable image references into route-sized request versions through the mounted attachment service, renders the model-facing handle text, accounts the per-request base64 budget, and builds the `IMAGE_OFFLOAD_REQUIRED` failure the harness answers by offloading the oldest images. |
| `lib/import-store.js` | Validates the dialog's selection, fills missing endpoints from the gateway + protocol preset, and diffs it against the stored catalogue (imported / updated / removed). |
| `lib/plugin.js` | Registers the adapter and the configurable-provider directory entry, applies imports through the settings seam, retires the shipped routes, and serves `/opencode/catalogue`, `/opencode/import`, `/opencode/status`. |
| `client.js` | The Models-card import wizard (RU/EN). |

Protocols are resolved while fetching: the shipped catalogue states a model's
protocol authoritatively, models.dev supplies it for ids newer than the installed
release, and a small fallback table covers the gateway's unlisted models that no
public catalogue describes (`qwen3.7-max` → Anthropic Messages, 1M context /
64k output; `omen-alpha` → OpenAI Chat Completions, 500k / 128k — sourced from
OpenCode's Go documentation and community Go catalogues). The dialog offers the
same four protocols as presets. Only a genuinely unknown id reaches the dialog's
interface picker; every prefilled value can still be overridden or reset per
model with the gear editor.

The provider inherits pi-ai 1.3.0's own behaviour. Replayed reasoning from
another model is dropped instead of converted to visible text; an Anthropic
strict-tool request retries without the preferred strict tools when the API
rejects it on grammar or size limits; images inside Anthropic error tool results
are split out instead of being sent inline; and an OpenAI-compatible stream may
order reasoning before text.

## Images

The session log stores an attached image as a durable reference, not bytes. When
the selected model accepts images (the per-model **Input types** editor declares
that), the adapter projects each live reference through the harness attachment
service into a deterministic request version:

- dimensions are fitted inside `requestImageMaxPixels` (default 4 Mi pixels,
  aspect preserved, never enlarged) and the bytes are re-encoded inside
  `requestImageMaxBytes` (default 1 MiB). The service caches the result per
  reference and target, so repeated turns reuse one request version;
- each image is preceded by a stable handle (`Image <name> (<sha256>); request
  preview <w>x<h>px.`) so the model can refer to it — plus the read-only path of
  the normalized copy when the deployment maps attachment host paths into the
  tool execution world;
- a text-only model never receives image bytes: the harness replaces every
  occurrence with placeholder text before the adapter is called;
- an occurrence the harness marked offloaded becomes placeholder text, so a long
  conversation keeps its recorded history without sending old images again;
- when the retained images exceed `maxRequestImageBytes` (default 20 MiB of
  base64) the request fails with `IMAGE_OFFLOAD_REQUIRED` and the number of
  additional oldest occurrences to omit; the harness's image-offload plugin
  records that decision in the session and retries. Set the field to `0` to send
  every image regardless of the bound.

Images need the harness `attachments` service, which the base profile mounts; the
service is only required while a live image must be read, so an already-offloaded
history still renders placeholders (with the normalized copy's read-only path when
available). A reference whose bytes cannot be derived (for example a session moved
from a deployment that stored its attachments elsewhere) is replaced with a
placeholder naming the unreadable attachment instead of failing the turn. The
three budgets apply to the whole provider route rather than per model. Images in
assistant output are not part of pi-ai's chat replay and are rejected.

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
    sessionId: dsh-opencode       # routing value for sessionless calls
    forceSessionHeader: true      # send that value even without a session id
    includeFree: true             # keep `-free` variants
    exclude: []                   # model-id substrings to hide
    retireShipped: true           # remove shipped opencode routes after import
    endpoints:
      opencode: https://opencode.ai/inference
      opencode-go: https://opencode.ai/inference/go
    catalogueUrl: https://models.dev/api.json
    catalogueTimeoutMs: 90000
    cacheDir: ""                  # empty: <profile>/.dsh-opencode
    timeoutMs: 15000
    requestImageMaxPixels: 4194304  # pixel budget of one image sent to the model
    requestImageMaxBytes: 1048576   # encoded-byte budget of one image
    maxRequestImageBytes: 20971520  # base64 budget of all images in one request; 0 disables offloading
    models: []                    # imported store (dialog-managed; rows carry `enabled` and `defaults`)
```

The `endpoints` block follows pi-ai 1.3.0's canonical gateway roots. The legacy
`/zen` roots still answer and can be restored through `endpoints`; rows imported
earlier keep the base URL captured at import. An imported model that declares no
capacity falls back to the DSH 0.2.2 default for custom models: 1,000,000
context and 128,000 output tokens.

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
  context window, output cap, interface and input types captured in the row's
  `defaults`; `{ id, contextWindow?, maxTokens?, api?, input? }` sets overrides,
  where `null` resets one field to its default (an interface change rewrites
  `baseURL` from the gateway root; `input` is a non-empty list of `text` and/or
  `image`). Returns `{ ok, model }` with the row in status shape.
- `GET /opencode/status` → provider state, the full stored model list with
  `source`, `enabled`, effective `contextWindow` / `maxTokens`, `input` (what the
  model accepts: `text`, `image` or both) and the `defaults` snapshot,
  `stored` / `enabledCount`, registered provider ids, a resolved sample
  of the first enabled model, and the last import.

## Verification

- `npm test` — 83 unit tests, no network.
- Live probe of the adapter (one provider, real OpenCode Go key): OpenAI Chat
  Completions (`glm-5.2`), Anthropic Messages (`claude-haiku-5-5`) and OpenAI
  Responses (`gpt-6-luna`) all streamed successfully. The adapter now serves
  four protocols — Google Generative AI was added with pi-ai 1.3.0, and the live
  gateways advertise Gemini models (`gemini-4-argon` on both) — but the recorded
  probe covers the other three.
- Live image probe: an image sent through the adapter reached the gateway's
  Chat Completions route as an `image_url` data part (preceded by its handle
  text, with the session header and the bearer key), and the gateway accepted
  the request.

## Known limitations

- The shipped Models page lists every dormant pi-ai catalog provider in its
  add-provider picker. After the shipped OpenCode routes are retired, the plugin
  card removes the retired ids (`opencode`, `opencode-go`) from those provider
  selects, so OpenCode is offered exactly once. That is a DOM-level adjustment of
  another plugin's picker — the page offers dormant catalog providers regardless
  of which adapter owns them, and it has no extension point for filtering them.
- Images need the harness attachment service and a model whose **Input types**
  declare `image`; the adapter itself supports image input on all four wire
  protocols. An image that appears in an assistant or system/developer message is
  still rejected with `UNSUPPORTED_CONTENT`, because pi-ai's chat replay cannot
  represent it.
- Duplicate ids across gateways resolve to the first entry in `targets`.
- The authenticated Zen listing is entitlement-filtered; the import mirrors what
  the account can call.

## License

Apache-2.0. See [LICENSE](LICENSE).
