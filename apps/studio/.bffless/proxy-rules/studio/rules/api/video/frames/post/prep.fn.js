function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')

  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }),
      input: '', projectId: '', times: [], height: 0,
      h180: false, h720: false, h1080: false, executor: '',
    }
  }

  if (sourceUrl.indexOf('/api/uploads/') !== 0 || sourceUrl.indexOf('..') !== -1) {
    return no('sourceUrl must be an /api/uploads/ path')
  }
  if (pid === '' || pid.indexOf('..') !== -1 || pid.indexOf('/') !== -1) {
    return no('projectId is required and must be a single path segment')
  }
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
  var height = body.height
  // One ffmpeg step per allowed size (rule.yaml): CE does not template the numeric knobs.
  if (height !== 180 && height !== 720 && height !== 1080) {
    return no('height must be one of 180, 720, 1080')
  }
  return {
    ok: true, notOk: false, error: '', failJson: '',
    input: sourceUrl, projectId: pid, times: times, height: height,
    h180: height === 180, h720: height === 720, h1080: height === 1080,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
