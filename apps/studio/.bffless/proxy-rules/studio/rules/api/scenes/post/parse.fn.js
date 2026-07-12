function handler({ steps }) {
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0
  }

  var d = (steps && steps.director) || {}
  if (!d || (d.status == null && d.output == null)) {
    return { ok: false, notOk: true, error: 'The AI director did not return a result - it may be temporarily overloaded, or the video may be too long. Please try again.', data: { synopsis: '', scenes: [] } }
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
    var out = []
    for (var i = 0; i < pieces.length; i++) {
      try { out.push(JSON.parse(pieces[i])) } catch (e) {}
    }
    return out
  }
  function extractString(key) {
    var m = '"' + key + '"'
    var ki = text.indexOf(m)
    if (ki < 0) return ''
    var ci = text.indexOf(':', ki)
    if (ci < 0) return ''
    var qi = text.indexOf('"', ci + 1)
    if (qi < 0) return ''
    var out = ''
    var esc = false
    for (var i = qi + 1; i < text.length; i++) {
      var ch = text.charAt(i)
      if (esc) { out += ch; esc = false; continue }
      if (ch === '\\') { esc = true; out += ch; continue }
      if (ch === '"') break
      out += ch
    }
    try { return JSON.parse('"' + out + '"') } catch (e) { return out }
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
    return { ok: false, notOk: true, error: emsg, data: { synopsis: '', scenes: [] } }
  }

  var prep = (steps && steps.prep) || {}
  var hasDuration = (typeof prep.duration === 'number' && prep.duration > 0)
  var duration = hasDuration ? prep.duration : 1000000000

  var arr = []
  for (var j = 0; j < rawScenes.length; j++) {
    arr.push(rawScenes[j])
  }
  arr.sort(function (x, y) {
    return num(x && x.start) - num(y && y.start)
  })

  // TILE the timeline (story 13f, ADR-0003): each scene opens where the previous
  // closed (the raw starts only decide the order), the first opens at 0, the
  // last closes at the full duration. Footage can only be dropped by a cut,
  // never by a gap between scenes. The FE's toScenes applies the same rule.
  var scenes = []
  var cursor = 0
  for (var k = 0; k < arr.length; k++) {
    var sc = arr[k] || {}
    var start = cursor
    var end = Math.min(Math.max(num(sc.end), start), duration)
    if (end <= start) {
      end = Math.min(start + 0.05, duration)
    }
    if (k === arr.length - 1 && hasDuration) {
      end = duration
    }
    cursor = end

    var cutsIn = sc.cuts
    if (!cutsIn || typeof cutsIn.length !== 'number') cutsIn = []
    var cuts = []
    for (var c = 0; c < cutsIn.length; c++) {
      var cc = cutsIn[c] || {}
      var cs = Math.min(Math.max(num(cc.start), start), end)
      var ce = Math.min(Math.max(num(cc.end), start), end)
      if (ce - cs > 0.05) {
        cuts.push({ start: cs, end: ce })
      }
    }

    var title = (typeof sc.title === 'string' && sc.title) ? sc.title : ('Scene ' + (k + 1))
    var brief = (typeof sc.brief === 'string') ? sc.brief : ((typeof sc.refinePrompt === 'string') ? sc.refinePrompt : '')
    var sceneOut = { title: title, start: start, end: end, cuts: cuts }
    if (brief) { sceneOut.brief = brief }
    scenes.push(sceneOut)
  }

  var synopsisOut = (typeof synopsis === 'string') ? synopsis : ''
  return { ok: true, notOk: false, error: '', data: { synopsis: synopsisOut, scenes: scenes } }
}
