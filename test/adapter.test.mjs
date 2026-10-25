import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildPiModel,
  createAdapter,
  settingsHeaders,
  shippedModel,
  toPiContext,
  toStreamChunks,
} from '../lib/adapter.js'
import { normalizeConfig } from '../lib/config.js'

const settings = normalizeConfig({
  targets: ['opencode-go', 'opencode'],
  models: [
    { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go', contextWindow: 1000000, maxTokens: 131072 },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', api: 'anthropic-messages', source: 'opencode-go' },
    {
      id: 'fresh-model',
      name: 'Fresh',
      api: 'openai-responses',
      source: 'opencode-go',
      contextWindow: 200000,
      maxTokens: 32000,
      input: ['text', 'image'],
    },
  ],
})

describe('adapter', () => {
  it('reuses shipped catalogue metadata for a known id', () => {
    const model = buildPiModel(settings.models[0], settings, 'opencode-live')
    assert.equal(model.id, 'glm-5.2')
    assert.equal(model.provider, 'opencode-live')
    assert.equal(model.api, 'openai-completions')
    assert.equal(model.baseUrl, 'https://opencode.ai/zen/go/v1')
    assert.equal(model.contextWindow, 1000000)
    assert.equal(model.reasoning, true)
    assert.ok(model.compat !== undefined)
    assert.equal(typeof shippedModel('opencode-go', 'glm-5.2').api, 'string')
  })

  it('builds a minimal hand-declared model for an id the catalogue does not know', () => {
    const model = buildPiModel(settings.models[2], settings, 'opencode-live')
    assert.equal(model.api, 'openai-responses')
    assert.equal(model.provider, 'opencode-live')
    assert.equal(model.baseUrl, 'https://opencode.ai/zen/go/v1')
    assert.equal(model.contextWindow, 200000)
    assert.equal(model.maxTokens, 32000)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.equal(model.reasoning, false)
    assert.equal(model.compat, undefined)
  })

  it('serves the stored catalogue through one provider route', async () => {
    const adapter = createAdapter({ getSettings: () => settings, resolveApiKey: async () => undefined })
    assert.deepEqual(adapter.providerInfo('opencode-live'), { id: 'opencode-live', name: 'OpenCode' })
    const models = await adapter.listModels('opencode-live')
    assert.deepEqual(models.map((model) => model.id), ['glm-5.2', 'claude-haiku-5-5', 'fresh-model'])
    assert.deepEqual(await adapter.listModels('other'), [])

    const info = await adapter.resolveModel('opencode-live', 'fresh-model')
    assert.equal(info.context.contextWindow, 200000)
    assert.equal(info.defaultMaxTokens, 32000)
    assert.deepEqual(info.inputModalities, ['text', 'image'])

    const prepared = await adapter.prepareCall('opencode-live', 'claude-haiku-5-5')
    assert.equal(prepared.model.id, 'claude-haiku-5-5')
    await assert.rejects(adapter.resolveModel('opencode-live', 'absent'), /no imported model/)
    await assert.rejects(adapter.resolveModel('someone-else', 'glm-5.2'), /does not own provider/)
  })

  it('omits disabled models from the provider catalogue and refuses them', async () => {
    const disabled = normalizeConfig({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', source: 'opencode-go' },
        { id: 'off-model', name: 'Off', api: 'openai-completions', source: 'opencode-go', enabled: false },
      ],
    })
    const adapter = createAdapter({ getSettings: () => disabled, resolveApiKey: async () => undefined })
    const models = await adapter.listModels('opencode-live')
    assert.deepEqual(models.map((model) => model.id), ['glm-5.2'])
    await assert.rejects(adapter.resolveModel('opencode-live', 'off-model'), /imported but disabled/)
  })

  it('reports reasoning efforts for a reasoning model', async () => {
    const adapter = createAdapter({ getSettings: () => settings, resolveApiKey: async () => undefined })
    const info = await adapter.resolveModel('opencode-live', 'glm-5.2')
    assert.ok(Array.isArray(info.reasoning.efforts))
    assert.ok(info.reasoning.efforts.length > 0)
    assert.ok(info.reasoning.efforts.every((effort) => typeof effort.id === 'string' && typeof effort.name === 'string'))
  })

  it('sends the static session header unless disabled', () => {
    assert.deepEqual(settingsHeaders(settings), { 'x-opencode-session': 'dsh-opencode' })
    assert.equal(settingsHeaders(normalizeConfig({ forceSessionHeader: false })), undefined)
  })

  it('converts a harness conversation to a pi-ai context', () => {
    const context = toPiContext({
      system: 'sys',
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'leading' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          source: { kind: 'model', provider: 'opencode-live', model: 'glm-5.2' },
          content: [
            { type: 'reasoning', text: 'hm' },
            { type: 'text', text: 'calling' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file body' }] },
        { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
      ],
    })
    assert.equal(context.systemPrompt, 'sys\n\nleading')
    assert.equal(context.tools.length, 1)
    assert.equal(context.messages[0].role, 'user')
    assert.equal(context.messages[0].content, 'hi')
    const assistant = context.messages[1]
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content[0].type, 'thinking')
    assert.equal(assistant.content[2].type, 'toolCall')
    assert.deepEqual(assistant.content[2].arguments, { path: 'a' })
    const toolResult = context.messages[2]
    assert.equal(toolResult.role, 'toolResult')
    assert.equal(toolResult.toolName, 'read')
    assert.equal(toolResult.content[0].text, 'file body')
  })

  it('refuses image content honestly', () => {
    assert.throws(
      () => toPiContext({ messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] }),
      /does not forward image content/,
    )
  })

  it('maps the pi-ai event stream to harness chunks', async () => {
    async function* events() {
      yield { type: 'start', partial: {} }
      yield { type: 'text_start', contentIndex: 0, partial: {} }
      yield { type: 'text_delta', contentIndex: 0, delta: 'he' }
      yield { type: 'text_delta', contentIndex: 0, delta: 'llo' }
      yield { type: 'text_end', contentIndex: 0, content: 'hello', partial: {} }
      yield {
        type: 'toolcall_start',
        contentIndex: 1,
        partial: { content: [{}, { type: 'toolCall', id: 'call-1', name: 'read' }] },
      }
      yield { type: 'toolcall_delta', contentIndex: 1, delta: '{"path":', partial: {} }
      yield { type: 'toolcall_delta', contentIndex: 1, delta: '"a"}', partial: {} }
      yield { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'call-1', name: 'read', arguments: { path: 'a' } } }
      yield {
        type: 'done',
        message: {
          model: 'glm-5.2',
          content: [{ type: 'text', text: 'hello' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }],
          stopReason: 'toolUse',
          usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 2, cacheWrite: 0 },
        },
      }
    }
    const chunks = []
    for await (const chunk of toStreamChunks(events(), 1000000)) chunks.push(chunk)
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      [
        'block-start',
        'text-delta',
        'text-delta',
        'block-end',
        'block-start',
        'tool-call-delta',
        'tool-call-delta',
        'block-end',
        'usage',
        'finish',
      ],
    )
    assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
    assert.equal(chunks[5].name, 'read')
    assert.deepEqual(chunks[7].block, {
      type: 'tool-call',
      id: 'call-1',
      name: 'read',
      arguments: '{"path":"a"}',
    })
    assert.equal(chunks[8].usage.inputTokens, 10)
    assert.equal(chunks[8].usage.cacheReadTokens, 2)
    assert.deepEqual(chunks[9].reason, { kind: 'tool-calls' })
  })

  it('turns a pi-ai error event into an error finish', async () => {
    async function* events() {
      yield {
        type: 'error',
        error: {
          model: 'glm-5.2',
          content: [],
          stopReason: 'error',
          errorMessage: 'upstream 500',
          usage: { input: 1, output: 0, totalTokens: 1, cacheRead: 0, cacheWrite: 0 },
        },
      }
    }
    const chunks = []
    for await (const chunk of toStreamChunks(events(), 1000000)) chunks.push(chunk)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.message, 'upstream 500')
  })
})
