function handler({ user, request }) {
  var b = (request && request.body) || {}
  var uid = (user && user.id) ? String(user.id) : ''
  var url = (typeof b.url === 'string') ? b.url.trim() : ''
  var ok = !!(url && uid)
  var feed = {
    userId: uid,
    scopedUrl: uid + '::' + url,
    url: url,
    title: (typeof b.title === 'string') ? b.title : '',
    siteUrl: (typeof b.siteUrl === 'string') ? b.siteUrl : '',
    folder: (b.folder != null && b.folder !== '') ? String(b.folder) : null,
    addedAt: Number(b.addedAt) || 0
  }
  return {
    feeds: [feed],
    hasUrl: ok,
    noUrl: !ok
  }
}
