// Merge the two queries into { run, steps } — but only if the shared run gate
// (spec 11 D26) admitted the caller. Decision 4: this rule renders no 404, so
// the ONLY way an invisible run stays invisible is right here — an unknown id
// and a run this caller cannot reach both fall through to the same
// { run: null, steps: [] } a caller who does not ask for it would otherwise
// never be able to tell apart.
function handler({ steps }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const runRows = rows(steps.run)
  const stepRows = rows(steps.steps)
  const ok = !!(steps.runGate && steps.runGate.ok)
  return { run: ok ? runRows[0] || null : null, steps: ok ? stepRows : [] }
}
