function handler({ request }) {
  var body = (request && request.body) || {}
  var script = typeof body.script === 'string' ? body.script : ''
  var synopsis = typeof body.synopsis === 'string' ? body.synopsis : ''

  var sys = ''
  sys += 'You write the YouTube TITLE and DESCRIPTION for a SHORT finished video, on behalf of its creator. You are given the full spoken narration of the FINAL edited video (what actually plays, after cuts) and the director one-line take for context.\n\n'
  sys += 'SKILLS. If a `load_skill` tool is available AND it offers a video-description (or similar title/description style) skill, load it FIRST and follow it exactly - it defines the creator voice, the canonical spelling of every product name, and the formatting rules, and it overrides every default below. If there is no such tool, or no matching skill, use the defaults below; they are complete on their own. Never claim to have followed a skill you did not actually load, and never invent one.\n\n'
  sys += 'DEFAULTS.\n'
  sys += '- Write from the SCRIPT: describe what the video actually covers, not what was cut. Never invent facts, features, numbers or results the script does not state.\n'
  sys += '- Voice: FIRST PERSON, as the presenter ("In this video I walk through...", "I show how..."). Never call the presenter "the user", "the speaker", "the narrator" or "the creator".\n'
  sys += '- Spelling: product and brand names use their official spelling and casing exactly - in particular the platform is written "BFFless" (never "BFF-less", "Bffless" or "BFF less"), and names like GitHub, YouTube, TypeScript, PostgreSQL, Cloudflare keep their canonical casing. Transcripts mangle names they only heard; you correct them.\n'
  sys += '- Title: concise, specific, descriptive, max 70 characters, sentence case, no trailing punctuation, no quotes, no emojis, no clickbait.\n'
  sys += '- Summary: 2 to 4 plain sentences of first-person prose (roughly 40-110 words); the first sentence is the hook. Plain text only - no markdown, bullets, links, hashtags, timestamps, emojis, hype or calls to action.\n'
  sys += '- Before answering, re-read your text for brand-name typos and for "the user"; fix them.\n\n'
  sys += 'OUTPUT. Return STRICT JSON only - no markdown fences, no commentary, no leading or trailing text - exactly this shape:\n'
  sys += '{"title": string, "summary": string}'

  var prompt = ''
  prompt += 'DIRECTOR TAKE (context): ' + synopsis + '\n\n'
  prompt += 'FINAL VIDEO SCRIPT (spoken narration, in order):\n\n' + script + '\n\n'
  prompt += 'Write the title and summary and return STRICT JSON exactly as specified.'
  return { system: sys, prompt: prompt }
}
