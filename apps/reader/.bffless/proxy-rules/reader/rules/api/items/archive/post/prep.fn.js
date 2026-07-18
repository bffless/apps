function handler({ request }) {
  var b = (request && request.body) || {}
  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''
  var archived = (b.archived === true || b.archived === 'true' || b.archived === 1 || b.archived === '1')
  return {
    guid: guid,
    archived: archived,
    hasGuid: !!guid,
    noGuid: !guid
  }
}
