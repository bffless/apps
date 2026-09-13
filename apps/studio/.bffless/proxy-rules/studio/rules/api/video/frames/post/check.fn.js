function handler({ steps, deployment, stepErrors }) {
  // One of frames180 / frames720 / frames1080 ran (rule.yaml), picked by prep.
  var out = (steps && (steps.frames180 || steps.frames720 || steps.frames1080)) || null
  var list = out && out.frames
  if (!list || typeof list.length !== 'number' || list.length === 0) {
    var err = stepErrors && (stepErrors.frames180 || stepErrors.frames720 || stepErrors.frames1080)
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server frame capture failed' + detail, data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var frames = []
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {}
    if (typeof f.storage_path !== 'string' || !f.storage_path) continue
    if (typeof f.time !== 'number' || !isFinite(f.time)) continue
    var key = f.storage_path.indexOf(prefix) === 0 ? f.storage_path.slice(prefix.length) : f.storage_path
    frames.push({ time: f.time, url: '/api/uploads/' + key })
  }
  var data = { frames: frames }
  var stats = ['executor', 'timings', 'bytesIn', 'bytesOut']
  for (var k = 0; k < stats.length; k++) {
    if (out[stats[k]] !== undefined && out[stats[k]] !== null) data[stats[k]] = out[stats[k]]
  }
  return { ok: true, notOk: false, error: '', data: data }
}
