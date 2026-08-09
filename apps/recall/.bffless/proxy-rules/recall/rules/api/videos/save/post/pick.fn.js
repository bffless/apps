function handler({ request, steps }) {
  var body = (request && request.body) || {}
  var id = body.videoId != null ? String(body.videoId) : ''
  var row = (steps && steps.query) || null

  // Partial PATCH: any field omitted from the request body falls back to the
  // row's current value, so a caller can save just { videoId, source_path }
  // (Task 6's ingest hook) without clobbering title/description/youtube_url,
  // and the title-edit form can keep sending all three without touching
  // source_path/audio_path.
  function coalesce(v, fallback) {
    return typeof v === 'undefined' ? fallback : v
  }

  return {
    videoId: id,
    now: Date.now(),
    hasId: !!id,
    noId: !id,
    exists: !!(id && row),
    missing: !!(id && !row),
    title: coalesce(body.title, row ? row.title : ''),
    description: coalesce(body.description, row ? row.description : null),
    youtube_url: coalesce(body.youtube_url, row ? row.youtube_url : null),
    source_path: coalesce(body.source_path, row ? row.source_path : null),
    audio_path: coalesce(body.audio_path, row ? row.audio_path : null),
    sheet_path: coalesce(body.sheet_path, row ? row.sheet_path : null),
    sheet_meta: coalesce(body.sheet_meta, row ? row.sheet_meta : null),
  }
}
