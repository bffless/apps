function handler({ request }) {
  var body = (request && request.body) || {}
  var script = typeof body.script === 'string' ? body.script : ''
  var synopsis = typeof body.synopsis === 'string' ? body.synopsis : ''
  var sys = ''
  sys += 'You title and describe a SHORT finished video for its creator. You are given the full spoken narration of the FINAL edited video (what actually plays, after cuts) and the director one-line take for context.\n'
  sys += 'Write from the SCRIPT - describe what the video actually covers, not what was cut. No hype, no clickbait, no emojis, no surrounding quotes.\n'
  sys += 'Return STRICT JSON only - no markdown fences, no commentary - exactly this shape:\n'
  sys += '{"title": string, "summary": string}\n'
  sys += 'Rules: title is concise, specific and descriptive (max 70 characters); summary is 2 to 4 plain sentences, third person, describing what the video covers. Return nothing but the JSON object.'
  var prompt = ''
  prompt += 'DIRECTOR TAKE (context): ' + synopsis + '\n\n'
  prompt += 'FINAL VIDEO SCRIPT (spoken narration, in order):\n\n' + script + '\n\n'
  prompt += 'Write the title and summary and return STRICT JSON exactly as specified.'
  return { system: sys, prompt: prompt }
}