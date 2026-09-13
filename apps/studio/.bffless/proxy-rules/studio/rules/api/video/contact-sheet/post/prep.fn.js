function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')

  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }),
      input: '', projectId: '', times: [], labels: [], executor: '',
    }
  }

  if (sourceUrl.indexOf('/api/uploads/') !== 0 || sourceUrl.indexOf('..') !== -1) {
    return no('sourceUrl must be an /api/uploads/ path')
  }
  if (pid === '' || pid.indexOf('..') !== -1 || pid.indexOf('/') !== -1) {
    return no('projectId is required and must be a single path segment')
  }

  // CE's MAX_STILLS_PER_JOB is 200 (ffmpeg.handler.ts), measured on times.length.
  var rawTimes = body.times
  if (!rawTimes || typeof rawTimes.length !== 'number' || rawTimes.length === 0 || rawTimes.length > 200) {
    return no('times must be 1-200 non-negative seconds')
  }
  var times = []
  for (var i = 0; i < rawTimes.length; i++) {
    var t = rawTimes[i]
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return no('times must be 1-200 non-negative seconds')
    times.push(t)
  }

  var rawLabels = body.labels
  if (!rawLabels || typeof rawLabels.length !== 'number' || rawLabels.length !== times.length) {
    return no('labels must be one string per time')
  }
  var labels = []
  for (var j = 0; j < rawLabels.length; j++) {
    if (typeof rawLabels[j] !== 'string') return no('labels must be one string per time')
    labels.push(rawLabels[j])
  }

  return {
    ok: true, notOk: false, error: '', failJson: '',
    input: sourceUrl, projectId: pid, times: times, labels: labels,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
