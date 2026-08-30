function handler({ steps, deployment, stepErrors }) {
  var prep = (steps && steps.prep) || {}
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function rel(p) {
    if (typeof p !== 'string') return ''
    return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
  }

  var paths = []
  var byTime = {}
  // `srcs` is `byTime` re-keyed by the token as the post writes it (`frame:<key>`):
  // the harness `images` map (workflow spec 02, apps#446) a markdown output declares
  // so the finished run's Output tab draws the tokens as images.
  var srcs = {}
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
    // `own` is parallel to `keys` (prep.fn.js): false marks a picker candidate the caller
    // sent as `sibling`. Every still lands in `byTime`/`srcs` (that is how the island
    // and blog-bundle reach it, by path), but only the caller's OWN frames become
    // `paths` — the list the workflow declares as `type: file` and so registers one
    // HTTP call at a time (apps#490). An absent/short `own` means all own (older callers).
    var own = prep['own' + i] || []
    for (var f = 0; f < frames.length; f++) {
      var p = rel((frames[f] || {}).storage_path)
      if (own[f] !== false) paths.push(p)
      var key = (f < keys.length) ? keys[f] : String((frames[f] || {}).time)
      byTime[key] = p
      srcs['frame:' + key] = p
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
      srcs: srcs,
      dropped: (typeof prep.dropped === 'number' && isFinite(prep.dropped)) ? prep.dropped : 0,
    },
  }
}
