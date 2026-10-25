import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { planImport } from '../lib/import-store.js'

const settings = normalizeConfig({
  targets: ['opencode-go', 'opencode'],
  models: [
    { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go', contextWindow: 200000 },
    { id: 'old-model', name: 'Old', api: 'openai-completions', source: 'opencode' },
  ],
})

describe('import store', () => {
  it('notes additions, updates and removals against the stored catalogue', () => {
    const plan = planImport(
      {
        models: [
          { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go', contextWindow: 1000000 },
          { id: 'new-model', name: 'New', api: 'anthropic-messages', source: 'opencode-go' },
        ],
      },
      settings,
    )
    assert.equal(plan.added, 1)
    assert.equal(plan.updated, 1)
    assert.equal(plan.removed, 1)
    assert.deepEqual(plan.models.map((model) => model.id), ['glm-5.2', 'new-model'])
    assert.deepEqual(plan.skipped, [])
  })

  it('fills a missing base URL from the gateway and protocol, and a missing source', () => {
    const plan = planImport(
      {
        models: [
          { id: 'neo', api: 'openai-responses' },
          { id: 'anthropic-one', api: 'anthropic-messages', source: 'unknown-gateway' },
        ],
      },
      settings,
    )
    const [first, second] = plan.models
    assert.equal(first.source, 'opencode-go')
    assert.equal(first.baseURL, 'https://opencode.ai/zen/go/v1')
    assert.equal(second.source, 'opencode-go')
    assert.equal(second.baseURL, 'https://opencode.ai/zen/go')
  })

  it('keeps the submitted order and drops invalid rows with a reason', () => {
    const plan = planImport(
      {
        models: [
          { id: 'z-model', api: 'openai-completions' },
          { id: 'broken' },
          { id: 'a-model', api: 'openai-responses' },
        ],
      },
      settings,
    )
    assert.deepEqual(plan.models.map((model) => model.id), ['z-model', 'a-model'])
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0].reason, /invalid row/)
  })

  it('enables newly imported models and keeps a previously disabled one disabled', () => {
    const stored = normalizeConfig({
      targets: ['opencode-go'],
      models: [
        { id: 'kept-off', name: 'Kept off', api: 'openai-completions', source: 'opencode-go', enabled: false },
        { id: 'kept-on', name: 'Kept on', api: 'openai-completions', source: 'opencode-go' },
      ],
    })
    const plan = planImport(
      {
        models: [
          { id: 'kept-off', api: 'openai-completions' },
          { id: 'kept-on', api: 'openai-completions' },
          { id: 'new-model', api: 'openai-responses' },
          { id: 'explicitly-off', api: 'openai-completions', enabled: false },
        ],
      },
      stored,
    )
    const byId = new Map(plan.models.map((model) => [model.id, model]))
    assert.equal(byId.get('kept-off').enabled, false)
    assert.equal(byId.get('kept-on').enabled, true)
    assert.equal(byId.get('new-model').enabled, true)
    assert.equal(byId.get('explicitly-off').enabled, false)
    assert.equal(plan.enabled, 2)
  })

  it('captures the catalogue statement as the reset-to-defaults snapshot', () => {
    const plan = planImport(
      {
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
      },
      normalizeConfig({ targets: ['opencode-go'] }),
    )
    assert.deepEqual(plan.models[0].defaults, {
      name: 'GLM-5.2',
      api: 'openai-completions',
      baseURL: 'https://opencode.ai/zen/go/v1',
      contextWindow: 1000000,
      maxTokens: 131072,
    })
    assert.equal(plan.models[0].contextWindow, 1000000)
  })

  it('tolerates a missing body without failing', () => {
    const plan = planImport(undefined, settings)
    assert.equal(plan.models.length, 0)
    assert.equal(plan.removed, 2)
    assert.deepEqual(plan.skipped, [])
  })
})
