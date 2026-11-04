/**
 * dsh-opencode — durable image references and pi-ai request images.
 *
 * Harness history carries images as durable references
 * (`{ type: 'image', attachment: { attachmentId, mediaType, width, height, ... } }`),
 * never as bytes: the append-only session log stays small and one attachment
 * may serve every route. A provider adapter must project each reference into
 * the exact version it will send — resized inside a pixel budget and re-encoded
 * inside a byte budget — through the mounted attachment service, and must
 * replace occurrences the harness marked `offloaded` with stable placeholder
 * text.
 *
 * The helpers here are the pure and service-facing pieces of that projection;
 * `lib/adapter.js` turns the result into pi-ai user/tool content. Text formats
 * match the shipped pi-ai adapter, so a conversation moved between routes
 * keeps the same model-facing image handles.
 *
 * They are kept local rather than imported from the installed harness packages:
 * a profile plugin installed as a `link:` dependency cannot resolve
 * installation-scope packages (the Loader only intercepts linked plugins that
 * declare them in `peerDependencies`), and duplicating the pure arithmetic is
 * preferable to a second module instance of the harness classes. The tests
 * pin the dimensions and base64 accounting against the documented values.
 */

/** Stable code the harness routes automatic image offloading on. */
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED'

/** A coded error carrying a harness failure code. */
function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Whether typed content carries any image block, offloaded or not. */
export function contentHasImage(content) {
  return Array.isArray(content) && content.some((block) => block.type === 'image')
}

/** Whether typed content carries an image block that still needs request bytes. */
function contentHasLiveImage(content) {
  return Array.isArray(content) && content.some((block) => block.type === 'image' && block.offloaded !== true)
}

/** Whether a message list carries any live image occurrence. */
export function messagesHaveLiveImage(messages) {
  return messages.some((message) => contentHasLiveImage(message.content))
}

/**
 * Aspect-preserving integer dimensions within a hard total-pixel budget.
 * Small images are never enlarged.
 *
 * @param {number} width Positive source width.
 * @param {number} height Positive source height.
 * @param {number} maxPixels Positive width-times-height cap.
 * @returns {{ width: number, height: number }}
 */
export function requestImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/** Base64 length of raw bytes, including padding. */
export function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/**
 * The exact request-image target this route asks the attachment service for.
 *
 * @param {{ width: number, height: number }} attachment Durable image reference.
 * @param {{ maxPixels: number, maxBytes: number }} policy Route image budgets.
 * @returns {{ width: number, height: number, maxBytes: number }}
 */
export function imageRequestTarget(attachment, policy) {
  return {
    ...requestImageDimensions(attachment.width, attachment.height, policy.maxPixels),
    maxBytes: policy.maxBytes,
  }
}

/** Image identity used in model-facing handle text. */
function imageIdentity(ref) {
  return ref.name === undefined ? String(ref.attachmentId) : `${JSON.stringify(ref.name)} (${ref.attachmentId})`
}

/** File extension of a normalized image media type. */
function extension(mediaType) {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return ''
  }
}

/** Describe the resolved read-only copy of the normalized attachment. */
function normalizedAccessText(ref, access) {
  const suffix = extension(ref.mediaType)
  return (
    ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(access.readonlyPath)}` +
    ` (${ref.width}x${ref.height}px, ${ref.mediaType}).` +
    ' Source dimensions, format, and byte size may differ.' +
    (suffix.length === 0 ? '' : ` Copy to a writable path ending in ${suffix} before editing.`)
  )
}

/**
 * Stable model-facing handle for one exact request image, placed beside its
 * bytes so the model can name the image and (with a filesystem mapping) reach
 * the normalized copy with its own tools.
 *
 * @param {object} ref Durable image reference of one occurrence.
 * @param {{ width: number, height: number }} version Exact request-image version.
 * @param {{ readonlyPath: string } | undefined} access Resolved tool-world path.
 * @returns {string}
 */
export function requestImageHandleText(ref, version, access) {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Stable placeholder for one image occurrence omitted from this request.
 *
 * @param {object} ref Durable image reference of the omitted occurrence.
 * @param {{ readonlyPath: string } | undefined} access Resolved tool-world path.
 * @returns {string}
 */
export function offloadedImageText(ref, access) {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * Stable placeholder for one stored image whose bytes cannot be read (a
 * reference from another deployment, a retired attachment, or a damaged store).
 * The turn continues with a placeholder instead of failing; the model is told
 * that bytes were unavailable, not that a request budget omitted them.
 *
 * @param {object} ref Durable image reference of the unreadable occurrence.
 * @param {{ readonlyPath: string } | undefined} access Resolved tool-world path.
 * @returns {string}
 */
export function unreadableImageText(ref, access) {
  const identity = `image could not be read from the attachment store; ${imageIdentity(ref)}.`
  if (access === undefined) return `[${identity} Ask the user to attach it again if needed.]`
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * Replace every occurrence the harness marked `offloaded` with placeholder text,
 * preserving message order.
 *
 * @param {any[]} messages Harness messages.
 * @param {(ref: object) => string} placeholder Placeholder text for one reference.
 * @returns {any[]}
 */
export function projectOffloadedImages(messages, placeholder) {
  return messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    let next
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'image' || block.offloaded !== true) {
        next?.push(block)
        continue
      }
      const attachment = block.attachment
      next ??= message.content.slice(0, index)
      next.push({
        type: 'text',
        text: attachment === null || typeof attachment !== 'object' ? '' : placeholder(attachment),
      })
    }
    return next === undefined ? message : { ...message, content: next }
  })
}

/**
 * How many oldest retained image occurrences must still be offloaded before the
 * request fits its base64 budget. The harness records that decision as one
 * `image/offload` event and retries; a route never sends an unrecorded
 * projection. This route only ever sends base64, so the harness's generic budget
 * arithmetic (representation, count and byte quanta) is specialized to that one
 * representation: base64 length, one occurrence at a time.
 *
 * @param {any[]} messages Harness messages, offloaded marks included.
 * @param {number} maxBytes Base64 budget of the whole request.
 * @param {(block: { attachment: object }) => number} versionBytes Raw byte length of one request version.
 * @returns {number} Leading retained occurrences to offload; zero when the request fits.
 */
export function requiredImageOffload(messages, maxBytes, versionBytes) {
  const lengths = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      lengths.push(base64Length(versionBytes(block)))
    }
  }
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excess = Math.max(0, total - maxBytes)
  if (excess === 0) return 0
  let count = 0
  let removed = 0
  for (const bytes of lengths) {
    if (removed >= excess) break
    removed += bytes
    count += 1
  }
  return count
}

/**
 * Failure the harness routes to `dsh-compaction-image-offload`.
 *
 * The harness trusts the carried `failure` snapshot only when its `code`
 * agrees with the error's own `code`, so both are set: a plain host error
 * still produces a routable failure without importing harness classes.
 *
 * @param {number} offloadImages Additional oldest occurrences to omit.
 * @param {number} maxBytes Base64 budget that was exceeded.
 * @returns {Error}
 */
export function imageOffloadRequired(offloadImages, maxBytes) {
  const message =
    `dsh-opencode request images exceed the ${maxBytes}-byte base64 bound; ` +
    `${offloadImages} more oldest occurrence(s) must be offloaded.`
  const error = codedError(message, IMAGE_OFFLOAD_REQUIRED_CODE)
  error.failure = Object.freeze({ message, code: IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages })
  return error
}

/**
 * Derive the request version of every live image occurrence in message order.
 *
 * The attachment service resolves each durable reference into deterministic
 * route-sized bytes and caches the result, so one reference shared by several
 * occurrences is read once. An occurrence whose bytes cannot be derived (a
 * reference from another machine or a damaged store) becomes `null`: the
 * adapter then sends the offload placeholder instead of failing the whole turn.
 *
 * @param {any[]} messages Harness messages after the system-prefix split.
 * @param {{ readImageRequest: (ref: object, target: object, signal?: AbortSignal) => Promise<any> }} attachments Mounted durable attachment service.
 * @param {{ maxPixels: number, maxBytes: number }} policy Route image budgets.
 * @param {AbortSignal | undefined} signal Caller cancellation.
 * @returns {Promise<Map<string, any | null>>} Request version per attachment id.
 */
export async function prepareRequestImages(messages, attachments, policy, signal) {
  const refs = new Map()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      const attachment = block.attachment
      if (attachment === null || typeof attachment !== 'object') continue
      const id = String(attachment.attachmentId)
      if (!refs.has(id)) refs.set(id, attachment)
    }
  }
  // A request whose images are all offloaded needs no service: every
  // occurrence becomes placeholder text.
  if (refs.size === 0) return new Map()
  if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
    throw codedError('dsh-opencode image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const versions = new Map()
  await Promise.all(
    [...refs.values()].map(async (ref) => {
      try {
        const version = await attachments.readImageRequest(ref, imageRequestTarget(ref, policy), signal)
        versions.set(String(ref.attachmentId), version)
      } catch (error) {
        if (signal?.aborted === true) throw error
        versions.set(String(ref.attachmentId), null)
      }
    }),
  )
  return versions
}

/**
 * Raw byte length of the request version one occurrence will send. An omitted
 * (unreadable) occurrence sends only placeholder text, so it contributes
 * nothing to the request budget; an unprepared one falls back to the durable
 * reference size.
 *
 * @param {{ attachment: object }} block Harness image block.
 * @param {Map<string, any | null>} requestImages Prepared versions by attachment id.
 * @returns {number}
 */
export function requestImageBytes(block, requestImages) {
  const version = requestImages.get(String(block.attachment?.attachmentId))
  if (version === null) return 0
  if (version !== undefined) {
    if (Number.isFinite(version.bytes)) return version.bytes
    return Number.isFinite(version.data?.byteLength) ? version.data.byteLength : 1
  }
  return Number.isFinite(block.attachment?.bytes) ? block.attachment.bytes : 1
}

/**
 * Convert one harness message's content blocks into pi-ai user content:
 * text blocks stay text, image blocks become a model-facing handle plus pi-ai
 * `ImageContent`. The result is a plain string when no image survived.
 *
 * @param {any[]} blocks Harness content blocks.
 * @param {Map<string, any | null>} requestImages Prepared request versions.
 * @param {(ref: object) => ({ readonlyPath: string } | undefined)} [resolveImageAccess] Tool-world mapping for handle text.
 * @returns {string | any[]}
 */
export function userContent(blocks, requestImages, resolveImageAccess) {
  const content = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    const attachment = block.attachment
    if (attachment === null || typeof attachment !== 'object') continue
    const id = String(attachment.attachmentId)
    const version = requestImages.get(id)
    const access = resolveImageAccess === undefined ? undefined : safeImageAccess(resolveImageAccess, attachment)
    if (version === undefined || version === null) {
      content.push({ type: 'text', text: unreadableImageText(attachment, access) })
      continue
    }
    content.push({ type: 'text', text: requestImageHandleText(attachment, version, access) })
    content.push({
      type: 'image',
      data: Buffer.from(version.data).toString('base64'),
      mimeType: version.mediaType,
    })
  }
  if (content.every((block) => block.type === 'text')) return content.map((block) => block.text).join('')
  return content
}

/**
 * Resolve one tool-world mapping without failing the request on a bad reference.
 *
 * @param {(ref: object) => ({ readonlyPath: string } | undefined)} [resolveImageAccess] Host mapping.
 * @param {object} attachment Durable image reference.
 * @returns {{ readonlyPath: string } | undefined}
 */
export function safeImageAccess(resolveImageAccess, attachment) {
  if (typeof resolveImageAccess !== 'function') return undefined
  try {
    return resolveImageAccess(attachment) ?? undefined
  } catch {
    return undefined
  }
}
