import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  base64Length,
  imageOffloadRequired,
  imageRequestTarget,
  offloadedImageText,
  prepareRequestImages,
  projectOffloadedImages,
  requestImageBytes,
  requestImageDimensions,
  requestImageHandleText,
  requiredImageOffload,
  safeImageAccess,
  unreadableImageText,
  userContent,
} from '../lib/images.js'

/** One durable image reference with the stored shape. */
function imageRef(overrides = {}) {
  return {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png',
    bytes: 3,
    width: 4000,
    height: 3000,
    ...overrides,
  }
}

/** Fake durable attachment service recording every projection request. */
function attachmentsFor(versions = {}) {
  const calls = []
  return {
    calls,
    imageHostPath: (ref) => `/host/${String(ref.attachmentId).slice(7, 15)}.png`,
    async readImageRequest(ref, target) {
      calls.push({ ref, target })
      const entry = versions[ref.attachmentId] ?? { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
      return {
        variantId: 'sha256:variant',
        attachment: ref,
        data: entry.data,
        mediaType: entry.mediaType,
        bytes: entry.data.byteLength,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
}

describe('request images', () => {
  it('fits images inside the pixel budget without enlarging them', () => {
    assert.deepEqual(requestImageDimensions(100, 50, 4_194_304), { width: 100, height: 50 })
    assert.deepEqual(requestImageDimensions(4000, 3000, 4_194_304), { width: 2364, height: 1773 })
    assert.deepEqual(requestImageDimensions(3000, 4000, 4_194_304), { width: 1773, height: 2364 })
    const slim = requestImageDimensions(100_000, 10, 1000)
    assert.deepEqual(slim, { width: 1000, height: 1 })
    assert.ok(slim.width * slim.height <= 1000)
  })

  it('computes the exact base64 length of raw bytes', () => {
    assert.equal(base64Length(0), 0)
    assert.equal(base64Length(1), 4)
    assert.equal(base64Length(3), 4)
    assert.equal(base64Length(4), 8)
    assert.equal(base64Length(3_000_000), 4_000_000)
  })

  it('derives the route target from the image reference', () => {
    const target = imageRequestTarget(imageRef(), { maxPixels: 4_194_304, maxBytes: 1_048_576 })
    assert.deepEqual(target, { width: 2364, height: 1773, maxBytes: 1_048_576 })
  })

  it('counts the oldest occurrences a base64 budget must offload', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', attachment: imageRef({ attachmentId: 'sha256:a' }) }] },
      { role: 'tool', content: [{ type: 'image', attachment: imageRef({ attachmentId: 'sha256:b' }) }] },
    ]
    const bytesOf = () => 3
    // Two 3-byte images are 4 base64 characters each.
    assert.equal(requiredImageOffload(messages, 8, bytesOf), 0)
    assert.equal(requiredImageOffload(messages, 7, bytesOf), 1)
    assert.equal(requiredImageOffload(messages, 4, bytesOf), 1)
    assert.equal(requiredImageOffload(messages, 1, bytesOf), 2)
    const offloaded = [{ role: 'user', content: [{ type: 'image', attachment: imageRef(), offloaded: true }] }]
    assert.equal(requiredImageOffload(offloaded, 0, bytesOf), 0)
  })

  it('builds the failure the harness routes to image offloading', () => {
    const error = imageOffloadRequired(2, 1_000)
    assert.equal(error.code, IMAGE_OFFLOAD_REQUIRED_CODE)
    assert.match(error.message, /2 more oldest occurrence/)
    assert.deepEqual(error.failure, {
      message: error.message,
      code: IMAGE_OFFLOAD_REQUIRED_CODE,
      offloadImages: 2,
    })
  })

  it('derives one request version per live attachment and shares repeats', async () => {
    const attachments = attachmentsFor()
    const shared = imageRef({ attachmentId: 'sha256:shared' })
    const messages = [
      { role: 'user', content: [{ type: 'image', attachment: shared }] },
      { role: 'user', content: [{ type: 'image', attachment: shared }] },
      { role: 'user', content: [{ type: 'image', attachment: imageRef({ attachmentId: 'sha256:gone' }), offloaded: true }] },
    ]
    const versions = await prepareRequestImages(messages, attachments, { maxPixels: 4_194_304, maxBytes: 1_048_576 })
    assert.deepEqual([...versions.keys()], ['sha256:shared'])
    assert.equal(versions.get('sha256:shared').bytes, 3)
    assert.equal(attachments.calls.length, 1)
    assert.deepEqual(attachments.calls[0].target, { width: 2364, height: 1773, maxBytes: 1_048_576 })
  })

  it('degrades an unreadable reference to a placeholder instead of failing', async () => {
    const attachments = attachmentsFor()
    attachments.readImageRequest = async () => {
      throw new Error('attachment is gone')
    }
    const versions = await prepareRequestImages(
      [{ role: 'user', content: [{ type: 'image', attachment: imageRef() }] }],
      attachments,
      { maxPixels: 4_194_304, maxBytes: 1_048_576 },
    )
    assert.equal(versions.get(imageRef().attachmentId), null)
  })

  it('rethrows a projection failure caused by cancellation', async () => {
    const attachments = attachmentsFor()
    attachments.readImageRequest = async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      prepareRequestImages([{ role: 'user', content: [{ type: 'image', attachment: imageRef() }] }], attachments, {
        maxPixels: 4_194_304,
        maxBytes: 1_048_576,
      }, controller.signal),
      /aborted/,
    )
  })

  it('refuses image projection without the durable attachment service', async () => {
    await assert.rejects(
      prepareRequestImages(
        [{ role: 'user', content: [{ type: 'image', attachment: imageRef() }] }],
        undefined,
        { maxPixels: 1, maxBytes: 1 },
      ),
      /requires the durable attachment service/,
    )
    // With every occurrence already offloaded no service is needed at all.
    const versions = await prepareRequestImages(
      [{ role: 'user', content: [{ type: 'image', attachment: imageRef(), offloaded: true }] }],
      undefined,
      { maxPixels: 1, maxBytes: 1 },
    )
    assert.equal(versions.size, 0)
  })

  it('replaces offloaded occurrences with placeholder text', () => {
    const ref = imageRef({ name: 'shot.png' })
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'before' }, { type: 'image', attachment: ref, offloaded: true }],
      },
      { role: 'user', content: [{ type: 'text', text: 'plain' }] },
    ]
    const projected = projectOffloadedImages(messages, (attachment) => offloadedImageText(attachment, undefined))
    assert.equal(projected[0].content[0].text, 'before')
    assert.match(projected[0].content[1].text, /^\[image omitted to fit request image limits; "shot\.png" \(sha256:a+\)\./)
    assert.equal(projected[1], messages[1])
  })

  it('describes the request image and its normalized read-only copy', () => {
    const ref = imageRef({ width: 4000, height: 3000, name: 'shot.png' })
    const plain = requestImageHandleText(ref, { width: 2364, height: 1773 }, undefined)
    assert.match(plain, /^Image "shot\.png" \(sha256:a{64}\); request preview 2364x1773px\./)
    assert.match(plain, /It may be resized or re-encoded; source dimensions, format, and byte size may differ\./)
    const withAccess = requestImageHandleText(ref, { width: 2364, height: 1773 }, { readonlyPath: 'C:\\work\\shot.png' })
    assert.ok(withAccess.includes('Normalized copy (read-only; may be resized or re-encoded): "C:\\\\work\\\\shot.png"'))
    assert.ok(withAccess.includes('(4000x3000px, image/png).'))
    assert.ok(withAccess.includes('Copy to a writable path ending in .png before editing.'))
  })

  it('turns blocks into pi-ai content with a handle beside each image', () => {
    const ref = imageRef()
    const versions = new Map([[ref.attachmentId, { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 2364, height: 1773 }]])
    const mixed = userContent(
      [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }],
      versions,
      () => ({ readonlyPath: '/work/shot.png' }),
    )
    assert.ok(Array.isArray(mixed))
    assert.deepEqual(mixed[0], { type: 'text', text: 'look' })
    assert.match(mixed[1].text, /^Image sha256:a{64}; request preview 2364x1773px\./)
    assert.ok(mixed[1].text.includes('Normalized copy (read-only'))
    assert.deepEqual(mixed[2], { type: 'image', data: 'AQID', mimeType: 'image/png' })

    // With no image left the content collapses back to the plain string form.
    assert.equal(userContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], versions), 'ab')
    // An unreadable reference becomes a placeholder, not an image.
    const missing = userContent([{ type: 'image', attachment: ref }], new Map([[ref.attachmentId, null]]))
    assert.equal(typeof missing, 'string')
    assert.match(missing, /image could not be read from the attachment store/)
  })

  it('names an unreadable attachment distinctly from a budget omission', () => {
    const text = unreadableImageText(imageRef({ name: 'shot.png' }), { readonlyPath: '/work/shot.png' })
    assert.match(text, /^\[image could not be read from the attachment store; "shot\.png"/)
    assert.ok(text.includes('Normalized copy (read-only'))
    assert.ok(text.includes('/work/shot.png'))
    assert.match(unreadableImageText(imageRef(), undefined), /Ask the user to attach it again/)
  })

  it('measures a request occurrence from its version, then its reference', () => {
    const ref = imageRef({ bytes: 500 })
    const block = { type: 'image', attachment: ref }
    assert.equal(requestImageBytes(block, new Map([[ref.attachmentId, { bytes: 3, data: new Uint8Array(3) }]])), 3)
    assert.equal(requestImageBytes(block, new Map([[ref.attachmentId, { data: new Uint8Array(7) }]])), 7)
    // An unreadable occurrence sends placeholder text only.
    assert.equal(requestImageBytes(block, new Map([[ref.attachmentId, null]])), 0)
    assert.equal(requestImageBytes(block, new Map()), 500)
    assert.equal(requestImageBytes({ type: 'image', attachment: { attachmentId: 'x' } }, new Map()), 1)
  })

  it('resolves a tool-world mapping without letting it break the request', () => {
    assert.equal(safeImageAccess(undefined, imageRef()), undefined)
    assert.deepEqual(safeImageAccess((ref) => ({ readonlyPath: `/work/${ref.width}` }), imageRef()), {
      readonlyPath: '/work/4000',
    })
    assert.equal(
      safeImageAccess(() => {
        throw new Error('bad reference')
      }, imageRef()),
      undefined,
    )
    assert.equal(safeImageAccess(() => null, imageRef()), undefined)
  })
})
