function handler({ request, deployment }) {
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import).
  function safe(v) {
    if (typeof v !== 'string') return ''
    var p = v.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'

  // The workflow sends `audio` as the uploads-relative path the extract step returned
  // (Studio's rule took an /api/uploads/ URL). The signer wants the storage path.
  var key = safe(body.audio)
  if (!key) return { ok: false, notOk: true, error: REFUSAL, storagePath: '', diarize: false }

  return {
    ok: true,
    notOk: false,
    error: '',
    storagePath: deployment.owner + '/' + deployment.repo + '/uploads/' + key,
    diarize: body.diarize === true,
  }
}
