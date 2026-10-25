/**
 * dsh-opencode — plugin mounting: the own provider route and its HTTP surface.
 *
 * The plugin contributes three things:
 *
 * 1. **One LLM provider route** (`config.provider`, display name from
 *    `config.displayName`) served by `lib/adapter.js`. It is registered once
 *    here; the adapter reads the live `models` config on every call, so an
 *    import applies without a reload.
 * 2. **The import endpoints** the Models-card dialog calls —
 *    `GET /opencode/catalogue` (live gateways → rows with prefilled
 *    interface/capacity, unresolved rows left for the user) and
 *    `POST /opencode/import` (validate, store through the settings seam,
 *    optionally retire the shipped per-protocol routes).
 * 3. **`GET /opencode/status`** for the last import and the live registration
 *    state.
 *
 * The static `x-opencode-session` header lives on the adapter request path (see
 * lib/adapter.js): OpenCode Go rejects inference without it (400
 * MissingSessionID), including calls the harness makes without a session id.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createAdapter } from './adapter.js'
import { buildCatalogue } from './catalogue.js'
import {
  LEGACY_ROUTE,
  PRESETS,
  snapshot,
} from './config.js'
import { planImport } from './import-store.js'
import { planModelSettings, statusModel } from './model-settings.js'
import {
  fetchCatalogue,
  readCatalogueSlice,
  readSliceCache,
  writeSliceCache,
} from './metadata.js'

/** Authenticated route the import dialog reads the live catalogue from. */
export const CATALOGUE_PATH = '/opencode/catalogue'

/** Authenticated route the import dialog posts the selected models to. */
export const IMPORT_PATH = '/opencode/import'

/** Authenticated route the card toggles enabled models through. */
export const ENABLED_PATH = '/opencode/enabled'

/** Authenticated route the card edits one model's settings through. */
export const MODEL_PATH = '/opencode/model'

/** Authenticated route the card reads the last import from. */
export const STATUS_PATH = '/opencode/status'

/** Package name of the shipped pi-ai adapter whose routes may be retired. */
export const PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'

/** This plugin's package name, used to locate its own config row. */
export const PACKAGE = 'dsh-opencode'

/** Largest accepted import body. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** How long a built catalogue is reused without another gateway fetch. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000

/** Shared gate: browser-trust rejection, then method. */
function gate(child, req, res, methods) {
  const rejection = child.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return true
  }
  if (!methods.includes(req.method)) {
    res.statusCode = 405
    res.setHeader('allow', methods.join(', '))
    res.end()
    return true
  }
  return false
}

/** Send a JSON payload with no-store caching. */
function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Read a bounded JSON request body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`the import body exceeds ${MAX_BODY_BYTES} bytes`)
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('the import body is not valid JSON')
    error.code = 'INVALID_BODY'
    throw error
  }
}

/** Locate one plugin config row by package name. */
function entryOf(child, name) {
  const editor = child.get('configEditor')
  if (editor === undefined) return undefined
  return editor.entries().find((row) => row.options?.name === name)
}

/** Providers of the shipped pi-ai row, or an empty object. */
function piAiProviders(child, settingsService, llmPiAiId) {
  const descriptor = settingsService.describe().find((row) => row.ns === llmPiAiId)
  const providers = descriptor?.value?.providers
  return providers !== null && typeof providers === 'object' ? providers : {}
}

/**
 * Resolve a credential reference through the credential seam, then the process
 * environment.
 *
 * @param {object} child Plugin context.
 * @param {string} ref
 * @returns {Promise<string | undefined>}
 */
export async function resolveApiKey(child, ref) {
  const credentials = child.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // fall through to the process environment
    }
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

/**
 * Cache file for the reduced models.dev projection.
 *
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @returns {string}
 */
export function cacheFilePath(settings) {
  if (settings.cacheDir.length > 0) return join(settings.cacheDir, 'catalogue-cache.json')
  const profileDir =
    process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  return join(profileDir, '.dsh-opencode', 'catalogue-cache.json')
}

/**
 * Build the catalogue rows, reusing the models.dev projection on disk.
 *
 * @param {object} child Plugin context.
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, onWarn?: (message: string) => void }} [io]
 */
export async function catalogueFor(child, settings, io = {}) {
  const cachePath = cacheFilePath(settings)
  const body = await fetchCatalogue({
    url: settings.catalogueUrl,
    timeoutMs: settings.catalogueTimeoutMs,
    fetchImpl: io.fetchImpl,
    signal: io.signal,
  })
  let slice = body === undefined ? {} : readCatalogueSlice(body, settings.targets)
  if (body === undefined || Object.keys(slice).length === 0) {
    slice = readSliceCache(cachePath)
    if (Object.keys(slice).length === 0) {
      io.onWarn?.('the model metadata catalogue is unavailable; unknown ids will require an interface choice')
    }
  } else if (!writeSliceCache(cachePath, slice)) {
    io.onWarn?.(`could not persist the metadata catalogue cache at ${cachePath}`)
  }
  return buildCatalogue({
    settings,
    metadata: slice,
    resolveApiKey: (ref) => resolveApiKey(child, ref),
    fetchImpl: io.fetchImpl,
    signal: io.signal,
    onWarn: io.onWarn,
  })
}

/**
 * Apply one import: store the models on the plugin row, then retire the shipped
 * per-protocol provider routes when configured.
 *
 * @param {object} child Plugin context.
 * @param {() => ReturnType<import('./config.js').normalizeConfig>} readSettings
 * @param {unknown} payload Request body.
 * @returns {Promise<Record<string, any>>}
 */
export async function performImport(child, readSettings, payload) {
  const settings = readSettings()
  const settingsService = child.get('settings')
  if (settingsService === undefined) throw new Error('dsh-opencode: the settings service is not available')
  const ownEntry = entryOf(child, PACKAGE)
  if (ownEntry === undefined) throw new Error(`dsh-opencode: no "${PACKAGE}" row is loaded`)
  const plan = planImport(payload, settings)
  if (plan.models.length === 0) {
    const error = new Error(
      plan.skipped.length > 0
        ? `no model could be imported: ${plan.skipped[0].reason}`
        : 'no models were selected for import',
    )
    error.code = 'INVALID_IMPORT'
    throw error
  }

  await settingsService.mutate(ownEntry.options.id, [
    { op: 'set', path: ['models'], value: plan.models },
  ])

  const retired = []
  if (settings.retireShipped) {
    const piAi = entryOf(child, PI_AI_PACKAGE)
    if (piAi !== undefined) {
      const providers = piAiProviders(child, settingsService, piAi.options.id)
      const ops = []
      for (const name of Object.keys(providers)) {
        const isShippedTarget = settings.targets.includes(name)
        const isLegacyMirror = LEGACY_ROUTE.test(name)
        if (!isShippedTarget && !isLegacyMirror) continue
        ops.push({ op: 'unset', path: ['providers', name] })
        retired.push(name)
      }
      if (ops.length > 0) await settingsService.mutate(piAi.options.id, ops)
    }
  }

  const llm = child.get('llm')
  const registered =
    llm === undefined ? [] : llm.listProviders().map((provider) => provider.id).filter((id) => id === settings.provider)
  const report = {
    ok: true,
    provider: settings.provider,
    displayName: settings.displayName,
    imported: plan.added,
    updated: plan.updated,
    removed: plan.removed,
    total: plan.models.length,
    enabled: plan.enabled,
    skipped: plan.skipped,
    retired,
    registered: registered.length > 0,
    models: plan.models.map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      source: model.source,
      enabled: model.enabled !== false,
    })),
    importedAt: new Date().toISOString(),
  }
  return report
}

/**
 * Enable exactly the submitted model ids; every other imported model becomes
 * disabled. Disabled models stay in the store and can be re-enabled later, but
 * the provider does not offer them to the picker.
 *
 * @param {object} child Plugin context.
 * @param {() => ReturnType<import('./config.js').normalizeConfig>} readSettings
 * @param {unknown} payload Request body `{ enabled: string[] }`.
 * @returns {Promise<Record<string, any>>}
 */
export async function performEnablement(child, readSettings, payload) {
  const settings = readSettings()
  const settingsService = child.get('settings')
  if (settingsService === undefined) throw new Error('dsh-opencode: the settings service is not available')
  const ownEntry = entryOf(child, PACKAGE)
  if (ownEntry === undefined) throw new Error(`dsh-opencode: no "${PACKAGE}" row is loaded`)
  if (settings.models.length === 0) {
    const error = new Error('no models are imported yet; import a catalogue first')
    error.code = 'INVALID_ENABLEMENT'
    throw error
  }
  const source = payload !== null && typeof payload === 'object' ? payload : {}
  if (!Array.isArray(source.enabled)) {
    const error = new Error('the request body must name the enabled model ids: { enabled: string[] }')
    error.code = 'INVALID_ENABLEMENT'
    throw error
  }
  const enabledIds = new Set(source.enabled.filter((id) => typeof id === 'string'))
  const unknown = [...enabledIds].filter((id) => !settings.models.some((model) => model.id === id))
  if (unknown.length > 0) {
    const error = new Error(`unknown model id(s): ${unknown.slice(0, 5).join(', ')}`)
    error.code = 'INVALID_ENABLEMENT'
    throw error
  }
  const models = settings.models.map((model) => ({ ...model, enabled: enabledIds.has(model.id) }))
  await settingsService.mutate(ownEntry.options.id, [{ op: 'set', path: ['models'], value: models }])
  return {
    ok: true,
    enabled: models.filter((model) => model.enabled).length,
    disabled: models.filter((model) => !model.enabled).length,
    total: models.length,
  }
}

/**
 * Apply one per-model settings edit (override or reset to catalogue defaults).
 *
 * @param {object} child Plugin context.
 * @param {() => ReturnType<import('./config.js').normalizeConfig>} readSettings
 * @param {unknown} payload Request body.
 * @returns {Promise<Record<string, any>>}
 */
export async function performModelSettings(child, readSettings, payload) {
  const settings = readSettings()
  const settingsService = child.get('settings')
  if (settingsService === undefined) throw new Error('dsh-opencode: the settings service is not available')
  const ownEntry = entryOf(child, PACKAGE)
  if (ownEntry === undefined) throw new Error(`dsh-opencode: no "${PACKAGE}" row is loaded`)
  const plan = planModelSettings(settings, payload)
  await settingsService.mutate(ownEntry.options.id, [{ op: 'set', path: ['models'], value: plan.models }])
  return { ok: true, model: plan.model }
}

/**
 * Mount the provider route and the import endpoints.
 *
 * @param {object} ctx Plugin context supplied by the DSH loader.
 * @param {unknown} rawConfig Bundle row config.
 */
export function mount(ctx, rawConfig) {
  const readSettings = () => snapshot(rawConfig)

  const adapter = createAdapter({
    getSettings: readSettings,
    // A profile may store the key under either OpenCode reference; try the
    // model's own gateway reference first, then every configured one.
    resolveApiKey: async (ref) => {
      const direct = await resolveApiKey(ctx, ref)
      if (direct !== undefined) return direct
      const settings = readSettings()
      const alternatives = [settings.apiKeyEnv, ...Object.values(settings.targetApiKeyEnv)]
      for (const alternative of alternatives) {
        if (alternative === ref) continue
        const value = await resolveApiKey(ctx, alternative)
        if (value !== undefined) return value
      }
      return undefined
    },
  })

  /** Last successful import, served to a freshly opened page. */
  let last = null
  /** Cached catalogue, keyed by the fetch-relevant configuration. */
  let cached = null

  const catalogueCacheKey = () => {
    const settings = readSettings()
    return JSON.stringify({
      targets: settings.targets,
      includeFree: settings.includeFree,
      exclude: settings.exclude,
      endpoints: settings.endpoints,
      apiKeyEnv: settings.apiKeyEnv,
      targetApiKeyEnv: settings.targetApiKeyEnv,
      catalogueUrl: settings.catalogueUrl,
    })
  }

  const loadCatalogue = async (refresh) => {
    const key = catalogueCacheKey()
    if (!refresh && cached !== null && cached.key === key && Date.now() - cached.at < CATALOGUE_TTL_MS) {
      return cached.value
    }
    const settings = readSettings()
    const warnings = []
    const value = await catalogueFor(ctx, settings, { onWarn: (message) => warnings.push(message) })
    const body = {
      ok: true,
      provider: settings.provider,
      displayName: settings.displayName,
      fetched: value.rows.length,
      resolved: value.resolved,
      models: value.rows,
      unknown: value.unknown,
      presets: value.presets ?? PRESETS,
      warnings: [...new Set([...value.warnings, ...warnings])],
    }
    cached = { key, at: Date.now(), value: body }
    return body
  }

  // Required services: the LLM registry for the provider route, then the HTTP
  // surface. The adapter itself reaches credentials/settings lazily per call.
  ctx.inject(['llm'], (child) => {
    const providerId = readSettings().provider
    child.effect(() => {
      try {
        const handle = child.llm.registerAdapter([providerId], adapter)
        return () => handle()
      } catch (error) {
        child.logger?.error?.(
          `dsh-opencode: cannot register provider route "${providerId}" (${error instanceof Error ? error.message : String(error)}); set config.provider to a free route id`,
        )
        return () => {}
      }
    }, 'dsh-opencode: provider route')

    // Declare the route in the configurable-provider directory so the Models
    // page renders its card (the seat the import wizard lives in).
    child.effect(() => {
      const ownEntry = entryOf(ctx, PACKAGE)
      if (ownEntry === undefined) return () => {}
      const settings = readSettings()
      try {
        const directory = child.llm.registerConfigurableProviders([
          {
            provider: providerId,
            displayName: settings.displayName,
            settingsNs: ownEntry.options.id,
            settingsPath: ['models'],
            declared: true,
            ...(settings.endpoints[settings.targets[0]] === undefined
              ? {}
              : { defaultBaseURL: settings.endpoints[settings.targets[0]] }),
          },
        ])
        return () => directory()
      } catch (error) {
        child.logger?.error?.(
          `dsh-opencode: cannot declare provider "${providerId}" in the Models directory (${error instanceof Error ? error.message : String(error)})`,
        )
        return () => {}
      }
    }, 'dsh-opencode: configurable provider')
  })

  ctx.inject(['webServer', 'connection'], (child) => {
    const routes = [
      {
        path: CATALOGUE_PATH,
        methods: ['GET'],
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.invalid')
            const refresh = url.searchParams.get('refresh') === '1'
            json(res, 200, await loadCatalogue(refresh))
          } catch (error) {
            json(res, 502, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      },
      {
        path: IMPORT_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          try {
            const payload = await readJson(req)
            const report = await performImport(ctx, readSettings, payload)
            last = report
            cached = null
            json(res, 200, report)
          } catch (error) {
            const code = error?.code === 'BODY_TOO_LARGE' || error?.code === 'INVALID_BODY' || error?.code === 'INVALID_IMPORT' ? 400 : 500
            json(res, code, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(error?.code === undefined ? {} : { code: error.code }),
            })
          }
        },
      },
      {
        path: ENABLED_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          try {
            const payload = await readJson(req)
            json(res, 200, await performEnablement(ctx, readSettings, payload))
          } catch (error) {
            const code =
              error?.code === 'BODY_TOO_LARGE' || error?.code === 'INVALID_BODY' || error?.code === 'INVALID_ENABLEMENT'
                ? 400
                : 500
            json(res, code, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(error?.code === undefined ? {} : { code: error.code }),
            })
          }
        },
      },
      {
        path: MODEL_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          try {
            const payload = await readJson(req)
            json(res, 200, await performModelSettings(ctx, readSettings, payload))
          } catch (error) {
            const code =
              error?.code === 'BODY_TOO_LARGE' || error?.code === 'INVALID_BODY' || error?.code === 'INVALID_MODEL_SETTINGS'
                ? 400
                : 500
            json(res, code, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              ...(error?.code === undefined ? {} : { code: error.code }),
            })
          }
        },
      },
      {
        path: STATUS_PATH,
        methods: ['GET'],
        handler: async (req, res) => {
          try {
            const settings = readSettings()
            const llm = child.get('llm')
            const registeredAll = llm === undefined ? [] : llm.listProviders().map((provider) => provider.id)
            const enabledModels = settings.models.filter((model) => model.enabled !== false)
            let sample = null
            if (llm !== undefined && enabledModels.length > 0) {
              try {
                const info = await llm.resolveModelInfo(settings.provider, enabledModels[0].id)
                sample = {
                  id: info.id,
                  name: info.name,
                  contextWindow: info.context?.contextWindow,
                  reasoningEfforts: info.reasoning?.efforts?.length ?? 0,
                }
              } catch (error) {
                sample = { error: error instanceof Error ? error.message : String(error) }
              }
            }
            json(res, 200, {
              ok: true,
              provider: settings.provider,
              displayName: settings.displayName,
              stored: settings.models.length,
              enabledCount: enabledModels.length,
              models: settings.models.map(statusModel),
              registered: registeredAll.includes(settings.provider),
              registeredAll,
              // Retired upstream routes: the page offers dormant catalog providers
              // in its add-provider list regardless of other adapters, so the card
              // uses these ids to filter that list.
              retireShipped: settings.retireShipped,
              targets: [...settings.targets],
              sample,
              last,
            })
          } catch (error) {
            json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      },
    ]
    for (const route of routes) {
      child.effect(
        () =>
          child.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (req, res) => {
              if (gate(child, req, res, route.methods)) return
              await route.handler(req, res)
            },
          }),
        `dsh-opencode: ${route.methods.join('/')} ${route.path}`,
      )
    }
  })
}
