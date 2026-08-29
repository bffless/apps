function handler({ request, deployment }) {
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0 }
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
    bad.audioPath = ''
    bad.start = 0
    bad.end = 0
    bad.system = ''
    bad.prompt = ''
    return bad
  }

  // Up to 10 contact sheets are signed for the multimodal call, in order (Studio signed
  // 10 the same way). The workflow sends uploads-relative paths, not /api/uploads/ URLs.
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var sheetsIn = body.sheets
  if (!sheetsIn || typeof sheetsIn.length !== 'number') sheetsIn = []
  var sheets = []
  for (var s0 = 0; s0 < sheetsIn.length; s0++) {
    var sheet = safe(sheetsIn[s0])
    if (!sheet) return no(REFUSAL)
    sheets.push(sheet)
  }
  var out = { ok: true, notOk: false, error: '' }
  for (var i = 0; i < 10; i++) {
    out['path' + i] = i < sheets.length ? prefix + sheets[i] : ''
  }

  // Studio THREW when the scene audio was missing; here a bad or missing path is a
  // refusal (R129) - answered 400 before the job row and the paid Gemini call exist.
  var audio = safe(body.audio)
  if (!audio) return no(REFUSAL)
  out.audioPath = prefix + audio

  var start = num(body.start)
  var end = num(body.end)
  if (end <= start) { end = start + 0.05 }
  var wordTimings = typeof body.wordTimings === 'string' ? body.wordTimings : ''
  var brief = typeof body.brief === 'string' ? body.brief.trim() : ''
  // Decision 17: the harness measures no dead space, so this stays empty, Studio's optional
  // MEASURED DEAD SPACE section never renders, and the three clauses that would otherwise
  // promise it are trimmed (R136, below). Nothing is invented to fill it.
  var deadSpace = typeof body.deadSpace === 'string' ? body.deadSpace.trim() : ''
  // The harness has ONE direction input: `inputs.direction`, the creator's note to the
  // director for the WHOLE video (the same value the `scenes` rule is sent). That is
  // Studio's `directorDirection`, NOT its per-scene `direction` (Studio's was the scene's
  // own `refinePrompt`, typed per scene in the Studio UI). There is no per-scene note in
  // the port, so the prompt's "INSTRUCTIONS FOR THIS SCENE" section is dropped and the
  // whole-video section carries it.
  var directorDirection = typeof body.direction === 'string' ? body.direction.trim() : ''
  var sceneNumber = num(body.sceneNumber)
  var sceneCount = num(body.sceneCount)
  var previousContext = typeof body.previousContext === 'string' ? body.previousContext.trim() : ''

  var sys = ''
  sys += "You are the Scene Refiner: an expert film and YouTube editor placing the precise cuts for ONE scene of a longer talk." + NL
  sys += "THE EDIT MODEL (cut-first): the finished scene is this scene's ORIGINAL footage minus your cuts, always in the speaker's own recorded voice. Nothing is rewritten, re-voiced or added - a cut (a span of footage to drop) is the ONLY edit you can make. You never write narration, a script or text of any kind." + NL + NL
  // R136: the input list, the accuracy rule below and the closing user instruction all name
  // the MEASURED DEAD SPACE unconditionally in Studio, but under Decision 17 the harness
  // measures none - so promising it made the prompt assert an input the refiner never gets.
  // With dead space present each of the three renders Studio's sentence byte for byte; with
  // none, the list is renumbered and the two clauses name only the inputs that are really
  // there. (The SNAP CUT EDGES clause below is left alone: its "whenever one is available"
  // already reads correctly either way.)
  sys += "You are given (1) the scene WORD TIMINGS - every spoken word with its exact start and end time in seconds, "
  if (deadSpace) {
    sys += "(2) the MEASURED DEAD SPACE - spans of true silence measured from the audio waveform itself, not guessed from transcript gaps, (3) contact-sheet images sampled DENSELY across just this scene, each frame with its wall-clock timestamp burned into a corner, (4) this scene's own AUDIO, and (5) the director's CUTTING BRIEF - instructions from the first-pass editor who watched the whole recording. Use all of them." + NL + NL
  } else {
    sys += "(2) contact-sheet images sampled DENSELY across just this scene, each frame with its wall-clock timestamp burned into a corner, (3) this scene's own AUDIO, and (4) the director's CUTTING BRIEF - instructions from the first-pass editor who watched the whole recording. Use all of them." + NL + NL
  }
  sys += "Decide precisely ONE thing - cuts: the footage spans to DROP within this scene, each {start, end} in seconds (filler, false starts, repeated takes, tangents, long dead air, coughs and interruptions, and whatever the brief calls out)." + NL + NL
  sys += "SNAP CUT EDGES INTO SILENCE, NEVER MID-WORD: every cut boundary must land in a gap between words - inside a measured dead-space span whenever one is available, otherwise between one word's end and the next word's start from the WORD TIMINGS. Never place a boundary inside a word's [start, end], and keep a small breath of space (about 0.15s) clear of the adjacent kept word's edge so onsets and tails are never clipped. Long measured dead space is the prime territory to cut; when cutting it, keep a natural beat of silence (about 0.3-0.5s) rather than butting two words hard together." + NL + NL
  sys += "BIAS TOWARD KEEPING FOOTAGE: the creator can trim further by hand afterwards but CANNOT recover audio you remove, so when in doubt, KEEP it. Cut only CLEARLY unwanted material. Prefer a few LARGER cuts (whole tangents, long dead air, abandoned takes) over many tiny micro-slices; skip cuts shorter than about a second unless the span is clearly unwanted (a cough, a hard interruption). DO NOT CUT TOO CLOSE TOGETHER: if removing a span would leave less than about 3 seconds of kept footage between two cuts, keep the footage and accept a little dead space instead. A slightly loose take beats an over-cut, choppy one. Returning few or even NO cuts is a valid answer for a scene that is already tight." + NL + NL
  sys += "AUDIO: the attached audio file is this scene's soundtrack, cut to exactly the scene span - audio time 0:00 corresponds to " + start + "s on the shared timeline used by the word timings, the dead space and the cuts; add " + start + " to any time you hear before using it as a boundary. Listen and align every cut edge to the natural flow of speech. A cough, a shout or an interruption (e.g. yelling at a pet), a throat clear, an off-script noise or a restart that does not belong in the final cut must be covered by a cut." + NL + NL
  sys += "Rules: all values are SECONDS from the start of the whole recording and MUST lie within the scene span [" + start + ", " + end + "]. For every cut start < end. Cuts are ordered earliest-first and must NOT overlap. "
  sys += (deadSpace
    ? "Use the word timings, the measured dead space and the frame timestamps to be accurate."
    : "Use the word timings and the frame timestamps to be accurate.") + NL + NL
  sys += "CONTINUITY: this scene is one of several stitched together in order. You may be told its position in the talk and the last words the viewer hears before it. Use that to judge the opening seam - e.g. cut a re-introduction of something the viewer just heard - but only ever through cuts inside THIS scene." + NL + NL
  sys += 'Output STRICT JSON only - no markdown fences, no commentary - exactly this shape:' + NL
  sys += '{"cuts": [{"start": number, "end": number}]}' + NL
  sys += 'Do NOT return segments, narration or text of any kind. Return nothing but the JSON object.'

  var prompt = ''
  prompt += "SCENE SPAN: start=" + start + "s, end=" + end + "s (duration " + Math.round(end - start) + "s)." + NL + NL
  prompt += 'SCENE WORD TIMINGS (one line per spoken word, "start end word" in seconds on the shared timeline; cut boundaries must land BETWEEN these words, never inside one):' + NL + NL + wordTimings + NL + NL
  if (deadSpace) {
    prompt += 'MEASURED DEAD SPACE (one line per span of true silence, "start end" in seconds on the shared timeline, measured from the waveform - the prime territory for cut edges):' + NL + NL + deadSpace + NL + NL
  }
  prompt += "The attached images are dense contact sheets for THIS scene." + NL + NL
  prompt += "The attached audio is this scene's own soundtrack (audio 0:00 = " + start + "s on the shared timeline)." + NL + NL
  if (brief) {
    prompt += "THE DIRECTOR'S CUTTING BRIEF FOR THIS SCENE (from the first pass over the whole recording - follow it): " + brief + NL + NL
  }
  if (directorDirection) {
    prompt += "THE CREATOR'S OVERALL DIRECTION FOR THE WHOLE VIDEO (context for this scene): " + directorDirection + NL + NL
  }
  if (sceneNumber && sceneCount) {
    prompt += "POSITION IN THE TALK: this is scene " + sceneNumber + " of " + sceneCount + "." + NL + NL
  }
  if (previousContext) {
    prompt += "THE PREVIOUS SCENE'S KEPT SPEECH ENDS WITH (context only - it belongs to another scene; you can only cut inside THIS scene): \"" + previousContext + "\"" + NL + NL
  }
  prompt += "Now place the precise cuts for this scene using the exact word timings " + (deadSpace ? "and measured dead space " : "") + "above, and produce them as STRICT JSON exactly as specified. Return nothing but the JSON object."

  out.start = start
  out.end = end
  out.system = sys
  out.prompt = prompt
  return out
}
