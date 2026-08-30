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
  var BAD_SPANS = 'Refused - spans must be a non-empty list of { start, end } seconds with end > start'

  // A refusal must also DISARM both ffmpeg branches: `wantAudio`/`noAudio` are the
  // conditions on the two slice steps (a step takes exactly one condition, and the
  // branch flag has to carry the `steps.prep.ok` gate with it), so unlike Studio's
  // `noAudio: !wantAudio` they are BOTH false here - otherwise a refused request
  // would still run the paid ffmpeg pass off the back of the 400.
  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      input: '', outPrefix: '', spans: [],
      wantAudio: false, noAudio: false, audioFades: false, executor: '',
    }
  }

  var input = safe(body.source)
  var outPrefix = safe(body.outPrefix)
  if (!input || !outPrefix) return no(REFUSAL)

  var rawSpans = body.spans
  if (!rawSpans || typeof rawSpans.length !== 'number' || rawSpans.length === 0) return no(BAD_SPANS)
  var spans = []
  for (var i = 0; i < rawSpans.length; i++) {
    var s = rawSpans[i] || {}
    var start = s.start
    var end = s.end
    if (typeof start !== 'number' || typeof end !== 'number') return no(BAD_SPANS)
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) return no(BAD_SPANS)
    spans.push({ start: start, end: end })
  }

  var wantAudio = body.wantAudio === true
  return {
    ok: true,
    notOk: false,
    error: '',
    input: input,
    outPrefix: outPrefix,
    spans: spans,
    wantAudio: wantAudio,
    noAudio: !wantAudio,
    // ffmpeg_handler reads `audioFades` as a RAW boolean (never expression-evaluated,
    // unlike input/output/spans), so the two slice steps hardcode it - false on the
    // cut pass, true on the assemble pass, exactly as Studio's rule does. This value
    // is computed for the record only; no step reads it. The workflow sends
    // `audioFades: true` only on the assemble (noAudio) call, which is what the
    // sliceOnly step hardcodes, so the two agree.
    audioFades: body.audioFades === true,
    // CE omits the executor for '' (its selector does `requested?.trim() || default`),
    // which is how the workflow's `auto` reaches the instance default. Never pass 'auto'.
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
