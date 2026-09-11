// Join each listed run's *waiting* steps onto its run record (apps#473).
//
// Past runs reads run rows only — no per-run step fetch — but the one
// step-level fact it shows ("waiting on <step>") lives on the step rows. So
// the rule runs a query for every `status = waiting` step row and this
// attaches, to each run in the page, the keys of the ones that are its own:
// `waitingOn: ["<job>/<index>/<step>", …]`, always present, `[]` when the run
// waits on nothing. Step rows carry no impl/workflow to narrow that query on,
// and it is capped by its limit; the client resolves each key's display name
// from the run row's own `definition` snapshot.
//
// The run page itself comes from whichever of the rule's two conditional
// `data_query` steps ran (spec 11 §Listing): `mine` (the caller's own runs)
// or `all` (asked for, and only ever populated once `scope.fn.js` allowed
// it) — exactly one of the two is ever anything but `undefined`.
function handler({ steps }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  // A record's columns: flattened onto the record, or under `fields` (the client's
  // `fieldsOf` reads both the same way).
  const nested = (r) => r && r.fields && typeof r.fields === 'object' && Object.keys(r.fields).length > 0
  const fieldsOf = (r) => (nested(r) ? r.fields : r) || {}
  // `driveKey` (spec 11 D28) is the dispatched driver's nonce: legitimate on
  // the stored row, never on a response body — it travels only in
  // `client_payload.drive_key` and the `x-workflow-drive-key` request header.
  // Strip it from whichever shape this CE answered before it rides the page.
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

  const waiting = {}
  for (const row of rows(steps.waiting)) {
    const f = fieldsOf(row)
    if (typeof f.runId !== 'string' || typeof f.key !== 'string') continue
    if (!waiting[f.runId]) waiting[f.runId] = []
    waiting[f.runId].push(f.key)
  }

  return rows(steps.mine !== undefined ? steps.mine : steps.all).map((row) => {
    const keys = (waiting[fieldsOf(row).runId] || []).slice().sort()
    // Put the column where the record keeps its other columns, so the client
    // reads it with the rest of the row.
    const shaped = nested(row)
      ? Object.assign({}, row, { fields: Object.assign({}, row.fields, { waitingOn: keys }) })
      : Object.assign({}, row, { waitingOn: keys })
    return withoutDriveKey(shaped)
  })
}
