function handler({ request }) {
  var b = (request && request.body) || {}
  var url = (typeof b.url === 'string') ? b.url.trim() : ''
  var folder = (b.folder != null && typeof b.folder === 'string' && b.folder.trim() !== '') ? b.folder.trim() : null
  return {
    url: url,
    folder: folder,
    hasUrl: !!url,
    noUrl: !url
  }
}
