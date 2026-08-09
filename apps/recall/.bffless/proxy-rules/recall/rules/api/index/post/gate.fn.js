// Sync-side eligibility gate for POST /api/index (Task 8). Runs BEFORE any job is
// created: rejects with a reason the sync steps can turn into a 400, so a bad
// request never creates a recall_jobs row or touches the video record. The
// postSteps chain re-checks `steps.gate.ok` (it's the SAME `context` object
// carried from the sync steps into postSteps, so this step's output is still
// visible there) before doing anything, so a rejected request is a true no-op
// downstream too — see zipCheck.fn.js.
//
// The YouTube-URL regex mirrors src/lib/youtube.ts's `extractYouTubeId` (fn.js
// sandboxes can't import app source, so it's duplicated here on purpose).
var YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/

function isValidYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (YOUTUBE_RE.test(url)) return true
  var trimmed = url.trim()
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed)
}

function handler({ steps }) {
  var load = (steps && steps.load) || null
  var record = load && load.records ? load.records[0] : load
  if (!record) {
    return { ok: false, notOk: true, reason: 'VIDEO_NOT_FOUND' }
  }
  if (record.status !== 'transcribed' && record.status !== 'published') {
    return { ok: false, notOk: true, reason: 'INVALID_STATUS' }
  }
  if (!isValidYouTubeUrl(record.youtube_url)) {
    return { ok: false, notOk: true, reason: 'MISSING_YOUTUBE_URL' }
  }
  if (!record.transcript) {
    return { ok: false, notOk: true, reason: 'MISSING_TRANSCRIPT' }
  }
  return { ok: true, notOk: false, reason: '' }
}
