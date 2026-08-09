// Validates videoId is present and hands embed_store a REAL empty array.
// The expression evaluator (apps/backend/src/pipelines/execution/
// expression-evaluator.ts) has no array-literal syntax -- a bare `[]` in YAML
// config would fail its `validRoots` check and come back as the literal
// two-character STRING "[]", which embed_store's `Array.isArray(chunks)`
// guard would then reject. Returning a real array from a function step's
// output sidesteps that: `steps.prep.chunks` resolves via plain property
// lookup, no re-parsing involved.
//
// PR-feedback-4: NOW THROWS on a missing/blank videoId, unlike its original
// permissive version. That used to be safe because every downstream step was
// RECORD-ID-KEYED (embedStore/data_update against an empty id just match
// nothing -- a harmless no-op). This rule now also runs a PREFIX-based
// file_delete against 'sheets/<id>/' -- an empty id would resolve to
// 'sheets//', which collapses to the top-level 'sheets/' prefix and would
// wipe EVERY video's contact sheet. Failing closed here mirrors
// api/videos/delete/post/prep.fn.js's existing convention.
function handler({ request }) {
  var body = (request && request.body) || {}
  var id = String(body.videoId || '').trim()
  if (!id) throw new Error('videoId required')
  return {
    videoId: id,
    chunks: [],
    sheetsPrefix: 'sheets/' + id + '/',
    sheetsSubDir: 'sheets/' + id,
  }
}
