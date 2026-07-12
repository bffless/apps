function handler({ request }) {
  var b = (request && request.body) || {}
  var view = (typeof b.view === 'string') ? b.view : 'all'
  var feedId = (typeof b.feedId === 'string') ? b.feedId : ''
  var folder = (typeof b.folder === 'string') ? b.folder : ''
  return {
    view: view, feedId: feedId, folder: folder, yes: true,
    isAllOrRiver: (view === 'all' || view === 'river'),
    isStarred: view === 'starred',
    isFeed: view === 'feed',
    isFolder: view === 'folder',
    hasFolder: view === 'folder'
  }
}
