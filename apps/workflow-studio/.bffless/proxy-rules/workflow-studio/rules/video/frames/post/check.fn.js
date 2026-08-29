function handler({ steps, deployment, stepErrors }) {
  var prep = (steps && steps.prep) || {}
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function rel(p) {
    if (typeof p !== 'string') return ''
    return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
  }

  var paths = []
  var byTime = {}
  for (var i = 0; i < 3; i++) {
    if (prep['has' + i] !== true) continue
    var step = (steps && steps['frames' + i]) || null
    var frames = step && step.frames
    if (!frames || typeof frames.length !== 'number' || frames.length === 0) {
      // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js.
      var err = stepErrors && stepErrors['frames' + i]
      var code = (err && typeof err.code === 'string') ? err.code : ''
      var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
      return { ok: false, notOk: true, error: 'Frame capture failed' + detail, code: code, data: null }
    }
    // CE returns the stills in `times` order, so the caller's own keys zip by index -
    // which keeps `byTime` keyed by what the CALLER asked for (R140: the global token
    // second, via `captures[].key`) rather than by the local seek time CE echoes back.
    // The `String(frame.time)` fallback below only fires if CE returned more stills
    // than were asked for.
    var keys = prep['keys' + i] || []
    for (var f = 0; f < frames.length; f++) {
      var p = rel((frames[f] || {}).storage_path)
      paths.push(p)
      var key = (f < keys.length) ? keys[f] : String((frames[f] || {}).time)
      byTime[key] = p
    }
  }

  return {
    ok: true,
    notOk: false,
    error: '',
    code: '',
    data: {
      paths: paths,
      byTime: byTime,
      dropped: (typeof prep.dropped === 'number' && isFinite(prep.dropped)) ? prep.dropped : 0,
    },
  }
}
