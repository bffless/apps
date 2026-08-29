function handler({ request }) {
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import). `outPrefix` becomes the upload's subDir, so an unconfined
  // one would write the rendered image anywhere under the uploads root.
  function safe(v) {
    if (typeof v !== 'string') return ''
    var p = v.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'
  var BAD_PROMPT = 'Refused - prompt must be a non-empty string'

  function no(msg) {
    return { ok: false, notOk: true, error: msg, prompt: '', outPrefix: '' }
  }

  var outPrefix = safe(body.outPrefix)
  if (!outPrefix) return no(REFUSAL)

  // This rule is SYNC and the refusal must land before the paid image call: a
  // response_handler does not terminate a CE pipeline, so `generate`/`store`/`respond`
  // are all gated on `steps.prep.ok`.
  var prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return no(BAD_PROMPT)

  return { ok: true, notOk: false, error: '', prompt: prompt, outPrefix: outPrefix }
}
