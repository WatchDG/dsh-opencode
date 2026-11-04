# Changelog

## 0.3.0

Image support: an imported model whose input types include `image` now receives
attached images instead of failing the turn with `UNSUPPORTED_CONTENT`.

- Durable image references from session history (user and tool messages) are
  projected through the harness attachment service into deterministic
  route-sized request versions: aspect-preserving dimensions inside
  `requestImageMaxPixels` (default 4 Mi pixels) and re-encoded bytes inside
  `requestImageMaxBytes` (default 1 MiB). The service caches the version per
  reference and target, so repeated turns reuse one projection.
- Each image travels with the same stable model-facing handle the shipped
  pi-ai adapter uses (`Image <name> (<sha256>); request preview <w>x<h>px.`),
  plus the read-only path of the normalized copy when the deployment maps
  attachment host paths into the tool execution world.
- Occurrences the harness marked `offloaded` become placeholder text. A request
  whose retained images exceed `maxRequestImageBytes` (default 20 MiB of base64)
  fails with `IMAGE_OFFLOAD_REQUIRED` and the number of additional oldest
  occurrences to omit, so `dsh-compaction-image-offload` records the decision in
  the session and retries. Set the field to `0` to disable the bound.
- An image reference whose bytes cannot be derived (for example a session moved
  from a deployment that stored attachments elsewhere) is replaced with a
  placeholder naming the unreadable attachment instead of failing the turn. The
  attachment service is required only while a live image must be read, so an
  already-offloaded history renders placeholders (and the normalized copy's
  read-only path when the deployment can map it) without it. Images in assistant
  or system/developer messages remain `UNSUPPORTED_CONTENT`, because pi-ai's chat
  replay cannot represent them; a text-only model keeps receiving the harness's
  own placeholders.
- `imageRequestTarget` now reports the real request projection (fitted
  dimensions and the encoded-byte budget) instead of echoing the source image.
- New route-wide config fields `requestImageMaxPixels`, `requestImageMaxBytes`
  and `maxRequestImageBytes`; new `lib/images.js` module and image unit tests
  (the suite now has 80 tests).

## 0.2.0

Per-model **input types**: the model settings editor can now declare whether a
model accepts text, images, or both.

- The per-model gear editor gains **Input types** — `Text` / `Image` checkboxes,
  at least one required — and saves the selection through
  `POST /opencode/model`.
- `POST /opencode/model` accepts an `input` override (a non-empty list of `text`
  and/or `image`); `null` resets it to the catalogue statement. `GET
  /opencode/status` and the model-settings answer carry `input` and
  `defaults.input`, so the editor shows the catalogue default and reset restores
  it.
- Imports capture each model's input types in `defaults`, so a re-import
  refreshes the modalities along with the rest of the catalogue statement.

## 0.1.0

A single plugin-owned OpenCode provider for DeepSeek Harness, with a live
catalogue import, model enablement, and per-model settings.

- Registers one LLM provider (`opencode-live`, display name "OpenCode") whose
  adapter serves a mixed-protocol catalogue — OpenAI Chat Completions, OpenAI
  Responses and Anthropic Messages models at once. Streaming delegates to
  pi-ai's shipped OpenCode transport, so per-model protocol dispatch,
  compatibility quirks and the `x-opencode-session` wrapper are reused.
- Models-page import dialog: reads the live OpenCode Zen / Zen Go catalogue,
  deduplicates by id (first target wins), filters internal ids, and prefills each
  model's interface, name and context window from the shipped pi-ai catalogue,
  models.dev, or a fallback table for unlisted gateway models (`qwen3.7-max` →
  Anthropic Messages / 1M / 64k, `omen-alpha` → Chat Completions / 500k / 128k).
  Only genuinely unknown ids ask the user to pick an interface before import.
- The imported catalogue is stored on the plugin's own row (`models`, volatile)
  and applies to the provider without a reload; the catalogue statement is kept
  as `defaults` for reset. A re-import refreshes defaults.
- Model enablement: the provider offers only enabled models, newly imported
  models start enabled, and `POST /opencode/enabled` curates the picker while
  disabled models stay imported.
- Model management card: search by name/id, a Go/Zen source filter with per-model
  source badges, enable-all/disable-all over the visible rows, and a per-model
  gear editor that overrides the context window, max output tokens and interface
  or resets them to the captured defaults (`POST /opencode/model`).
- After the shipped per-protocol `opencode` / `opencode-go` routes are retired,
  the card removes those retired ids from the Models page add-provider selects,
  so OpenCode is offered exactly once.
- Host routes: `GET /opencode/catalogue`, `POST /opencode/import`,
  `POST /opencode/enabled`, `POST /opencode/model`, `GET /opencode/status`.
- `x-opencode-session` is sent on every request, including the sessionless paths
  the harness makes without a session id.
- Google Generative AI models are omitted (a configured pi-ai route cannot serve
  that protocol); image content in history is refused with
  `UNSUPPORTED_CONTENT` for now.
