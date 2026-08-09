function handler({ request }) {
  var id = String((request.body && request.body.videoId) || '').trim()
  if (!id) throw new Error('videoId required')
  return { prefix: 'videos/' + id + '/', videoId: id }
}
