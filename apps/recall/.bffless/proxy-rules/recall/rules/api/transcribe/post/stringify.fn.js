function handler({ steps }) {
  // Builds the exact blob recall_videos.transcript stores: a single JSON string
  // carrying both the word-level timings and the plain joined text, so the
  // reader/search side has one field to parse instead of two to keep in sync.
  var f = (steps && steps.flatten) || {}
  var words = f.words || []
  var text = f.text || ''
  return { transcript: JSON.stringify({ words: words, text: text }) }
}
