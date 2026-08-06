/**
 * Build nano-banana's `image_input` array from the optional reference image.
 *
 * The expression evaluator has no array-literal syntax, so an array input has to
 * come from a step output — hence this step rather than an inline `[...]` in the
 * rule's `input:` block.
 *
 * The value stays an `/api/uploads/...` serve path: the replicate handler
 * resolves such a path itself (reading the object from storage and handing the
 * bytes to Replicate), so the bytes never travel through a request body and the
 * flow works on every storage backend, including local filesystem where
 * presigned GET isn't available.
 *
 * `image_input` defaults to `[]` in the model schema, so "no reference image" is
 * simply an empty array — no conditional step needed.
 */
function handler({ request }) {
  var body = (request && request.body) || {}
  var url = typeof body.referenceImageUrl === 'string' ? body.referenceImageUrl.trim() : ''

  // Only a serve path under /api/uploads/ is accepted, and never one with
  // traversal segments — anything else is dropped rather than forwarded, so a
  // caller can't point the renderer at an arbitrary object.
  var ok = url.indexOf('/api/uploads/') === 0 && url.indexOf('..') === -1

  return { images: ok ? [url] : [] }
}
