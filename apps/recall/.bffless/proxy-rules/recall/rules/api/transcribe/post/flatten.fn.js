function handler({ steps }) {
  // WhisperX returns { segments: [{ start, end, text, words: [{ word, start, end, score }] }] }.
  // Recall drops diarization entirely (no pyannote call, no `speaker` field) —
  // unlike Studio, there's no per-speaker UI to feed.
  var whisper = steps.whisper || {}
  var out = whisper.output != null ? whisper.output : whisper
  var segments = (out && out.segments) || []
  var words = []
  var parts = []
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i] || {}
    if (typeof seg.text === 'string' && seg.text.length > 0) {
      parts.push(seg.text.trim())
    }
    var segWords = seg.words || []
    for (var j = 0; j < segWords.length; j++) {
      var w = segWords[j] || {}
      var text = ''
      if (w.word != null) { text = String(w.word) }
      else if (w.text != null) { text = String(w.text) }
      var start = typeof w.start === 'number' ? w.start : null
      var end = typeof w.end === 'number' ? w.end : null
      words.push({ text: text.trim(), start: start, end: end })
    }
  }
  var text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return { words: words, text: text }
}
