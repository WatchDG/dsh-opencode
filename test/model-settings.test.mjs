import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { planModelSettings, statusModel } from '../lib/model-settings.js'

const settings = normalizeConfig({
  targets: ['opencode-go', 'opencode'],
  models: [
    {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      api: 'openai-completions',
      baseURL: 'https://opencode.ai/zen/go/v1',
      contextWindow: 1000000,
      maxTokens: 131072,
      source: 'opencode-go',
      enabled: true,
      defaults: {
        name: 'GLM-5.2',
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1',
        contextWindow: 1000000,
        maxTokens: 131072,
      },
    },
    {
      id: 'legacy-model',
      name: 'Legacy',
      api: 'openai-completions',
      source: 'opencode',
      enabled: false,
    },
  ],
})

describe('model settings', () => {
  it('projects a status row with defaults', () => {
    assert.deepEqual(statusModel(settings.models[0]), {
      id: 'glm-5.2',
      name: 'GLM-5.2',
      api: 'openai-completions',
      source: 'opencode-go',
      enabled: true,
      contextWindow: 1000000,
      maxTokens: 131072,
      defaults: { contextWindow: 1000000, maxTokens: 131072, api: 'openai-completions' },
    })
    assert.deepEqual(statusModel(settings.models[1]).defaults, null)
  })

  it('overrides one field and keeps the default snapshot', () => {
    const plan = planModelSettings(settings, { id: 'glm-5.2', contextWindow: 500000 })
    assert.equal(plan.models[0].contextWindow, 500000)
    assert.equal(plan.models[0].defaults.contextWindow, 1000000)
    assert.deepEqual(plan.model, statusModel(plan.models[0]))
    // Other rows and fields untouched.
    assert.equal(plan.models[1].id, 'legacy-model')
    assert.equal(plan.models[0].maxTokens, 131072)
  })

  it('resets one field with null and everything with reset', () => {
    const changed = planModelSettings(settings, { id: 'glm-5.2', contextWindow: 10, maxTokens: 20 })
    const fieldReset = planModelSettings(
      normalizeConfig({ ...settings, models: changed.models }),
      { id: 'glm-5.2', maxTokens: null },
    )
    assert.equal(fieldReset.models[0].maxTokens, 131072)
    assert.equal(fieldReset.models[0].contextWindow, 10)

    const allReset = planModelSettings(
      normalizeConfig({ ...settings, models: changed.models }),
      { id: 'glm-5.2', reset: true },
    )
    assert.equal(allReset.models[0].contextWindow, 1000000)
    assert.equal(allReset.models[0].maxTokens, 131072)
  })

  it('rewrites the endpoint when the interface changes', () => {
    const plan = planModelSettings(settings, { id: 'glm-5.2', api: 'anthropic-messages' })
    assert.equal(plan.models[0].api, 'anthropic-messages')
    assert.equal(plan.models[0].baseURL, 'https://opencode.ai/zen/go')
    const restored = planModelSettings(
      normalizeConfig({ ...settings, models: plan.models }),
      { id: 'glm-5.2', api: null },
    )
    assert.equal(restored.models[0].api, 'openai-completions')
    assert.equal(restored.models[0].baseURL, 'https://opencode.ai/zen/go/v1')
  })

  it('rejects unknown ids, bad values and empty edits', () => {
    assert.throws(() => planModelSettings(settings, {}), /must name a model id/)
    assert.throws(() => planModelSettings(settings, { id: 'absent' }), /no imported model/)
    assert.throws(() => planModelSettings(settings, { id: 'glm-5.2', contextWindow: 0 }), /positive integer/)
    assert.throws(() => planModelSettings(settings, { id: 'glm-5.2', maxTokens: 'many' }), /positive integer/)
    assert.throws(() => planModelSettings(settings, { id: 'glm-5.2', api: 'nope' }), /unknown interface/)
    assert.throws(() => planModelSettings(settings, { id: 'glm-5.2' }), /no setting to change/)
    assert.throws(() => planModelSettings(settings, { id: 'legacy-model', reset: true }), /defaults .* unknown/)
    assert.throws(() => planModelSettings(settings, { id: 'legacy-model', api: null }), /no captured default/)
  })
})
