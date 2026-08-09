// Sync-side validation for GET /api/search?q=<query> (Task 9, converted from
// POST in PR-feedback-7 for HTTP cacheability — GETs can carry a
// Cache-Control response header shared/browser caches actually respect;
// POST responses are effectively uncacheable). Rejects before any Replicate
// call is made: an empty/oversized/non-string `q` never spends a query
// embedding. Mirrors gate.fn.js's ok/notOk sentinel convention so the rule's
// respond400 step can key off `steps.prep.notOk` (CE condition expressions
// only support a single field path or its negation).
function handler({ request }) {
  var query = (request && request.query) || {}
  var q = query.q

  if (typeof q !== 'string' || !q.trim()) {
    return { ok: false, notOk: true, reason: 'INVALID_QUERY', q: '', textsJson: '' }
  }

  var trimmed = q.trim()
  if (trimmed.length > 500) {
    return { ok: false, notOk: true, reason: 'QUERY_TOO_LONG', q: '', textsJson: '' }
  }

  // Replicate's texts input wants a JSON-encoded array of strings, same as
  // texts.fn.js in the index rule -- here it's always a single-element array
  // (one query), but the shape has to match what the bge model expects.
  return { ok: true, notOk: false, reason: '', q: trimmed, textsJson: JSON.stringify([trimmed]) }
}
