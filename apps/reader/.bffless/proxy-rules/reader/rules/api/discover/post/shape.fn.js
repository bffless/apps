function handler({ steps }) {
  var f = (steps && steps.fetch) || {}
  var raw = f.body
  var body = (typeof raw === 'string') ? raw : (raw == null ? '' : JSON.stringify(raw))
  return {
    json: JSON.stringify({
      body: body,
      status: (typeof f.status === 'number') ? f.status : 0,
      ok: (f.ok === true)
    })
  }
}
