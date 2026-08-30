function handler({ request }) {
  var body = (request && request.body) || {}

  // R129 path confinement. Every path-taking body field is uploads-relative, has
  // no leading slash, no `..`, and lives under the harness's run prefix
  // `workflows/`. Repeated verbatim in every prep.fn.js — function_handler files
  // cannot import, so the helper is copied rather than shared.
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

  var input = safe(body.source)
  var outPrefix = safe(body.outPrefix)
  if (!input || !outPrefix) {
    return { ok: false, notOk: true, error: REFUSAL, input: '', outPrefix: '', executor: '' }
  }

  return {
    ok: true,
    notOk: false,
    error: '',
    input: input,
    outPrefix: outPrefix,
    // CE omits the executor for '' (its selector does `requested?.trim() || default`),
    // which is how the workflow's `auto` reaches the instance default. Never pass 'auto'.
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
