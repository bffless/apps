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
    // Keep the count/chunks shape stable (Task 8's pipeline can rely on it
    // always being present) but flag the failure so the caller can branch on
    // it instead of silently treating a corrupt transcript as "no words".
    return { count: 0, chunks: [], error: 'TRANSCRIPT_PARSE_ERROR' }
  }
  var words = transcript.words || []

  var TARGET = 45 // seconds
  var OVERLAP = 10 // seconds
  var MAXW = 120 // words
  var MINW = 15 // words
  // Cap on how many words a restart can rewind by. Without this, a window
  // that closes on the word cap (MAXW) rather than the time target — e.g.
  // MAXW/TARGET = 120/45s ≈ 160 wpm, an ordinary speaking rate, so this is
  // common, not exotic — would get a bare "resume where we left off" with
  // zero overlap, silently dropping the spec's ~10s of cross-boundary
  // context on exactly the videos where it matters most (dense speech).
  // Flooring the rewind at (windowLen - OVERLAP_WORDS_CAP) guarantees every
  // window still overlaps the next by at most 24 words (~9s at 160wpm) while
  // guaranteeing at least (MAXW - 24) = 96 words of forward progress.
  var OVERLAP_WORDS_CAP = 24

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
    if (texts.length === 0) {
      // A non-numeric/NaN word.start makes every comparison above false on
      // the first iteration, so nothing gets pushed and i never advances —
      // without this guard that's an infinite loop. Skip the bad word and
      // retry; it simply drops out of every chunk's text.
      i++
      continue
    }
    // If the window closed on both bounds at once (last word pushed exactly
    // reached MAXW while also landing right at TARGET), the restart formula
    // below still works: it derives entirely from endT/windowLen, not from
    // which bound "caused" the stop, so the ambiguity is harmless.
    var windowLen = i - startIdx
    var endT = words[i - 1].end
    chunks.push({ startT: startT, endT: endT, texts: texts })
    if (i >= words.length) break

    // Restart at the later (more advanced) of: the first word at least
    // OVERLAP seconds before this window's end, or the word-count floor that
    // caps how far back that can reach.
    var backT = endT - OVERLAP
    var j = startIdx
    while (j < i && words[j].start < backT) j++
    var floorJ = startIdx + (windowLen - OVERLAP_WORDS_CAP)
    if (floorJ > j) j = floorJ
    if (j > i) j = i
    i = j > startIdx ? j : i // never move backwards past progress already made
  }

  if (chunks.length > 1 && chunks[chunks.length - 1].texts.length < MINW) {
    var tail = chunks.pop()
    var prev = chunks[chunks.length - 1]
    prev.texts = prev.texts.concat(tail.texts)
    prev.endT = tail.endT
  }

  // `text` is BOTH what gets embedded (texts.fn.js feeds it straight to the
  // model) and what gets stored as chunk_text, so it holds transcript words
  // and nothing else. Timing rides in `metadata`, which embed_store persists
  // to pipeline_data_embeddings.metadata and CE returns as `chunkMetadata` on
  // every vector_search hit / rag-search tool result (CE #652).
  //
  // This used to carry an inline '[t=<sec>s] ' prefix as the interim carrier
  // for the start time, back when CE dropped chunk metadata on the way out.
  // That made the marker part of the embedded vector while the QUERY side --
  // search's prep.fn.js and the chat plugin's embed template -- never had one,
  // so every document vector was skewed by a token the query could never
  // match. Metadata is a lossless carrier (float start AND end, vs. a rounded
  // integer start), so the prefix is pure asymmetry with nothing to buy back.
  //
  // Chunks embedded BEFORE this change still carry the prefix in their stored
  // chunk_text; search's shape.fn.js keeps stripping it for display until
  // those videos are re-indexed.
  return {
    count: chunks.length,
    chunks: chunks.map(function (c) {
      return {
        text: c.texts.join(' '),
        metadata: { start: c.startT, end: c.endT },
      }
    }),
  }
}
