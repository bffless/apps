function handler({ steps, stepErrors }) {
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0
  }
  function str(v) {
    return typeof v === 'string' ? v : ''
  }

  var d = (steps && steps.director) || {}
  if (!d || (d.status == null && d.output == null)) {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js: the code
    // travels as its own field (R120) so the harness can fill error.code.
    var derr = stepErrors && stepErrors.director
    var dcode = (derr && typeof derr.code === 'string') ? derr.code : ''
    return { ok: false, notOk: true, code: dcode, error: 'The AI director did not return a result - it may be temporarily overloaded, or the video may be too long. Please try again.', data: { synopsis: '', scenes: [] } }
  }

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

  // Salvage helpers: recover complete top-level {...} objects (and a leading
  // string field) from JSON the model may have truncated mid-output.
  function objectsIn(s) {
    var objs = []
    var depth = 0, start = -1, inStr = false, esc = false
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i)
      if (inStr) {
        if (esc) { esc = false }
        else if (ch === '\\') { esc = true }
        else if (ch === '"') { inStr = false }
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') { if (depth === 0) { start = i } depth++ }
      else if (ch === '}') { if (depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(s.slice(start, i + 1)); start = -1 } } }
    }
    return objs
  }
  function parseArray(key) {
    var marker = '"' + key + '"'
    var ki = text.indexOf(marker)
    if (ki < 0) return []
    var bi = text.indexOf('[', ki)
    if (bi < 0) return []
    // Find the matching ] for this [ (respecting strings + nested []), so scene
    // objects that themselves contain arrays (e.g. cuts) aren't cut short. If the
    // model truncated before the array closed, fall back to the rest of the text.
    var depth = 0, inStr = false, esc = false, endIdx = -1
    for (var bm = bi; bm < text.length; bm++) {
      var bc = text.charAt(bm)
      if (inStr) {
        if (esc) { esc = false }
        else if (bc === '\\') { esc = true }
        else if (bc === '"') { inStr = false }
        continue
      }
      if (bc === '"') { inStr = true; continue }
      if (bc === '[') { depth++ }
      else if (bc === ']') { depth--; if (depth === 0) { endIdx = bm; break } }
    }
    var body = endIdx >= 0 ? text.slice(bi + 1, endIdx) : text.slice(bi + 1)
    var pieces = objectsIn(body)
    var list = []
    for (var i = 0; i < pieces.length; i++) {
      try { list.push(JSON.parse(pieces[i])) } catch (e) {}
    }
    return list
  }
  function extractString(key) {
    var m = '"' + key + '"'
    var ki = text.indexOf(m)
    if (ki < 0) return ''
    var ci = text.indexOf(':', ki)
    if (ci < 0) return ''
    var qi = text.indexOf('"', ci + 1)
    if (qi < 0) return ''
    var acc = ''
    var esc = false
    for (var i = qi + 1; i < text.length; i++) {
      var ch = text.charAt(i)
      if (esc) { acc += ch; esc = false; continue }
      if (ch === '\\') { esc = true; acc += ch; continue }
      if (ch === '"') break
      acc += ch
    }
    try { return JSON.parse('"' + acc + '"') } catch (e) { return acc }
  }

  var parsed = null
  var sIdx = text.indexOf('{')
  var eIdx = text.lastIndexOf('}')
  if (sIdx >= 0 && eIdx > sIdx) {
    try { parsed = JSON.parse(text.slice(sIdx, eIdx + 1)) } catch (e) { parsed = null }
  }

  var rawScenes, synopsis
  if (parsed && typeof parsed === 'object') {
    rawScenes = parsed.scenes
    synopsis = (typeof parsed.synopsis === 'string') ? parsed.synopsis : ''
  } else {
    rawScenes = parseArray('scenes')
    synopsis = extractString('synopsis')
  }
  if (!rawScenes || typeof rawScenes.length !== 'number') rawScenes = []

  if (rawScenes.length === 0) {
    var snippet = (typeof text === 'string') ? text.slice(0, 280).trim() : ''
    var emsg = snippet
      ? 'The AI director\'s response could not be read. Please try again. Model said: ' + snippet
      : 'The AI director returned an empty response - it may be temporarily overloaded. Please try again.'
    return { ok: false, notOk: true, code: '', error: emsg, data: { synopsis: '', scenes: [] } }
  }

  // --- apps/studio/src/lib/director.ts `toScenes` (L146-235), ported to ES5 -------
  // The director reasons over the GLOBAL (concatenated) timeline; every returned row
  // is mapped back to the single source it overlaps most, in that source's LOCAL
  // seconds. R130: the keys stay camelCase - the workflow YAML renames them itself.
  var prep = (steps && steps.prep) || {}
  var spans = prep.spans
  if (!spans || typeof spans.length !== 'number') spans = []
  var sources = prep.sources
  if (!sources || typeof sources.length !== 'number') sources = []
  if (spans.length === 0) {
    return { ok: false, notOk: true, code: '', error: 'No source recordings to place the scenes against.', data: { synopsis: '', scenes: [] } }
  }
  var bound = num(spans[spans.length - 1].end)

  var sorted = []
  for (var j = 0; j < rawScenes.length; j++) sorted.push(rawScenes[j])
  sorted.sort(function (x, y) { return num(x && x.start) - num(y && y.start) })

  // 1) TILE the GLOBAL timeline: each scene opens where the previous closed (the raw
  // starts only decide the order), ends are clamped, the last runs to the total
  // duration. Footage can only be dropped by a cut, never by a gap between scenes.
  var tiled = []
  var cursor = 0
  for (var k = 0; k < sorted.length; k++) {
    var sc = sorted[k] || {}
    var gStart = cursor
    var gEnd = Math.min(Math.max(num(sc.end), gStart), bound)
    if (gEnd <= gStart) gEnd = Math.min(gStart + 0.05, bound)
    cursor = gEnd
    tiled.push({ start: gStart, end: gEnd, raw: sc })
  }
  if (tiled.length) tiled[tiled.length - 1].end = bound

  // 2) assign each global scene to the source it overlaps most; convert to local.
  // Deliberately NOT split per source it touches: rounded director spans routinely
  // overflow the real fractional durations, and splitting made sliver duplicates.
  var assigned = []
  for (var g = 0; g < tiled.length; g++) {
    var gs = tiled[g]
    var bestIdx = -1
    var bestOverlap = 0
    for (var sI = 0; sI < spans.length; sI++) {
      var span = spans[sI] || {}
      var overlap = Math.min(gs.end, num(span.end)) - Math.max(gs.start, num(span.start))
      if (overlap > bestOverlap) { bestOverlap = overlap; bestIdx = sI }
    }
    if (bestIdx < 0 || bestOverlap <= 0.05) continue
    var best = spans[bestIdx]
    assigned.push({
      spanIndex: bestIdx,
      spanStart: num(best.start),
      spanEnd: num(best.end),
      start: Math.max(gs.start, num(best.start)) - num(best.start),
      end: Math.min(gs.end, num(best.end)) - num(best.start),
      raw: gs.raw,
    })
  }

  // 3) re-tile each source's LOCAL timeline: dominant-source assignment can orphan a
  // source's head/tail (a boundary-crossing scene keeps only its dominant side), so
  // snap the first scene to 0, each next to the previous end, and the last to the
  // source's duration. Only ever widens a window, so the cuts clamped below stay in.
  var lastBySource = {}
  for (var r = assigned.length - 1; r >= 0; r--) {
    var rk = String(assigned[r].spanIndex)
    if (!Object.prototype.hasOwnProperty.call(lastBySource, rk)) lastBySource[rk] = r
  }
  var cursorBySource = {}
  for (var q = 0; q < assigned.length; q++) {
    var aq = assigned[q]
    var qk = String(aq.spanIndex)
    aq.start = Object.prototype.hasOwnProperty.call(cursorBySource, qk) ? cursorBySource[qk] : 0
    if (lastBySource[qk] === q) aq.end = aq.spanEnd - aq.spanStart
    if (aq.end < aq.start) aq.end = aq.start
    cursorBySource[qk] = aq.end
  }

  // 4) build the rows off the final windows.
  function leadWords(t, n) {
    var parts = t.trim().split(/\s+/)
    var kept = []
    for (var p = 0; p < parts.length && kept.length < n; p++) {
      if (parts[p]) kept.push(parts[p])
    }
    return kept.join(' ')
  }
  function clampCut(cs, ce, lo, hi) {
    var cStart = Math.min(Math.max(cs, lo), hi)
    var cEnd = Math.min(Math.max(ce, lo), hi)
    if (cEnd - cStart <= 0.05) return null
    return { start: cStart, end: cEnd }
  }

  var scenes = []
  for (var n2 = 0; n2 < assigned.length; n2++) {
    var an = assigned[n2]
    // The 13f wire contract no longer echoes the words back and this rule is not sent
    // any, so a transcript only appears when a legacy row carries one.
    var sceneTranscript = str(an.raw && an.raw.transcript).trim()
    var brief = str(an.raw && an.raw.brief).trim() || str(an.raw && an.raw.refinePrompt).trim()
    var lead = leadWords(sceneTranscript, 5)
    var title = str(an.raw && an.raw.title).trim() || (lead ? lead + '…' : 'Scene ' + (n2 + 1))
    var cutsIn = (an.raw && an.raw.cuts)
    if (!cutsIn || typeof cutsIn.length !== 'number') cutsIn = []
    var cuts = []
    for (var c2 = 0; c2 < cutsIn.length; c2++) {
      var cc = cutsIn[c2] || {}
      var kept2 = clampCut(num(cc.start) - an.spanStart, num(cc.end) - an.spanStart, an.start, an.end)
      if (kept2) cuts.push(kept2)
    }
    var row = {
      number: n2 + 1,
      title: title,
      brief: brief,
      source: typeof sources[an.spanIndex] === 'string' ? sources[an.spanIndex] : '',
      sourceIndex: an.spanIndex,
      start: an.start,
      end: an.end,
      spans: [{ start: an.start, end: an.end }],
      cuts: cuts,
    }
    if (sceneTranscript) row.transcript = sceneTranscript
    scenes.push(row)
  }

  if (scenes.length === 0) {
    return { ok: false, notOk: true, code: '', error: 'None of the scenes the AI director returned overlap the recordings. Please try again.', data: { synopsis: '', scenes: [] } }
  }

  return { ok: true, notOk: false, code: '', error: '', data: { synopsis: str(synopsis), scenes: scenes } }
}
