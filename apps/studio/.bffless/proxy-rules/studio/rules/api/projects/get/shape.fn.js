function handler({ steps }) {
  var rows = (steps && steps.query) || []
  function num(v) {
    var n = Number(v)
    return (typeof v !== 'undefined' && v !== null && !isNaN(n)) ? n : 0
  }
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var q = rows[i] || {}
    out.push({
      id: (typeof q.projectId === 'string') ? q.projectId : null,
      name: (typeof q.name === 'string') ? q.name : '',
      createdAt: num(q.createdMs),
      updatedAt: num(q.updatedMs),
      phase: (typeof q.phase === 'string') ? q.phase : '',
      thumbnailUrl: (typeof q.thumbnailUrl === 'string' && q.thumbnailUrl) ? q.thumbnailUrl : null,
    })
  }
  return { projects: out }
}
