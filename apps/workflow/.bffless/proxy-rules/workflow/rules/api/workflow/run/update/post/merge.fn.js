function handler({ steps, request }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.run)[0] || null
  const patch = request.body.patch || {}
  // Only these columns are patchable post-create; everything else is immutable (D16 snapshot).
  // `driveKey` is deliberately NOT among them — it is written below, off the row.
  const KEYS = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations', 'annotationCounts']
  const fields = {}
  for (const k of KEYS) {
    fields[k] = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : (row ? row[k] : null)
  }
  // driveKey (D28) is the drive door's nonce — only the harness itself writes
  // it, at dispatch. A caller must never be able to set or clear it through
  // this patch, so it never rides the body path above: the value written is
  // always the row's OWN. It is carried through
  // unchanged at EVERY status, terminal included (apps#665 review): the
  // request that seals a run is the driver's own, and its next reads — the
  // sealed record, then each file output (spec 07 §Results) — present nothing
  // but this nonce. Clearing it here would refuse the driver its own results
  // the instant it finished producing them. A later dispatch re-mints the key
  // (`run/drive`'s claim, or its `resume` rekey), so a stale one is replaced
  // rather than left standing.
  fields.driveKey = row && typeof row.driveKey === 'string' ? row.driveKey : ''
  return { found: !!row, missing: !row, recordId: row ? row.id : null, fields }
}
