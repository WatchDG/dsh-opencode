/**
 * dsh-opencode — one live OpenCode provider for DeepSeek Harness.
 *
 * The harness ships an OpenCode model catalogue inside the pi-ai adapter, so
 * new gateway models only appear when DeepSeek Harness (or the vendor library)
 * is upgraded, and the only workaround is hand-editing
 * `providers.opencode-go.models`. This plugin replaces that with a provider it
 * owns:
 *
 * 1. **One provider route** (`provider`, display name "OpenCode") served by
 *    `lib/adapter.js`. Every imported model carries its own wire protocol, so
 *    the single route serves OpenAI Chat Completions, OpenAI Responses and
 *    Anthropic Messages models at once — no more one-provider-per-interface
 *    mirror routes.
 * 2. **The import dialog** in Settings → Models → OpenCode. It reads the live
 *    gateway catalogue (`GET /opencode/catalogue`), prefills each model's
 *    interface and context window from the shipped pi-ai catalogue or from
 *    models.dev, and asks the user to choose an interface only for models no
 *    metadata describes. `POST /opencode/import` stores the selection on the
 *    plugin's own row; the adapter serves it immediately.
 * 3. **`x-opencode-session` on every request.** OpenCode Go rejects inference
 *    without it (400 MissingSessionID), including calls the harness makes
 *    without a session id; the adapter always sends the configured value.
 *
 * Config (all optional, live):
 *
 *   provider          string    route id the plugin registers (opencode-live)
 *   displayName       string    picker name (OpenCode)
 *   targets           string[]  gateways read, first wins duplicate ids
 *   apiKeyEnv         string    credential reference (OPENCODE_API_KEY)
 *   targetApiKeyEnv   map       per-gateway credential overrides
 *   sessionHeader     string    header the gateway routes by
 *   sessionId         string    value sent in that header
 *   forceSessionHeader boolean  send it unconditionally (default true)
 *   includeFree       boolean   keep `-free` variants (default true)
 *   exclude           string[]  model-id substrings to hide
 *   retireShipped     boolean   remove shipped opencode routes after import
 *   endpoints         map       gateway root overrides
 *   catalogueUrl      string    models.dev metadata for unknown ids
 *   catalogueTimeoutMs number
 *   cacheDir          string
 *   timeoutMs         number
 *   models            array     imported model store (written by the dialog)
 */

import { Config } from './lib/config.js'
import { mount } from './lib/plugin.js'

/**
 * Activate the plugin for one profile context.
 *
 * @param {object} ctx Plugin context supplied by the DSH loader.
 * @param {unknown} config Bundle row config.
 */
export function apply(ctx, config) {
  mount(ctx, config)
}

export { Config }
export const name = 'opencode'
