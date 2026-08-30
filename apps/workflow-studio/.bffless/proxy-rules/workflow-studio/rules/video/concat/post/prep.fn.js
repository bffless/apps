function handler({ request }) {
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import).
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
  var BAD_CLIPS = 'Refused - clips must be a non-empty list of uploads-relative paths'

  function no(msg) {
    return { ok: false, notOk: true, error: msg, failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }), clips: [], outPrefix: '', executor: '' }
  }

  var outPrefix = safe(body.outPrefix)
  if (!outPrefix) return no(REFUSAL)

  var rawClips = body.clips
  if (!rawClips || typeof rawClips.length !== 'number' || rawClips.length === 0) return no(BAD_CLIPS)
  // Order is the edit: the workflow hands the scene clips over in scene order and
  // concat stitches them exactly as given.
  var clips = []
  for (var i = 0; i < rawClips.length; i++) {
    var c = safe(rawClips[i])
    if (!c) return no(REFUSAL)
    clips.push(c)
  }

  return {
    ok: true,
    notOk: false,
    error: '',
    failJson: '',
    clips: clips,
    outPrefix: outPrefix,
    // CE omits the executor for '' (its selector does `requested?.trim() || default`),
    // which is how the workflow's `auto` reaches the instance default. Never pass 'auto'.
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
