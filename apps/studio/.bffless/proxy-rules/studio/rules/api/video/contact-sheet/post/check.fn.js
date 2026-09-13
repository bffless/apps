function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.sheets) || null
  var list = out && out.sheets
  if (!list || typeof list.length !== 'number' || list.length === 0) {
    // Forward-compatible with CE's `stepErrors.<step>` root (ce#662), as in slice/post/check.fn.js.
    var err = stepErrors && stepErrors.sheets
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server contact-sheet capture failed' + detail, data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function toUrl(p) {
    var key = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
    return '/api/uploads/' + key
  }
  var sheets = []
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {}
    if (typeof s.storage_path !== 'string' || !s.storage_path) continue
    sheets.push({
      url: toUrl(s.storage_path),
      times: s.times || [],
      cols: typeof s.cols === 'number' ? s.cols : 0,
      rows: typeof s.rows === 'number' ? s.rows : 0,
      index: typeof s.index === 'number' ? s.index : i,
      total: typeof s.total === 'number' ? s.total : list.length,
      bytes: typeof s.size === 'number' ? s.size : 0,
    })
  }
  var data = { sheets: sheets, drawn: out.drawn === true }
  var stats = ['executor', 'timings', 'bytesIn', 'bytesOut']
  for (var k = 0; k < stats.length; k++) {
    if (out[stats[k]] !== undefined && out[stats[k]] !== null) data[stats[k]] = out[stats[k]]
  }
  return { ok: true, notOk: false, error: '', data: data }
}
