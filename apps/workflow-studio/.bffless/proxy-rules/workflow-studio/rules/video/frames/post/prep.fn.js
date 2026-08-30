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
  var BAD_TIME = 'Refused - every capture needs a finite non-negative time'
  var TOO_MANY = 'Refused - at most 200 captures per source (CE MAX_STILLS_PER_JOB)'

  // Up to THREE sources: one `frames` op call per distinct source is not expressible
  // in a static rule, so the rule fans out to three conditional steps (R119), the same
  // idiom apps/studio's scenes rule uses for sign0..sign9.
  var MAX_SOURCES = 3

  function out(base) {
    var o = { ok: base.ok, notOk: base.notOk, error: base.error, failJson: base.failJson, dropped: base.dropped, executor: base.executor }
    for (var i = 0; i < MAX_SOURCES; i++) {
      var g = base.groups[i]
      o['has' + i] = !!g
      o['src' + i] = g ? g.src : ''
      o['times' + i] = g ? g.times : []
      o['keys' + i] = g ? g.keys : []
      // Parallel to `keys`: is this still one of the caller's OWN frames (true) or a
      // picker candidate it marked `sibling` (false)? `check` registers only the own
      // ones as `paths` (apps#490).
      o['own' + i] = g ? g.own : []
      o['out' + i] = g ? base.outPrefix + '/frames/' + i : ''
    }
    return o
  }
  function no(msg) {
    return out({ ok: false, notOk: true, error: msg, failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }), dropped: 0, executor: '', outPrefix: '', groups: [] })
  }

  var outPrefix = safe(body.outPrefix)
  if (!outPrefix) return no(REFUSAL)

  var captures = body.captures
  if (!captures || typeof captures.length !== 'number') captures = []

  var groups = []
  var dropped = 0
  for (var c = 0; c < captures.length; c++) {
    var cap = captures[c] || {}
    var src = safe(cap.source)
    if (!src) return no(REFUSAL)
    var t = cap.time
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return no(BAD_TIME)

    var found = null
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].src === src) { found = groups[g]; break }
    }
    if (!found) {
      // A fourth or later distinct source has no step to run on: its captures are
      // counted into `dropped` and the workflow annotates the run.
      if (groups.length >= MAX_SOURCES) { dropped++; continue }
      found = { src: src, times: [], keys: [], own: [] }
      groups.push(found)
    }
    if (found.times.length >= 200) return no(TOO_MANY)
    found.times.push(t)
    // The `byTime` key travels with the capture (R140): `frame-times` sends the GLOBAL
    // token second as `key` while `time` is the LOCAL second CE seeks to, and the two
    // differ for every recording after the first. A capture with no `key` falls back to
    // its own time (R119, the single-source shape). Either way CE names the stills
    // itself, so the caller's key is the only stable handle back to a frame.
    var key = cap.key
    found.keys.push(typeof key === 'string' && key ? key : String(t))
    found.own.push(cap.sibling !== true)
  }

  return out({
    ok: true,
    notOk: false,
    error: '',
    failJson: '',
    dropped: dropped,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
    outPrefix: outPrefix,
    groups: groups,
  })
}
