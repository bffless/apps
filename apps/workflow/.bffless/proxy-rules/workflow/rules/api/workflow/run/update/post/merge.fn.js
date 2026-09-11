function handler({ steps, request }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.run)[0] || null
  const patch = request.body.patch || {}
  // Only these columns are patchable post-create; everything else is immutable (D16 snapshot).
  const KEYS = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations', 'annotationCounts', 'driveKey']
  const fields = {}
  for (const k of KEYS) {
    fields[k] = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : (row ? row[k] : null)
  }
  // driveKey (D28) is the drive door's nonce — only the harness itself writes
  // it, at dispatch. A caller must never be able to set or clear it through
  // this patch, so whatever the loop above computed is overwritten here with
  // the row's OWN value, ignoring the body entirely.
  fields.driveKey = row && typeof row.driveKey === 'string' ? row.driveKey : ''
  // And a run with nothing left to drive has nothing worth a nonce for:
  // clear it at any terminal status so a stale key cannot reopen the `drive`
  // door after the fact (runGate.ts's own TERMINAL_STATUSES check, mirrored).
  const TERMINAL = { succeeded: true, failed: true, cancelled: true }
  if (TERMINAL[fields.status]) fields.driveKey = ''
  else if (typeof fields.driveKey !== 'string') fields.driveKey = ''
  return { found: !!row, missing: !row, recordId: row ? row.id : null, fields }
}
