function handler({ steps }) {
  var entries = (steps && steps.parse && steps.parse.entries) || []
  var nowMs = (steps && steps.stamp && steps.stamp.ms) || 0
  var nowIso = new Date(nowMs).toISOString()
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i] || {}
    var pub = e.publishedAt
    if (pub) { var d = new Date(pub); if (isNaN(d.getTime())) pub = '' }
    if (!pub) pub = nowIso
    var encType = null
    var encUrl = null
    var encs = e.enclosures
    if (encs && encs.length) {
      for (var j = 0; j < encs.length; j++) {
        var en = encs[j]
        if (en && typeof en.type === 'string' && en.type.indexOf('text/') === 0) {
          encType = en.type
          encUrl = (en.url != null) ? en.url : null
          break
        }
      }
    }
    out.push({
      source: e.source,
      guid: e.guid,
      title: e.title,
      link: e.link,
      author: e.author,
      content: e.content,
      summary: e.summary,
      publishedAt: pub,
      enclosureType: encType,
      enclosureUrl: encUrl
    })
  }
  return { entries: out }
}
