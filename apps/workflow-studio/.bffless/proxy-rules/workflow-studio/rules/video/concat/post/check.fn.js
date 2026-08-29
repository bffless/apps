function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.stitch) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js: the code
    // travels as its own field (R120) so the harness can fill error.code.
    var err = stepErrors && stepErrors.stitch
    var code = (err && typeof err.code === 'string') ? err.code : ''
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server stitch failed' + detail, code: code, data: null }
  }
  // storage path <owner>/<repo>/uploads/<key> -> the uploads-relative <key> the
  // harness registers as a file output.
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  return { ok: true, notOk: false, error: '', code: '', data: { path: key } }
}
