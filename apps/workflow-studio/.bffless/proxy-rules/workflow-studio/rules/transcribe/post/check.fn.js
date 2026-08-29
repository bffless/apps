function handler({ steps, stepErrors }) {
  var f = (steps && steps.flatten) || null
  var words = f && f.words
  if (!f || !words || typeof words.length !== 'number') {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js.
    var err = stepErrors && stepErrors.whisper
    var code = (err && typeof err.code === 'string') ? err.code : ''
    var detail = (err && (err.code || err.message)) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Transcription failed' + detail, code: code, data: null }
  }
  return {
    ok: true,
    notOk: false,
    error: '',
    code: '',
    data: {
      words: words,
      text: f.text || '',
      timed: f.timed || '',
      duration: (typeof f.duration === 'number' && isFinite(f.duration)) ? f.duration : 0,
    },
  }
}
