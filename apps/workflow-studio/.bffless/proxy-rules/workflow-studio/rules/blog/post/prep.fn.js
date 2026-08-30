function handler({ request, deployment }) {
  var NL = String.fromCharCode(10)
  var body = (request && request.body) || {}

  // R129 path confinement (copied verbatim into every prep.fn.js - function_handler
  // files cannot import).
  function safe(v) {
    if (typeof v !== 'string') return ''
    var p = v.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!p) return ''
    if (p.indexOf('..') >= 0) return ''
    if (p.indexOf('workflows/') !== 0) return ''
    return p
  }
  var REFUSAL = 'Refused - every path must be an uploads-relative path under workflows/'

  function no(msg) {
    var bad = { ok: false, notOk: true, error: msg }
    for (var b = 0; b < 10; b++) bad['path' + b] = ''
    bad.transcript = ''
    bad.duration = 0
    bad.system = ''
    bad.prompt = ''
    return bad
  }

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
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  for (var i = 0; i < 10; i++) {
    out['path' + i] = i < flat.length ? prefix + flat[i] : ''
  }

  // apps/studio/src/lib/contactSheet.ts `clockLabel`, ported to ES5 (m:ss, h:mm:ss past
  // an hour) - the same clock the transcript lines and the contact-sheet cells use.
  function clockLabel(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) seconds = 0
    var total = Math.floor(seconds)
    var hh = Math.floor(total / 3600)
    var mm = Math.floor((total % 3600) / 60)
    var ss = total % 60
    var s2 = ss < 10 ? '0' + ss : String(ss)
    if (hh) return hh + ':' + (mm < 10 ? '0' + mm : String(mm)) + ':' + s2
    return mm + ':' + s2
  }

  // R135: the blog writer emits `frame:<seconds>` tokens that the workflow's
  // `frame-times` script maps global -> local through the cumulative durations, so the
  // blog must read the SAME globally-clocked transcript the director read. Identical to
  // the `scenes` rule's shiftLabels (R132: one global clock; R133: the 8s buckets are
  // NOT recomputed, so an offset that is not a multiple of 8 leaves the labels off-grid
  // - they are anchors to read a moment by, not a grid). Single-source runs (offset 0)
  // are untouched.
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

  // One transcript across every source, each section introduced by a boundary marker
  // naming the video and its GLOBAL start (apps/studio/src/lib/director.ts
  // `combinedTimedTranscript`, as ported by the `scenes` rule): the SAME header the
  // director read - `--- VIDEO n: <file name> (starts m:ss) ---` - so the writer knows the
  // recordings by name too (apps#468). `sources` is confined like every other path
  // (R129) even though it is never signed here; a caller that sends none, or fewer than
  // `timed`, gets the index-only header for the unnamed videos.
  var timedIn = body.timed
  if (!timedIn || typeof timedIn.length !== 'number') timedIn = []
  var durationsIn = body.durations
  if (!durationsIn || typeof durationsIn.length !== 'number') durationsIn = []
  var sourcesIn = body.sources
  if (!sourcesIn || typeof sourcesIn.length !== 'number') sourcesIn = []
  var sources = []
  for (var s0 = 0; s0 < sourcesIn.length; s0++) {
    var sp = safe(sourcesIn[s0])
    if (!sp) return no(REFUSAL)
    sources.push(sp)
  }
  var sections = []
  var cursor = 0
  for (var t0 = 0; t0 < timedIn.length; t0++) {
    var rendered = typeof timedIn[t0] === 'string' ? timedIn[t0] : ''
    var name = ''
    if (t0 < sources.length) {
      var slash = sources[t0].lastIndexOf('/')
      name = ': ' + (slash >= 0 ? sources[t0].slice(slash + 1) : sources[t0])
    }
    var header = '--- VIDEO ' + (t0 + 1) + name + ' (starts ' + clockLabel(cursor) + ') ---'
    var bodyText = shiftLabels(rendered, cursor)
    sections.push(t0 === 0 ? header + NL + bodyText : NL + header + NL + bodyText)
    var dv = durationsIn[t0]
    cursor = cursor + ((typeof dv === 'number' && isFinite(dv) && dv > 0) ? dv : 0)
  }
  var transcript = sections.join(NL)

  var script = typeof body.script === 'string' ? body.script : ''
  var direction = typeof body.direction === 'string' ? body.direction : ''
  var title = typeof body.title === 'string' ? body.title : ''
  var summary = typeof body.summary === 'string' ? body.summary : ''
  var synopsis = typeof body.synopsis === 'string' ? body.synopsis : ''
  var duration = cursor
  var scenes = (body.scenes && typeof body.scenes.length === 'number') ? body.scenes : []
  var timed = transcript

  // The timestamped transcript IS the narration with its timing inline; prefer it so
  // image placement is a direct read of the adjacent [m:ss]. Fall back to the plain
  // finished script only when no timed transcript is available.
  var haveTimed = timed.length > 0
  var narration = haveTimed ? timed : script

  var outline = ''
  for (var s = 0; s < scenes.length; s++) {
    var sc = scenes[s] || {}
    var st = (typeof sc.title === 'string') ? sc.title : ''
    var tr = (typeof sc.transcript === 'string') ? sc.transcript : ''
    outline += (s + 1) + '. ' + (st || ('Scene ' + (s + 1)))
    if (tr) { outline += ' — ' + tr }
    outline += '\n'
  }

  var sys = ''
  sys += 'You are a senior technical writer. You turn a finished short video into a faithful, well-structured written blog post that reads well on its own.\n\n'
  if (haveTimed) {
    sys += 'You are given: the video TIMESTAMPED NARRATION — the words that were said, in order, as lines like `[m:ss] words` (~8-second buckets) so every sentence carries its own moment in the video; a recommended TITLE and SUMMARY; the director one-line SYNOPSIS; a per-scene OUTLINE (each scene heading + the words spoken in it); the creator optional DIRECTION; the video DURATION; and CONTACT-SHEET images (grids of frames sampled across the recording, each with its wall-clock timestamp burned into a corner) as your visual context.\n\n'
  } else {
    sys += 'You are given: the video NARRATION (the words that were said, in order); a recommended TITLE and SUMMARY; the director one-line SYNOPSIS; a per-scene OUTLINE (each scene heading + the words spoken in it); the creator optional DIRECTION; the video DURATION; and CONTACT-SHEET images (grids of frames sampled across the recording, each with its wall-clock timestamp burned into a corner) as your visual context.\n\n'
  }
  sys += 'Your job:\n'
  sys += '1. Write the post as flowing PROSE first — paragraphs that explain and narrate, not a transcript dump and not a bare bullet skeleton. Expand the narration into readable writing while staying FAITHFUL: never invent facts, numbers, names, features, or claims that are not supported by the narration, the outline, or what is clearly visible in the frames. If something is uncertain, leave it out.'
  if (haveTimed) {
    sys += ' The `[m:ss]` markers are there to help you place images — do NOT copy them into your prose.'
  }
  sys += '\n'
  sys += '2. Begin with YAML FRONT-MATTER delimited by --- lines, containing exactly `title` and `description` (a one-sentence summary). Prefer the recommended title/summary; you may tighten them for the page.\n'
  sys += '3. Use an ELASTIC outline seeded from the scenes: roughly one `##` section per meaningful scene, in order, but you MAY merge tiny adjacent scenes into one section and rename headings for flow. Do not pad — fewer, stronger sections beat one-per-scene.\n'
  if (haveTimed) {
    sys += '4. Add inline IMAGES SPARINGLY and only where a frame genuinely helps (a key UI state, a result, a diagram). Write each as a Markdown image whose URL is a frame token: `![A short caption](frame:<t>)`, where <t> is the moment in the video in SECONDS. Read <t> DIRECTLY off the narration: take the `[m:ss]` on the narration line(s) you are illustrating and convert it to seconds (minutes*60 + seconds), then confirm against the contact-sheet frame whose burned-in clock is nearest. The caption is required (it is shown under the image). Use at most a handful across the whole post; the post must read well even if every image were removed — images are additive, never load-bearing.\n\n'
  } else {
    sys += '4. Add inline IMAGES SPARINGLY and only where a frame genuinely helps (a key UI state, a result, a diagram). Write each as a Markdown image whose URL is a frame token: `![A short caption](frame:<t>)`, where <t> is the moment in the video in SECONDS (estimate it from the position of that content within the narration and confirm against the contact-sheet frame whose burned-in clock is nearest) and the caption is required (it is shown under the image). Use at most a handful across the whole post; the post must read well even if every image were removed — images are additive, never load-bearing.\n\n'
  }
  sys += '5. When a frame shows CODE, a configuration file, a terminal command, or any other block of TEXT the reader would want to reuse, do NOT rely on the screenshot alone — a screenshot of code cannot be copied and is of little use on its own. TRANSCRIBE that content into the post as a fenced code block with the correct language tag (for example ```typescript, ```html, ```xml, ```css, or ```bash) so the reader can copy and paste it directly. Transcribe faithfully from what is legible in the frames and the narration; if part of it is not clearly readable, include only what you can read and never guess or invent the rest. You may still add the frame as an image when the surrounding UI matters, but the copyable code block is the point.\n\n'
  sys += 'Markdown rules: standard Markdown — `#`/`##` headings, paragraphs, `-` lists, `>` blockquotes, `**bold**`, `*italic*`, `` `code` ``. Do NOT wrap the whole document in a code fence.\n\n'
  sys += 'Output STRICT JSON only — no markdown fences around the JSON, no commentary — exactly this shape:\n'
  sys += '{"markdown": string}\n'
  sys += 'where the string is the COMPLETE Markdown document (front-matter + body). Return nothing but the JSON object.'

  var prompt = ''
  if (haveTimed) {
    prompt += 'TIMESTAMPED NARRATION (what was said and when, in order — each line is `[m:ss] words`):\n\n' + narration + '\n\n'
  } else {
    prompt += 'NARRATION (the finished video, in order — no timestamps available):\n\n' + narration + '\n\n'
  }
  if (title) { prompt += 'RECOMMENDED TITLE: ' + title + '\n' }
  if (summary) { prompt += 'SUMMARY: ' + summary + '\n' }
  if (synopsis) { prompt += 'DIRECTOR SYNOPSIS: ' + synopsis + '\n' }
  if (outline) { prompt += '\nSCENE OUTLINE (title — transcript), in order:\n' + outline }
  prompt += '\nThe finished video is ' + Math.round(duration) + ' seconds long. The attached images are the contact sheets described in your instructions.\n'
  if (direction) {
    prompt += '\nEXTRA DIRECTION FROM THE CREATOR (weight this heavily): ' + direction + '\n'
  }
  prompt += '\nNow write the blog post as STRICT JSON exactly as specified: {"markdown": "..."}. Return nothing but the JSON object.'

  out.transcript = transcript
  out.duration = duration
  out.system = sys
  out.prompt = prompt
  return out
}
