function handler({ steps }) {
  return {
    id: steps.query.id,
    status: steps.query.status,
    result: steps.query.result || null,
    error: steps.query.error || null,
  }
}
