function handler({ request }) {
  var b = (request && request.body) || {}
  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''
  var read = (b.read === true || b.read === 'true' || b.read === 1 || b.read === '1')
  return {
    guid: guid,
    read: read,
    hasGuid: !!guid,
    noGuid: !guid
  }
}
