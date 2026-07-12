function handler({ request, deployment }) {
  var body = (request && request.body) || {}

  // Sign the existing Contact sheets step-by-step (like the master director):
  // turn each serve path into a bucket key the postStep signed_url handlers read.
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

  var script = typeof body.script === 'string' ? body.script : ''
  var direction = typeof body.direction === 'string' ? body.direction : ''
  var title = typeof body.title === 'string' ? body.title : ''
  var summary = typeof body.summary === 'string' ? body.summary : ''
  var synopsis = typeof body.synopsis === 'string' ? body.synopsis : ''
  var duration = typeof body.duration === 'number' ? body.duration : 0
  var scenes = (body.scenes && typeof body.scenes.length === 'number') ? body.scenes : []
  var timed = typeof body.timedTranscript === 'string' ? body.timedTranscript : ''

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

  out.system = sys
  out.prompt = prompt
  return out
}
