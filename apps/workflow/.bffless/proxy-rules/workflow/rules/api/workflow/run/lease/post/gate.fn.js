function handler({ steps, request }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.find)[0] || null
  const now = Date.now()
  const owner = String(request.body.owner || '')
  const takeover = request.body.takeover === true
  if (!row) return { ok: false, recordId: null, owner, leaseUntil: 0, result: { ok: false, error: 'run not found' } }
  const held = row.leaseOwner && typeof row.leaseUntil === 'number' && row.leaseUntil > now
  const ok = takeover || !held || row.leaseOwner === owner
  const leaseUntil = now + 60000
  return {
    ok, recordId: row.id, owner, leaseUntil,
    result: ok ? { ok: true, leaseUntil } : { ok: false, heldBy: row.leaseOwner, leaseUntil: row.leaseUntil },
  }
}
