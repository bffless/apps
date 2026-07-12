function handler({ steps }) {
  var rows = (steps && steps.query) || []
  var q = (rows && rows.length) ? rows[0] : {}
  if (q == null) q = {}
  function asObj(v) {
    if (v == null) return null
    if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return null } }
    return v
  }
  function num(v) {
    var n = Number(v)
    return (typeof v !== 'undefined' && v !== null && !isNaN(n)) ? n : 0
  }
  return {
    id: (typeof q.projectId === 'string') ? q.projectId : null,
    name: (typeof q.name === 'string') ? q.name : '',
    createdAt: num(q.createdMs),
    updatedAt: num(q.updatedMs),
    phase: (typeof q.phase === 'string') ? q.phase : '',
    thumbnailUrl: (typeof q.thumbnailUrl === 'string' && q.thumbnailUrl) ? q.thumbnailUrl : null,
    data: asObj(q.data),
  }
}
