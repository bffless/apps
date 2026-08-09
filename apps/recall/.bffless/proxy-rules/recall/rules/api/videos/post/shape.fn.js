function handler({ steps }) {
  var c = (steps && steps.create) || {}
  function str(v) {
    return typeof v === 'string' ? v : null
  }
  function num(v) {
    var n = Number(v)
    return typeof v !== 'undefined' && v !== null && !isNaN(n) ? n : 0
  }
  return {
    video: {
      id: typeof c.id === 'string' ? c.id : null,
      title: typeof c.title === 'string' ? c.title : '',
      description: str(c.description),
      youtube_url: str(c.youtube_url),
      status: typeof c.status === 'string' ? c.status : 'draft',
      duration: num(c.duration),
      source_path: str(c.source_path),
      audio_path: str(c.audio_path),
      created_ms: num(c.created_ms),
      updated_ms: num(c.updated_ms),
    },
  }
}
