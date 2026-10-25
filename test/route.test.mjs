import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CATALOGUE_PATH, ENABLED_PATH, IMPORT_PATH, MODEL_PATH, STATUS_PATH, mount } from '../lib/plugin.js'

const PI_AI = '@deepseek-ai/dsh-llm-pi-ai'

const catalogue = {
  'opencode-go': {
    name: 'OpenCode Go',
    models: {
      'mini-dev-only': {
        name: 'Mini Dev Only',
        limit: { context: 123456, output: 4096 },
        provider: { api: 'https://opencode.ai/inference/openai/v1' },
      },
    },
  },
}

/** Mock response capturing status/headers/body. */
function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name] = value
    },
    writeHead(code, headers) {
      res.statusCode = code
      Object.assign(res.headers, headers ?? {})
    },
    end(body) {
      res.body = body ?? ''
    },
  }
  return res
}

/** Apply one settings path op to a plain object. */
function applyOp(root, op) {
  const walk = (parent, path) => path.slice(0, -1).reduce((node, key) => (node[key] ??= {}), parent)
  if (op.op === 'unset') {
    delete walk(root, op.path)[op.path.at(-1)]
    return
  }
  walk(root, op.path)[op.path.at(-1)] = structuredClone(op.value)
}

/** Fake harness context + services for the mount. */
function harness({ providers = {}, key = 'test-key', rejection = undefined } = {}) {
  const config = { models: [] }
  const llmProviders = structuredClone(providers)
  const mutations = []
  const adapters = []
  const directories = []
  const routes = []
  const services = {
    configEditor: {
      entries: () => [
        { options: { id: 'include:opencode', name: 'dsh-opencode' } },
        { options: { id: 'include:llm-pi-ai', name: PI_AI } },
      ],
    },
    settings: {
      describe: () => [
        { ns: 'include:opencode', value: { models: structuredClone(config.models) } },
        { ns: 'include:llm-pi-ai', value: { providers: structuredClone(llmProviders) } },
      ],
      mutate: async (ns, ops) => {
        mutations.push({ ns, ops })
        if (ns === 'include:opencode') {
          for (const op of ops) applyOp(config, op)
        } else {
          for (const op of ops) applyOp({ providers: llmProviders }, op)
        }
      },
    },
    credentials: { resolve: async () => (typeof key === 'string' ? { value: key } : undefined) },
    llm: {
      registerAdapter: (providersList, adapter) => {
        adapters.push({ providers: providersList, adapter })
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders: (entries) => {
        directories.push(...entries)
        return Object.assign(() => {}, { replace() {} })
      },
      listProviders: () => [{ id: 'opencode-live' }, ...Object.keys(llmProviders).map((id) => ({ id }))],
    },
  }
  const child = {
    get: (name) => services[name],
    logger: { warn: () => {}, error: () => {} },
    settings: services.settings,
    llm: services.llm,
    connection: { requestRejection: () => rejection },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    effect: (factory) => {
      factory()
    },
    inject: (deps, callback) => callback(child),
  }
  const ctx = {
    fiber: {},
    get: child.get,
    logger: child.logger,
    inject: (deps, callback) => callback(child),
    effect: (factory) => {
      factory()
    },
  }
  mount(ctx, config)
  return { config, llmProviders, mutations, adapters, directories, routes }
}

/** Fake gateways: two listings and the metadata catalogue. */
function stubFetch(calls = []) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers })
    if (String(url).includes('models.dev')) return new Response(JSON.stringify(catalogue), { status: 200 })
    if (String(url).endsWith('/zen/go/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'glm-5.2' },
            { id: 'mini-dev-only' },
            { id: 'brand-new-model' },
            { id: 'test' },
            { id: 'qwen3.7-max' },
            { id: 'omen-alpha' },
          ],
        }),
        { status: 200 },
      )
    }
    if (String(url).endsWith('/zen/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'mimo-v2.5' }] }), { status: 200 })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  return () => {
    globalThis.fetch = previous
  }
}

describe('host routes', () => {
  let cacheDir
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'dsh-opencode-route-'))
    process.env.DSH_OPENCODE_TEST_CACHE = cacheDir
  })
  afterEach(() => {
    delete process.env.DSH_OPENCODE_TEST_CACHE
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('registers one provider route, its directory entry and five endpoints', () => {
    const { adapters, directories, routes } = harness()
    assert.deepEqual(adapters.map((entry) => entry.providers), [['opencode-live']])
    assert.equal(directories.length, 1)
    assert.equal(directories[0].provider, 'opencode-live')
    assert.equal(directories[0].settingsNs, 'include:opencode')
    assert.deepEqual(
      routes.map((route) => route.path).sort(),
      [CATALOGUE_PATH, ENABLED_PATH, IMPORT_PATH, MODEL_PATH, STATUS_PATH].sort(),
    )
  })

  it('rejects an untrusted browser and the wrong method', async () => {
    const rejected = harness({ rejection: 403 })
    const catalogueRoute = rejected.routes.find((route) => route.path === CATALOGUE_PATH)
    const denied = mockResponse()
    await catalogueRoute.handler({ method: 'GET', headers: {}, url: CATALOGUE_PATH }, denied)
    assert.equal(denied.statusCode, 403)

    const { routes } = harness()
    const importRoute = routes.find((route) => route.path === IMPORT_PATH)
    const wrong = mockResponse()
    await importRoute.handler({ method: 'GET', headers: {} }, wrong)
    assert.equal(wrong.statusCode, 405)
    assert.equal(wrong.headers.allow, 'POST')
  })

  it('builds the catalogue with prefilled interfaces and marks unknown models', async () => {
    const restore = stubFetch()
    try {
      const { routes } = harness()
      const route = routes.find((candidate) => candidate.path === CATALOGUE_PATH)
      const res = mockResponse()
      await route.handler({ method: 'GET', headers: {}, url: `${CATALOGUE_PATH}?refresh=1` }, res)
      assert.equal(res.statusCode, 200)
      const body = JSON.parse(res.body)
      assert.equal(body.ok, true)
      assert.equal(body.fetched, 6)
      const byId = new Map(body.models.map((model) => [model.id, model]))
      assert.equal(byId.get('glm-5.2').resolved, true)
      assert.equal(byId.get('glm-5.2').api, 'openai-completions')
      assert.ok(byId.get('glm-5.2').contextWindow > 0)
      assert.equal(byId.get('mini-dev-only').resolved, true)
      assert.equal(byId.get('mini-dev-only').contextWindow, 123456)
      assert.equal(byId.get('mini-dev-only').apiLabel, 'OpenAI Chat Completions')
      assert.equal(byId.get('brand-new-model').resolved, false)
      assert.equal(byId.get('brand-new-model').api, null)
      assert.equal(byId.get('brand-new-model').suggestedApi, 'openai-completions')
      assert.equal(byId.has('test'), false)
      // Unlisted gateway models resolve from the plugin's fallback table.
      assert.equal(byId.get('qwen3.7-max').resolved, true)
      assert.equal(byId.get('qwen3.7-max').api, 'anthropic-messages')
      assert.equal(byId.get('qwen3.7-max').contextWindow, 1_000_000)
      assert.equal(byId.get('qwen3.7-max').maxTokens, 65_536)
      assert.equal(byId.get('qwen3.7-max').name, 'Qwen3.7 Max')
      assert.equal(byId.get('qwen3.7-max').baseURL, 'https://opencode.ai/zen/go')
      assert.equal(byId.get('omen-alpha').resolved, true)
      assert.equal(byId.get('omen-alpha').api, 'openai-completions')
      assert.equal(byId.get('omen-alpha').contextWindow, 500_000)
      assert.equal(byId.get('omen-alpha').maxTokens, 128_000)
      assert.equal(byId.get('omen-alpha').baseURL, 'https://opencode.ai/zen/go/v1')
      assert.deepEqual(body.unknown, ['brand-new-model'])
      assert.equal(body.fetched, 6)
      assert.deepEqual(body.presets.map((preset) => preset.api), [
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
      ])
    } finally {
      restore()
    }
  })

  it('imports the selected models and retires the shipped provider routes', async () => {
    const { config, llmProviders, mutations, routes, adapters } = harness({
      providers: {
        opencode: { apiKeyEnv: 'OPENCODE_API_KEY' },
        'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
        'opencode-live-anthropic': { api: 'anthropic-messages' },
        inceptionlabs: { apiKeyEnv: 'INCEPTIONLABS_API_KEY' },
      },
    })
    const route = routes.find((candidate) => candidate.path === IMPORT_PATH)
    const payload = {
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go' },
        {
          id: 'brand-new-model',
          name: 'Brand New',
          api: 'openai-responses',
          contextWindow: 200000,
          maxTokens: 32000,
          input: ['text'],
          source: 'opencode-go',
        },
      ],
    }
    const res = mockResponse()
    await route.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(payload))
        },
      },
      res,
    )
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.imported, 2)
    assert.equal(body.total, 2)
    assert.equal(body.enabled, 2)
    assert.equal(body.registered, true)
    assert.deepEqual(body.retired.sort(), ['opencode', 'opencode-go', 'opencode-live-anthropic'])

    assert.deepEqual(config.models.map((model) => model.id), ['glm-5.2', 'brand-new-model'])
    assert.equal(config.models[0].baseURL, 'https://opencode.ai/zen/go/v1')
    assert.equal(config.models[1].baseURL, 'https://opencode.ai/zen/go/v1')
    assert.deepEqual(Object.keys(llmProviders), ['inceptionlabs'])

    const adapter = adapters[0].adapter
    const models = await adapter.listModels('opencode-live')
    assert.deepEqual(models.map((model) => model.id), ['glm-5.2', 'brand-new-model'])
    assert.equal((await adapter.resolveModel('opencode-live', 'brand-new-model')).context.contextWindow, 200000)
    assert.ok(mutations.some((mutation) => mutation.ns === 'include:opencode'))

    // The status carries each stored model's source gateway so the card can
    // show whether the model is routed through OpenCode Go.
    const statusRoute = routes.find((candidate) => candidate.path === STATUS_PATH)
    const statusRes = mockResponse()
    await statusRoute.handler({ method: 'GET', headers: {}, url: STATUS_PATH }, statusRes)
    const statusBody = JSON.parse(statusRes.body)
    assert.deepEqual(
      statusBody.models.map((model) => `${model.id}:${model.source}`),
      ['glm-5.2:opencode-go', 'brand-new-model:opencode-go'],
    )
  })

  it('enables exactly the chosen imported models and hides the rest', async () => {
    const { config, routes, adapters } = harness()
    const importRoute = routes.find((candidate) => candidate.path === IMPORT_PATH)
    const payload = {
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go' },
        { id: 'mimo-v2.5', name: 'MiMo 2.5', api: 'openai-completions', source: 'opencode' },
      ],
    }
    await importRoute.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(payload))
        },
      },
      mockResponse(),
    )
    assert.equal(config.models.every((model) => model.enabled === true), true)

    const enabledRoute = routes.find((candidate) => candidate.path === ENABLED_PATH)
    const body = JSON.stringify({ enabled: ['mimo-v2.5'] })
    const res = mockResponse()
    await enabledRoute.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        },
      },
      res,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, enabled: 1, disabled: 1, total: 2 })
    assert.equal(config.models.find((model) => model.id === 'glm-5.2').enabled, false)
    assert.equal(config.models.find((model) => model.id === 'mimo-v2.5').enabled, true)

    const listed = await adapters[0].adapter.listModels('opencode-live')
    assert.deepEqual(listed.map((model) => model.id), ['mimo-v2.5'])
    await assert.rejects(adapters[0].adapter.resolveModel('opencode-live', 'glm-5.2'), /imported but disabled/)

    const unknown = mockResponse()
    const unknownBody = JSON.stringify({ enabled: ['not-imported'] })
    await enabledRoute.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(unknownBody)
        },
      },
      unknown,
    )
    assert.equal(unknown.statusCode, 400)
  })

  it('overrides one model setting and resets it to the captured defaults', async () => {
    const { config, routes, adapters } = harness()
    const importRoute = routes.find((candidate) => candidate.path === IMPORT_PATH)
    const payload = {
      models: [
        {
          id: 'glm-5.2',
          name: 'GLM-5.2',
          api: 'openai-completions',
          contextWindow: 1000000,
          maxTokens: 131072,
          source: 'opencode-go',
        },
      ],
    }
    await importRoute.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(payload))
        },
      },
      mockResponse(),
    )
    assert.equal(config.models[0].defaults.contextWindow, 1000000)

    const modelRoute = routes.find((candidate) => candidate.path === MODEL_PATH)
    const post = async (body) => {
      const res = mockResponse()
      await modelRoute.handler(
        {
          method: 'POST',
          headers: {},
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify(body))
          },
        },
        res,
      )
      return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
    }

    const overridden = await post({ id: 'glm-5.2', contextWindow: 500000 })
    assert.equal(overridden.status, 200)
    assert.equal(overridden.body.model.contextWindow, 500000)
    assert.equal(overridden.body.model.defaults.contextWindow, 1000000)
    assert.equal(config.models[0].contextWindow, 500000)
    assert.equal((await adapters[0].adapter.resolveModel('opencode-live', 'glm-5.2')).context.contextWindow, 500000)

    const restored = await post({ id: 'glm-5.2', reset: true })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.model.contextWindow, 1000000)
    assert.equal(config.models[0].contextWindow, 1000000)

    // A field-level null resets that field only.
    await post({ id: 'glm-5.2', maxTokens: 4096 })
    const fieldReset = await post({ id: 'glm-5.2', maxTokens: null })
    assert.equal(fieldReset.body.model.maxTokens, 131072)

    // An interface override rewrites the endpoint for the new protocol.
    const interfaceChange = await post({ id: 'glm-5.2', api: 'anthropic-messages' })
    assert.equal(interfaceChange.body.model.api, 'anthropic-messages')
    assert.equal(config.models[0].baseURL, 'https://opencode.ai/zen/go')

    assert.equal((await post({ id: 'absent', contextWindow: 5 })).status, 400)
    assert.equal((await post({ id: 'glm-5.2', contextWindow: -1 })).status, 400)
    assert.equal((await post({ id: 'glm-5.2' })).status, 400)
    assert.equal((await post({ id: 'glm-5.2', api: 'nope' })).status, 400)
  })

  it('answers 400 for an invalid or empty body', async () => {
    const { routes } = harness()
    const route = routes.find((candidate) => candidate.path === IMPORT_PATH)
    const broken = mockResponse()
    await route.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{oops')
        },
      },
      broken,
    )
    assert.equal(broken.statusCode, 400)
    assert.equal(JSON.parse(broken.body).code, 'INVALID_BODY')

    const empty = mockResponse()
    await route.handler(
      {
        method: 'POST',
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}')
        },
      },
      empty,
    )
    assert.equal(empty.statusCode, 400)
  })

  it('serves the status with the live registration state', async () => {
    const { routes } = harness()
    const route = routes.find((candidate) => candidate.path === STATUS_PATH)
    const res = mockResponse()
    await route.handler({ method: 'GET', headers: {}, url: STATUS_PATH }, res)
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.provider, 'opencode-live')
    assert.equal(body.registered, true)
    assert.equal(body.stored, 0)
    assert.equal(body.last, null)
  })
})
