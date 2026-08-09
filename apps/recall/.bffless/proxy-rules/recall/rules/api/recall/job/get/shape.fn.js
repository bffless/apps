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

  return {
    status: (typeof q.status === 'string') ? q.status : 'pending',
    kind: (typeof q.kind === 'string') ? q.kind : '',
    result: asObj(q.result),
    error: (typeof q.error === 'string' && q.error) ? q.error : null,
    prompt: (typeof q.prompt === 'string' && q.prompt) ? q.prompt : null,
    system: (typeof q.system === 'string' && q.system) ? q.system : null,
  }
}
