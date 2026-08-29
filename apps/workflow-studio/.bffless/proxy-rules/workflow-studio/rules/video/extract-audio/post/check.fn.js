function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.extract) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // Forward-compatible with CE's `stepErrors.<step>` context root (ce#662): when it
    // exists, carry the failed step's code + message so the workflow can tell FFMPEG_BUSY
    // (transient - retry) from a real failure. On today's CE it's undefined and `code`
    // stays ''. R120: the code travels as its own field, not folded into `error`.
    var err = stepErrors && stepErrors.extract
    var code = (err && typeof err.code === 'string') ? err.code : ''
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server audio extraction failed' + detail, code: code, data: null }
  }
  // storage path <owner>/<repo>/uploads/<key> -> the uploads-relative <key> the
  // harness registers as a file output.
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  return { ok: true, notOk: false, error: '', code: '', data: { path: key } }
}
