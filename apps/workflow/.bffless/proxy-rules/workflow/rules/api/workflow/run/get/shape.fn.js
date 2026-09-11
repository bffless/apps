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
  // A record's columns: flattened onto the record, or under `fields` (the
  // client's `fieldsOf` reads both the same way).
  const nested = (r) => r && r.fields && typeof r.fields === 'object' && Object.keys(r.fields).length > 0
  // `driveKey` (spec 11 D28) is the dispatched driver's nonce: legitimate on
  // the stored row, never on a response body — it travels only in
  // `client_payload.drive_key` and the `x-workflow-drive-key` request header.
  // Strip it from whichever shape this CE answered before `respond` renders
  // the run.
  const withoutDriveKey = (row) => {
    if (!row) return row
    if (nested(row)) {
      if (!('driveKey' in row.fields)) return row
      const fields = Object.assign({}, row.fields)
      delete fields.driveKey
      return Object.assign({}, row, { fields })
    }
    if (!('driveKey' in row)) return row
    const copy = Object.assign({}, row)
    delete copy.driveKey
    return copy
  }
  const runRows = rows(steps.run)
  const stepRows = rows(steps.steps)
  const ok = !!(steps.runGate && steps.runGate.ok)
  return { run: ok ? withoutDriveKey(runRows[0] || null) : null, steps: ok ? stepRows : [] }
}
