function handler({ steps }) {
  var f = (steps && steps.flatten) || null
  var words = f && f.words
  var ok = !!(f && words && typeof words.length === 'number')
  if (ok) return { ok: true, notOk: false, error: '', data: { words: words, text: (f.text || '') } }
  return { ok: false, notOk: true, error: 'Transcription failed', data: null }
}
