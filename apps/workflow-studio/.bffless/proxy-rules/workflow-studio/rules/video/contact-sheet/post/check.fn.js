function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.sheets) || null
  var sheets = out && out.sheets
  if (!sheets || typeof sheets.length !== 'number' || sheets.length === 0) {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js.
    var err = stepErrors && stepErrors.sheets
    var code = (err && typeof err.code === 'string') ? err.code : ''
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Contact-sheet capture failed' + detail, code: code, data: null }
  }

  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function rel(p) {
    if (typeof p !== 'string') return ''
    return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
  }

  var paths = []
  var times = []
  for (var i = 0; i < sheets.length; i++) {
    var s = sheets[i] || {}
    paths.push(rel(s.storage_path))
    times.push(s.times || [])
  }

  var prep = (steps && steps.prep) || {}
  // `drawn` is CE's telemetry, not the request: false means the sheets came back
  // un-labelled (no drawtext filter). Surfaced, never fatal.
  return {
    ok: true,
    notOk: false,
    error: '',
    code: '',
    data: {
      paths: paths,
      times: times,
      columns: 3,
      interval: (typeof prep.interval === 'number' && isFinite(prep.interval)) ? prep.interval : 0,
      drawn: out.drawn === true,
    },
  }
}
