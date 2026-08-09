function handler({ steps }) {
  var up = (steps && steps.update) || {}
  var arr = up.updated || []
  var u = arr && arr.length ? arr[0] : {}
  function str(v) {
    return typeof v === 'string' ? v : null
  }
  function num(v) {
    var n = Number(v)
    return typeof v !== 'undefined' && v !== null && !isNaN(n) ? n : 0
  }
  return {
    video: {
      id: typeof u.id === 'string' ? u.id : null,
      title: typeof u.title === 'string' ? u.title : '',
      description: str(u.description),
      youtube_url: str(u.youtube_url),
      status: typeof u.status === 'string' ? u.status : 'draft',
      duration: num(u.duration),
      source_path: str(u.source_path),
      audio_path: str(u.audio_path),
      created_ms: num(u.created_ms),
      updated_ms: num(u.updated_ms),
    },
  }
}
