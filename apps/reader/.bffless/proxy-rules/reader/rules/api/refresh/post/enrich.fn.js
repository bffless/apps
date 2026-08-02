function handler({ steps }) {
  var feeds = (steps && steps.feeds) || []
  var entries = (steps && steps.parse && steps.parse.entries) || []
  var nowMs = (steps && steps.stamp && steps.stamp.ms) || 0
  var nowIso = new Date(nowMs).toISOString()

  // feed url -> owning userIds. One parsed entry becomes one row per subscriber,
  // because the cron runs userless and ownership can only come from the feed rows.
  // '#'-prefixed keys keep feed URLs off Object.prototype (ES5 sandbox: no Map).
  var subs = {}
  for (var f = 0; f < feeds.length; f++) {
    var row = feeds[f] || {}
    var fu = row.url
    var owner = row.userId
    if (typeof fu !== 'string' || !fu) continue
    if (typeof owner !== 'string' || !owner) continue
    var k = '#' + fu
    if (!subs[k]) subs[k] = []
    if (subs[k].indexOf(owner) === -1) subs[k].push(owner)
  }

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
    // D8's dedup chain, resolved here now that the key must also carry the owner.
    var key = e.guid || e.link || (String(e.source) + '|' + String(e.title) + '|' + pub)
    var owners = subs['#' + e.source] || []
    for (var o = 0; o < owners.length; o++) {
      out.push({
        userId: owners[o],
        scopedGuid: owners[o] + '::' + key,
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
  }
  return { entries: out }
}
