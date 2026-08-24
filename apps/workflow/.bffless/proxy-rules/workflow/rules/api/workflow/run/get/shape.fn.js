// Merge the two queries into { run, steps }. Tolerate both result envelopes
// (records vs data) the data_query handler has used across CE versions.
function handler({ steps }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const runRows = rows(steps.run)
  const stepRows = rows(steps.steps)
  return { run: runRows[0] || null, steps: stepRows }
}
