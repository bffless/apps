function handler({ steps }) {
  var rows = (steps && steps.feeds) || []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var u = rows[i] && rows[i].url
    if (typeof u === 'string' && u) out.push(u)
  }
  return { urls: out, count: out.length }
}
