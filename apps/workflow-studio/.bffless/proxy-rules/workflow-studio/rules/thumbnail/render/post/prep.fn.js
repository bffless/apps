function handler({ request, deployment }) {
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import). `outPrefix` becomes the upload's subDir, so an unconfined
  // one would write the rendered image anywhere under the uploads root; `reference`
  // is read back out of the bucket and handed to the image model, so an unconfined
  // one would let a caller feed it any object in the project.
  function safe(v) {
    if (typeof v !== 'string') return ''
    // Same steps, same order as the harness's files/sign/post/confine.fn.js (apps#466):
    // strip leading slashes, an `api/uploads/` prefix and any `?query`, then refuse
    // `..`, `//` and anything not anchored at `workflows/`. The trailing-slash strip is
    // this app's own, so an outPrefix comes back normalised.
    var p = v.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0].replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('//') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'
  var BAD_PROMPT = 'Refused - prompt must be a non-empty string'

  function no(msg) {
    return { ok: false, notOk: true, error: msg, prompt: '', outPrefix: '', images: [] }
  }

  var outPrefix = safe(body.outPrefix)
  if (!outPrefix) return no(REFUSAL)

  // This rule is SYNC and the refusal must land before the paid image call: a
  // response_handler does not terminate a CE pipeline, so `generate`/`store`/`respond`
  // are all gated on `steps.prep.ok`.
  var prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return no(BAD_PROMPT)

  // The optional reference photo (the cover-direction form's `reference` File ref, by
  // `path` - apps#437).
  // Absent, null or '' means none - the workflow sends `reference.path` of a null ref,
  // which is null. A non-empty string that is not confined is refused like any other
  // path, never silently dropped (Studio's prepImages dropped an unusable
  // referenceImageUrl on the floor; here the caller learns about it).
  //
  // What the model gets is nano-banana's `image_input`: a list of FULL storage paths
  // (<owner>/<repo>/uploads/<path>, the same prefix `scenes` builds for signed_url),
  // which the replicate handler reads from the bucket element-wise and re-uploads or
  // inlines - the bytes never travel through a request body. `[]` is the model's own
  // default for "no reference", so there is no conditional step.
  var images = []
  var reference = body.reference
  if (typeof reference === 'string' && reference.trim() !== '') {
    var ref = safe(reference.trim())
    if (!ref) return no(REFUSAL)
    images = [deployment.owner + '/' + deployment.repo + '/uploads/' + ref]
  }

  return { ok: true, notOk: false, error: '', prompt: prompt, outPrefix: outPrefix, images: images }
}
