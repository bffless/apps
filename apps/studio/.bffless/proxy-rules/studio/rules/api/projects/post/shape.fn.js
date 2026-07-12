function handler({ steps }) {
  var c = (steps && steps.create) || {}
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
    id: (typeof c.projectId === 'string') ? c.projectId : null,
    name: (typeof c.name === 'string') ? c.name : '',
    createdAt: num(c.createdMs),
    updatedAt: num(c.updatedMs),
    phase: (typeof c.phase === 'string') ? c.phase : '',
    thumbnailUrl: (typeof c.thumbnailUrl === 'string' && c.thumbnailUrl) ? c.thumbnailUrl : null,
    data: asObj(c.data),
  }
}
