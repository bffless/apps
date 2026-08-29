function handler({ steps, stepErrors }) {
  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0
  }

  // Prefer the refiner that HEARD the scene; fall back to the deaf re-run that
  // `refinerNoAudio` performs when the provider's audio input is unavailable
  // (see fallback.fn.js). Only when BOTH produced nothing is this a real error.
  function got(st) {
    return st && (st.status != null || st.output != null)
  }
  var withAudio = (steps && steps.refiner) || {}
  var deaf = (steps && steps.refinerNoAudio) || {}
  var d = got(withAudio) ? withAudio : deaf

  // Replicate/Gemini call failed (model overloaded, timeout, API error): the
  // executor drops a failed post-step's output, so steps.refiner is empty here.
  if (!got(d)) {
    // ce#662 forward-compat, as in video/extract-audio/post/check.fn.js: the code
    // travels as its own field (R120) so the harness can fill error.code. R130 keeps
    // the result keys camelCase; the failure envelopes carry the same shape as the
    // happy one so `job/get` never hands the workflow a half-built result.
    var rerr = stepErrors && (stepErrors.refiner || stepErrors.refinerNoAudio)
    var rcode = (rerr && typeof rerr.code === 'string') ? rerr.code : ''
    return { ok: false, notOk: true, code: rcode, error: 'The AI model did not return a result for this scene - it may be temporarily overloaded, or the scene may be too long. Please try refining again.', data: { cuts: [], heardAudio: false } }
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

  // Salvage helper: pull every COMPLETE top-level {...} object out of a string,
  // honouring JSON string escaping so braces inside text values don't confuse it.
  // A truncated trailing object (never closed) is simply dropped.
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
  // Find the array body for a key and JSON.parse each complete element.
  function parseArray(key) {
    var marker = '"' + key + '"'
    var ki = text.indexOf(marker)
    if (ki < 0) return []
    var bi = text.indexOf('[', ki)
    if (bi < 0) return []
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

  // Happy path: try a normal full parse. If the model truncated its JSON, fall
  // back to salvaging whatever complete cut objects we did receive.
  var parsed = null
  var sIdx = text.indexOf('{')
  var eIdx = text.lastIndexOf('}')
  if (sIdx >= 0 && eIdx > sIdx) {
    try { parsed = JSON.parse(text.slice(sIdx, eIdx + 1)) } catch (e) { parsed = null }
  }

  // 13f contract: the refiner returns cuts and nothing else. An EMPTY cuts
  // array is a valid answer (the scene is already tight) - only a response
  // with no readable "cuts" key at all is an error.
  var cutsIn
  if (parsed && typeof parsed === 'object' && parsed.cuts && typeof parsed.cuts.length === 'number') {
    cutsIn = parsed.cuts
  } else {
    cutsIn = parseArray('cuts')
  }
  if (!cutsIn || typeof cutsIn.length !== 'number') cutsIn = []

  var sawCuts = (parsed && typeof parsed === 'object' && parsed.cuts != null) || text.indexOf('"cuts"') >= 0
  if (!sawCuts) {
    var snippet = (typeof text === 'string') ? text.slice(0, 280).trim() : ''
    var emsg = snippet
      ? 'The AI model\'s response could not be read as a scene cut. Please try refining again. Model said: ' + snippet
      : 'The AI model returned an empty response for this scene - it may be temporarily overloaded. Please try refining again.'
    return { ok: false, notOk: true, code: '', error: emsg, data: { cuts: [], heardAudio: got(withAudio) } }
  }

  var prep = (steps && steps.prep) || {}
  var lo = num(prep.start)
  var hi = num(prep.end)
  if (hi <= lo) {
    hi = lo + 0.05
  }

  var cuts = []
  for (var c = 0; c < cutsIn.length; c++) {
    var cc = cutsIn[c] || {}
    var cs = Math.min(Math.max(num(cc.start), lo), hi)
    var ce = Math.min(Math.max(num(cc.end), lo), hi)
    if (ce - cs > 0.05) {
      cuts.push({ start: cs, end: ce })
    }
  }
  cuts.sort(function (x, y) { return x.start - y.start })

  // `heardAudio: false` means these cuts came from the DEAF re-run - the model
  // read the sheets, word timings and measured dead space, but never heard the
  // scene. That is a quiet quality drop (the provider's audio input failed), so
  // it rides back with the cuts and the UI flags it. No schema change: the job
  // row's `result` is already a json field.
  return { ok: true, notOk: false, code: '', error: '', data: { cuts: cuts, heardAudio: got(withAudio) } }
}
