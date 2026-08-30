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
  var text = typeof f.text === 'string' ? f.text : ''
  var language = typeof f.language === 'string' && f.language ? f.language : null
  // The rule always asks for `align_output`, so a transcript with text but not one word
  // timing means the alignment was skipped - WhisperX has no alignment model for the
  // language it detected (a UK-accented English talk once came back as Welsh). Everything
  // downstream is built on word times: `duration` is the last word's end, so the sheet
  // planner would see 0 s and the run would die two jobs later as "no spoken audio". Fail
  // here, at the step that knows why. A silent recording (no text either) is not this
  // case - it stays `ok` with an empty transcript, which the plan step reports as silence.
  if (words.length === 0 && text.trim().length > 0) {
    var heard = language ? "'" + language + "'" : 'a language'
    return {
      ok: false,
      notOk: true,
      error: 'Transcription came back without word timings: WhisperX heard the recording as ' + heard + ', which it cannot align. Pick the spoken language at kickoff instead of auto-detect.',
      code: 'UNALIGNED_TRANSCRIPT',
      data: null,
    }
  }
  return {
    ok: true,
    notOk: false,
    error: '',
    code: '',
    data: {
      words: words,
      text: text,
      timed: f.timed || '',
      duration: (typeof f.duration === 'number' && isFinite(f.duration)) ? f.duration : 0,
      language: language,
    },
  }
}
