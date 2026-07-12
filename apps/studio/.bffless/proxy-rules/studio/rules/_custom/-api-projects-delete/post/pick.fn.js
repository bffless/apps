function handler({ steps }) {
  var rows = (steps && steps.query) || []
  var q = (rows && rows.length) ? rows[0] : null
  var rid = q ? (q.recordId || q.id || q._id) : null
  return { recordId: rid ? String(rid) : '', found: rid ? true : false }
}
