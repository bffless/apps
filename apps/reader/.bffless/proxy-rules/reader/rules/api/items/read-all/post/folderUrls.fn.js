function handler({ steps }) {
  var rows = (steps && steps.folderFeeds) || []
  var target = ((steps && steps.prep && steps.prep.folder) || '').toLowerCase()
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var f = rows[i] && rows[i].folder
    var u = rows[i] && rows[i].url
    if (typeof u === 'string' && u && typeof f === 'string' && f.toLowerCase() === target) out.push(u)
  }
  return { urls: out, count: out.length }
}
