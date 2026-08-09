// Shapes a single recall_videos record for GET /api/video?videoId=<id>
// (Task 11): the PUBLIC video page's data source. Only a 'published' row is
// ever returned -- a missing id and a draft/processing/error row both 404
// the same way (no leaking existence via status code), unlike the
// admin-only _custom/videos-get (which returns EVERY status, including the
// raw transcript string, for the editor).
//
// The transcript field on the record is a stringified
// `{ words: [...], text: '...' }` blob (see api/transcribe/post). This
// parses it server-side so the client gets `{ words: [...] }` directly --
// the exact shape TranscriptView expects -- with an empty words array if
// the record has no transcript yet or the JSON fails to parse, rather than
// shipping a broken string to the player page.
//
// The YouTube-id regex mirrors src/lib/youtube.ts's extractYouTubeId (fn.js
// sandboxes can't import app source, so it's duplicated here on purpose,
// same as api/search/post/shape.fn.js and api/index/post/gate.fn.js).
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

function parseWords(transcript) {
  if (typeof transcript !== 'string' || !transcript) return []
  try {
    var parsed = JSON.parse(transcript)
    if (parsed && Array.isArray(parsed.words)) return parsed.words
    return []
  } catch (e) {
    return []
  }
}

function handler({ steps }) {
  // steps.query is data_query's recordId-lookup output: the record object,
  // or null if not found (also undefined when the prep step rejected the
  // request and the query step's condition kept it from running at all --
  // either way, no record here means 404).
  var q = (steps && steps.query) || null

  if (!q || typeof q.id !== 'string' || !q.id || q.status !== 'published') {
    return { ok: false, notOk: true, video: null }
  }

  return {
    ok: true,
    notOk: false,
    video: {
      videoId: q.id,
      title: typeof q.title === 'string' ? q.title : '',
      description: typeof q.description === 'string' ? q.description : null,
      youtubeId: extractYouTubeId(q.youtube_url),
      duration: num(q.duration),
      transcript: { words: parseWords(q.transcript) },
    },
  }
}
