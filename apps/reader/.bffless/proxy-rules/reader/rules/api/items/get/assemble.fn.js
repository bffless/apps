function handler({ steps }) {
  var p = steps.prep || {}
  function rows(v) { return (v && v.length != null) ? v : null }
  var items = rows(steps.pageGuid) || rows(steps.pageAll) || rows(steps.pageRiver) || rows(steps.pageStarred) || rows(steps.pageFeed) || rows(steps.pageFolder) || []
  function cnt(c) { return (c && typeof c.result === 'number') ? c.result : null }
  var total = null
  if (p.hasGuid) {
    total = items.length
  } else {
    total = cnt(steps.countAll)
    if (total == null) total = cnt(steps.countRiver)
    if (total == null) total = cnt(steps.countStarred)
    if (total == null) total = cnt(steps.countFeed)
    if (total == null) total = cnt(steps.countFolder)
    if (total == null) total = items.length
  }
  var pageSize = p.limit || items.length || 1
  var totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1
  var out = []
  for (var i = 0; i < items.length; i++) out.push(items[i])
  return { items: out, total: total, page: p.page || 1, pageSize: pageSize, totalPages: totalPages }
}
