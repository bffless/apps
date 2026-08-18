function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')
  var spans = body.spans
  var spansOk = Array.isArray(spans) && spans.length > 0
  if (spansOk) {
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i]
      var start = s && Number(s.start)
      var end = s && Number(s.end)
      if (!(isFinite(start) && isFinite(end) && start >= 0 && end > start)) { spansOk = false; break }
    }
  }
  var ok = sourceUrl.indexOf('/api/uploads/') === 0 && sourceUrl.indexOf('..') === -1 && pid !== '' && pid.indexOf('..') === -1 && pid.indexOf('/') === -1 && spansOk
  var wantAudio = body.wantAudio === true
  return {
    ok: ok, notOk: !ok,
    input: sourceUrl, projectId: pid, spans: spans,
    wantAudio: wantAudio, noAudio: !wantAudio,
    audioFades: body.audioFades === true,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
