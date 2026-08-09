function handler({ request }) {
  var body = (request && request.body) || {}
  var videoId = body.videoId
  return { videoId: typeof videoId === 'string' ? videoId : '' }
}
