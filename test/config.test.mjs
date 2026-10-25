import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  PRESETS,
  baseUrlFor,
  normalizeConfig,
  normalizeModel,
  normalizeModels,
  normalizeDefaults,
  snapshot,
} from '../lib/config.js'

describe('config', () => {
  it('defaults every field when the row has no config', () => {
    const settings = normalizeConfig(undefined)
    assert.equal(settings.provider, 'opencode-live')
    assert.equal(settings.displayName, 'OpenCode')
    assert.deepEqual(settings.targets, ['opencode-go', 'opencode'])
    assert.equal(settings.apiKeyEnv, 'OPENCODE_API_KEY')
    assert.equal(settings.sessionHeader, 'x-opencode-session')
    assert.equal(settings.forceSessionHeader, true)
    assert.equal(settings.retireShipped, true)
    assert.deepEqual(settings.models, [])
    assert.equal(settings.endpoints.opencode, 'https://opencode.ai/zen')
    assert.equal(settings.endpoints['opencode-go'], 'https://opencode.ai/zen/go')
    assert.equal(settings.targetApiKeyEnv.opencode, 'OPENCODE_API_KEY')
    assert.equal(settings.targetApiKeyEnv['opencode-go'], 'OPENCODE_GO_API_KEY')
  })

  it('normalizes user input', () => {
    const settings = normalizeConfig({
      provider: '  oc  ',
      displayName: '',
      targets: ['opencode', '', 'opencode', 4],
      includeFree: false,
      exclude: ['gemini-'],
      forceSessionHeader: false,
      retireShipped: false,
      catalogueTimeoutMs: 9_999_999,
      timeoutMs: 9_999_999,
      endpoints: { opencode: 'https://example.test/zen///' },
      models: [
        { id: 'glm-5.2', api: 'openai-completions', source: 'opencode' },
        { id: 'glm-5.2', api: 'openai-responses' },
        { id: 'bad api', api: 'openai-completions' },
        { id: 'no-api' },
      ],
    })
    assert.equal(settings.provider, 'oc')
    assert.equal(settings.displayName, 'OpenCode')
    assert.deepEqual(settings.targets, ['opencode'])
    assert.equal(settings.includeFree, false)
    assert.equal(settings.forceSessionHeader, false)
    assert.equal(settings.retireShipped, false)
    assert.equal(settings.catalogueTimeoutMs, 180_000)
    assert.equal(settings.timeoutMs, 60_000)
    assert.equal(settings.endpoints.opencode, 'https://example.test/zen')
    assert.equal(settings.models.length, 1)
  })

  it('normalizes one model row defensively', () => {
    assert.deepEqual(normalizeModel({ id: 'a', api: 'openai-completions' }), {
      id: 'a',
      name: 'a',
      api: 'openai-completions',
      input: ['text'],
      enabled: true,
    })
    const filled = normalizeModel({
      id: 'b',
      name: ' B ',
      api: 'anthropic-messages',
      contextWindow: '200000',
      maxTokens: -3,
      input: ['image', 'pdf', 'image'],
      source: 'opencode-go',
    })
    assert.equal(filled.name, 'B')
    assert.equal(filled.contextWindow, 200000)
    assert.equal(filled.maxTokens, undefined)
    assert.deepEqual(filled.input, ['image'])
    assert.equal(filled.source, 'opencode-go')
    assert.equal(filled.enabled, true)
    assert.equal(normalizeModel({ id: 'd', api: 'openai-completions', enabled: false }).enabled, false)
    assert.equal(normalizeModel({ id: 'c', api: 'google-generative-ai' }), undefined)
    assert.equal(normalizeModel({ id: 'a b', api: 'openai-completions' }), undefined)
    assert.equal(normalizeModel(null), undefined)
    assert.deepEqual(
      normalizeModels([{ id: 'x', api: 'openai-completions' }, { id: 'x', api: 'openai-responses' }]).map((m) => m.api),
      ['openai-completions'],
    )
  })

  it('captures catalogue defaults separately from the effective values', () => {
    const model = normalizeModel({
      id: 'glm-5.2',
      api: 'openai-completions',
      contextWindow: 500000,
      defaults: { contextWindow: 1000000, maxTokens: 131072, api: 'openai-completions', baseURL: 'https://x/v1' },
    })
    assert.equal(model.contextWindow, 500000)
    assert.deepEqual(model.defaults, {
      contextWindow: 1000000,
      maxTokens: 131072,
      api: 'openai-completions',
      baseURL: 'https://x/v1',
    })
    assert.equal(normalizeModel({ id: 'x', api: 'openai-completions' }).defaults, undefined)
    assert.equal(normalizeDefaults({}), undefined)
    assert.deepEqual(normalizeDefaults({ contextWindow: '10', api: 'google-generative-ai' }), { contextWindow: 10 })
  })

  it('unwraps volatile references on every read', () => {
    let current = 'first'
    const ref = { get: () => current }
    const before = snapshot({ sessionId: ref })
    current = 'second'
    assert.equal(before.sessionId, 'first')
    assert.equal(snapshot({ sessionId: ref }).sessionId, 'second')
  })

  it('declares the volatile fields the import writes', () => {
    for (const field of ['targets', 'models', 'forceSessionHeader', 'retireShipped', 'includeFree', 'exclude']) {
      assert.equal(Config.dict[field].meta?.volatile, true, `${field} must be volatile`)
    }
  })

  it('builds gateway base URLs per protocol', () => {
    assert.equal(baseUrlFor('https://opencode.ai/zen/go', 'openai-completions'), 'https://opencode.ai/zen/go/v1')
    assert.equal(baseUrlFor('https://opencode.ai/zen/go/v1', 'openai-responses'), 'https://opencode.ai/zen/go/v1')
    assert.equal(baseUrlFor('https://opencode.ai/zen/go', 'anthropic-messages'), 'https://opencode.ai/zen/go')
    assert.equal(baseUrlFor('https://opencode.ai/zen/go/v1', 'anthropic-messages'), 'https://opencode.ai/zen/go')
    assert.equal(baseUrlFor('', 'openai-completions'), '')
  })

  it('exposes the interface presets the dialog offers', () => {
    assert.deepEqual(
      PRESETS.map((preset) => preset.api),
      ['openai-completions', 'openai-responses', 'anthropic-messages'],
    )
    assert.ok(PRESETS.every((preset) => typeof preset.label === 'string' && preset.label.length > 0))
    assert.equal(DEFAULT_CONTEXT_WINDOW, 262_144)
  })
})
