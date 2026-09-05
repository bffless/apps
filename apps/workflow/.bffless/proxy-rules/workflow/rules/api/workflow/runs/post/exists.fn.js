function handler({ steps }) {
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const exists = rows(steps.find).length > 0
  return { exists, fresh: !exists }
}
