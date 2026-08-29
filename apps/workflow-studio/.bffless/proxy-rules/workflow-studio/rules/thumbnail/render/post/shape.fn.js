function handler({ steps, deployment, stepErrors }) {
  var store = (steps && steps.store) || null
  var path = store && store.storage_path
  if (typeof path !== 'string' || !path) {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js: the code
    // travels as its own field (R120). SYNC rule, so there is no job row - the
    // envelope is what the 502 branch answers with.
    // R137: the envelope's `code` IS this value - the rule's fail branch emits
    // {{steps.shape.code}} rather than a hard-coded string, so a real CE code survives
    // once ce#662 lands and 'RENDER_FAILED' is only the fallback when there is none.
    var err = stepErrors && (stepErrors.store || stepErrors.generate)
    var code = (err && typeof err.code === 'string' && err.code) ? err.code : 'RENDER_FAILED'
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return {
      ok: false,
      notOk: true,
      error: 'The thumbnail could not be rendered or stored. Please try again.' + detail,
      code: code,
      pathJson: '',
    }
  }
  // file_upload_handler writes <owner>/<repo>/uploads/<subDir>/<uuid>-<name>; the
  // harness registers file outputs by their uploads-relative path, so strip the
  // uploads root back off. JSON.stringify keeps the response body escaped.
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  return { ok: true, notOk: false, error: '', code: '', pathJson: JSON.stringify({ path: key }) }
}
