function handler({ steps }) {
  // steps.load is the data_query result for the video record. Handle both the
  // usual { records: [...] } shape and a direct record object (some steps
  // unwrap single-row queries).
  var load = (steps && steps.load) || {}
  var record = load.records ? load.records[0] : load
  record = record || {}

  var transcript
  try {
    transcript = JSON.parse(record.transcript || '{"words":[]}')
  } catch (e) {
    transcript = { words: [] }
  }
  var words = transcript.words || []

  var TARGET = 45 // seconds
  var OVERLAP = 10 // seconds
  var MAXW = 120 // words
  var MINW = 15 // words

  var chunks = []
  var i = 0
  while (i < words.length) {
    var startIdx = i
    var startT = words[i].start
    var texts = []
    while (i < words.length && (words[i].start - startT) < TARGET && texts.length < MAXW) {
      texts.push(words[i].text)
      i++
    }
    var wordCapped = texts.length >= MAXW
    var endT = words[i - 1].end
    chunks.push({ startT: startT, endT: endT, texts: texts })
    if (i >= words.length) break

    if (!wordCapped) {
      // Natural time-bound close: pull the next window's start back by
      // OVERLAP seconds so nearby context isn't lost across the boundary.
      var backT = endT - OVERLAP
      var j = startIdx
      while (j < i && words[j].start < backT) j++
      i = j > startIdx ? j : i // never move backwards past progress already made
    }
    // A word-cap close (very dense speech) resumes exactly where we left
    // off — rewinding here would barely advance the window (the window's
    // own span is often shorter than OVERLAP) and stalls progress.
  }

  if (chunks.length > 1 && chunks[chunks.length - 1].texts.length < MINW) {
    var tail = chunks.pop()
    var prev = chunks[chunks.length - 1]
    prev.texts = prev.texts.concat(tail.texts)
    prev.endT = tail.endT
  }

  return {
    count: chunks.length,
    chunks: chunks.map(function (c) {
      return {
        text: '[t=' + Math.round(c.startT) + 's] ' + c.texts.join(' '),
        metadata: { start: c.startT, end: c.endT },
      }
    }),
  }
}
