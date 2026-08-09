// Extracts the query embedding out of Replicate's bge response (Task 9).
// steps.embed is the raw Replicate prediction object -- its own `.output`
// field is an order-preserving array of vectors, one per input text
// (zip.fn.js in the index rule reads the same shape for a batch; here
// texts.fn.js/prep.fn.js always sends exactly one text, so the query vector
// is steps.embed.output[0]). Validates the SAME way zip.fn.js does (defensive
// against the replicate step having failed outright -- postSteps semantics
// don't apply here since this is a sync step, but a condition-gated step that
// never ran writes no output either, so steps.embed can still be missing).
function handler({ steps }) {
  var embedStep = (steps && steps.embed) || {}
  var vectors = embedStep.output || []

  if (!Array.isArray(vectors) || vectors.length === 0) {
    return { ok: false, notOk: true, vector: [] }
  }

  var vector = vectors[0]
  if (!Array.isArray(vector) || typeof vector[0] !== 'number') {
    return { ok: false, notOk: true, vector: [] }
  }

  return { ok: true, notOk: false, vector: vector }
}
