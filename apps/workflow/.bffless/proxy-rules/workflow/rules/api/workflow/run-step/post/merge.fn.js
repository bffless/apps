function handler({ steps, request }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.find)[0] || null
  const patch = request.body.patch || {}
  const base = row || {
    runId: request.body.runId, key: request.body.key,
    job: null, index: 0, step: null, kind: null,
    status: 'queued', attempt: 1, inputs: null, response: null, outputs: null,
    error: null, summary: null, annotations: null, log: null,
    startedAt: null, finishedAt: null, heartbeatAt: null,
  }
  const fields = { ...base }
  delete fields.id
  for (const k of Object.keys(patch)) fields[k] = patch[k]
  fields.runId = request.body.runId
  fields.key = request.body.key
  return { create: !row, update: !!row, recordId: row ? row.id : null, fields }
}
