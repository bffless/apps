function handler({ request }) {
  var b = (request && request.body) || {}
  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''
  return {
    guid: guid,
    hasGuid: !!guid,
    noGuid: !guid
  }
}
