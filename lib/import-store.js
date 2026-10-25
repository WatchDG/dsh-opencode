/**
 * dsh-opencode — turn the dialog's import rows into the stored model catalogue.
 *
 * Pure planning: validate the submitted rows, fill the fields the dialog may
 * omit, and compare against the models already stored so the report can say
 * what changed. The Host applies the result through the settings seam.
 */

import {
  PROTOCOLS,
  baseUrlFor,
  endpointOf,
  normalizeDefaults,
  normalizeModel,
  normalizeModels,
} from './config.js'

/** Comparable fields of one stored model row. */
const FIELDS = ['name', 'api', 'baseURL', 'contextWindow', 'maxTokens', 'input', 'source', 'enabled', 'defaults']

/** Whether two model rows describe the same import target. */
function sameModel(left, right) {
  for (const field of FIELDS) {
    const before = left[field]
    const after = right[field]
    if (Array.isArray(before) || Array.isArray(after)) {
      const a = Array.isArray(before) ? [...before].sort() : []
      const b = Array.isArray(after) ? [...after].sort() : []
      if (a.length !== b.length || a.some((value, index) => value !== b[index])) return false
      continue
    }
    if (
      (before !== null && typeof before === 'object') ||
      (after !== null && typeof after === 'object')
    ) {
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) return false
      continue
    }
    if (before !== after) return false
  }
  return true
}

/**
 * Plan one import.
 *
 * @param {unknown} payload Request body: `{ models: ImportRow[] }`.
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @returns {{
 *   models: Array<ReturnType<typeof normalizeModel>>,
 *   added: number,
 *   updated: number,
 *   removed: number,
 *   skipped: Array<{ id: string, reason: string }>,
 * }}
 */
export function planImport(payload, settings) {
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  const incoming = Array.isArray(source.models) ? source.models : []
  const previous = new Map(settings.models.map((model) => [model.id, model]))
  const skipped = []
  const models = []
  for (const raw of incoming) {
    const model = normalizeModel(raw)
    if (model === undefined) {
      skipped.push({
        id: typeof raw?.id === 'string' ? raw.id : '',
        reason: `invalid row (needs a model id and one of ${PROTOCOLS.join(', ')})`,
      })
      continue
    }
    const target = settings.targets.includes(model.source) ? model.source : settings.targets[0]
    const root = endpointOf(settings, target) ?? ''
    // An import keeps a previously disabled model disabled unless the row states
    // `enabled` explicitly; a newly imported model is enabled.
    const previouslyDisabled = previous.get(model.id)?.enabled === false
    const keepEnabled = typeof raw?.enabled === 'boolean' ? raw.enabled : !previouslyDisabled
    const baseURL = model.baseURL ?? baseUrlFor(root, model.api)
    // The row as it arrives is the catalogue's statement: it becomes the
    // reset-to-defaults snapshot, while the effective fields may later be
    // overridden through the per-model settings endpoint.
    const defaults =
      normalizeDefaults(raw?.defaults) ??
      normalizeDefaults({
        name: model.name,
        api: model.api,
        baseURL,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })
    models.push(
      normalizeModel({
        ...model,
        source: target,
        baseURL,
        enabled: keepEnabled,
        ...(defaults === undefined ? {} : { defaults }),
      }),
    )
  }
  const store = normalizeModels(models)
  const storeIds = new Set(store.map((model) => model.id))
  let added = 0
  let updated = 0
  for (const model of store) {
    const before = previous.get(model.id)
    if (before === undefined) added += 1
    else if (!sameModel(before, model)) updated += 1
  }
  let removed = 0
  for (const id of previous.keys()) if (!storeIds.has(id)) removed += 1
  const enabled = store.filter((model) => model.enabled !== false).length
  return { models: store, added, updated, removed, skipped, enabled }
}
