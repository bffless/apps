function handler({ steps, deployment, stepErrors }) {
  var out = (steps && (steps.sliceWithAudio || steps.sliceOnly)) || null
  var path = out && out.storage_path
  if (typeof path !== 'string' || !path) {
    // Forward-compatible with CE's `stepErrors.<step>` context root (ce#662): when it
    // exists, carry the failed step's code + message so the workflow can tell FFMPEG_BUSY
    // (transient - retry) from a real failure. On today's CE it's undefined and `code`
    // stays ''. R120: the code travels as its own field, not folded into `error`.
    var err = stepErrors && (stepErrors.sliceWithAudio || stepErrors.sliceOnly)
    var code = (err && typeof err.code === 'string') ? err.code : ''
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server slice failed' + detail, code: code, data: null }
  }
  // storage path <owner>/<repo>/uploads/<key> -> the uploads-relative <key> the
  // harness registers as a file output. R130: the keys stay camelCase.
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function rel(p) {
    return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
  }
  var audio = (out.audio && typeof out.audio.storage_path === 'string') ? rel(out.audio.storage_path) : null
  return {
    ok: true,
    notOk: false,
    error: '',
    code: '',
    data: {
      path: rel(path),
      audioPath: audio,
      duration: typeof out.duration === 'number' ? out.duration : null,
    },
  }
}
