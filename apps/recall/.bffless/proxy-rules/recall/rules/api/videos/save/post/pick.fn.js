function handler({ request, steps }) {
  var id = request && request.body && request.body.videoId != null ? String(request.body.videoId) : ''
  var row = (steps && steps.query) || null
  return {
    videoId: id,
    now: Date.now(),
    hasId: !!id,
    noId: !id,
    exists: !!(id && row),
    missing: !!(id && !row),
  }
}
