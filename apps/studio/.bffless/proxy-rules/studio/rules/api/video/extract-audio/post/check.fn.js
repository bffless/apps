function handler({ steps, deployment }) {
  var out = (steps && steps.extract) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    return { ok: false, notOk: true, error: 'Server audio extraction failed', data: null }
  }
  // storage path <owner>/<repo>/uploads/<key>  ->  serve URL /api/uploads/<key>
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var key = path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path
  return { ok: true, notOk: false, error: '', data: { url: '/api/uploads/' + key } }
}
