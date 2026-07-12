function handler({ request }) {
  var id = String((request.body && request.body.projectId) || '').trim()
  if (!id) throw new Error('projectId required')
  return { prefix: 'projects/' + id + '/', projectId: id }
}
