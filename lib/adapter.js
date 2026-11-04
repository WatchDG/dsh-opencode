/**
 * dsh-opencode — the plugin-owned LLM adapter.
 *
 * One provider route (config `provider`) serves the whole imported catalogue.
 * Each stored model carries its own wire protocol, and the actual streaming is
 * delegated to the pi-ai OpenCode provider object, whose API map dispatches on
 * `model.api` and whose implementations already attach the
 * `x-opencode-session` routing header. That is what lets a single provider hold
 * OpenAI Chat Completions, OpenAI Responses and Anthropic Messages models at
 * once instead of one configured pi-ai route per protocol.
 *
 * The adapter converts the harness request into a pi-ai context, and the pi-ai
 * assistant event stream back into harness StreamChunks. Image occurrences are
 * durable references in that request; `lib/images.js` projects them through the
 * mounted attachment service into the exact bytes this route sends.
 */

import { createModels, envApiKeyAuth, getSupportedThinkingLevels, isContextOverflow } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_MAX_PIXELS,
  baseUrlFor,
  endpointOf,
} from './config.js'
import {
  contentHasImage,
  imageOffloadRequired,
  imageRequestTarget as imageTargetFor,
  messagesHaveLiveImage,
  offloadedImageText,
  prepareRequestImages,
  projectOffloadedImages,
  requestImageBytes,
  requiredImageOffload,
  safeImageAccess,
  userContent,
} from './images.js'

/** Model-level cost placeholder; the harness does not report spend. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Reasoning level labels for the picker. */
const EFFORT_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** Lazily built map of shipped catalog models, by provider id. */
let catalogIndex

/**
 * Shipped pi-ai catalogue models, keyed by provider id then model id.
 * @returns {Map<string, Map<string, any>>}
 */
function catalog() {
  if (catalogIndex !== undefined) return catalogIndex
  catalogIndex = new Map()
  for (const provider of builtinProviders()) {
    const models = new Map()
    for (const model of provider.getModels?.() ?? []) models.set(model.id, model)
    catalogIndex.set(provider.id, models)
  }
  return catalogIndex
}

/**
 * Shipped catalogue model lookup.
 *
 * @param {string} provider pi-ai provider id (`opencode`, `opencode-go`).
 * @param {string} id Model id.
 * @returns {any | undefined}
 */
export function shippedModel(provider, id) {
  return catalog().get(provider)?.get(id)
}

/** A plain error carrying a harness failure code. */
function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Empty pi-ai usage record for a replayed assistant message. */
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
}

/** Parse stored tool-call arguments without failing the replay. */
function parseArguments(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Flatten the text blocks of one message. */
function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Convert one tool declaration to the pi-ai shape. */
function piTool(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/** Tools of one request, without deferred declarations. */
function toolsOf(options) {
  return options.tools?.filter((tool) => !tool.deferLoading).map(piTool)
}

/** Combine request-level text and leading system history into the initial prompt. */
function splitSystemPrompt(options) {
  const text = [options.system]
  let end = 0
  for (const message of options.messages) {
    if (message.role !== 'system') break
    text.push(flattenText(message))
    end += 1
  }
  return {
    systemPrompt: text.filter(Boolean).join('\n\n') || undefined,
    messages: options.messages.slice(end),
  }
}

/** Reject history pi-ai cannot represent. */
function assertSupportedHistory(messages) {
  for (const message of messages) {
    if (message.role !== 'developer' && message.content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw codedError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    // pi-ai carries images only in user and tool-result messages; a session log
    // never stores them anywhere else, so this is a contract assertion.
    if (contentHasImage(message.content) && message.role !== 'user' && message.role !== 'tool') {
      throw codedError(`pi-ai cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system' && message.content.some((block) => block.type !== 'text')) {
      throw codedError('pi-ai cannot represent non-text system messages', 'UNSUPPORTED_CONTENT')
    }
  }
}

/** Convert one harness tool-role message to a pi-ai toolResult. */
function toolResultOf(message, toolNames, content) {
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content.length > 0 ? content : '(no output)' }]
      : content
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: blocks.length > 0 ? blocks : [{ type: 'text', text: '(no output)' }],
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/** Convert one historical assistant message to a pi-ai assistant message. */
function assistantOf(message) {
  const content = []
  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'reasoning') {
      content.push({ type: 'thinking', thinking: block.text })
      continue
    }
    if (block.type === 'tool-call') {
      content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      })
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: message.source?.provider ?? 'dsh-opencode',
    model: message.source?.model ?? 'unknown',
    usage: emptyUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** Convert one developer message to a pi-ai system update carrying tool changes. */
function appendDeveloper(message, options, messages) {
  const content = []
  const toolsAdded = []
  const toolsRemoved = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-addition') {
      const tool = options.tools?.find((candidate) => candidate.name === block.toolName)
      if (tool === undefined) throw codedError(`pi-ai tool update references undeclared tool "${block.toolName}"`, 'INVALID_REQUEST')
      toolsAdded.push(piTool(tool))
      continue
    }
    if (block.type === 'tool-removal') {
      toolsRemoved.push({ name: block.toolName })
      continue
    }
    throw codedError(`pi-ai cannot represent developer content ${block.type}`, 'UNSUPPORTED_CONTENT')
  }
  if (content.length === 0 && toolsAdded.length === 0 && toolsRemoved.length === 0) return
  messages.push({
    role: 'system',
    content,
    timestamp: 0,
    ...(toolsAdded.length === 0 ? {} : { toolsAdded }),
    ...(toolsRemoved.length === 0 ? {} : { toolsRemoved }),
  })
}

/** Assemble the pi-ai request envelope shared by both conversion paths. */
function piContext(systemPrompt, options, messages) {
  const tools = toolsOf(options)
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
  }
}

/**
 * Convert a harness request into the pi-ai context envelope.
 *
 * This is the text-only path: an image occurrence cannot be represented here,
 * so it fails loudly instead of dropping bytes. Requests that carry images go
 * through {@link toPiContextWithImages}.
 *
 * @param {any} options GenerateOptions.
 * @returns {{ systemPrompt?: string, messages: any[], tools?: any[] }}
 */
export function toPiContext(options) {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const toolNames = new Map()
  const messages = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw codedError('dsh-opencode text-only context cannot carry image content', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'developer') {
      appendDeveloper(message, options, messages)
      continue
    }
    if (message.role === 'system') {
      const content = flattenText(message)
      if (content.length > 0) messages.push({ role: 'system', content, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = assistantOf(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      messages.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, flattenText(message)))
      continue
    }
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

/**
 * Convert a harness request that carries image references into the pi-ai
 * context envelope.
 *
 * Every live occurrence is projected through the durable attachment service to
 * the exact request version this route sends (aspect-preserving dimensions
 * inside the pixel budget, re-encoded inside the byte budget), and its
 * model-facing handle text is placed immediately before the bytes. Occurrences
 * the harness marked `offloaded` become placeholder text. When the retained
 * occurrences exceed the route's base64 budget, the request fails with
 * `IMAGE_OFFLOAD_REQUIRED` and the count of additional oldest occurrences to
 * omit: `dsh-compaction-image-offload` records that decision and retries, so a
 * projection is never dropped without a session-log entry.
 *
 * @param {any} options GenerateOptions.
 * @param {{
 *   attachments: any,
 *   resolveImageAccess?: (ref: object) => ({ readonlyPath: string } | undefined),
 *   maxRequestImageBytes?: number,
 *   requestImagePolicy?: { maxPixels: number, maxBytes: number },
 * }} images Durable attachment service and route image budgets.
 * @returns {Promise<{ systemPrompt?: string, messages: any[], tools?: any[] }>}
 */
export async function toPiContextWithImages(options, images) {
  const { attachments, resolveImageAccess, maxRequestImageBytes } = images
  const policy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_REQUEST_IMAGE_MAX_PIXELS,
    maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const accessOf =
    typeof resolveImageAccess === 'function' ? (ref) => safeImageAccess(resolveImageAccess, ref) : undefined
  const requestImages = await prepareRequestImages(split.messages, attachments, policy, options.signal)
  if (maxRequestImageBytes !== undefined && maxRequestImageBytes > 0) {
    const offloadImages = requiredImageOffload(split.messages, maxRequestImageBytes, (block) =>
      requestImageBytes(block, requestImages),
    )
    if (offloadImages > 0) throw imageOffloadRequired(offloadImages, maxRequestImageBytes)
  }
  const exactMessages = projectOffloadedImages(split.messages, (ref) => offloadedImageText(ref, accessOf?.(ref)))
  const toolNames = new Map()
  const messages = []
  for (const message of exactMessages) {
    if (message.role === 'developer') {
      appendDeveloper(message, options, messages)
      continue
    }
    if (message.role === 'system') {
      const content = flattenText(message)
      if (content.length > 0) messages.push({ role: 'system', content, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = assistantOf(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      messages.push(assistant)
      continue
    }
    const content = userContent(message.content, requestImages, accessOf)
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, content))
      continue
    }
    messages.push({ role: 'user', content, timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

/** Map pi-ai usage (reasoning already folded into output). */
function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens ?? usage.input + usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/** Map a terminal pi-ai event to a harness finish reason. */
function mapStopReason(message, contextWindow) {
  if (isContextOverflow(message, contextWindow)) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: 'CONTEXT_WINDOW_EXCEEDED',
      },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: 'EMPTY_RESPONSE',
          },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return {
        kind: 'aborted',
        failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
      }
    case 'pending':
    case 'deferred':
      return {
        kind: 'error',
        failure: {
          message: `pi-ai stream for model "${message.model}" ended ${message.stopReason}`,
          code: 'PI_AI_ERROR',
        },
      }
    default:
      return {
        kind: 'error',
        failure: { message: message.errorMessage ?? 'pi-ai stream error', code: 'PI_AI_ERROR' },
      }
  }
}

/**
 * Translate the pi-ai event stream into harness StreamChunks.
 *
 * @param {AsyncIterable<any>} events
 * @param {number} contextWindow
 * @param {AbortSignal} [callerSignal]
 * @yields {any} StreamChunk
 */
export async function* toStreamChunks(events, contextWindow, callerSignal) {
  const toolIds = new Map()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name === undefined || known.name.length === 0 ? {} : { name: known.name }),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      default:
        break
    }
  }
  throw codedError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}

/**
 * Build the pi-ai model object for one stored row.
 *
 * A row whose id the shipped catalogue knows reuses that model's metadata
 * (compat quirks, thinking map, cost) and only substitutes the fields the
 * import actually chose. A row the catalogue does not know becomes a minimal
 * hand-declared model, which pi-ai supports for the three wire protocols.
 *
 * @param {ReturnType<import('./config.js').normalizeModel>} row
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @param {string} provider Our provider route id.
 * @returns {any} pi-ai model object.
 */
export function buildPiModel(row, settings, provider) {
  const source = row.source ?? settings.targets[0]
  const catalogModel = catalog().get(source)?.get(row.id) ?? catalog().get(settings.targets[0])?.get(row.id)
  const root = endpointOf(settings, source) ?? ''
  const baseUrl = row.baseURL ?? catalogModel?.baseUrl ?? baseUrlFor(root, row.api)
  const base = {
    ...(catalogModel ?? {}),
    id: row.id,
    name: row.name,
    api: row.api,
    provider,
    baseUrl,
    input: row.input.length > 0 ? row.input : (catalogModel?.input ?? ['text']),
    contextWindow: row.contextWindow ?? catalogModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: row.maxTokens ?? catalogModel?.maxTokens ?? DEFAULT_MAX_TOKENS,
    cost: catalogModel?.cost ?? NO_COST,
    type: 'chat',
  }
  if (catalogModel?.api === row.api) return base
  // A protocol override must not inherit the catalog compatibility flags of the
  // model's original protocol.
  const { compat: _compat, thinkingLevelMap: _thinking, reasoning: _reasoning, ...rest } = base
  return { ...rest, reasoning: false }
}

/**
 * Reasoning metadata for one pi-ai model.
 *
 * @param {any} model
 * @returns {{ efforts: Array<{ id: string, name: string }>, defaultEffort?: string } | undefined}
 */
function reasoningInfo(model) {
  if (model.reasoning !== true) return undefined
  const levels = getSupportedThinkingLevels(model)
  if (levels.length === 0) return undefined
  const efforts = levels.map((level) => ({ id: level, name: EFFORT_LABELS[level] ?? level }))
  const defaultEffort = levels.includes('medium') ? 'medium' : levels.find((level) => level !== 'off')
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

/**
 * Credential reference one imported row authenticates through.
 *
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @param {ReturnType<import('./config.js').normalizeModel> | undefined} row
 * @returns {string}
 */
export function apiKeyEnvOf(settings, row) {
  if (row?.source !== undefined) {
    const configured = settings.targetApiKeyEnv[row.source]
    if (typeof configured === 'string' && configured.length > 0) return configured
  }
  return settings.apiKeyEnv
}

/**
 * Static routing header for every request, or undefined when disabled.
 *
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @returns {Record<string, string> | undefined}
 */
export function settingsHeaders(settings) {
  if (!settings.forceSessionHeader) return undefined
  return { [settings.sessionHeader]: settings.sessionId }
}

/**
 * Route image budgets from one settings snapshot.
 *
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings
 * @returns {{ maxPixels: number, maxBytes: number }}
 */
function imagePolicyOf(settings) {
  return { maxPixels: settings.requestImageMaxPixels, maxBytes: settings.requestImageMaxBytes }
}

/**
 * Convert one request into its pi-ai context, projecting durable image
 * references into this route's request versions when the history carries any.
 *
 * The durable attachment service is resolved whenever the history contains an
 * image block at all — even one the harness already offloaded — because the
 * model-facing placeholder still names the normalized read-only copy when the
 * deployment can map it. A missing service is fatal only for a live
 * occurrence, which cannot be represented as bytes without it.
 *
 * @param {any} options GenerateOptions.
 * @param {any} piModel pi-ai model of the request's route.
 * @param {ReturnType<import('./config.js').normalizeConfig>} settings Plugin settings.
 * @param {{
 *   getAttachments?: () => any,
 *   resolveImageAccess?: (attachments: any, ref: object) => ({ readonlyPath: string } | undefined),
 * }} imageAccess Host image capabilities.
 * @returns {Promise<any>} pi-ai context.
 */
export async function buildContext(options, piModel, settings, imageAccess = {}) {
  const hasImage = options.messages.some((message) => contentHasImage(message.content))
  if (!hasImage) return toPiContext(options)
  if (!piModel.input.includes('image')) {
    throw codedError(`dsh-opencode model "${piModel.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  const attachments = imageAccess.getAttachments?.()
  if (messagesHaveLiveImage(options.messages) && attachments === undefined) {
    throw codedError('dsh-opencode image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  return toPiContextWithImages(options, {
    attachments,
    ...(imageAccess.resolveImageAccess === undefined
      ? {}
      : { resolveImageAccess: (ref) => imageAccess.resolveImageAccess(attachments, ref) }),
    ...(settings.maxRequestImageBytes === 0 ? {} : { maxRequestImageBytes: settings.maxRequestImageBytes }),
    requestImagePolicy: imagePolicyOf(settings),
  })
}

/**
 * The plugin's LLM adapter: one provider route, mixed protocols.
 *
 * @param {{
 *   getSettings: () => ReturnType<import('./config.js').normalizeConfig>,
 *   resolveApiKey: (ref: string) => Promise<string | undefined>,
 *   getAttachments?: () => any,
 *   resolveImageAccess?: (attachments: any, ref: object) => ({ readonlyPath: string } | undefined),
 * }} config
 */
export function createAdapter(config) {
  /** Shipped pi-ai OpenCode provider: protocol dispatch + session-header wrapper. */
  let transport
  const transportFor = () => {
    if (transport !== undefined) return transport
    const provider = builtinProviders().find((candidate) => candidate.id === 'opencode')
    if (provider === undefined) throw codedError('pi-ai ships no OpenCode provider', 'NO_ADAPTER')
    transport = provider
    return transport
  }

  /** Build a pi-ai collection for the current stored catalogue. */
  const snapshotModels = () => {
    const settings = config.getSettings()
    const providerId = settings.provider
    const models = createModels()
    const piModels = settings.models.map((row) => buildPiModel(row, settings, providerId))
    const enabledModels = piModels.filter(
      (_model, index) => settings.models[index].enabled !== false,
    )
    models.setProvider({
      id: providerId,
      name: settings.displayName,
      // pi-ai only resolves an explicit `options.apiKey` when the provider
      // declares an api-key method; this one also keeps pi-ai's own env
      // discovery working for a deliberately keyless profile.
      auth: { apiKey: envApiKeyAuth('OpenCode API key', ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY']) },
      // Disabled models stay imported but are not offered to the picker.
      getModels: () => enabledModels,
      stream: (model, context, options) => transportFor().stream(model, context, options),
      streamSimple: (model, context, options) => transportFor().streamSimple(model, context, options),
    })
    return { settings, providerId, models, piModels }
  }

  /** Resolve one stored model, or fail like the shipped adapter does. */
  const modelOf = (snapshot, provider, model) => {
    if (provider !== snapshot.providerId) {
      throw codedError(`dsh-opencode does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    const row = snapshot.settings.models.find((candidate) => candidate.id === model)
    if (row === undefined) {
      throw codedError(`dsh-opencode provider "${provider}" has no imported model "${model}"`, 'UNKNOWN_MODEL')
    }
    if (row.enabled === false) {
      throw codedError(
        `dsh-opencode model "${model}" is imported but disabled; enable it on the OpenCode card in Settings -> Models`,
        'UNKNOWN_MODEL',
      )
    }
    return snapshot.piModels.find((candidate) => candidate.id === model)
  }

  /** Harness model metadata for one pi-ai model. */
  const modelInfo = (provider, model) => {
    const reasoning = reasoningInfo(model)
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
      context: { contextWindow: model.contextWindow },
      ...(model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  }

  return {
    providerInfo(provider) {
      const settings = config.getSettings()
      return { id: provider, name: settings.displayName }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(provider, model, image) {
      const snapshot = snapshotModels()
      modelOf(snapshot, provider, model)
      return imageTargetFor(image, imagePolicyOf(snapshot.settings))
    },
    listModels(provider) {
      const { settings, providerId } = snapshotModels()
      if (provider !== providerId) return Promise.resolve([])
      return Promise.resolve(
        settings.models
          .filter((row) => row.enabled !== false)
          .map((row) => ({
            provider,
            id: row.id,
            name: row.name,
            inputModalities: [...row.input],
          })),
      )
    },
    resolveModel(provider, model) {
      return Promise.resolve().then(() => {
        const snapshot = snapshotModels()
        return modelInfo(provider, modelOf(snapshot, provider, model))
      })
    },
    prepareCall(provider, model) {
      const snapshot = snapshotModels()
      const piModel = modelOf(snapshot, provider, model)
      return Promise.resolve({
        model: modelInfo(provider, piModel),
        stream: (options) => this.stream({ ...options, provider, model }),
      })
    },
    async *stream(options) {
      if (options.stop !== undefined) {
        throw codedError('dsh-opencode does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
      }
      const snapshot = snapshotModels()
      const piModel = modelOf(snapshot, options.provider, options.model)
      const row = snapshot.settings.models.find((candidate) => candidate.id === options.model)
      const apiKey = await config.resolveApiKey(apiKeyEnvOf(snapshot.settings, row))
      const context = await buildContext(options, piModel, snapshot.settings, {
        getAttachments: config.getAttachments,
        resolveImageAccess: config.resolveImageAccess,
      })
      const headers = settingsHeaders(snapshot.settings)
      const stream = snapshot.models.streamSimple(piModel, context, {
        ...(apiKey === undefined ? {} : { apiKey }),
        sessionId: snapshot.settings.sessionId,
        ...(headers === undefined ? {} : { headers }),
        ...(options.reasoningEffort === undefined || options.reasoningEffort === 'off'
          ? {}
          : { reasoning: options.reasoningEffort }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        maxRetries: 0,
      })
      yield* toStreamChunks(stream, piModel.contextWindow, options.signal)
    },
  }
}
