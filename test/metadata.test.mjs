import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyProtocol,
  fetchCatalogue,
  readCatalogueSlice,
  readMetadataModel,
  readProviderMetadata,
  readSliceCache,
  writeSliceCache,
} from '../lib/metadata.js'

const catalogue = {
  'opencode-go': {
    name: 'OpenCode Go',
    models: {
      'claude-haiku-5-5': {
        name: 'Claude Haiku 5.5',
        limit: { context: 200000, output: 64000 },
        modalities: { input: ['text', 'image', 'pdf'] },
        provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/anthropic/v1' },
      },
      'gpt-5.6-luna': {
        name: 'GPT-5.6 Luna',
        provider: { npm: '@ai-sdk/openai' },
      },
      'gemini-4-argon': { provider: { npm: '@ai-sdk/google' } },
      'glm-5.2': { provider: { api: 'https://opencode.ai/inference/openai/v1' } },
    },
  },
}

describe('metadata', () => {
  it('classifies the wire protocol from SDK metadata', () => {
    assert.equal(classifyProtocol({ provider: { npm: '@ai-sdk/anthropic' } }), 'anthropic-messages')
    assert.equal(classifyProtocol({ provider: { npm: '@ai-sdk/openai' } }), 'openai-responses')
    assert.equal(classifyProtocol({ provider: { npm: '@ai-sdk/google' } }), 'google-generative-ai')
    assert.equal(classifyProtocol({ provider: { api: 'https://opencode.ai/inference/openai/v1' } }), 'openai-completions')
    assert.equal(classifyProtocol(undefined), 'openai-completions')
  })

  it('projects ids, capacities and modalities', () => {
    const entry = readMetadataModel(catalogue['opencode-go'].models['claude-haiku-5-5'], 'claude-haiku-5-5')
    assert.deepEqual(entry.input, ['text', 'image'])
    assert.equal(entry.contextWindow, 200000)
    assert.equal(entry.maxTokens, 64000)
    assert.equal(entry.protocol, 'anthropic-messages')
    assert.equal(readMetadataModel({}, 'fallback').id, 'fallback')
    assert.equal(readMetadataModel(null, ''), undefined)
  })

  it('projects a provider slice for the import cache', () => {
    const body = readProviderMetadata(catalogue, 'opencode-go')
    assert.equal(body.displayName, 'OpenCode Go')
    assert.equal(body.models.size, 4)
    const slice = readCatalogueSlice(catalogue, ['opencode-go', 'absent'])
    assert.deepEqual(Object.keys(slice), ['opencode-go'])
    assert.equal(slice['opencode-go'].length, 4)
  })

  it('keeps the last good body when the network fails and persists a slice', async () => {
    const url = 'https://catalogue.test/api.json'
    let mode = 'ok'
    const fetchImpl = async () => {
      if (mode === 'fail') throw new Error('offline')
      return new Response(JSON.stringify(catalogue), { status: 200 })
    }
    const first = await fetchCatalogue({ url, timeoutMs: 1_000, fetchImpl })
    assert.equal(first['opencode-go'].name, 'OpenCode Go')
    mode = 'fail'
    assert.equal((await fetchCatalogue({ url, timeoutMs: 1_000, fetchImpl }))['opencode-go'].name, 'OpenCode Go')

    const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-meta-'))
    try {
      const path = join(dir, 'nested', 'catalogue.json')
      const slice = readCatalogueSlice(catalogue, ['opencode-go'])
      assert.equal(writeSliceCache(path, slice), true)
      const restored = readSliceCache(path)
      assert.equal(restored['opencode-go'].length, 4)
      assert.equal(readSliceCache(join(dir, 'missing.json'))['opencode-go'], undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
