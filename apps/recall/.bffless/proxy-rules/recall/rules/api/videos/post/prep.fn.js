function handler({ request }) {
  var body = (request && request.body) || {}
  var title = typeof body.title === 'string' ? body.title.trim() : ''
  var ms = Number(body.createdMs)
  if (!ms || isNaN(ms)) ms = Date.now()
  return { title: title, ms: ms }
}
