// Shapes vector_search hits into { videos: [...] } for POST /api/search
// (Task 9). steps.search is vector_search's raw output: an array of
// { id, similarity, chunkText, chunkIndex, chunkMetadata?, title,
// youtube_url, duration, status } -- `chunkMetadata` is only present once
// CE's vector-search handler patch (feat/vector-search-chunk-metadata) is
// deployed, so this prefers it but falls back to parsing the `[t=Ns] `
// prefix chunk.fn.js baked into every chunkText at index time.
//
// The [t=Ns] prefix regex and the YouTube-id regex both mirror
// src/lib/youtube.ts / gate.fn.js's YOUTUBE_RE -- fn.js sandboxes can't
// import app source, so they're duplicated here on purpose.
var PREFIX_RE = /^\[t=(\d+)s\] /
var YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/

function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null
  var m = url.match(YOUTUBE_RE)
  if (m) return m[1]
  var trimmed = url.trim()
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : null
}

function bySimilarityDesc(a, b) {
  return b.similarity - a.similarity
}

function handler({ steps }) {
  var hits = (steps && steps.search) || []
  if (!Array.isArray(hits)) hits = []

  var videosById = {}
  var order = []

  for (var i = 0; i < hits.length; i++) {
    var hit = hits[i] || {}

    // Defense-in-depth: unpublished videos shouldn't have embeddings at all
    // (unpublish deletes them), but a failed unpublish could leave strays --
    // never surface those in public search.
    if (hit.status !== 'published') continue

    var youtubeId = extractYouTubeId(hit.youtube_url)
    if (!youtubeId) continue // nothing to seek/link to without a valid id

    var chunkText = typeof hit.chunkText === 'string' ? hit.chunkText : ''
    var start
    var end
    var meta = hit.chunkMetadata
    if (meta && typeof meta.start === 'number') {
      start = meta.start
      if (typeof meta.end === 'number') end = meta.end
    } else {
      var m = chunkText.match(PREFIX_RE)
      if (!m) continue // neither chunkMetadata nor a parseable prefix -- skip
      start = Number(m[1])
    }

    var snippet = chunkText.replace(PREFIX_RE, '')

    var id = hit.id
    if (!videosById[id]) {
      videosById[id] = {
        videoId: id,
        title: typeof hit.title === 'string' ? hit.title : '',
        youtubeId: youtubeId,
        duration: typeof hit.duration === 'number' ? hit.duration : 0,
        moments: [],
      }
      order.push(id)
    }

    var moment = { start: start, snippet: snippet, similarity: hit.similarity }
    if (typeof end === 'number') moment.end = end
    videosById[id].moments.push(moment)
  }

  var videos = []
  for (var k = 0; k < order.length; k++) {
    var video = videosById[order[k]]
    video.moments.sort(bySimilarityDesc)
    video.moments = video.moments.slice(0, 4)
    videos.push(video)
  }

  videos.sort(function (a, b) {
    var aBest = a.moments.length ? a.moments[0].similarity : -Infinity
    var bBest = b.moments.length ? b.moments[0].similarity : -Infinity
    return bBest - aBest
  })

  return { videos: videos }
}
