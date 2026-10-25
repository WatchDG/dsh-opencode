/**
 * dsh-opencode — per-model settings.
 *
 * Imported rows keep the catalogue's statement in `defaults` and the values the
 * provider actually serves in the row's own fields. This module applies a
 * per-model override (context window, output cap, wire interface) and can reset
 * one field — or the whole row — back to the captured defaults.
 */

import {
  PROTOCOLS,
  baseUrlFor,
  endpointOf,
  normalizeModel,
  positiveInteger,
} from './config.js'

/** A settings failure the HTTP layer answers with 400. */
function invalid(message) {
  const error = new Error(message)
  error.code = 'INVALID_MODEL_SETTINGS'
  return error
}

/**
 * Status/detail projection of one stored model (what the card renders).
 *
 * @param {ReturnType<typeof normalizeModel>} model
 * @returns {Record<string, any>}
 */
export function statusModel(model) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    source: model.source ?? null,
    enabled: model.enabled !== false,
    contextWindow: positiveInteger(model.contextWindow) ?? null,
    maxTokens: positiveInteger(model.maxTokens) ?? null,
    defaults:
      model.defaults === undefined
        ? null
        : {
            contextWindow: positiveInteger(model.defaults.contextWindow) ?? null,
            maxTokens: positiveInteger(model.defaults.maxTokens) ?? null,
            api: PROTOCOLS.includes(model.defaults.api) ? model.defaults.api : null,
          },
  }
}

/** Recompute the endpoint of a row whose interface changed. */
function endpointFor(settings, model, api) {
  const root = endpointOf(settings, model.source ?? settings.targets[0]) ?? ''
  return baseUrlFor(root, api)
}

/**
 * Apply one per-model edit.
 *
 * Payload forms:
 *  - `{ id, reset: true }` — restore every overridable field from `defaults`;
 *  - `{ id, contextWindow?, maxTokens?, api? }` — set overrides; `null` resets
 *    that single field to its default; omitted fields stay untouched.
 *
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @param {unknown} payload
 * @returns {{ models: Array<ReturnType<typeof normalizeModel>>, model: Record<string, any> }}
 */
export function planModelSettings(settings, payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (id.length === 0) throw invalid('the request must name a model id')
  const current = settings.models.find((model) => model.id === id)
  if (current === undefined) throw invalid(`no imported model "${id}"`)
  const defaults = current.defaults
  const next = { ...current }

  /** Restore one override field from its catalogue default. */
  const resetField = (field) => {
    if (defaults !== undefined && defaults[field] !== undefined) next[field] = defaults[field]
    else delete next[field]
  }

  if (body.reset === true) {
    if (defaults === undefined) {
      throw invalid(`catalogue defaults for "${id}" are unknown; re-import the catalogue to capture them`)
    }
    if (defaults.api !== undefined) {
      next.api = defaults.api
      next.baseURL = defaults.baseURL ?? endpointFor(settings, current, defaults.api)
    }
    if (defaults.name !== undefined) next.name = defaults.name
    if (defaults.contextWindow !== undefined) next.contextWindow = defaults.contextWindow
    else delete next.contextWindow
    if (defaults.maxTokens !== undefined) next.maxTokens = defaults.maxTokens
    else delete next.maxTokens
  } else {
    let touched = false
    if ('contextWindow' in body) {
      touched = true
      if (body.contextWindow === null) resetField('contextWindow')
      else {
        const value = positiveInteger(body.contextWindow)
        if (value === undefined) throw invalid('contextWindow must be a positive integer or null')
        next.contextWindow = value
      }
    }
    if ('maxTokens' in body) {
      touched = true
      if (body.maxTokens === null) resetField('maxTokens')
      else {
        const value = positiveInteger(body.maxTokens)
        if (value === undefined) throw invalid('maxTokens must be a positive integer or null')
        next.maxTokens = value
      }
    }
    if ('api' in body) {
      touched = true
      if (body.api === null) {
        if (defaults?.api !== undefined) {
          next.api = defaults.api
          next.baseURL = defaults.baseURL ?? endpointFor(settings, current, defaults.api)
        } else {
          throw invalid(`the interface of "${id}" has no captured default; pick one explicitly`)
        }
      } else {
        if (!PROTOCOLS.includes(body.api)) throw invalid(`unknown interface "${String(body.api)}"`)
        if (body.api !== next.api) {
          next.api = body.api
          next.baseURL = endpointFor(settings, current, body.api)
        }
      }
    }
    if (!touched) throw invalid('the request names no setting to change')
  }

  const normalized = normalizeModel(next)
  if (normalized === undefined) throw invalid(`the settings for "${id}" do not form a valid model row`)
  return {
    models: settings.models.map((model) => (model.id === id ? normalized : model)),
    model: statusModel(normalized),
  }
}
