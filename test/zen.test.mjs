import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fetchLiveModels, listingUrls, readListing } from '../lib/zen.js'

/** Build a fake fetch that answers each URL from a table. */
function fakeFetch(table, calls = []) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    const entry = table[url]
    if (entry === undefined) throw new Error(`unexpected URL ${url}`)
    return new Response(entry.body, { status: entry.status ?? 200 })
  }
}

const base = {
  root: 'https://opencode.ai/zen/go',
  apiKey: 'test-key',
  sessionHeader: 'x-opencode-session',
  sessionId: 'session-value',
  timeoutMs: 1_000,
}

describe('zen listing', () => {
  it('builds the standard and fallback URLs', () => {
    assert.deepEqual(listingUrls('https://opencode.ai/zen/'), [
      'https://opencode.ai/zen/v1/models',
      'https://opencode.ai/zen/models',
    ])
    assert.deepEqual(listingUrls(''), [])
  })

  it('reads the OpenAI list shape and ignores non-object rows', () => {
    const models = readListing({
      object: 'list',
      data: [{ id: 'glm-5.2' }, { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' }, null, { nope: 1 }],
    })
    assert.deepEqual(
      models.map((model) => model.id),
      ['glm-5.2', 'gpt-5.6-luna'],
    )
    assert.equal(models[1].name, 'GPT 5.6 Luna')
  })

  it('reads an enriched models map', () => {
    const models = readListing({ models: { 'claude-haiku-5-5': { name: 'Claude Haiku 5.5', limit: { context: 200000, output: 64000 } } } })
    assert.deepEqual(models, [
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 200000, maxTokens: 64000 },
    ])
  })

  it('sends the bearer key and the session header on the listing request', async () => {
    const calls = []
    const fetchImpl = fakeFetch(
      { 'https://opencode.ai/zen/go/v1/models': { body: JSON.stringify({ data: [{ id: 'glm-5.2' }] }) } },
      calls,
    )
    const result = await fetchLiveModels({ ...base, fetchImpl })
    assert.equal(result.models.length, 1)
    assert.equal(calls[0].headers.authorization, 'Bearer test-key')
    assert.equal(calls[0].headers['x-opencode-session'], 'session-value')
  })

  it('falls through a 404 listing path to the next candidate', async () => {
    const calls = []
    const fetchImpl = fakeFetch(
      {
        'https://opencode.ai/zen/go/v1/models': { status: 404, body: 'not found' },
        'https://opencode.ai/zen/go/models': { body: JSON.stringify({ data: [{ id: 'glm-5.2' }] }) },
      },
      calls,
    )
    const result = await fetchLiveModels({ ...base, fetchImpl })
    assert.equal(result.url, 'https://opencode.ai/zen/go/models')
    assert.equal(calls.length, 2)
  })

  it('reports an invalid credential instead of falling through', async () => {
    const calls = []
    const fetchImpl = fakeFetch(
      { 'https://opencode.ai/zen/go/v1/models': { status: 401, body: JSON.stringify({ error: { message: 'Invalid credential' } }) } },
      calls,
    )
    await assert.rejects(fetchLiveModels({ ...base, fetchImpl }), /401.*OpenCode credential.*Invalid credential/)
    assert.equal(calls.length, 1)
  })

  it('reports a transport failure after trying every path', async () => {
    const fetchImpl = async () => {
      throw new Error('offline')
    }
    await assert.rejects(fetchLiveModels({ ...base, fetchImpl }), /listing failed.*could not reach/)
  })
})
