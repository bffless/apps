function handler({ steps, deployment, stepErrors }) {
  var out = (steps && (steps.sliceWithAudio || steps.sliceOnly)) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // Forward-compatible with CE's `stepErrors.<step>` context root (ce#662): when it
    // exists, carry the failed step's code + message so the client can tell FFMPEG_BUSY
    // (transient — retry) from a real failure. On today's CE it's undefined and the
    // message stays exactly as before.
    var err = stepErrors && (stepErrors.sliceWithAudio || stepErrors.sliceOnly)
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server slice failed' + detail, data: null }
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
