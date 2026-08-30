function handler({ request, deployment }) {
  var NL = String.fromCharCode(10)
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import).
  function safe(v) {
    if (typeof v !== 'string') return ''
    // Same steps, same order as the harness's files/sign/post/confine.fn.js (apps#466):
    // strip leading slashes, an `api/uploads/` prefix and any `?query`, then refuse
    // `..`, `//` and anything not anchored at `workflows/`. The trailing-slash strip is
    // this app's own, so an outPrefix comes back normalised.
    var p = v.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0].replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('//') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'

  function no(msg) {
    var bad = { ok: false, notOk: true, error: msg }
    for (var b = 0; b < 10; b++) bad['path' + b] = ''
    bad.sources = []
    bad.spans = []
    bad.transcript = ''
    bad.direction = ''
    bad.duration = 0
    bad.system = ''
    bad.prompt = ''
    return bad
  }

  // apps/studio/src/lib/contactSheet.ts `clockLabel`, ported to ES5 (m:ss, h:mm:ss
  // past an hour) - the boundary marker's "starts m:ss" uses the same clock the
  // transcript lines and the contact-sheet cells do.
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

  var timedIn = body.timed
  if (!timedIn || typeof timedIn.length !== 'number') timedIn = []
  var durationsIn = body.durations
  if (!durationsIn || typeof durationsIn.length !== 'number') durationsIn = []
  var sourcesIn = body.sources
  if (!sourcesIn || typeof sourcesIn.length !== 'number') sourcesIn = []

  // Every source path is confined and kept, so parse can hand each scene back the
  // source it belongs to (R130 keeps the keys camelCase).
  var sources = []
  for (var s0 = 0; s0 < sourcesIn.length; s0++) {
    var sp = safe(sourcesIn[s0])
    if (!sp) return no(REFUSAL)
    sources.push(sp)
  }

  // apps/studio/src/lib/sources.ts `sourceOffsets`: lay the sources end to end on one
  // global timeline. parse re-uses these spans to map a global scene back to a source.
  var spans = []
  var cursor = 0
  for (var d0 = 0; d0 < sources.length; d0++) {
    var dv = durationsIn[d0]
    var dur = (typeof dv === 'number' && isFinite(dv) && dv > 0) ? dv : 0
    spans.push({ start: cursor, end: cursor + dur })
    cursor = cursor + dur
  }
  var duration = cursor

  // apps/studio/src/lib/director.ts `combinedTimedTranscript` (L295+): one transcript
  // across every source, each section introduced by a boundary marker naming the video
  // and its GLOBAL start, so the director sees one continuous talk but knows where each
  // video begins.
  //
  // R132: the director reasons on ONE GLOBAL clock, exactly as Studio's version did.
  // Studio shifted each source's WORDS by its offset before bucketing; here the buckets
  // arrive already rendered (`timed[]`, one string per source), so each line's leading
  // `[m:ss]` label is re-stamped at `offset + bucketSeconds` instead. R133: the buckets
  // are NOT recomputed, so with an offset that is not a multiple of 8 the labels sit
  // off-grid (0:13, 0:21, ...) - accepted, because they are anchors to read a moment by,
  // not a grid. Single-source runs (offset 0) are untouched. `parse` consumes global
  // seconds unchanged (toScenes maps them back to a source).
  function shiftLabels(text, offset) {
    if (!offset || !text) return text
    var lines = text.split(NL)
    var stamped = []
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li]
      var close = line.indexOf(']')
      if (line.charAt(0) !== '[' || close < 1) { stamped.push(line); continue }
      var pieces = line.slice(1, close).split(':')
      var secs = 0
      var readable = pieces.length === 2 || pieces.length === 3
      for (var pi = 0; pi < pieces.length && readable; pi++) {
        if (!/^[0-9]+$/.test(pieces[pi])) readable = false
        else secs = secs * 60 + parseInt(pieces[pi], 10)
      }
      if (!readable) { stamped.push(line); continue }
      stamped.push('[' + clockLabel(secs + offset) + ']' + line.slice(close + 1))
    }
    return stamped.join(NL)
  }

  var sections = []
  for (var t0 = 0; t0 < sources.length; t0++) {
    var slash = sources[t0].lastIndexOf('/')
    var fileName = slash >= 0 ? sources[t0].slice(slash + 1) : sources[t0]
    var rendered = typeof timedIn[t0] === 'string' ? timedIn[t0] : ''
    var offset = spans[t0] ? spans[t0].start : 0
    var bodyText = shiftLabels(rendered, offset)
    var header = '--- VIDEO ' + (t0 + 1) + ': ' + fileName + ' (starts ' + clockLabel(offset) + ') ---'
    sections.push(t0 === 0 ? header + NL + bodyText : NL + header + NL + bodyText)
  }
  var transcript = sections.join(NL)
  var direction = typeof body.direction === 'string' ? body.direction : ''

  var out = { ok: true, notOk: false, error: '' }
  // R147: `sheets` is ONE nested list per SOURCE, in `per-video` order - the workflow's
  // `sheets` matrix job collects one entry per plan - and an entry may be null or empty:
  // a recording with no spoken audio plans no times, so its contact-sheet step is
  // `if:`-skipped and contributes nothing. Up to 10 sheets are signed for the multimodal
  // call, picked ROUND-ROBIN across the sources (source 0's first sheet, source 1's
  // first, then each source's second, ...) rather than flattening in order: a flat
  // `slice(0, 10)` spent the whole budget on a long FIRST recording and the director
  // never saw a frame of the second.
  var perSource = []
  var longest = 0
  var sheetsIn = body.sheets
  if (!sheetsIn || typeof sheetsIn.length !== 'number') sheetsIn = []
  for (var g = 0; g < sheetsIn.length; g++) {
    var list = sheetsIn[g]
    if (typeof list === 'string') list = [list]
    if (!list || typeof list.length !== 'number') { perSource.push([]); continue }
    var one = []
    for (var h = 0; h < list.length; h++) {
      var sheet = safe(list[h])
      if (!sheet) return no(REFUSAL)
      one.push(sheet)
    }
    if (one.length > longest) longest = one.length
    perSource.push(one)
  }
  var flat = []
  for (var rr = 0; rr < longest && flat.length < 10; rr++) {
    for (var si = 0; si < perSource.length && flat.length < 10; si++) {
      if (rr < perSource[si].length) flat.push(perSource[si][rr])
    }
  }
  var storagePrefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  for (var i = 0; i < 10; i++) {
    out['path' + i] = i < flat.length ? storagePrefix + flat[i] : ''
  }

  var sys = ''
  sys += 'You are the Master Director: an award-winning film and YouTube editor who turns long, rambling screen recordings into tight, compelling shorts.' + NL
  sys += 'You are given (1) a timestamped transcript and (2) contact-sheet images: grids of frames sampled across the recording, each with its wall-clock timestamp burned into a corner. Use BOTH the words and the frames to understand what happens and when.' + NL + NL
  sys += "THE EDIT MODEL (cut-first): the final video is the ORIGINAL recording minus CUTS, always in the speaker's own recorded voice. Nothing is rewritten, re-voiced or added - a cut (a span of footage to drop) is the only edit. You never write narration or a script." + NL + NL
  sys += 'Your job is the BIG PICTURE only - a second-pass editor places the precise cuts for each scene later.' + NL
  sys += '1. Write a one-sentence SYNOPSIS (a logline) of the whole talk: punchy, like a movie one-liner.' + NL
  sys += '2. TILE the recording into logical SCENES (chapters), roughly 2-5 minutes each. Never split a strong continuous run just to hit a number. Give each a short chapter TITLE. Scenes MUST tile the recording exactly: the first scene starts at 0, each scene starts exactly where the previous one ends, and the last scene ends at the full duration. Every second of footage belongs to exactly one scene - footage is only ever dropped by a cut, never by leaving it outside the scenes.' + NL
  sys += '3. For EACH scene write a CUTTING BRIEF (brief): one to three sentences of prose instructions to the second-pass editor who will place the precise cuts inside THIS scene. Say what to drop and why - false starts, repeated takes, tangents, long dead air - grounded in what you saw across the WHOLE recording (e.g. "the demo is re-attempted here; keep only the second take"), plus the pacing to aim for and anything on-screen to preserve. Guidance in words, not spans - do NOT restate exact timestamps you already give as cuts, and do NOT write narration.' + NL
  sys += '4. For EACH scene give the obvious footage spans to CUT within it (cuts: array of {start,end} in seconds) - clear dead air, tangents, false starts, repeated takes. This is the coarse baseline; the result must already be watchable. Mark only a few LARGER spans worth removing; do not place cuts close together or slice out many tiny fragments - leaving a little dead space is better than a choppy, over-cut result. The second-pass editor refines these.' + NL + NL
  sys += 'Rules for timestamps: all values are SECONDS from the start of the recording. For every scene start < end. Scenes are ordered earliest-first, must NOT overlap and must NOT leave gaps (each start equals the previous end; the first start is 0; the last end is the full duration). Every cut lies inside its own scene [start,end]. Use the transcript timestamps and the frame timestamps to be accurate.' + NL + NL
  sys += 'MULTI-VIDEO: if the transcript contains "--- VIDEO n: ... ---" boundary markers, it is several source recordings concatenated onto one timeline. Put a scene boundary exactly at every video boundary - a scene must NEVER start in one video and end in another.' + NL + NL
  sys += 'Output STRICT JSON only - no markdown fences, no commentary - exactly this shape:' + NL
  sys += '{"synopsis": string, "scenes": [{"title": string, "start": number, "end": number, "brief": string, "cuts": [{"start": number, "end": number}]}]}' + NL
  sys += 'Do NOT include a transcript, script, narration or voicing field. Return nothing but the JSON object.'

  var prompt = ''
  prompt += 'TIMESTAMPED TRANSCRIPT (each line starts with its [m:ss] time):' + NL + NL + transcript + NL + NL
  prompt += 'The full recording is ' + Math.round(duration) + ' seconds long. The attached images are the contact sheets described in your instructions.' + NL + NL
  if (direction) {
    prompt += 'EXTRA DIRECTION FROM THE CREATOR (weight this heavily): ' + direction + NL + NL
  }
  prompt += 'Now produce the synopsis and the scene breakdown as STRICT JSON exactly as specified. Return nothing but the JSON object.'

  out.sources = sources
  out.spans = spans
  out.transcript = transcript
  out.direction = direction
  out.duration = duration
  out.system = sys
  out.prompt = prompt
  return out
}
