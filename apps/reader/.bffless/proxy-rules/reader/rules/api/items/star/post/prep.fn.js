function handler({ request }) {
  var b = (request && request.body) || {}
  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''
  var starred = (b.starred === true || b.starred === 'true' || b.starred === 1 || b.starred === '1')
  return {
    guid: guid,
    starred: starred,
    hasGuid: !!guid,
    noGuid: !guid
  }
}
