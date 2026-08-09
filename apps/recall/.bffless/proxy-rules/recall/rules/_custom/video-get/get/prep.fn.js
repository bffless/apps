// Sync-side validation for GET /api/video?videoId=<id> (Task 11). Mirrors the
// ok/notOk sentinel convention used throughout this app (gate.fn.js,
// api/search/post/prep.fn.js) so the rule can gate the data_query step and
// the final response purely on `steps.prep.ok` / `steps.shape.notOk` (CE
// condition expressions only support a single field path or its negation).
function handler({ request }) {
  var q = (request && request.query) || {}
  var videoId = typeof q.videoId === 'string' ? q.videoId.trim() : ''
  if (!videoId) {
    return { ok: false, notOk: true, videoId: '' }
  }
  return { ok: true, notOk: false, videoId: videoId }
}
