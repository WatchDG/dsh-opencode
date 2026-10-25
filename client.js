/**
 * dsh-opencode — browser half (Client plugin).
 *
 * Destination: Settings -> Models -> the plugin's own OpenCode provider card.
 * Seat: `settings.models.provider-card`, a keyed slot the shipped Models page
 * dispatches with the provider's settings namespace as the key. The plugin
 * declares its provider in the configurable-provider directory with
 * `settingsNs = include:opencode`, so that card exists; the pi-ai namespace
 * keys are kept so the wizard also shows on a catalog OpenCode card.
 *
 * The card is an import wizard plus an enabled/disabled curator: the Host owns
 * ONE provider route (`opencode-live`, display name "OpenCode") holding every
 * imported model, so the browser reads the live catalogue, lets the user choose
 * models and an interface for the ones whose wire protocol is unknown, posts the
 * selection, then curates which stored models the model picker shows.
 *
 * Host contract (lib/plugin.js):
 *   GET  /opencode/catalogue -> { ok, fetched, models, unknown, presets }
 *     model  = { id, name, api|null, apiLabel|null, baseURL|null,
 *                contextWindow|null, maxTokens|null, input, source, resolved }
 *     preset = { api, label, baseURL }
 *   POST /opencode/import    body { models: [{ id, name, api, baseURL?,
 *                              contextWindow?, maxTokens?, input?, source? }] }
 *                            -> { ok, imported, enabled, updated, removed, retired, models }
 *   POST /opencode/enabled   body { enabled: string[] } -> { ok, enabled, disabled, total }
 *   POST /opencode/model     body { id, reset: true } | { id, contextWindow?, maxTokens?, api? }
 *                            -> { ok, model: <row in status.models shape> }
 *   GET  /opencode/status    -> { stored, enabledCount, models: [{ id, name, api, source, enabled,
 *                                 contextWindow, maxTokens, defaults }], registered, registeredAll,
 *                                 last, sample }
 *
 * Same-origin, cookie-authenticated routes (the Host gate rejects unknown
 * browsers); no token header. Both POSTs carry a JSON body, so they also send
 * `content-type: application/json` — no other headers.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'settings.opencode'
    /** Cards that belong to OpenCode (pi-ai `opencode`/`opencode-go`; the own
     * `opencode-live` route is tolerated when dispatched through the same seat). */
    const PROVIDERS = ['opencode', 'opencode-go', 'opencode-live']
    /** Authenticated Host routes (lib/plugin.js). */
    const CATALOGUE_PATH = '/opencode/catalogue'
    const IMPORT_PATH = '/opencode/import'
    const ENABLED_PATH = '/opencode/enabled'
    const MODEL_PATH = '/opencode/model'
    const STATUS_PATH = '/opencode/status'
    /** Keyed-seat dispatch keys: this plugin's own Loader row first, then the
     * pi-ai namespace so the wizard stays reachable from the catalog card. */
    const CARD_KEYS = ['include:opencode', 'opencode', 'include:llm-pi-ai', 'llm-pi-ai']
    /** Last successful import mirrored in this browser. */
    const STORAGE_KEY = 'dsh-opencode:last-import'
    /** Context-window default prefilled for models with no recognized interface. */
    const DEFAULT_CONTEXT = 262144

    /** English copy. */
    const en = {
      provider: 'OpenCode', title: 'Model import',
      intro:
        'Reads the live OpenCode catalogue and imports the models you pick into the single OpenCode provider route. Models with a recognized protocol import as-is; the rest need an interface first.',
      keyHint: 'No API key is configured for this provider; the catalogue read may fail until one is saved.',
      fetch: 'Fetch models', fetching: 'Fetching the catalogue…',
      lastImport: 'Last import', never: 'never',
      fetched: 'Fetched', resolved: 'recognized', unknown: 'without interface',
      model: 'Model', interface: 'Interface', context: 'Context', source: 'Source', tokens: 'tokens',
      pickInterface: 'Pick an interface…',
      unknownHint: 'Models without a recognized interface need one before they can be imported.',
      noPresets: 'The Host returned no interface presets, so models without a recognized interface cannot be imported.',
      selectAll: 'Select all', clearAll: 'Clear selection',
      import: 'Import selected', importing: 'Importing…',
      selected: 'selected', imported: 'Imported', updated: 'Updated', removed: 'Removed', retired: 'Retired',
      registered: 'Registered', stored: 'Imported', importedModels: 'Imported models',
      enabled: 'Enabled', manage: 'Model management',
      manageHint: 'Only enabled models appear in the model picker; disabled models stay imported. The source badge shows whether the model is routed through OpenCode Go.',
      searchModels: 'Search by name or id',
      noMatches: 'No models match the search.',
      shown: 'shown',
      sourceGo: 'Go',
      sourceZen: 'Zen',
      filterAll: 'All sources',
      filterGo: 'Go only',
      filterZen: 'Zen only',
      enableAll: 'Enable all', disableAll: 'Disable all',
      apply: 'Apply', applying: 'Applying…', applyFailed: 'Failed to apply:', applied: 'Enabled set updated.',
      noStored: 'No models imported yet.',
      enabledHint: 'Newly imported models are enabled by default; manage them below.',
      settings: 'Settings', maxTokens: 'Max tokens', defaultIs: 'default', close: 'Close',
      resetModel: 'Reset to defaults', hintEmptyResets: 'An empty field resets that value to its default.',
      defaultsUnknown: 'Catalogue defaults are unknown for this model; reset to defaults is unavailable.',
      invalidNumber: 'Enter a positive number or leave a field empty to reset it.',
      modelSaved: 'Model settings applied.', modelReset: 'Model settings reset to defaults.',
      empty: 'The Host returned no models.',
      fetchFailed: 'Catalogue request failed:', importFailed: 'Import failed:',
      noSelection: 'Select at least one model.',
      needsInterface: 'Pick an interface for the selected model(s) without a recognized one.',
      done: 'Import finished.', retiredList: 'Removed from the provider',
    }

    /** Russian copy. */
    const ru = {
      provider: 'OpenCode', title: 'Импорт моделей',
      intro:
        'Запрашивает живой каталог OpenCode и импортирует выбранные модели в единственный маршрут провайдера OpenCode. Модели с распознанным протоколом импортируются как есть; для остальных сначала нужно выбрать интерфейс.',
      keyHint: 'Для этого провайдера не настроен API-ключ; чтение каталога может не пройти, пока ключ не сохранён.',
      fetch: 'Проверить модели', fetching: 'Загружаю каталог…',
      lastImport: 'Последний импорт', never: 'ещё не было',
      fetched: 'Получено', resolved: 'с интерфейсом', unknown: 'без интерфейса',
      model: 'Модель', interface: 'Интерфейс', context: 'Контекст', source: 'Источник', tokens: 'токенов',
      pickInterface: 'Выберите интерфейс…',
      unknownHint: 'Моделям без распознанного интерфейса нужно выбрать интерфейс, иначе импорт невозможен.',
      noPresets: 'Хост не вернул пресеты интерфейсов, поэтому модели без распознанного интерфейса импортировать нельзя.',
      selectAll: 'Выбрать все', clearAll: 'Снять выбор',
      import: 'Импортировать выбранные', importing: 'Импортирую…',
      selected: 'выбрано', imported: 'Добавлено', updated: 'Обновлено', removed: 'Удалено', retired: 'Списано',
      registered: 'Зарегистрировано', stored: 'Импортировано', importedModels: 'Импортированные модели',
      enabled: 'Включено', manage: 'Управление моделями',
      manageHint: 'В выборе моделей видны только включённые; отключённые остаются импортированными. Метка источника показывает, идёт ли модель через OpenCode Go.',
      searchModels: 'Поиск по названию или id',
      noMatches: 'Ничего не найдено.',
      shown: 'показано',
      sourceGo: 'Go',
      sourceZen: 'Zen',
      filterAll: 'Все источники',
      filterGo: 'Только Go',
      filterZen: 'Только Zen',
      enableAll: 'Включить все', disableAll: 'Отключить все',
      apply: 'Применить', applying: 'Применяю…', applyFailed: 'Не удалось применить:', applied: 'Набор включённых моделей обновлён.',
      noStored: 'Импортированных моделей пока нет.',
      enabledHint: 'Импортированные модели включаются по умолчанию; управлять ими можно ниже.',
      settings: 'Настройки', maxTokens: 'Макс. токены', defaultIs: 'по умолчанию', close: 'Закрыть',
      resetModel: 'Сбросить к стандартным', hintEmptyResets: 'Пустое поле сбрасывает значение к стандартному.',
      defaultsUnknown: 'Стандартные значения каталога для этой модели неизвестны; сброс к стандартным недоступен.',
      invalidNumber: 'Введите положительное число или оставьте поле пустым, чтобы сбросить значение.',
      modelSaved: 'Настройки модели применены.', modelReset: 'Настройки модели сброшены к стандартным.',
      empty: 'Хост не вернул ни одной модели.',
      fetchFailed: 'Не удалось получить каталог:', importFailed: 'Импорт не удался:',
      noSelection: 'Выберите хотя бы одну модель.',
      needsInterface: 'Выберите интерфейс для выбранных моделей без распознанного интерфейса.',
      done: 'Импорт завершён.', retiredList: 'Убрано из провайдера',
    }

    /** Protocol names shown when the Host sends no `apiLabel`. */
    const API_LABELS = {
      'openai-completions': 'Chat Completions',
      'openai-responses': 'Responses',
      'anthropic-messages': 'Anthropic Messages',
    }

    /** Interfaces the per-model override select offers. */
    const PROTOCOL_OPTIONS = ['openai-completions', 'openai-responses', 'anthropic-messages']

    /** Page-local styles; theme tokens only (no literal colors). */
    const CSS = `
.oimp-card{display:flex;flex-direction:column;gap:10px;margin-top:10px;padding:12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
.oimp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.oimp-ident{display:flex;flex-direction:column;gap:1px;min-width:0}
.oimp-provider{font-size:13px;font-weight:600}
.oimp-title{color:var(--dsw-alias-label-secondary);font-size:11px}
.oimp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.oimp-button{height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer;flex:none;white-space:nowrap}
.oimp-button:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.oimp-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.oimp-button[aria-busy="true"]{cursor:progress}
.oimp-button-accent{border-color:var(--dsw-alias-brand-primary)}
.oimp-button-quiet{border-color:transparent;padding:0 6px}
.oimp-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.oimp-meta{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;flex-wrap:wrap;gap:0 6px}
.oimp-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.oimp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:6px}
.oimp-cell{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}
.oimp-cell b{font-size:14px;font-weight:600}
.oimp-cell span{font-size:10px;color:var(--dsw-alias-label-secondary)}
.oimp-table{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;max-height:300px;overflow:auto}
.oimp-thead,.oimp-row{display:grid;grid-template-columns:22px minmax(0,1fr) 150px 104px 78px;gap:8px;align-items:center;padding:5px 8px}
.oimp-thead{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.03em;text-transform:uppercase}
.oimp-row+.oimp-row{border-top:.5px solid var(--dsw-alias-border-l1)}
.oimp-pick{display:flex;align-items:center;justify-content:center}
.oimp-model{display:flex;flex-direction:column;min-width:0}
.oimp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oimp-id{color:var(--dsw-alias-label-secondary);font-size:10px;font-family:var(--dsw-font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oimp-badge{display:inline-block;max-width:100%;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oimp-select,.oimp-input{box-sizing:border-box;width:100%;height:24px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:11px}
.oimp-select:disabled,.oimp-input:disabled{color:var(--dsw-alias-label-secondary)}
.oimp-select:focus-visible,.oimp-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.oimp-ctx{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oimp-src{color:var(--dsw-alias-label-secondary);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oimp-list{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow:auto;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px}
.oimp-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.oimp-list code{font-family:var(--dsw-font-mono,monospace);font-size:10px;color:var(--dsw-alias-label-secondary);flex:none}
.oimp-sub{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.oimp-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.oimp-manage{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1)}
.oimp-manage-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.oimp-manage-list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;max-height:280px;overflow:auto}
.oimp-manage-row{display:grid;grid-template-columns:22px minmax(0,1.1fr) minmax(0,0.9fr) 118px 46px 26px;gap:8px;align-items:center;padding:4px 8px;cursor:pointer}
.oimp-manage-item{display:flex;flex-direction:column}
.oimp-manage-item+.oimp-manage-item{border-top:.5px solid var(--dsw-alias-border-l1)}
.oimp-manage-row input{margin:0;justify-self:center}
.oimp-manage-row .oimp-badge{justify-self:start}
.oimp-manage-search{display:flex;align-items:center;gap:8px}
.oimp-search-input{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}
.oimp-search-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.oimp-shown{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.oimp-source-filter{flex:0 0 auto;width:auto;min-width:110px}
.oimp-src-badge{justify-self:start;font-size:10px;line-height:14px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.oimp-gear{justify-self:center;width:24px;height:24px;padding:0;border:.5px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}
.oimp-gear:hover{border-color:var(--dsw-alias-border-l2)}
.oimp-gear:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.oimp-gear:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.oimp-gear[aria-expanded="true"]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.oimp-editor{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-top:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.oimp-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.oimp-field{display:flex;flex-direction:column;gap:2px;min-width:0}
.oimp-field-label{color:var(--dsw-alias-label-secondary);font-size:10px;letter-spacing:.03em;text-transform:uppercase}
.oimp-field-hint{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
.oimp-editor-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
`

    /** JSON from storage; any failure degrades to null (private mode, quota). */
    function readStored() {
      try {
        return normalizeReport(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
      } catch {
        return null
      }
    }
    function writeStored(value) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* best effort only */ }
    }
    /** ISO date -> localized wall clock, or null when absent. */
    function whenText(iso) {
      const time = Date.parse(String(iso ?? ''))
      return Number.isFinite(time) ? new Date(time).toLocaleString() : null
    }
    /** Compact count; em dash for a missing field. */
    function countText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '—'
    }
    /** Finite number or null. */
    function numberOf(value) {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : null
    }
    /** Parse the context-window input; null for an empty or invalid value. */
    function contextNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null
      const text = String(value ?? '').trim()
      const number = text === '' ? Number.NaN : Number(text)
      return Number.isFinite(number) && number > 0 ? Math.round(number) : null
    }
    /** Editor number field: empty -> reset (null), invalid -> ok:false. */
    function parseOverride(text) {
      const raw = String(text ?? '').trim()
      if (raw === '') return { value: null, ok: true }
      const number = Number(raw)
      if (!Number.isFinite(number) || number <= 0) return { value: null, ok: false }
      return { value: Math.round(number), ok: true }
    }
    /** Model id as a string, or '' when absent. */
    function modelId(model) {
      if (model === null || typeof model !== 'object') return ''
      return typeof model.id === 'string' ? model.id : String(model.id ?? '')
    }
    /** Row identity in the selection map (ids may repeat across sources). */
    function rowKey(model) {
      return `${String(model?.source ?? '')}::${modelId(model)}`
    }
    /** Human name with the id as a fallback. */
    function modelName(model) {
      return String(typeof model?.name === 'string' && model.name !== '' ? model.name : modelId(model))
    }
    /** A model whose wire protocol the Host already resolved. */
    function isResolved(model) {
      return (
        model !== null &&
        typeof model === 'object' &&
        (model.resolved === true || (typeof model.api === 'string' && model.api.length > 0))
      )
    }
    /** A stored model is enabled unless the Host says otherwise (old data has no flag). */
    function modelEnabled(model) {
      return !(model !== null && typeof model === 'object' && model.enabled === false)
    }
    /** Interface text: known protocol name, then the raw id. */
    function apiText(value) {
      const api = typeof value === 'string' ? value : ''
      return API_LABELS[api] ?? api
    }
    /** Per-model selection/interface state; every fetched model starts checked. */
    function defaultDraft(model) {
      const window = numberOf(model?.contextWindow)
      return {
        checked: true,
        api: typeof model?.api === 'string' ? model.api : '',
        context: window !== null && window > 0 ? String(Math.round(window)) : String(DEFAULT_CONTEXT),
      }
    }
    /** Selection map for a fresh catalogue answer. */
    function initialDraft(payload) {
      const models = Array.isArray(payload?.models) ? payload.models : []
      const next = {}
      for (const model of models) {
        if (modelId(model) !== '') next[rowKey(model)] = defaultDraft(model)
      }
      return next
    }
    /** Unknown-model ids from either Host shape (`string[]` or `{ id }[]`). */
    function unknownIds(payload) {
      const list = Array.isArray(payload?.unknown) ? payload.unknown : []
      return list
        .map((item) => (typeof item === 'string' ? item : String(item?.id ?? '')))
        .filter((id) => id !== '')
    }
    /** Build the POST body rows from the catalogue + selection state. */
    function buildImportRows(models, draft, presets) {
      const rows = []
      for (const model of models) {
        const id = modelId(model)
        if (id === '') continue
        const entry = draft[rowKey(model)] ?? defaultDraft(model)
        if (entry.checked !== true) continue
        const resolved = isResolved(model)
        const api = resolved ? String(model.api) : String(entry.api ?? '')
        if (api === '') continue
        const row = { id, name: modelName(model), api }
        const preset = presets.find((candidate) => candidate.api === api)
        const baseURL = model.baseURL || preset?.baseURL || ''
        if (baseURL !== '') row.baseURL = baseURL
        const window = resolved ? numberOf(model.contextWindow) : contextNumber(entry.context)
        if (window !== null && window > 0) row.contextWindow = Math.round(window)
        const maxTokens = resolved ? numberOf(model.maxTokens) : null
        if (maxTokens !== null && maxTokens > 0) row.maxTokens = Math.round(maxTokens)
        if (Array.isArray(model.input)) {
          const input = model.input.filter((value) => value === 'text' || value === 'image')
          if (input.length > 0) row.input = input
        }
        if (typeof model.source === 'string' && model.source !== '') row.source = model.source
        rows.push(row)
      }
      return rows
    }
    /** Tolerance for both the flat report and a `{ lastImport: report }` wrapper. */
    function normalizeReport(source) {
      if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
      const nested = source.lastImport ?? source.last ?? source.report
      const body = nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? nested : source
      const stored = numberOf(source.stored)
      return {
        at: body.at ?? body.importedAt ?? body.finishedAt ?? body.syncedAt ?? source.at ?? null,
        fetched: numberOf(body.fetched), imported: numberOf(body.imported ?? body.added),
        updated: numberOf(body.updated), removed: numberOf(body.removed), stored,
        enabledCount: numberOf(source.enabledCount ?? body.enabledCount ?? body.enabled),
        retired: Array.isArray(body.retired) ? body.retired.map((value) => String(value)) : [],
        models: Array.isArray(source.models) ? source.models : Array.isArray(body.models) ? body.models : [],
        /** `models` is the full stored list (status), not just the last import's rows. */
        manageable: Array.isArray(source.models) && (stored !== null || numberOf(source.enabledCount) !== null),
        registered: Array.isArray(source.registered) ? source.registered.map((value) => String(value)) : Array.isArray(source.registeredAll) ? source.registeredAll.map((value) => String(value)) : [],
        provider: typeof source.provider === 'string' ? source.provider : null,
        retireShipped: source.retireShipped === true,
        targets: Array.isArray(source.targets) ? source.targets.map((value) => String(value)) : [],
      }
    }
    /** Parse a Host JSON answer and turn `{ ok: false }` / HTTP errors into a throw. */
    async function jsonBody(response) {
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!response.ok || body === null || body.ok === false) {
        const message =
          body !== null && typeof body.error === 'string' && body.error.length > 0 ? body.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body
    }
    /** Host status route (tolerant: 404 or an empty body reads as "no import yet"). */
    async function fetchStatus() {
      try {
        const response = await fetch(STATUS_PATH, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' })
        return response.ok ? await jsonBody(response) : null
      } catch {
        return null
      }
    }
    /** The live catalogue read; `refresh=1` skips the Host's short cache on an explicit click. */
    async function fetchCatalogue() {
      const response = await fetch(`${CATALOGUE_PATH}?refresh=1`, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' })
      return jsonBody(response)
    }
    /** The one write action; the JSON body needs its own content-type. */
    async function postImport(rows) {
      const response = await fetch(IMPORT_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ models: rows }),
      })
      return jsonBody(response)
    }
    /** Set the exact enabled model-id set (the picker shows only these). */
    async function postEnabled(ids) {
      const response = await fetch(ENABLED_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ enabled: ids }),
      })
      return jsonBody(response)
    }
    /** Set field-level model overrides or reset them to the catalogue defaults. */
    async function postModel(payload) {
      const response = await fetch(MODEL_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload),
      })
      return jsonBody(response)
    }
    /** Error text that never throws on exotic rejection values. */
    function errorText(error) {
      return error instanceof Error ? error.message : String(error ?? '')
    }

    /** One count cell. */
    function Cell(props) {
      return h('div', { className: 'oimp-cell' }, h('b', null, props.value), h('span', null, props.label))
    }

    /** One card button (disabled + aria-busy states). */
    function cardButton(label, options) {
      return h('button', {
        type: 'button',
        className: `oimp-button${options?.accent === true ? ' oimp-button-accent' : ''}${options?.quiet === true ? ' oimp-button-quiet' : ''}`,
        disabled: options?.disabled === true,
        'aria-busy': options?.busy === true,
        onClick: options?.onClick,
      }, label)
    }

    /**
     * Inline per-model settings editor: context window, max tokens and interface
     * overrides, plus reset to the catalogue defaults the Host captured at
     * import. Mounted with `key = model id`; only one is open per manage list.
     */
    function ModelEditor(props) {
      const t = props.t
      const model = props.model
      const defaults = model !== null && typeof model === 'object' && model.defaults !== null && typeof model.defaults === 'object' ? model.defaults : null
      const text = (value) => (value === null || value === undefined ? '' : String(value))
      const [contextText, setContextText] = React.useState(text(model?.contextWindow))
      const [maxTokensText, setMaxTokensText] = React.useState(text(model?.maxTokens))
      const [apiValue, setApiValue] = React.useState(PROTOCOL_OPTIONS.includes(model?.api) ? model.api : '')
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const name = modelName(model)
      const context = parseOverride(contextText)
      const maxTokens = parseOverride(maxTokensText)
      const invalid = context.ok !== true || maxTokens.ok !== true || apiValue === ''
      const defaultHint = (value) => (value === null || value === undefined ? null : `${t('defaultIs')}: ${String(value)}`)
      const contextHint = defaultHint(defaults?.contextWindow)
      const maxTokensHint = defaultHint(defaults?.maxTokens)
      const apiHint = typeof defaults?.api === 'string' ? `${t('defaultIs')}: ${apiText(defaults.api)}` : null
      const syncFrom = (row) => {
        if (row === null || typeof row !== 'object') return
        setContextText(text(row.contextWindow))
        setMaxTokensText(text(row.maxTokens))
        if (PROTOCOL_OPTIONS.includes(row.api)) setApiValue(row.api)
      }
      const save = (payload) => {
        if (saving === true) return
        setSaving(true)
        setError(null)
        setNotice(null)
        postModel(payload)
          .then((answer) => {
            const updated = answer !== null && typeof answer === 'object' && answer.model !== null && typeof answer.model === 'object' ? answer.model : null
            if (updated !== null) syncFrom(updated)
            else if (payload.reset === true) syncFrom({ contextWindow: defaults?.contextWindow ?? null, maxTokens: defaults?.maxTokens ?? null, api: defaults?.api ?? null })
            setNotice(payload.reset === true ? t('modelReset') : t('modelSaved'))
            setSaving(false)
            if (typeof props.onSaved === 'function') props.onSaved()
          })
          .catch((caught) => {
            setError(errorText(caught))
            setSaving(false)
          })
      }
      const apply = () => {
        if (saving === true || invalid === true) return
        save({ id: modelId(model), contextWindow: context.value, maxTokens: maxTokens.value, api: apiValue })
      }
      const reset = () => {
        if (saving === true || defaults === null) return
        save({ id: modelId(model), reset: true })
      }
      const close = () => {
        if (saving !== true && typeof props.onClose === 'function') props.onClose()
      }
      return h('div', { className: 'oimp-editor', role: 'group', 'aria-label': `${t('settings')}: ${name}` },
        h('div', { className: 'oimp-editor-grid' },
          h('label', { className: 'oimp-field' },
            h('span', { className: 'oimp-field-label' }, t('context')),
            h('input', {
              className: 'oimp-input',
              type: 'number',
              min: '1',
              step: '1024',
              inputMode: 'numeric',
              value: contextText,
              placeholder: defaults?.contextWindow === null || defaults?.contextWindow === undefined ? undefined : String(defaults.contextWindow),
              disabled: saving,
              'aria-label': `${t('context')}: ${name}`,
              onChange: (event) => setContextText(event?.target?.value ?? ''),
            }),
            contextHint === null ? null : h('span', { className: 'oimp-field-hint' }, contextHint)),
          h('label', { className: 'oimp-field' },
            h('span', { className: 'oimp-field-label' }, t('maxTokens')),
            h('input', {
              className: 'oimp-input',
              type: 'number',
              min: '1',
              step: '1024',
              inputMode: 'numeric',
              value: maxTokensText,
              placeholder: defaults?.maxTokens === null || defaults?.maxTokens === undefined ? undefined : String(defaults.maxTokens),
              disabled: saving,
              'aria-label': `${t('maxTokens')}: ${name}`,
              onChange: (event) => setMaxTokensText(event?.target?.value ?? ''),
            }),
            maxTokensHint === null ? null : h('span', { className: 'oimp-field-hint' }, maxTokensHint)),
          h('label', { className: 'oimp-field' },
            h('span', { className: 'oimp-field-label' }, t('interface')),
            h('select', {
              className: 'oimp-select',
              value: apiValue,
              disabled: saving,
              'aria-label': `${t('interface')}: ${name}`,
              onChange: (event) => setApiValue(event?.target?.value ?? apiValue),
            },
              apiValue === '' ? h('option', { value: '' }, t('pickInterface')) : null,
              PROTOCOL_OPTIONS.map((api) => h('option', { value: api, key: api }, apiText(api)))),
            apiHint === null ? null : h('span', { className: 'oimp-field-hint' }, apiHint))),
        h('p', { className: 'oimp-hint' }, t('hintEmptyResets')),
        invalid ? h('p', { className: 'oimp-hint', role: 'status' }, t('invalidNumber')) : null,
        defaults === null ? h('p', { className: 'oimp-hint' }, t('defaultsUnknown')) : null,
        error === null ? null : h('p', { className: 'oimp-error', role: 'alert' }, `${t('applyFailed')} ${error}`),
        notice === null ? null : h('p', { className: 'oimp-hint', role: 'status' }, notice),
        h('div', { className: 'oimp-editor-actions' },
          cardButton(saving ? t('applying') : t('apply'), { accent: true, disabled: saving || invalid, busy: saving, onClick: apply }),
          cardButton(t('resetModel'), { quiet: true, disabled: saving || defaults === null, onClick: reset }),
          cardButton(t('close'), { quiet: true, disabled: saving, onClick: close })))
    }

    /**
     * Enabled/disabled curation for the stored models: the model picker shows
     * only enabled rows, while disabled rows stay imported and re-enable here.
     * The search box filters by model name or id; bulk actions apply to the
     * visible (filtered) rows, so a search can curate one family at a time.
     * Each row also opens the inline {@link ModelEditor} through its gear.
     */
    function ManageModels(props) {
      const t = props.t
      const applying = props.applying === true
      const [query, setQuery] = React.useState('')
      const [sourceFilter, setSourceFilter] = React.useState('all')
      const [openId, setOpenId] = React.useState('')
      const needle = query.trim().toLowerCase()
      const hasQuery = needle.length > 0
      const sourceOf = (model) => (typeof model?.source === 'string' ? model.source : '')
      const matchesSource = (model) => sourceFilter === 'all' || sourceOf(model) === sourceFilter
      const matchesQuery = (model) => {
        const id = modelId(model).toLowerCase()
        const name = modelName(model).toLowerCase()
        return id.includes(needle) || name.includes(needle)
      }
      const visible = props.models.filter((model) => matchesSource(model) && (!hasQuery || matchesQuery(model)))
      /** Gateway label: a model routed through the Go subscription is marked Go. */
      const sourceLabel = (model) => {
        const source = sourceOf(model)
        if (source === 'opencode-go') return t('sourceGo')
        if (source === 'opencode') return t('sourceZen')
        return source === '' ? '—' : source
      }
      /** Only one inline editor is open at a time, keyed by model id. */
      const toggleEditor = (model) => {
        const id = modelId(model)
        setOpenId((previous) => (previous === id ? '' : id))
      }
      const items = visible.length === 0
        ? [h('p', { className: 'oimp-hint', key: 'no-matches', role: 'status' }, t('noMatches'))]
        : visible.map((model) => {
            const id = modelId(model)
            const open = openId === id
            const enabled = props.isEnabled(model) === true
            const api = typeof model?.api === 'string' ? model.api : ''
            const source = sourceLabel(model)
            return h('div', { className: 'oimp-manage-item', key: id },
              h('label', { className: 'oimp-manage-row' },
                h('input', {
                  type: 'checkbox',
                  checked: enabled,
                  disabled: applying,
                  'aria-label': `${t('enabled')}: ${modelName(model)}`,
                  onChange: () => props.onToggle(model),
                }),
                h('span', { className: 'oimp-name', title: id }, modelName(model)),
                h('code', { className: 'oimp-id', title: id }, id),
                h('span', { className: 'oimp-badge', title: api }, api === '' ? '—' : apiText(api)),
                h('span', { className: 'oimp-src-badge', title: `${t('source')}: ${source}` }, source),
                h('button', {
                  type: 'button',
                  className: 'oimp-gear',
                  title: t('settings'),
                  'aria-label': `${t('settings')}: ${modelName(model)}`,
                  'aria-expanded': open,
                  disabled: applying,
                  onClick: (event) => {
                    // The row is a <label>: never toggle the checkbox from the gear.
                    event.preventDefault()
                    event.stopPropagation()
                    toggleEditor(model)
                  },
                }, '⚙')),
              open ? h(ModelEditor, {
                key: `${id}:editor`,
                t,
                model,
                onSaved: props.onRefresh,
                onClose: () => setOpenId(''),
              }) : null)
          })
      return h('div', { className: 'oimp-manage' },
        h('div', { className: 'oimp-manage-head' },
          h('div', { className: 'oimp-ident' },
            h('span', { className: 'oimp-sub' }, t('manage')),
            h('span', { className: 'oimp-hint' }, t('manageHint'))),
          h('div', { className: 'oimp-actions' },
            cardButton(t('enableAll'), { quiet: true, disabled: applying, onClick: () => props.onEnableAll(visible) }),
            cardButton(t('disableAll'), { quiet: true, disabled: applying, onClick: () => props.onDisableAll(visible) }),
            cardButton(applying ? t('applying') : t('apply'), {
              accent: true,
              disabled: applying || props.dirty !== true,
              busy: applying,
              onClick: props.onApply,
            }))),
        h('div', { className: 'oimp-manage-search' },
          h('input', {
            type: 'search',
            className: 'oimp-search-input',
            value: query,
            placeholder: t('searchModels'),
            'aria-label': t('searchModels'),
            spellCheck: false,
            onChange: (event) => setQuery(event?.target?.value ?? ''),
          }),
          h('select', {
            className: 'oimp-search-input oimp-source-filter',
            value: sourceFilter,
            'aria-label': t('source'),
            onChange: (event) => setSourceFilter(event?.target?.value ?? 'all'),
          },
            h('option', { value: 'all' }, t('filterAll')),
            h('option', { value: 'opencode-go' }, t('filterGo')),
            h('option', { value: 'opencode' }, t('filterZen'))),
          h('span', { className: 'oimp-shown' }, `${t('shown')}: ${countText(visible.length)} / ${countText(props.models.length)}`)),
        h('div', { className: 'oimp-manage-list', role: 'group', 'aria-label': t('manage') }, items),
        props.state !== null && props.state.status === 'failed'
          ? h('p', { className: 'oimp-error', role: 'alert' }, `${t('applyFailed')} ${props.state.error}`)
          : null,
        props.state !== null && props.state.status === 'done'
          ? h('p', { className: 'oimp-hint', role: 'status' }, t('applied'))
          : null)
    }

    /**
     * The OpenCode card extension: an import wizard. Receives `t` (from the
     * `locale` registration option) and owner props `provider` / `configured` /
     * `keyConfigured`.
     */
    function ImportCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key
      const provider = props.provider
      // Whether this card is one of the OpenCode provider cards. Pure, so it is
      // safe to compute before the hooks.
      const isTarget = provider !== null && typeof provider === 'object' && PROVIDERS.includes(provider.provider)
      const [report, setReport] = React.useState(readStored)
      const [catalogue, setCatalogue] = React.useState({ status: 'idle', error: null, data: null })
      const [draft, setDraft] = React.useState({})
      const [importState, setImportState] = React.useState({ status: 'idle', error: null, result: null })
      const [enabledDraft, setEnabledDraft] = React.useState({})
      const [enableState, setEnableState] = React.useState({ status: 'idle', error: null, result: null })

      /** Adopt a Host report: mirror it locally so the card survives a 404 later.
       * A report without a timestamp keeps the stored one (age survives restarts). */
      const remember = React.useCallback((payload, keepTimestamp) => {
        const normalized = normalizeReport(payload)
        if (normalized === null) return
        let next = normalized
        if (keepTimestamp === true && normalized.at === null) {
          const previous = readStored()
          if (previous !== null && previous.at !== null) next = { ...normalized, at: previous.at }
        }
        writeStored(next)
        setReport(next)
        // A fresh Host read is the new baseline: drop unsaved enable toggles.
        setEnabledDraft({})
      }, [])

      // One status read for the target cards only (the component also mounts on
      // every other pi-ai provider card and renders nothing there).
      React.useEffect(() => {
        if (!isTarget) return undefined
        let alive = true
        fetchStatus().then((payload) => { if (alive && payload !== null) remember(payload, true) }).catch(() => {})
        return () => { alive = false }
      }, [isTarget, remember])

      /**
       * The Models page offers every dormant pi-ai catalog provider in its
       * add-provider picker, even though this plugin already serves OpenCode.
       * Once the shipped routes are retired, remove those ids from any provider
       * <select> so the page offers exactly one OpenCode entry (this plugin's
       * own provider, which is never an addable draft). Seats owned by this
       * card are skipped: its source filter legitimately lists those ids.
       */
      const retiredIds =
        report !== null &&
        report.retireShipped === true &&
        report.provider !== null &&
        report.registered.includes(report.provider)
          ? report.targets.filter((id) => id !== report.provider)
          : []
      const retiredKey = retiredIds.join(',')
      React.useEffect(() => {
        if (retiredKey === '' || typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const hidden = new Set(retiredKey.split(','))
        const filter = () => {
          for (const select of document.querySelectorAll('select')) {
            if (typeof select.closest === 'function' && select.closest('.oimp-card') !== null) continue
            const offending = [...select.options].filter((option) => hidden.has(option.value))
            if (offending.length === 0) continue
            const selectedRetired = hidden.has(select.value)
            for (const option of offending) option.remove()
            const first = select.options[0]
            if (selectedRetired && first !== undefined && typeof Event === 'function') {
              select.value = first.value
              select.dispatchEvent(new Event('change', { bubbles: true }))
            }
          }
        }
        filter()
        const observer = new MutationObserver(filter)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [retiredKey])

      // Every other pi-ai provider card (inceptionlabs, openrouter-preset, …) renders nothing.
      if (!isTarget) return null

      /** Fetch the live catalogue and reset the selection to "everything checked". */
      const load = () => {
        if (catalogue.status === 'loading' || importState.status === 'importing') return
        setCatalogue({ status: 'loading', error: null, data: null })
        setImportState({ status: 'idle', error: null, result: null })
        setDraft({})
        fetchCatalogue()
          .then((payload) => { setCatalogue({ status: 'ready', error: null, data: payload }); setDraft(initialDraft(payload)) })
          .catch((error) => setCatalogue({ status: 'failed', error: errorText(error), data: null }))
      }

      /** Import the checked models (validated by the disabled state below). */
      const runImport = (rows) => {
        if (importState.status === 'importing' || rows.length === 0) return
        setImportState({ status: 'importing', error: null, result: null })
        postImport(rows)
          .then((payload) => {
            const done = { ...(normalizeReport(payload) ?? { at: null }), at: new Date().toISOString() }
            writeStored(done)
            setReport(done)
            setImportState({ status: 'done', error: null, result: payload })
            fetchStatus()
              .then((status) => {
                if (status !== null) remember(status, true)
              })
              .catch(() => {})
          })
          .catch((error) => setImportState({ status: 'failed', error: errorText(error), result: null }))
      }

      const cat = catalogue.data
      const models = Array.isArray(cat?.models) ? cat.models : []
      const presets = Array.isArray(cat?.presets) ? cat.presets.filter((preset) => typeof preset?.api === 'string') : []
      const browse = catalogue.status === 'ready'
      const busy = importState.status === 'importing'
      const loading = catalogue.status === 'loading'
      const unknown = unknownIds(cat)
      const resolvedCount = models.filter((model) => isResolved(model)).length
      const unknownCount = models.length - resolvedCount

      /** Selection state of one row (the draft map may not be populated yet). */
      const entryFor = (model) => draft[rowKey(model)] ?? defaultDraft(model)
      const setEntry = (model, patch) => {
        const key = rowKey(model)
        setDraft((previous) => ({ ...previous, [key]: { ...(previous[key] ?? defaultDraft(model)), ...patch } }))
      }
      const toggleAll = (checked) => {
        setDraft((previous) => {
          const next = { ...previous }
          for (const model of models) next[rowKey(model)] = { ...(next[rowKey(model)] ?? defaultDraft(model)), checked }
          return next
        })
      }

      const selected = models.filter((model) => entryFor(model).checked === true && modelId(model) !== '')
      const missing = selected.filter((model) => !isResolved(model) && String(entryFor(model).api ?? '') === '')
      const importRows = buildImportRows(models, draft, presets)
      const importDisabled = busy || selected.length === 0 || missing.length > 0 || importRows.length === 0
      const noPresets = presets.length === 0 && unknownCount > 0
      const when = report !== null ? whenText(report.at) : null
      const knownCounts = report !== null && [report.imported, report.updated, report.removed].some((value) => value !== null)
      const registered = report !== null && Array.isArray(report.registered) ? report.registered : []
      const retired = Array.isArray(importState.result?.retired) ? importState.result.retired : []

      // Stored models (status.models) plus the local enabled/disabled curation.
      const storedModels = report !== null && report.manageable === true && Array.isArray(report.models) ? report.models : []
      const storedTotal = storedModels.length > 0 ? storedModels.length : numberOf(report?.stored)
      /** Enabled state of a stored model: local draft first, then the Host flag. */
      const isEnabled = (model) => {
        const id = modelId(model)
        return id !== '' && id in enabledDraft ? enabledDraft[id] === true : modelEnabled(model)
      }
      const enabledNow = storedModels.filter(isEnabled).length
      const enabledTotal = storedModels.length > 0 ? enabledNow : numberOf(report?.enabledCount)
      const enabledDirty = storedModels.some((model) => isEnabled(model) !== modelEnabled(model))
      const toggleEnabled = (model) => {
        const id = modelId(model)
        if (id === '') return
        const next = !isEnabled(model)
        setEnabledDraft((previous) => ({ ...previous, [id]: next }))
      }
      const setAllEnabled = (value, subset) => {
        const target = Array.isArray(subset) && subset.length > 0 ? subset : storedModels
        setEnabledDraft((previous) => {
          const next = { ...previous }
          for (const model of target) {
            const id = modelId(model)
            if (id !== '') next[id] = value
          }
          return next
        })
      }
      /** Re-read the canonical status after a model overlay write. */
      const refreshStatus = () => {
        fetchStatus().then((status) => { if (status !== null) remember(status, true) }).catch(() => {})
      }
      /** POST the exact enabled id set, then re-read the canonical status. */
      const applyEnabled = () => {
        if (enableState.status === 'applying' || storedModels.length === 0) return
        const ids = storedModels.filter((model) => isEnabled(model)).map((model) => modelId(model)).filter((id) => id !== '')
        setEnableState({ status: 'applying', error: null, result: null })
        postEnabled(ids)
          .then((payload) => {
            setEnableState({ status: 'done', error: null, result: payload })
            refreshStatus()
          })
          .catch((error) => setEnableState({ status: 'failed', error: errorText(error), result: null }))
      }

      /** One card button (disabled + aria-busy states). */
      const button = cardButton

      return h(
        'section',
        { className: 'oimp-card', 'aria-label': `${t('provider')} — ${t('title')}` },
        h('style', null, CSS),
        h(
          'div',
          { className: 'oimp-head' },
          h(
            'div',
            { className: 'oimp-ident' },
            h('span', { className: 'oimp-provider' }, t('provider')),
            h('span', { className: 'oimp-title' }, t('title')),
          ),
          button(loading ? t('fetching') : t('fetch'), {
            accent: true,
            disabled: loading || busy,
            busy: loading,
            onClick: load,
          }),
        ),
        h('p', { className: 'oimp-hint' }, t('intro')),
        props.keyConfigured === false ? h('p', { className: 'oimp-hint' }, t('keyHint')) : null,
        h(
          'div',
          { className: 'oimp-meta' },
          h('span', null, `${t('lastImport')}: ${when ?? t('never')}`),
          knownCounts
            ? h('span', null, `${t('imported')} ${countText(report.imported)} · ${t('updated')} ${countText(report.updated)} · ${t('removed')} ${countText(report.removed)}`)
            : null,
          storedTotal !== null
            ? h('span', null, `${t('stored')}: ${countText(storedTotal)}${enabledTotal !== null ? ` · ${t('enabled')}: ${countText(enabledTotal)}` : ''}`)
            : registered.length > 0 ? h('span', null, `${t('registered')}: ${registered.length}`) : null,
        ),
        catalogue.status === 'failed'
          ? h('p', { className: 'oimp-error', role: 'alert' }, `${t('fetchFailed')} ${catalogue.error}`)
          : null,
        loading ? h('p', { className: 'oimp-hint', role: 'status' }, t('fetching')) : null,
        browse
          ? h(
              'div',
              { className: 'oimp-grid', role: 'group', 'aria-label': t('fetched') },
              h(Cell, { label: t('fetched'), value: countText(models.length) }),
              h(Cell, { label: t('resolved'), value: countText(resolvedCount) }),
              h(Cell, { label: t('unknown'), value: countText(unknownCount) }),
              h(Cell, { label: t('selected'), value: countText(selected.length) }),
            )
          : null,
        browse && models.length === 0 ? h('p', { className: 'oimp-hint' }, t('empty')) : null,
        browse && models.length > 0
          ? h(
              'div',
              { className: 'oimp-table', role: 'group', 'aria-label': t('model') },
              h(
                'div',
                { className: 'oimp-thead', 'aria-hidden': 'true' },
                h('span', null, ''),
                h('span', null, t('model')),
                h('span', null, t('interface')),
                h('span', null, t('context')),
                h('span', null, t('source')),
              ),
              models.map((model) => {
                const entry = entryFor(model)
                const resolved = isResolved(model)
                const name = modelName(model)
                const id = modelId(model)
                const chosenApi = resolved ? String(model.api) : String(entry.api ?? '')
                const window = numberOf(model.contextWindow)
                return h(
                  'div',
                  { className: 'oimp-row', key: rowKey(model) },
                  h(
                    'label',
                    { className: 'oimp-pick' },
                    h('input', {
                      type: 'checkbox',
                      checked: entry.checked === true,
                      disabled: busy,
                      'aria-label': name,
                      onChange: () => setEntry(model, { checked: entry.checked !== true }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'oimp-model' },
                    h('span', { className: 'oimp-name', title: id }, name),
                    name === id ? null : h('code', { className: 'oimp-id', title: id }, id),
                  ),
                  resolved
                    ? h('span', { className: 'oimp-badge', title: chosenApi }, typeof model.apiLabel === 'string' && model.apiLabel !== '' ? model.apiLabel : apiText(chosenApi))
                    : h(
                        'select',
                        {
                          className: 'oimp-select',
                          value: String(entry.api ?? ''),
                          disabled: busy,
                          required: true,
                          'aria-label': `${t('interface')}: ${name}`,
                          onChange: (event) => setEntry(model, { api: event.target.value }),
                        },
                        h('option', { value: '' }, t('pickInterface')),
                        presets.map((preset, index) => h('option', { value: preset.api, key: `${preset.api}:${index}` }, preset.label || apiText(preset.api))),
                      ),
                  resolved
                    ? h('span', { className: 'oimp-ctx', title: t('context') }, window !== null && window > 0 ? `${Math.round(window).toLocaleString()} ${t('tokens')}` : '—')
                    : h('input', {
                        className: 'oimp-input',
                        type: 'number',
                        min: '1',
                        step: '1024',
                        inputMode: 'numeric',
                        value: String(entry.context ?? ''),
                        placeholder: String(DEFAULT_CONTEXT),
                        disabled: busy,
                        'aria-label': `${t('context')}: ${name}`,
                        onChange: (event) => setEntry(model, { context: event.target.value }),
                      }),
                  h('span', { className: 'oimp-src', title: String(model.source ?? '') }, String(model.source ?? '—')),
                )
              }),
            )
          : null,
        browse && unknownCount > 0 ? h('p', { className: 'oimp-hint' }, t('unknownHint')) : null,
        browse && noPresets ? h('p', { className: 'oimp-error', role: 'alert' }, t('noPresets')) : null,
        browse && unknown.length > 0
          ? h('p', { className: 'oimp-hint' }, `${t('unknown')}: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? '…' : ''}`)
          : null,
        browse && models.length > 0 ? h('p', { className: 'oimp-hint' }, t('enabledHint')) : null,
        browse && models.length > 0
          ? h(
              'div',
              { className: 'oimp-foot' },
              h(
                'div',
                { className: 'oimp-meta' },
                h('span', null, `${t('selected')}: ${selected.length}`),
                selected.length === 0 ? h('span', null, t('noSelection')) : null,
                missing.length > 0 ? h('span', null, t('needsInterface')) : null,
              ),
              h(
                'div',
                { className: 'oimp-actions' },
                button(t('selectAll'), { quiet: true, disabled: busy, onClick: () => toggleAll(true) }),
                button(t('clearAll'), { quiet: true, disabled: busy, onClick: () => toggleAll(false) }),
                button(busy ? t('importing') : t('import'), {
                  accent: true,
                  disabled: importDisabled,
                  busy,
                  onClick: () => runImport(importRows),
                }),
              ),
            )
          : null,
        importState.status === 'failed'
          ? h('p', { className: 'oimp-error', role: 'alert' }, `${t('importFailed')} ${importState.error}`)
          : null,
        importState.status === 'done'
          ? h(
              'div',
              { className: 'oimp-grid', role: 'status', 'aria-label': t('done') },
              h(Cell, { label: t('imported'), value: countText(numberOf(importState.result?.imported ?? importState.result?.added)) }),
              h(Cell, { label: t('updated'), value: countText(numberOf(importState.result?.updated)) }),
              h(Cell, { label: t('removed'), value: countText(numberOf(importState.result?.removed)) }),
              h(Cell, { label: t('retired'), value: countText(retired.length) }),
            )
          : null,
        retired.length > 0
          ? h(
              'div',
              { className: 'oimp-list', role: 'group', 'aria-label': t('retiredList') },
              h('span', { className: 'oimp-sub' }, t('retiredList')),
              retired.slice(0, 12).map((value, index) => h('div', { className: 'oimp-line', key: `retired-${index}` }, h('span', { className: 'oimp-name' }, String(value)))),
            )
          : null,
        storedModels.length > 0
          ? h(ManageModels, {
              t,
              models: storedModels,
              isEnabled,
              onToggle: toggleEnabled,
              onEnableAll: (subset) => setAllEnabled(true, subset),
              onDisableAll: (subset) => setAllEnabled(false, subset),
              onApply: applyEnabled,
              applying: enableState.status === 'applying',
              dirty: enabledDirty,
              state: enableState,
              onRefresh: refreshStatus,
            })
          : report !== null && numberOf(report.stored) === 0
            ? h('p', { className: 'oimp-hint' }, t('noStored'))
            : null,
      )
    }

    /** Required Client services (`t` for the card comes from the `locale` option). */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the card while the Models page declares
     * `settings.models.provider-card` (disposed when the page is unmounted).
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'opencode: dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject('settings.models.provider-card', () => {
            const disposers = CARD_KEYS.map((key) =>
              ctx.slots.register({ name: 'settings.models.provider-card', key, locale: NS }, ImportCard),
            )
            return () => {
              for (const dispose of disposers) dispose()
            }
          }),
        'opencode: import wizard',
      )
    }

    return { inject, apply }
  },
})
