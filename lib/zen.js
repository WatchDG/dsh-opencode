/**
 * dsh-opencode — the live OpenCode Zen model listing.
 *
 * One HTTP contract, two gateways: OpenCode Zen (`/zen`) and Zen Go
 * (`/zen/go`) expose an OpenAI-compatible model listing at `<root>/v1/models`.
 * Every request carries the provider key as a bearer token *and* the
 * `x-opencode-session` header OpenCode Zen routes conversations by — the
 * header is mandatory for the gateway, not a nicety.
 *
 * The module takes `fetch` as a parameter so the parsing and fallback rules are
 * unit-testable without a network.
 */

/** Paths tried for a model listing, most standard first. */
const LISTING_PATHS = ['/v1/models', '/models']

/**
 * Build the listing URLs for one gateway root.
 *
 * @param {string} root Gateway root, e.g. `https://opencode.ai/zen`.
 * @returns {string[]} candidate URLs in request order.
 */
export function listingUrls(root) {
  const trimmed = String(root ?? '').replace(/\/+$/, '')
  if (trimmed.length === 0) return []
  return LISTING_PATHS.map((path) => `${trimmed}${path}`)
}

/** Positive integer or undefined. */
function capacity(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * Normalize one listing entry.
 *
 * @param {unknown} raw
 * @param {string} fallbackId
 * @returns {{ id: string, name?: string, contextWindow?: number, maxTokens?: number } | undefined}
 */
function readModel(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = /** @type {Record<string, unknown>} */ (raw)
  const id =
    typeof entry.id === 'string' && entry.id.length > 0
      ? entry.id
      : typeof entry.model === 'string' && entry.model.length > 0
        ? entry.model
        : fallbackId
  if (typeof id !== 'string' || id.length === 0) return undefined
  const name =
    typeof entry.name === 'string' && entry.name.length > 0
      ? entry.name
      : typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? entry.display_name
        : undefined
  const contextWindow = capacity(entry.context_window ?? entry.context_length ?? entry.max_input_tokens ?? entry.limit?.context)
  const maxTokens = capacity(entry.max_output_tokens ?? entry.max_tokens ?? entry.limit?.output)
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/**
 * Parse a model-listing body: OpenAI `{ data: [...] }`, a bare array, or an
 * enriched `{ models: { id: {...} } }` map (the shape pi-ai also accepts).
 *
 * @param {unknown} body Parsed JSON body.
 * @returns {Array<{ id: string, name?: string, contextWindow?: number, maxTokens?: number }>}
 */
export function readListing(body) {
  if (Array.isArray(body)) return body.map((entry) => readModel(entry, '')).filter(Boolean)
  if (body === null || typeof body !== 'object') return []
  const row = /** @type {Record<string, unknown>} */ (body)
  if (Array.isArray(row.data)) return row.data.map((entry) => readModel(entry, '')).filter(Boolean)
  if (Array.isArray(row.models)) return row.models.map((entry) => readModel(entry, '')).filter(Boolean)
  if (row.models !== null && typeof row.models === 'object') {
    return Object.entries(row.models)
      .map(([key, value]) => readModel(value, key))
      .filter((entry) => entry !== undefined)
  }
  return []
}

/** Read a response body as text with a size bound, so a hostile page cannot exhaust memory. */
async function readBounded(response, limit = 2_000_000) {
  const text = await response.text()
  return text.length > limit ? text.slice(0, limit) : text
}

/** One-line summary of a provider error body. */
function brief(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length === 0 ? '' : flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * Fetch the models one OpenCode gateway advertises.
 *
 * A 401/403 stops at the first URL because the credential, not the path, is
 * wrong. A 404/405 falls through to the next candidate, which tolerates a
 * gateway that mounts its listing under a different prefix.
 *
 * @param {{
 *   root: string,
 *   apiKey: string | undefined,
 *   sessionHeader: string,
 *   sessionId: string,
 *   timeoutMs: number,
 *   headers?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ url: string, models: Array<{ id: string, name?: string, contextWindow?: number, maxTokens?: number }> }>}
 */
export async function fetchLiveModels(input) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const urls = listingUrls(input.root)
  if (urls.length === 0) throw new Error(`dsh-opencode: no endpoint configured for the OpenCode gateway`)
  if (typeof fetchImpl !== 'function') throw new Error('dsh-opencode: this Host has no fetch implementation')

  /** Headers every OpenCode Zen request needs, including the session header. */
  const headers = {
    accept: 'application/json',
    ...(input.apiKey === undefined || input.apiKey.length === 0
      ? {}
      : { authorization: `Bearer ${input.apiKey}` }),
    [input.sessionHeader]: input.sessionId,
    ...(input.headers ?? {}),
  }

  let lastFailure = ''
  for (const url of urls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), input.timeoutMs)
    const signal =
      input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal])
    let response
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal })
    } catch (error) {
      clearTimeout(timeout)
      if (input.signal?.aborted) throw new Error('dsh-opencode: the sync was cancelled')
      lastFailure = `could not reach ${url} (${error instanceof Error ? error.message : String(error)})`
      continue
    }
    let text
    try {
      text = await readBounded(response)
    } finally {
      clearTimeout(timeout)
    }
    if (response.status === 401 || response.status === 403) {
      const detail = brief(text)
      throw new Error(
        `${url} answered ${response.status}; the ${input.apiKey === undefined ? 'missing' : 'stored'} OpenCode credential was rejected${detail.length === 0 ? '' : `: ${detail}`}`,
      )
    }
    if (response.status === 404 || response.status === 405) {
      lastFailure = `${url} answered ${response.status}`
      continue
    }
    if (!response.ok) {
      lastFailure = `${url} answered ${response.status}${brief(text).length === 0 ? '' : `: ${brief(text)}`}`
      continue
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`${url} did not answer with JSON`)
    }
    const models = readListing(body)
    if (models.length === 0) {
      lastFailure = `${url} answered without any model entry`
      continue
    }
    const seen = new Set()
    return {
      url,
      models: models.filter((model) => {
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      }),
    }
  }
  throw new Error(`dsh-opencode: the OpenCode model listing failed: ${lastFailure || 'no endpoint answered'}`)
}
