function handler({ steps, request }) {
  // Compose the report from the greet lines; poster = the uploaded photo's path (or null).
  const req = (steps.createJob && steps.createJob.request) || request.body || {}
  const lines = Array.isArray(req.lines) ? req.lines : []
  const markdown = ['## Hello report', '', ...lines.map((l) => `- ${l}`)].join('\n')
  const ms = Date.now() - (steps.createJob.startedMs || Date.now())
  return { markdown, posterPath: req.photo || null, ms }
}
