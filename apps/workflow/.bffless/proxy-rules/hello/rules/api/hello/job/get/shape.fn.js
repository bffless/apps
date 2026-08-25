function handler({ steps }) {
  const row = steps.query
  if (!row) return { found: false, missing: true }
  return {
    found: true,
    id: row.id,
    status: row.status,
    result: row.result || null,
    error: row.error || null,
  }
}
