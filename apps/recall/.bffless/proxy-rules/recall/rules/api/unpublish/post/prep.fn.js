// Validates videoId is present and hands embed_store a REAL empty array.
// The expression evaluator (apps/backend/src/pipelines/execution/
// expression-evaluator.ts) has no array-literal syntax -- a bare `[]` in YAML
// config would fail its `validRoots` check and come back as the literal
// two-character STRING "[]", which embed_store's `Array.isArray(chunks)`
// guard would then reject. Returning a real array from a function step's
// output sidesteps that: `steps.prep.chunks` resolves via plain property
// lookup, no re-parsing involved.
function handler({ request }) {
  var body = (request && request.body) || {}
  var videoId = body.videoId
  return { videoId: typeof videoId === 'string' ? videoId : '', chunks: [] }
}
