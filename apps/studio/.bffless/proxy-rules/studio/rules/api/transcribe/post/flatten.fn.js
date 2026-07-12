function handler({ steps }) {
  // WhisperX returns { segments: [{ start, end, text, speaker, words: [{ word, start, end, score, speaker }] }] }.
  // With diarization on each word carries a speaker; the segment carries one too as a backstop.
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
    var segSpeaker = typeof seg.speaker === 'string' && seg.speaker ? seg.speaker : null
    var segWords = seg.words || []
    for (var j = 0; j < segWords.length; j++) {
      var w = segWords[j] || {}
      var text = ''
      if (w.word != null) { text = String(w.word) }
      else if (w.text != null) { text = String(w.text) }
      var start = typeof w.start === 'number' ? w.start : null
      var end = typeof w.end === 'number' ? w.end : null
      var speaker = typeof w.speaker === 'string' && w.speaker ? w.speaker : segSpeaker
      words.push({ text: text.trim(), start: start, end: end, speaker: speaker })
    }
  }
  var text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return { words: words, text: text }
}
