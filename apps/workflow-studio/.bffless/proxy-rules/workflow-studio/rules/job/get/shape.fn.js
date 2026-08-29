function handler({ steps }) {
  var q = (steps && steps.query) || {}

  function asObj(v) {
    if (v == null) return null
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch (e) {
        return null
      }
    }
    return v
  }

  // R120: `code` rides alongside `error` so the harness can fill the step's
  // `error.code` and the workflow's `retry.if error.code == 'FFMPEG_BUSY'` fires.
  // An unknown id reads as still pending (Studio's behaviour) — the workflow's
  // `poll.timeout` is what ends a poll against a job that never existed.
  return {
    status: (typeof q.status === 'string') ? q.status : 'pending',
    result: asObj(q.result),
    error: (typeof q.error === 'string' && q.error) ? q.error : null,
    code: (typeof q.code === 'string' && q.code) ? q.code : null,
  }
}
