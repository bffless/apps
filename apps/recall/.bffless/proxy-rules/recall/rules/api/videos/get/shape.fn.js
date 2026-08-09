// Shapes the public GET /api/videos list (Task 11): every 'published' video's
// lightweight metadata for the home page library grid -- never the transcript
// or either storage path (source_path/audio_path), unlike the admin list at
// GET /api/admin/videos which keeps status+paths for the admin table.
//
// The YouTube-id regex mirrors src/lib/youtube.ts's extractYouTubeId (fn.js
// sandboxes can't import app source, so it's duplicated here on purpose, same
// as api/search/post/shape.fn.js and api/index/post/gate.fn.js).
var YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/

function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null
  var m = url.match(YOUTUBE_RE)
  if (m) return m[1]
  var trimmed = url.trim()
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : null
}

function num(v) {
  var n = Number(v)
  return typeof v !== 'undefined' && v !== null && !isNaN(n) ? n : 0
}

// Prefer updated_ms (the app's own last-write timestamp); fall back to the
// record's system createdAt (a Date/ISO-string from data_query) when
// updated_ms is missing or zero.
function publishedAtMs(updatedMs, createdAt) {
  var n = Number(updatedMs)
  if (updatedMs !== undefined && updatedMs !== null && !isNaN(n) && n > 0) return n
  if (createdAt) {
    var t = new Date(createdAt).getTime()
    if (!isNaN(t)) return t
  }
  return 0
}

function handler({ steps }) {
  var rows = (steps && steps.query) || []
  if (!Array.isArray(rows)) rows = []

  var videos = []
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {}
    if (r.status !== 'published') continue

    var youtubeId = extractYouTubeId(r.youtube_url)
    if (!youtubeId) continue // nothing to link/play without a valid id

    videos.push({
      videoId: typeof r.id === 'string' ? r.id : null,
      title: typeof r.title === 'string' ? r.title : '',
      description: typeof r.description === 'string' ? r.description : null,
      youtubeId: youtubeId,
      duration: num(r.duration),
      publishedAtMs: publishedAtMs(r.updated_ms, r.createdAt),
    })
  }

  videos.sort(function (a, b) {
    return b.publishedAtMs - a.publishedAtMs
  })

  return { videos: videos }
}
