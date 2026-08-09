function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var url = typeof body.url === 'string' ? body.url : ''

  // Only serve paths under /api/uploads/ may be signed, and never with
  // traversal segments — everything else resolves to an empty storagePath,
  // which makes the sign step fail closed.
  var key = url.replace(/^\/+/, '')
  var ok = key.indexOf('api/uploads/') === 0 && key.indexOf('..') === -1
  key = ok ? key.replace(/^api\/uploads\//, '') : ''

  // Split off any query string; the storage key is the bare path. Project
  // prefix comes from the deployment context so an import into any project
  // signs <owner>/<repo>/uploads/... (no hard-coded project name).
  key = key.split('?')[0]
  var storagePath = key ? deployment.owner + '/' + deployment.repo + '/uploads/' + key : ''

  // Optional download filename. Basename only, conservative charset — the
  // backend sanitizes again, this is defense in depth. Empty means "no
  // Content-Disposition", which is what every non-download caller sends.
  var name = typeof body.filename === 'string' ? body.filename : ''
  name = name.split('/').pop().split('\\').pop()
  name = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120)

  return {
    url: url,
    storagePath: storagePath,
    filename: name,
  }
}
