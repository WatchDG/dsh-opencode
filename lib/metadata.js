/**
 * dsh-opencode — optional models.dev metadata for model ids the shipped pi-ai
 * catalogue does not describe.
 *
 * The gateway listing answers *which* ids exist; for an id newer than the
 * installed catalogue, models.dev supplies the wire protocol family and
 * capacity hints the import dialog prefills. A failed or slow download never
 * fails the import: such models simply arrive unresolved and the user picks an
 * interface in the dialog.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Successful catalogue downloads, keyed by URL, kept as a stale fallback. */
const catalogueCache = new Map()

/** How long one downloaded catalogue stays fresh, in milliseconds. */
const CATALOGUE_TTL_MS = 10 * 60 * 1000

/** The public catalogue is ~6 MB; refuse anything far beyond that. */
const CATALOGUE_MAX_BYTES = 32 * 1024 * 1024

/** Positive integer or undefined. */
function capacity(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(number) && number > 0 ? number : undefined
}

/**
 * Classify one models.dev model entry to a supported wire protocol.
 *
 * @param {{ provider?: { npm?: string, api?: string } } | undefined} entry
 * @returns {string | undefined} one of the supported protocols, or a protocol
 *   the plugin cannot serve (reported as unresolved).
 */
export function classifyProtocol(entry) {
  const npm = String(entry?.provider?.npm ?? '')
  const api = String(entry?.provider?.api ?? '')
  if (npm === '@ai-sdk/anthropic' || /\/anthropic\//.test(api)) return 'anthropic-messages'
  if (npm.startsWith('@ai-sdk/google') || /\/google\//.test(api)) return 'google-generative-ai'
  if (npm === '@ai-sdk/openai') return 'openai-responses'
  return 'openai-completions'
}

/**
 * Read one models.dev entry into the metadata shape the import consumes.
 *
 * @param {unknown} raw
 * @param {string} fallbackId
 * @returns {{ id: string, name?: string, contextWindow?: number, maxTokens?: number, input: string[], protocol: string } | undefined}
 */
export function readMetadataModel(raw, fallbackId) {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = /** @type {Record<string, any>} */ (raw)
  const id =
    typeof entry.id === 'string' && entry.id.length > 0
      ? entry.id
      : typeof fallbackId === 'string' && fallbackId.length > 0
        ? fallbackId
        : undefined
  if (id === undefined) return undefined
  const contextWindow = capacity(entry.limit?.context)
  const maxTokens = capacity(entry.limit?.output)
  const modalities = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((value) => value === 'text' || value === 'image')
    : []
  return {
    id,
    ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    input: modalities.includes('image') ? ['text', 'image'] : ['text'],
    protocol: classifyProtocol(entry),
  }
}

/**
 * Project one provider out of a models.dev catalogue.
 *
 * @param {unknown} body
 * @param {string} provider
 * @returns {{ displayName?: string, models: Map<string, ReturnType<typeof readMetadataModel>> }}
 */
export function readProviderMetadata(body, provider) {
  const empty = { models: new Map() }
  if (body === null || typeof body !== 'object') return empty
  const entry = /** @type {Record<string, any>} */ (body)[provider]
  if (entry === null || typeof entry !== 'object') return empty
  const models = new Map()
  if (entry.models !== null && typeof entry.models === 'object') {
    for (const [key, value] of Object.entries(entry.models)) {
      const model = readMetadataModel(value, key)
      if (model !== undefined) models.set(model.id, model)
    }
  }
  return {
    ...(typeof entry.name === 'string' && entry.name.length > 0 ? { displayName: entry.name } : {}),
    models,
  }
}

/**
 * Download the public catalogue. Returns a previously downloaded body when the
 * network fails, and undefined when nothing was ever downloaded.
 *
 * @param {{ url: string, timeoutMs: number, fetchImpl?: typeof fetch, signal?: AbortSignal }} input
 * @returns {Promise<unknown | undefined>}
 */
export async function fetchCatalogue(input) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function' || input.url.length === 0) return undefined
  const cached = catalogueCache.get(input.url)
  if (cached !== undefined && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.body
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), input.timeoutMs)
  const signal =
    input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal])
  try {
    const response = await fetchImpl(input.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    })
    if (!response.ok) return cached?.body
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > CATALOGUE_MAX_BYTES) return cached?.body
    const text = await response.text()
    if (text.length > CATALOGUE_MAX_BYTES) return cached?.body
    const body = JSON.parse(text)
    catalogueCache.set(input.url, { at: Date.now(), body })
    return body
  } catch (error) {
    if (input.signal?.aborted) throw new Error('dsh-opencode: the request was cancelled')
    return cached?.body
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Serializable projection of the providers one import reads.
 *
 * @param {unknown} body
 * @param {string[]} providers
 * @returns {Record<string, Array<{ id: string, name?: string, contextWindow?: number, maxTokens?: number, input: string[], protocol: string }>>}
 */
export function readCatalogueSlice(body, providers) {
  const slice = {}
  for (const provider of providers) {
    const entry = readProviderMetadata(body, provider)
    if (entry.models.size === 0) continue
    slice[provider] = [...entry.models.values()]
  }
  return slice
}

/**
 * Read the metadata cache from disk.
 *
 * @param {string} path
 * @returns {Record<string, Array<any>>}
 */
export function readSliceCache(path) {
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    const providers = cached?.providers
    if (providers === null || typeof providers !== 'object') return {}
    const slice = {}
    for (const [provider, models] of Object.entries(providers)) {
      if (!Array.isArray(models)) continue
      slice[provider] = models.filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string')
    }
    return slice
  } catch {
    return {}
  }
}

/**
 * Persist the metadata cache; best effort.
 *
 * @param {string} path
 * @param {Record<string, Array<any>>} slice
 * @returns {boolean}
 */
export function writeSliceCache(path, slice) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 2, fetchedAt: new Date().toISOString(), providers: slice }))
    return true
  } catch {
    return false
  }
}
