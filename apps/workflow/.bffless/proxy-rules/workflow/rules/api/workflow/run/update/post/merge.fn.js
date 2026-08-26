function handler({ steps, request }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.find)[0] || null
  const patch = request.body.patch || {}
  // Only these columns are patchable post-create; everything else is immutable (D16 snapshot).
  const KEYS = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations', 'annotationCounts']
  const fields = {}
  for (const k of KEYS) {
    fields[k] = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : (row ? row[k] : null)
  }
  return { found: !!row, missing: !row, recordId: row ? row.id : null, fields }
}
