function handler({ steps }) {
  var rows = (steps && steps.feeds) || []
  var out = []
  // '#'-prefixed keys keep feed URLs off Object.prototype (ES5 sandbox: no Set/Map).
  var seen = {}
  for (var i = 0; i < rows.length; i++) {
    var u = rows[i] && rows[i].url
    if (typeof u !== 'string' || !u) continue
    if (seen['#' + u]) continue
    seen['#' + u] = true
    out.push(u)
  }
  return { urls: out, count: out.length }
}
