/**
 * dsh-opencode — configuration, import presets and model-store schema.
 *
 * The plugin owns ONE LLM provider route (default `opencode-live`, display
 * name "OpenCode") whose model catalogue is the `models` array below: every
 * imported model carries the wire protocol ("interface") it speaks, so one
 * provider serves a mixed-protocol catalogue. The array is `.volatile()`, so
 * an import writes it through the settings seam and the registered adapter
 * reads the new catalogue on the next call — no reload, no extra providers.
 *
 * The bundle row's `config` is user-authored YAML, so every field is optional
 * and normalized here. `snapshot()` unwraps volatile references on every use.
 */

import z from '@deepseek-ai/schemastery'

/** Default provider route id the plugin registers. */
export const DEFAULT_PROVIDER = 'opencode-live'

/** Default display name of that provider in the picker. */
export const DEFAULT_DISPLAY_NAME = 'OpenCode'

/** Upstream gateways to read a catalogue from, in preference order. */
export const DEFAULT_TARGETS = ['opencode-go', 'opencode']

/** Default credential reference both gateways use. */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_API_KEY'

/** Request header OpenCode Zen requires for conversation routing. */
export const DEFAULT_SESSION_HEADER = 'x-opencode-session'

/** Value written when the shipped per-session header is not available. */
export const DEFAULT_SESSION_ID = 'dsh-opencode'

/** Public catalogue carrying per-model protocol metadata for new ids. */
export const DEFAULT_CATALOGUE_URL = 'https://models.dev/api.json'

/** Public catalogue is large; it gets its own budget. */
export const DEFAULT_CATALOGUE_TIMEOUT_MS = 90_000

/** Per-request timeout for gateway calls. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Fallback context window for a model that states none. */
export const DEFAULT_CONTEXT_WINDOW = 262_144

/** Fallback output cap for a model that states none. */
export const DEFAULT_MAX_TOKENS = 32_768

const MAX_TIMEOUT_MS = 60_000
const MAX_CATALOGUE_TIMEOUT_MS = 180_000

/** Wire protocols a configured model may name, in picker order. */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * Interface presets. The import dialog shows these labels for a model whose
 * interface the catalogue does not state; the Host also uses the preset's base
 * URL rule to build the model's endpoint.
 */
export const PRESETS = [
  { api: 'openai-completions', label: 'OpenAI Chat Completions' },
  { api: 'openai-responses', label: 'OpenAI Responses' },
  { api: 'anthropic-messages', label: 'Anthropic Messages' },
]

/** Gateway roots of the two OpenCode gateways. */
export const DEFAULT_ENDPOINTS = {
  opencode: 'https://opencode.ai/zen',
  'opencode-go': 'https://opencode.ai/zen/go',
}

/**
 * Default credential reference per gateway. pi-ai's own environment discovery
 * uses OPENCODE_API_KEY for both; the Go deployment also commonly stores
 * OPENCODE_GO_API_KEY, so the two defaults match the two gateways.
 */
export const DEFAULT_TARGET_API_KEY_ENV = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY',
}

/** Provider prefix reserved for the plugin's own retired mirror routes. */
export const LEGACY_ROUTE = /^opencode(?:-go)?-live(?:-|$)/

/** Catalogue defaults captured at import, used by "reset to defaults". */
export const ModelDefaults = z.object({
  name: z.string(),
  api: z.union(PROTOCOLS),
  baseURL: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
})

/** One imported model, as stored in the plugin's own row. */
export const ModelEntry = z.object({
  id: z.string().required(),
  name: z.string(),
  api: z.union(PROTOCOLS).required(),
  baseURL: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  input: z.array(z.union(['text', 'image'])),
  source: z.string(),
  /** Whether the model is offered by the provider (picker/tool catalogues). */
  enabled: z.boolean().default(true),
  /** Values the catalogue stated when the model was imported. */
  defaults: ModelDefaults,
})

/**
 * Runtime configuration. Every field is volatile: the adapter reads the live
 * references on each call, and an import writes `models` without remounting.
 */
export const Config = z.object({
  /** Provider route id the plugin registers. Changing it needs a reload. */
  provider: z.string().default(DEFAULT_PROVIDER),
  /** Display name shown in the picker and the Models page. */
  displayName: z.string().default(DEFAULT_DISPLAY_NAME),
  /** Upstream gateways read for a catalogue, in preference order. */
  targets: z.array(z.string()).default([...DEFAULT_TARGETS]).volatile(),
  /** Credential reference resolved through `ctx.credentials` per request. */
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV).volatile(),
  /** Per-gateway credential overrides. */
  targetApiKeyEnv: z.dict(z.string()).default({}).volatile(),
  /** Header name the gateways route conversations by. */
  sessionHeader: z.string().default(DEFAULT_SESSION_HEADER).volatile(),
  /** Header value this plugin sends on every request. */
  sessionId: z.string().default(DEFAULT_SESSION_ID).volatile(),
  /** Send that static header unconditionally (guarantees sessionless paths). */
  forceSessionHeader: z.boolean().default(true).volatile(),
  /** Keep `-free` / trial variants when listing the catalogue. */
  includeFree: z.boolean().default(true).volatile(),
  /** Model-id substrings hidden from the catalogue. */
  exclude: z.array(z.string()).default([]).volatile(),
  /** Remove the shipped `opencode` / `opencode-go` routes after an import. */
  retireShipped: z.boolean().default(true).volatile(),
  /** Per-gateway endpoint root overrides. */
  endpoints: z.dict(z.string()).default({}).volatile(),
  /** Public per-model metadata catalogue (used only for unknown ids). */
  catalogueUrl: z.string().default(DEFAULT_CATALOGUE_URL).volatile(),
  catalogueTimeoutMs: z.number().default(DEFAULT_CATALOGUE_TIMEOUT_MS).volatile(),
  /** Directory for the metadata cache; empty means the profile directory. */
  cacheDir: z.string().default('').volatile(),
  /** Per-request HTTP timeout. */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS).volatile(),
  /** The imported model store the adapter serves. */
  models: z.array(ModelEntry).default([]).volatile(),
})

/**
 * Read one Config field, tolerating a plain value when the schema is parsed
 * without the volatile wrapper (tests, older readers).
 *
 * @param {unknown} value Stored field value or volatile reference.
 * @param {unknown} fallback Value when nothing usable is stored.
 * @returns {unknown} the stored choice.
 */
export function live(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

/** Normalize a list of non-empty unique trimmed strings. */
function stringList(value) {
  const source = Array.isArray(value) ? value : value instanceof Set ? [...value] : []
  const seen = new Set()
  const out = []
  for (const entry of source) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Normalize one non-empty string setting. */
function stringSetting(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** Positive integer or undefined. */
export function positiveInteger(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * Normalize the catalogue defaults captured at import.
 *
 * @param {unknown} raw
 * @returns {{ name?: string, api?: string, baseURL?: string, contextWindow?: number, maxTokens?: number } | undefined}
 */
export function normalizeDefaults(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = /** @type {Record<string, any>} */ (raw)
  const contextWindow = positiveInteger(entry.contextWindow)
  const maxTokens = positiveInteger(entry.maxTokens)
  const defaults = {
    ...(typeof entry.name === 'string' && entry.name.trim().length > 0 ? { name: entry.name.trim() } : {}),
    ...(PROTOCOLS.includes(entry.api) ? { api: entry.api } : {}),
    ...(typeof entry.baseURL === 'string' && entry.baseURL.trim().length > 0
      ? { baseURL: entry.baseURL.trim().replace(/\/+$/, '') }
      : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
  return Object.keys(defaults).length === 0 ? undefined : defaults
}

/**
 * Normalize one imported model row.
 *
 * @param {unknown} raw
 * @returns {{
 *   id: string,
 *   name: string,
 *   api: string,
 *   baseURL?: string,
 *   contextWindow?: number,
 *   maxTokens?: number,
 *   input: string[],
 *   source?: string,
 *   enabled: boolean,
 *   defaults?: { name?: string, api?: string, baseURL?: string, contextWindow?: number, maxTokens?: number },
 * } | undefined}
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = /** @type {Record<string, any>} */ (raw)
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id.length === 0 || /\s|\//.test(id)) return undefined
  if (!PROTOCOLS.includes(entry.api)) return undefined
  const contextWindow = positiveInteger(entry.contextWindow)
  const maxTokens = positiveInteger(entry.maxTokens)
  const input = Array.isArray(entry.input)
    ? [...new Set(entry.input.filter((value) => value === 'text' || value === 'image'))]
    : ['text']
  const defaults = normalizeDefaults(entry.defaults)
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : id,
    api: entry.api,
    ...(typeof entry.baseURL === 'string' && entry.baseURL.trim().length > 0
      ? { baseURL: entry.baseURL.trim().replace(/\/+$/, '') }
      : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    input: input.length === 0 ? ['text'] : input,
    ...(typeof entry.source === 'string' && entry.source.length > 0 ? { source: entry.source } : {}),
    enabled: entry.enabled !== false,
    ...(defaults === undefined ? {} : { defaults }),
  }
}

/**
 * Normalize the stored model store: unique ids, stored order preserved.
 *
 * @param {unknown} value
 * @returns {Array<ReturnType<typeof normalizeModel>>}
 */
export function normalizeModels(value) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  const models = []
  for (const raw of list) {
    const model = normalizeModel(raw)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * Normalize the loader row's config.
 *
 * @param {unknown} raw Value from the bundle row (`config` in the patch layer).
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const targets = stringList(source.targets)
  const overrides = source.endpoints !== null && typeof source.endpoints === 'object' ? source.endpoints : {}
  const endpoints = { ...DEFAULT_ENDPOINTS }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      endpoints[key.trim()] = value.trim().replace(/\/+$/, '')
    }
  }
  const keyOverrides =
    source.targetApiKeyEnv !== null && typeof source.targetApiKeyEnv === 'object' ? source.targetApiKeyEnv : {}
  const targetApiKeyEnv = { ...DEFAULT_TARGET_API_KEY_ENV, ...keyOverrides }
  for (const [key, value] of Object.entries(targetApiKeyEnv)) {
    if (typeof value !== 'string' || value.trim().length === 0) delete targetApiKeyEnv[key]
    else targetApiKeyEnv[key] = value.trim()
  }
  const timeout =
    Number.isFinite(source.timeoutMs) && source.timeoutMs > 0
      ? Math.min(source.timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS
  const catalogueTimeout =
    Number.isFinite(source.catalogueTimeoutMs) && source.catalogueTimeoutMs > 0
      ? Math.min(source.catalogueTimeoutMs, MAX_CATALOGUE_TIMEOUT_MS)
      : DEFAULT_CATALOGUE_TIMEOUT_MS
  return {
    provider: stringSetting(source.provider, DEFAULT_PROVIDER),
    displayName: stringSetting(source.displayName, DEFAULT_DISPLAY_NAME),
    targets: targets.length > 0 ? targets : [...DEFAULT_TARGETS],
    apiKeyEnv: stringSetting(source.apiKeyEnv, DEFAULT_API_KEY_ENV),
    targetApiKeyEnv,
    sessionHeader: stringSetting(source.sessionHeader, DEFAULT_SESSION_HEADER),
    sessionId: stringSetting(source.sessionId, DEFAULT_SESSION_ID),
    forceSessionHeader: source.forceSessionHeader !== false,
    includeFree: source.includeFree !== false,
    exclude: stringList(source.exclude),
    retireShipped: source.retireShipped !== false,
    endpoints,
    catalogueUrl: stringSetting(source.catalogueUrl, DEFAULT_CATALOGUE_URL),
    catalogueTimeoutMs: catalogueTimeout,
    cacheDir: typeof source.cacheDir === 'string' ? source.cacheDir.trim() : '',
    timeoutMs: timeout,
    models: normalizeModels(source.models),
  }
}

/**
 * Unwrap volatile Config references, then normalize on every use.
 *
 * @param {unknown} raw Plugin Config with optional volatile references.
 * @returns {ReturnType<typeof normalizeConfig>}
 */
export function snapshot(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return normalizeConfig({
    provider: live(source.provider, undefined),
    displayName: live(source.displayName, undefined),
    targets: live(source.targets, undefined),
    apiKeyEnv: live(source.apiKeyEnv, undefined),
    targetApiKeyEnv: live(source.targetApiKeyEnv, undefined),
    sessionHeader: live(source.sessionHeader, undefined),
    sessionId: live(source.sessionId, undefined),
    forceSessionHeader: live(source.forceSessionHeader, undefined),
    includeFree: live(source.includeFree, undefined),
    exclude: live(source.exclude, undefined),
    retireShipped: live(source.retireShipped, undefined),
    endpoints: live(source.endpoints, undefined),
    catalogueUrl: live(source.catalogueUrl, undefined),
    catalogueTimeoutMs: live(source.catalogueTimeoutMs, undefined),
    cacheDir: live(source.cacheDir, undefined),
    timeoutMs: live(source.timeoutMs, undefined),
    models: live(source.models, undefined),
  })
}

/**
 * Endpoint root of one upstream gateway.
 *
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @param {string} target Gateway route name.
 * @returns {string | undefined}
 */
export function endpointOf(settings, target) {
  return settings.endpoints[target]
}

/**
 * Credential reference one gateway authenticates through.
 *
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @param {string} target Gateway route name.
 * @returns {string}
 */
export function apiKeyEnvFor(settings, target) {
  const configured = settings.targetApiKeyEnv[target]
  return typeof configured === 'string' && configured.length > 0 ? configured : settings.apiKeyEnv
}

/**
 * Wire base URL for one gateway root and protocol.
 *
 * Anthropic endpoints name the API root (the SDK appends `/v1/messages`);
 * OpenAI-compatible endpoints name the `/v1` root. A root already ending in
 * `/v1` is accepted either way and normalized once.
 *
 * @param {string} root Gateway root.
 * @param {string} api Wire protocol.
 * @returns {string}
 */
export function baseUrlFor(root, api) {
  const trimmed = String(root ?? '').replace(/\/+$/, '')
  if (trimmed.length === 0) return ''
  const hasV1 = /\/v1$/.test(trimmed)
  if (api === 'anthropic-messages') return hasV1 ? trimmed.slice(0, -3) : trimmed
  return hasV1 ? trimmed : `${trimmed}/v1`
}
