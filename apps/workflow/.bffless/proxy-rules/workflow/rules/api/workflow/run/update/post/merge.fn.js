const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const row = rows(steps.find)[0] || null
const patch = request.body.patch || {}
// Only these columns are patchable post-create; everything else is immutable (D16 snapshot).
const KEYS = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations']
const fields = {}
for (const k of KEYS) {
  fields[k] = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : (row ? row[k] : null)
}
return { found: !!row, missing: !row, recordId: row ? row.id : null, fields }
