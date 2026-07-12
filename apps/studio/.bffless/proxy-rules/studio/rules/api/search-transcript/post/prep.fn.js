function handler({ request }) {
  var body = (request && request.body) || {}
  var query = typeof body.query === 'string' ? body.query : ''
  var transcript = typeof body.transcript === 'string' ? body.transcript : ''
  var duration = typeof body.duration === 'number' ? body.duration : 0

  var sys = ''
  sys += 'You are a simple transcript search. You are given a timestamped transcript of one screen recording (each line starts with its [m:ss] time) and a search query.\n'
  sys += 'No fancy search: just read the transcript and find the spans that match the query - by literal words OR by meaning/mood (e.g. \"where I sound excited\").\n'
  sys += 'Return STRICT JSON only - no markdown fences, no commentary - exactly this shape:\n'
  sys += '{\"results\": [{\"start\": number, \"end\": number, \"snippet\": string, \"reason\": string}]}\n'
  sys += 'Rules: times are SECONDS from the start of the recording, within [0, duration]; start < end; each span should cover the matching words (use the line timestamps to estimate; spans are typically 4-20 seconds); snippet is the matching words quoted from the transcript; reason is one short line on why it matches; order results by start; at most 20 results; return {\"results\": []} when nothing matches. Return nothing but the JSON object.'

  var prompt = ''
  prompt += 'TIMESTAMPED TRANSCRIPT (each line starts with its [m:ss] time):\n\n' + transcript + '\n\n'
  prompt += 'The full recording is ' + Math.round(duration) + ' seconds long.\n\n'
  prompt += 'SEARCH QUERY: ' + query + '\n\n'
  prompt += 'Find the matching spans and return STRICT JSON exactly as specified.'

  return { query: query, duration: duration, system: sys, prompt: prompt }
}
