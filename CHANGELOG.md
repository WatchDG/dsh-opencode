# Changelog

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
