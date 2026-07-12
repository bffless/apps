function handler({ request }) {
  var b = (request && request.body) || {}
  var url = (typeof b.url === 'string') ? b.url.trim() : ''
  var feed = {
    url: url,
    title: (typeof b.title === 'string') ? b.title : '',
    siteUrl: (typeof b.siteUrl === 'string') ? b.siteUrl : '',
    folder: (b.folder != null && b.folder !== '') ? String(b.folder) : null,
    addedAt: Number(b.addedAt) || 0
  }
  return {
    feeds: [feed],
    hasUrl: !!url,
    noUrl: !url
  }
}
