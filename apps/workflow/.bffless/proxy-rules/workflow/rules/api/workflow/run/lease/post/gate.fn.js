function handler({ steps, request }) {
  const rows = (r) => (r && (r.records || r.data || r.rows)) || []
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
