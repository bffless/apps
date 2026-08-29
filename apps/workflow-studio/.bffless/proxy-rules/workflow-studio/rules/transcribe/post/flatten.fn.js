function handler({ steps }) {
  var NL = String.fromCharCode(10)

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

  // apps/studio/src/lib/contactSheet.ts `clockLabel`, ported to ES5: m:ss, promoting
  // to h:mm:ss past an hour. The same wall-clock the contact-sheet cells carry, so the
  // director can line a moment it reads up with a frame it sees.
  function clockLabel(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) seconds = 0
    var total = Math.floor(seconds)
    var h = Math.floor(total / 3600)
    var m = Math.floor((total % 3600) / 60)
    var s = total % 60
    var ss = s < 10 ? '0' + s : String(s)
    if (h) return h + ':' + (m < 10 ? '0' + m : String(m)) + ':' + ss
    return m + ':' + ss
  }

  // apps/studio/src/lib/director.ts `timedTranscript` (L74-114), ported to ES5:
  // collapse word-level timings into `[m:ss] words` lines, one per 8-second window.
  // Words without a timestamp ride along with the current window.
  function timedTranscript(list, secondsPerLine) {
    if (!list || !list.length || !(secondsPerLine > 0)) return ''
    var lines = []
    var current = -1
    for (var k = 0; k < list.length; k++) {
      var word = list[k] || {}
      var wt = (typeof word.text === 'string' ? word.text : '').trim()
      if (!wt) continue
      var st = (typeof word.start === 'number' && isFinite(word.start)) ? word.start : null
      var bucket = st == null ? Math.max(0, current) : Math.floor(st / secondsPerLine)
      if (bucket !== current || lines.length === 0) {
        // New window - but keep null-timestamp words on the line we're already on.
        if (st != null || lines.length === 0) {
          lines.push({ bucket: bucket, words: [] })
          current = bucket
        }
      }
      lines[lines.length - 1].words.push(wt)
    }
    var rendered = []
    for (var n = 0; n < lines.length; n++) {
      rendered.push('[' + clockLabel(lines[n].bucket * secondsPerLine) + '] ' + lines[n].words.join(' '))
    }
    return rendered.join(NL)
  }

  // R126: the recording's duration is the LAST word's `end`, to 3 decimals (not
  // rounded up) - what the sheet planner and the director's scene tiling bound on.
  var duration = 0
  for (var d = words.length - 1; d >= 0; d--) {
    if (typeof words[d].end === 'number' && isFinite(words[d].end)) {
      duration = Math.round(words[d].end * 1000) / 1000
      break
    }
  }

  return { words: words, text: text, timed: timedTranscript(words, 8), duration: duration }
}
