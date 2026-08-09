function handler({ steps }) {
  var q = (steps && steps.query) || {}
  if (q == null) q = {}
  function str(v) {
    return typeof v === 'string' ? v : null
  }
  function num(v) {
    var n = Number(v)
    return typeof v !== 'undefined' && v !== null && !isNaN(n) ? n : 0
  }
  return {
    video: {
      id: typeof q.id === 'string' ? q.id : null,
      title: typeof q.title === 'string' ? q.title : '',
      description: str(q.description),
      youtube_url: str(q.youtube_url),
      status: typeof q.status === 'string' ? q.status : 'draft',
      duration: num(q.duration),
      source_path: str(q.source_path),
      audio_path: str(q.audio_path),
      sheet_path: str(q.sheet_path),
      sheet_meta: str(q.sheet_meta),
      transcript: str(q.transcript),
      created_ms: num(q.created_ms),
      updated_ms: num(q.updated_ms),
    },
  }
}
