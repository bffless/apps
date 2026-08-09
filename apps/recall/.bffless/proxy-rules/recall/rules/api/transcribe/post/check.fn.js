// postSteps never abort on a failed step, and a failed step writes NO output
// -- so when `whisper` (the Replicate call) fails, `steps.whisper` is simply
// absent, and `flatten` still runs on it, harmlessly producing
// `{words: [], text: ''}` rather than throwing. Without the `words.length > 0`
// requirement here, that empty-but-well-formed shape would read as `ok`, and
// the video would get an empty transcript + status 'transcribed' while the
// job reads 'done' -- the finishErr/videoErr branch would be unreachable.
// Mirrors the rigor of the index pipeline's zipCheck/storeCheck.
function handler({ steps }) {
  var f = (steps && steps.flatten) || null
  var words = f && f.words
  var ok = !!(f && words && typeof words.length === 'number' && words.length > 0)
  if (ok) return { ok: true, notOk: false, error: '', data: { words: words, text: (f.text || '') } }
  return { ok: false, notOk: true, error: 'Transcription failed', data: null }
}
