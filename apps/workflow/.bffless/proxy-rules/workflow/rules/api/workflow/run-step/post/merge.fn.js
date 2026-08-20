function handler({ steps, request }) {
  const rows = (r) => (r && (r.records || r.data || r.rows)) || []
  const row = rows(steps.find)[0] || null
  const patch = request.body.patch || {}
  const base = row || {
    runId: request.body.runId, key: request.body.key,
    job: null, index: 0, step: null, kind: null,
    status: 'queued', attempt: 1, inputs: null, response: null, outputs: null,
    error: null, summary: null, annotations: null,
    startedAt: null, finishedAt: null, heartbeatAt: null,
  }
  const fields = { ...base }
  delete fields.id
  for (const k of Object.keys(patch)) fields[k] = patch[k]
  fields.runId = request.body.runId
  fields.key = request.body.key
  return { create: !row, update: !!row, recordId: row ? row.id : null, fields }
}
