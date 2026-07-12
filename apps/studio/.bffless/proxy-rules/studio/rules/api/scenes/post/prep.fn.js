function handler({ request, deployment }) {
  var NL = String.fromCharCode(10)
  var body = (request && request.body) || {}
  var urls = body.sheetUrls
  if (!urls || typeof urls.length !== 'number') urls = []
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var out = {}
  for (var i = 0; i < 10; i++) {
    var p = ''
    if (i < urls.length && urls[i]) {
      var key = String(urls[i]).replace(/^\/+/, '')
      key = key.replace(/^api\/uploads\//, '')
      p = prefix + key
    }
    out['path' + i] = p
  }
  var transcript = typeof body.transcript === 'string' ? body.transcript : ''
  var direction = typeof body.direction === 'string' ? body.direction : ''
  var duration = typeof body.duration === 'number' ? body.duration : 0

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

  out.transcript = transcript
  out.direction = direction
  out.duration = duration
  out.system = sys
  out.prompt = prompt
  return out
}