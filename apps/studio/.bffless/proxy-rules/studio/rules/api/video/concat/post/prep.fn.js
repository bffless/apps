function handler({ request }) {
  var body = (request && request.body) || {}
  var pid = String(body.projectId || '')
  var parts = body.parts
  var partsOk = Array.isArray(parts) && parts.length > 0
  if (partsOk) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i]
      if (typeof p !== 'string' || p.indexOf('/api/uploads/') !== 0 || p.indexOf('..') !== -1) { partsOk = false; break }
    }
  }
  var ok = pid !== '' && pid.indexOf('..') === -1 && pid.indexOf('/') === -1 && partsOk
  return {
    ok: ok, notOk: !ok, parts: parts, projectId: pid,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
