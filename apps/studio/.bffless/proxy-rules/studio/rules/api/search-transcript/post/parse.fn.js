function handler({ steps }) {
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0
  }
  function str(v) {
    return typeof v === 'string' ? v : ''
  }

  var d = (steps && steps.search) || {}
  var raw = d.output != null ? d.output : d
  var text = ''
  if (typeof raw === 'string') {
    text = raw
  } else if (raw && typeof raw.length === 'number') {
    for (var a = 0; a < raw.length; a++) {
      text += String(raw[a])
    }
  } else if (raw && typeof raw.text === 'string') {
    text = raw.text
  }

  var sIdx = text.indexOf('{')
  var eIdx = text.lastIndexOf('}')
  if (sIdx >= 0 && eIdx > sIdx) {
    text = text.slice(sIdx, eIdx + 1)
  }

  var parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    parsed = null
  }

  var list = parsed && parsed.results
  if (!list || typeof list.length !== 'number') list = []

  var prep = (steps && steps.prep) || {}
  var duration = (typeof prep.duration === 'number' && prep.duration > 0) ? prep.duration : 1000000000

  var hits = []
  for (var i = 0; i < list.length; i++) {
    var r = list[i]
    if (!r || typeof r !== 'object') continue
    var start = Math.min(Math.max(num(r.start), 0), duration)
    var end = Math.min(Math.max(num(r.end), 0), duration)
    if (end - start < 0.3) continue
    hits.push({ start: start, end: end, snippet: str(r.snippet), reason: str(r.reason) })
  }
  hits.sort(function (x, y) { return x.start - y.start })
  if (hits.length > 20) hits = hits.slice(0, 20)

  return { resultsJson: JSON.stringify(hits), count: hits.length }
}
