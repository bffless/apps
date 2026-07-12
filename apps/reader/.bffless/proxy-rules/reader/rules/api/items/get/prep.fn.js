function handler({ request }) {
  var q = (request && request.query) || {}
  var guid = (typeof q.guid === 'string') ? q.guid : ''
  var hasGuid = !!guid
  var view = (typeof q.view === 'string') ? q.view : ''
  var feedId = (typeof q.feedId === 'string') ? q.feedId : ''
  var folder = (typeof q.folder === 'string') ? q.folder : ''
  var page = parseInt(q.page, 10)
  if (isNaN(page) || page < 1) page = 1
  var hasPage = (typeof q.page !== 'undefined' && q.page !== '')
  var limit = parseInt(q.limit, 10)
  var order = (q.order === 'oldest') ? 'asc' : 'desc'
  var legacy = (!view && !hasPage && !hasGuid)
  if (isNaN(limit) || limit < 1) limit = legacy ? 2000 : 20
  if (!view && feedId) view = 'feed'
  if (!view) view = 'all'
  var offset = (page - 1) * limit
  return {
    guid: guid, hasGuid: hasGuid,
    view: view, feedId: feedId, folder: folder,
    page: page, limit: limit, offset: offset, order: order, legacy: legacy,
    isAll: view === 'all' && !hasGuid, isRiver: view === 'river' && !hasGuid, isStarred: view === 'starred' && !hasGuid,
    isFeed: view === 'feed' && !hasGuid, isFolder: view === 'folder' && !hasGuid, hasFolder: view === 'folder' && !hasGuid
  }
}
