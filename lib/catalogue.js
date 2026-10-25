/**
 * dsh-opencode — build the import catalogue from the live gateways.
 *
 * Read-only planning: fetch each configured gateway's model listing, then
 * resolve every id to what the plugin already knows about it:
 *
 * 1. the shipped pi-ai catalogue (authoritative protocol, name, capacities);
 * 2. models.dev metadata for ids newer than the installed release;
 * 3. a small fallback table for gateway models that no public catalogue lists
 *    (see UNLISTED_MODELS);
 * 4. nothing — the row arrives unresolved and the import dialog asks the user
 *    to pick an interface before importing it.
 *
 * The result is one flat model list (duplicate ids across gateways keep the
 * first target's row), which is exactly what the single plugin provider will
 * hold after the import.
 */

import { PROTOCOLS, PRESETS, apiKeyEnvFor, baseUrlFor, endpointOf, positiveInteger } from './config.js'
import { fetchLiveModels } from './zen.js'
import { shippedModel } from './adapter.js'

/** Protocols the plugin provider cannot serve through pi-ai's OpenCode provider. */
const UNSERVABLE_PROTOCOL = 'google-generative-ai'

/**
 * Models the OpenCode Go gateway advertises but no public catalogue describes.
 *
 * These two are unlisted gateway models: `qwen3.7-max` is a legacy Qwen family
 * model served natively over Anthropic Messages (`/go/v1/messages` answers 200
 * and returns Anthropic thinking blocks; the OpenAI-compatible surface also
 * answers, but OpenCode's own docs route the Qwen family through
 * `@ai-sdk/anthropic`), and `omen-alpha` is a stealth model available only on
 * the OpenAI Chat Completions surface (Responses 503, Messages 400). Capacities
 * come from OpenCode's published Go pricing/endpoint documentation and the
 * community Go catalogue (terva `catalog_builtin.go`): qwen3.7-max 1M context /
 * 64k output, omen-alpha 500k context / 128k output. They are a prefill, not a
 * bound — the per-model gear editor overrides them and re-import refreshes them.
 */
export const UNLISTED_MODELS = {
  'qwen3.7-max': {
    name: 'Qwen3.7 Max',
    api: 'anthropic-messages',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  'omen-alpha': {
    name: 'Omen Alpha',
    api: 'openai-completions',
    contextWindow: 500_000,
    maxTokens: 128_000,
  },
}

/** Ids the gateways advertise that are not chat models. */
const INTERNAL_ID = /^(?:test|jev-)/

/** Ids a gateway advertises as routing backups, not models. */
const BACKUP_ID = /-backup$/

/**
 * Whether a live id may become an imported chat model.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isChatModelId(id) {
  if (typeof id !== 'string' || id.length === 0) return false
  if (/\s|\//.test(id)) return false
  if (INTERNAL_ID.test(id) || BACKUP_ID.test(id)) return false
  return true
}

/** Case-insensitive "does any needle occur in the id". */
function excluded(id, needles) {
  const lowered = id.toLowerCase()
  return needles.some((needle) => lowered.includes(needle))
}

/** Protocol family guessed from a model id, as a dialog suggestion only. */
export function suggestedProtocol(id) {
  const lowered = String(id).toLowerCase()
  if (lowered.startsWith('claude-')) return 'anthropic-messages'
  if (/^(gpt-|grok-|muse-|codex)/.test(lowered)) return 'openai-responses'
  return 'openai-completions'
}

/** Picker label of one protocol. */
export function protocolLabel(api) {
  return PRESETS.find((preset) => preset.api === api)?.label ?? api
}

/**
 * Build the catalogue the import dialog shows.
 *
 * @param {{
 *   settings: ReturnType<import('./config.js').normalizeConfig>,
 *   resolveApiKey: (ref: string) => Promise<string | undefined>,
 *   metadata: Record<string, Array<any>>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   onWarn?: (message: string) => void,
 * }} input
 * @returns {Promise<{ rows: any[], failures: Array<{ target: string, error: string }>, warnings: string[] }>}
 */
export async function buildCatalogue(input) {
  const { settings } = input
  const warnings = []
  const warn = (message) => {
    warnings.push(message)
    input.onWarn?.(message)
  }
  const rows = []
  const seen = new Set()
  const failures = []
  let unservable = 0

  for (const target of settings.targets) {
    const root = endpointOf(settings, target)
    if (root === undefined) {
      failures.push({ target, error: `no endpoint is configured for "${target}"` })
      continue
    }
    try {
      const apiKey = await input.resolveApiKey(apiKeyEnvFor(settings, target))
      const live = await fetchLiveModels({
        root,
        apiKey,
        sessionHeader: settings.sessionHeader,
        sessionId: settings.sessionId,
        timeoutMs: settings.timeoutMs,
        fetchImpl: input.fetchImpl,
        signal: input.signal,
      })
      const metadata = new Map(
        (input.metadata?.[target] ?? []).map((model) => [model.id, model]),
      )
      for (const model of live.models) {
        if (typeof model?.id !== 'string' || seen.has(model.id)) continue
        if (!isChatModelId(model.id)) continue
        if (excluded(model.id, settings.exclude)) continue
        if (!settings.includeFree && model.id.toLowerCase().includes('-free')) continue
        seen.add(model.id)
        const row = resolveRow(model, target, root, metadata)
        if (row.unsupported === UNSERVABLE_PROTOCOL) {
          unservable += 1
          continue
        }
        delete row.unsupported
        rows.push(row)
      }
    } catch (error) {
      failures.push({ target, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (rows.length === 0 && failures.length > 0) {
    throw new Error(failures.map((failure) => `${failure.target}: ${failure.error}`).join('; '))
  }
  for (const failure of failures) warn(`${failure.target}: ${failure.error}`)
  if (unservable > 0) {
    warn(`${unservable} model(s) use a protocol this provider cannot serve (Google Generative AI) and were omitted`)
  }

  const unresolved = rows.filter((row) => !row.resolved).length
  if (unresolved > 0) warn(`${unresolved} model(s) need an interface choice before import`)

  return {
    rows,
    failures,
    warnings,
    resolved: rows.length - unresolved,
    unknown: rows.filter((row) => !row.resolved).map((row) => row.id),
  }
}

/**
 * Resolve one advertised id to the dialog row.
 *
 * @param {{ id: string, name?: string, contextWindow?: number, maxTokens?: number }} live
 * @param {string} target Gateway route name.
 * @param {string} root Gateway root.
 * @param {Map<string, any>} metadata models.dev rows for this gateway.
 * @returns {Record<string, any>}
 */
function resolveRow(live, target, root, metadata) {
  const known = shippedModel(target, live.id) ?? shippedModel(target === 'opencode' ? 'opencode-go' : 'opencode', live.id)
  const meta = metadata.get(live.id)
  // A model whose authority says Google Generative AI can never be served by
  // the three protocols a configured pi-ai route supports, so it is omitted
  // instead of being offered with a deliberately wrong choice.
  if (known?.api === UNSERVABLE_PROTOCOL || meta?.protocol === UNSERVABLE_PROTOCOL) {
    return { id: live.id, unsupported: UNSERVABLE_PROTOCOL }
  }
  const metaProtocol = meta !== undefined && PROTOCOLS.includes(meta.protocol) ? meta.protocol : undefined
  const fallback = UNLISTED_MODELS[live.id]
  const fallbackProtocol = fallback !== undefined && PROTOCOLS.includes(fallback.api) ? fallback.api : undefined
  const api = known !== undefined && PROTOCOLS.includes(known.api) ? known.api : (metaProtocol ?? fallbackProtocol)
  const inputModalities = (known?.input ?? meta?.input ?? ['text']).filter(
    (value) => value === 'text' || value === 'image',
  )
  const contextWindow =
    positiveInteger(known?.contextWindow) ??
    positiveInteger(meta?.contextWindow) ??
    positiveInteger(fallback?.contextWindow) ??
    positiveInteger(live.contextWindow)
  const maxTokens =
    positiveInteger(known?.maxTokens) ??
    positiveInteger(meta?.maxTokens) ??
    positiveInteger(fallback?.maxTokens) ??
    positiveInteger(live.maxTokens)
  const baseURL = api === undefined ? undefined : (known?.baseUrl ?? baseUrlFor(root, api))
  return {
    id: live.id,
    name: known?.name ?? meta?.name ?? fallback?.name ?? live.name ?? live.id,
    api: api ?? null,
    apiLabel: api === undefined ? null : protocolLabel(api),
    baseURL: baseURL ?? null,
    contextWindow: contextWindow ?? null,
    maxTokens: maxTokens ?? null,
    input: inputModalities.length === 0 ? ['text'] : inputModalities,
    source: target,
    resolved: api !== undefined,
    suggestedApi: api === undefined ? suggestedProtocol(live.id) : null,
  }
}
