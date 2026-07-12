function handler({ request, steps }) {
  var id = (request && request.body && request.body.id != null) ? String(request.body.id) : ''
  var rows = (steps && steps.query) || []
  var q = (rows && rows.length) ? rows[0] : null
  var rid = q ? (q.recordId || q.id || q._id) : null
  return {
    hasId: !!id,
    noId: !id,
    exists: !!(id && rid),
    missing: !!(id && !rid),
    recordId: rid ? String(rid) : ''
  }
}
