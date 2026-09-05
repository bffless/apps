function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.extract) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // Forward-compatible with CE's `stepErrors.<step>` context root (ce#662): when it
    // exists, carry the failed step's code + message so the client can tell FFMPEG_BUSY
    // (transient — retry) from a real failure. On today's CE it's undefined and the
    // message stays exactly as before.
    var err = stepErrors && stepErrors.extract
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server audio extraction failed' + detail, data: null }
  }
  // storage path <owner>/<repo>/uploads/<key>  ->  serve URL /api/uploads/<key>
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  var data = { url: '/api/uploads/' + key }
  // CE >= 0.4.31 (ce#684) reports which executor ran the op and how long it took. Keep
  // them on the job row's `result` verbatim (apps#605) — the pipeline log ages out, the
  // row doesn't. Only when present: a pre-0.4.31 CE yields no `null` keys here.
  var stats = ['executor', 'timings', 'bytesIn', 'bytesOut']
  for (var i = 0; i < stats.length; i++) {
    if (out[stats[i]] !== undefined && out[stats[i]] !== null) data[stats[i]] = out[stats[i]]
  }
  return { ok: true, notOk: false, error: '', data: data }
}
