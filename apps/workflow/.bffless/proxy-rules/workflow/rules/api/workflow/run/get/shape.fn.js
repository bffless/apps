// Merge the two queries into { run, steps }. Tolerate both result envelopes
// (records vs data) the data_query handler has used across CE versions.
const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const runRows = rows(steps.run)
const stepRows = rows(steps.steps)
return { run: runRows[0] || null, steps: stepRows }
