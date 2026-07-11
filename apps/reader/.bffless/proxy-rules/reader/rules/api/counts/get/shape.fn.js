function handler({ steps }) {
  var u = (steps && steps.unread && steps.unread.results) || []
  var map = {}
  for (var i = 0; i < u.length; i++) {
    var r = u[i] || {}
    if (r.key != null) map[r.key] = r.value
  }
  var s = (steps && steps.starred && typeof steps.starred.result === 'number') ? steps.starred.result : 0
  var us = (steps && steps.unreadStarred && typeof steps.unreadStarred.result === 'number') ? steps.unreadStarred.result : 0
  return { json: JSON.stringify({ unreadByFeed: map, starred: s, unreadStarred: us }) }
}
