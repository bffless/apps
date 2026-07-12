function handler({ steps }) {
  var up = (steps && steps.update) || {}
  var arr = up.updated || []
  var u = (arr && arr.length) ? arr[0] : null
  if (!u) {
    var ins = (steps && steps.insert) || null
    if (ins && typeof ins === 'object') u = ins
  }
  if (!u) u = {}
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
    id: (typeof u.projectId === 'string') ? u.projectId : null,
    name: (typeof u.name === 'string') ? u.name : '',
    createdAt: num(u.createdMs),
    updatedAt: num(u.updatedMs),
    phase: (typeof u.phase === 'string') ? u.phase : '',
    thumbnailUrl: (typeof u.thumbnailUrl === 'string' && u.thumbnailUrl) ? u.thumbnailUrl : null,
    data: asObj(u.data),
  }
}
