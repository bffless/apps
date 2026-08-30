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
  var BAD_TIMES = 'Refused - times must be a non-empty list of at most 200 non-negative seconds'
  var BAD_LABELS = 'Refused - labels must be a list of strings the same length as times'

  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      input: '', outputPrefix: '', times: [], labels: [], executor: '',
    }
  }

  var input = safe(body.source)
  var outPrefix = safe(body.outPrefix)
  if (!input || !outPrefix) return no(REFUSAL)

  // R116/R117: the CALLER plans the sampling (the workflow's `plan` script), so the
  // rule only validates it. CE's MAX_STILLS_PER_JOB is 200, measured on times.length.
  var rawTimes = body.times
  if (!rawTimes || typeof rawTimes.length !== 'number' || rawTimes.length === 0 || rawTimes.length > 200) {
    return no(BAD_TIMES)
  }
  var times = []
  for (var i = 0; i < rawTimes.length; i++) {
    var t = rawTimes[i]
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return no(BAD_TIMES)
    times.push(t)
  }

  var rawLabels = body.labels
  if (!rawLabels || typeof rawLabels.length !== 'number' || rawLabels.length !== times.length) {
    return no(BAD_LABELS)
  }
  var labels = []
  for (var j = 0; j < rawLabels.length; j++) {
    if (typeof rawLabels[j] !== 'string') return no(BAD_LABELS)
    labels.push(rawLabels[j])
  }

  return {
    ok: true,
    notOk: false,
    error: '',
    input: input,
    outputPrefix: outPrefix + '/sheets',
    times: times,
    labels: labels,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
