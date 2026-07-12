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
  sys += 'You are given: the finished video NARRATION SCRIPT (what was actually said, in order), a recommended TITLE and SUMMARY, the director one-line SYNOPSIS, a per-scene OUTLINE (each scene heading + the words spoken in it), a TIMESTAMPED TRANSCRIPT of the original recording (lines like `[m:ss] words`, ~8-second buckets) so you can align what is said to WHEN, the creator optional DIRECTION, the video DURATION, and CONTACT-SHEET images (grids of frames sampled across the recording, each with its wall-clock timestamp burned into a corner) as your visual context.\n\n'
  sys += 'Your job:\n'
  sys += '1. Write the post as flowing PROSE first — paragraphs that explain and narrate, not a transcript dump and not a bare bullet skeleton. Expand the spoken script into readable writing while staying FAITHFUL: never invent facts, numbers, names, features, or claims that are not supported by the script, the outline, or what is clearly visible in the frames. If something is uncertain, leave it out.\n'
  sys += '2. Begin with YAML FRONT-MATTER delimited by --- lines, containing exactly `title` and `description` (a one-sentence summary). Prefer the recommended title/summary; you may tighten them for the page.\n'
  sys += '3. Use an ELASTIC outline seeded from the scenes: roughly one `##` section per meaningful scene, in order, but you MAY merge tiny adjacent scenes into one section and rename headings for flow. Do not pad — fewer, stronger sections beat one-per-scene.\n'
  sys += '4. Add inline IMAGES SPARINGLY and only where a frame genuinely helps (a key UI state, a result, a diagram). Write each as a Markdown image whose URL is a frame token: `![A short caption](frame:<t>)`, where <t> is the moment in the ORIGINAL video in SECONDS (to pick <t>, find where that content is discussed in the TIMESTAMPED TRANSCRIPT to get its [m:ss], set <t> to a second in that window, then confirm against the contact-sheet frame whose burned-in clock is nearest) and the caption is required (it is shown under the image). Use at most a handful across the whole post; the post must read well even if every image were removed — images are additive, never load-bearing.\n\n'
  sys += 'Markdown rules: standard Markdown — `#`/`##` headings, paragraphs, `-` lists, `>` blockquotes, `**bold**`, `*italic*`, `` `code` ``. Do NOT wrap the whole document in a code fence.\n\n'
  sys += 'Output STRICT JSON only — no markdown fences around the JSON, no commentary — exactly this shape:\n'
  sys += '{"markdown": string}\n'
  sys += 'where the string is the COMPLETE Markdown document (front-matter + body). Return nothing but the JSON object.'

  var prompt = ''
  prompt += 'NARRATION SCRIPT (the finished video, in order):\n\n' + script + '\n\n'
  if (timed) { prompt += 'TIMESTAMPED TRANSCRIPT of the ORIGINAL recording (each line "[m:ss] words"; the re-voiced script above tracks the same content in the same order — use this only to locate WHEN something is discussed when choosing image timestamps):\n\n' + timed + '\n\n' }
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