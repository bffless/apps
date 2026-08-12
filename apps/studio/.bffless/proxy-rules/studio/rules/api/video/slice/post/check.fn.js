function handler({ steps, deployment }) {
  var out = (steps && (steps.sliceWithAudio || steps.sliceOnly)) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    return { ok: false, notOk: true, error: 'Server slice failed', data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function toUrl(p) {
    var key = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
    return '/api/uploads/' + key
  }
  var audio = out.audio && typeof out.audio.storage_path === 'string' ? toUrl(out.audio.storage_path) : null
  return {
    ok: true, notOk: false, error: '',
    data: { url: toUrl(path), audioUrl: audio, duration: typeof out.duration === 'number' ? out.duration : null },
  }
}
