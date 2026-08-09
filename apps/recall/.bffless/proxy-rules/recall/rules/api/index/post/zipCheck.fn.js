// Final pass/fail verdict for the postSteps chain (Task 8). Runs
// unconditionally (no `condition`) so it always produces a signal, but
// deliberately returns {ok:false, notOk:false} -- not notOk:true -- when the
// sync gate rejected the request: that's a "never ran" state, not a failure,
// and the embedStore/videoPublished/jobDone (condition ok) AND the
// jobErr/videoErrBack (condition notOk) steps must both stay skipped, since
// no job was ever created and the video shouldn't be touched.
//
// When the gate DID pass, ok requires a genuinely paired, non-empty zip
// result; on failure `error` prefers zip's own error (e.g.
// EMBED_COUNT_MISMATCH) and falls back to chunk's (e.g.
// TRANSCRIPT_PARSE_ERROR), since either can be the reason zip came up empty.
function handler({ steps }) {
  var gate = (steps && steps.gate) || {}
  if (!gate.ok) {
    return { ok: false, notOk: false, error: '' }
  }
  var z = (steps && steps.zip) || null
  var ok = !!(z && !z.error && Array.isArray(z.chunks) && z.chunks.length > 0)
  if (ok) {
    return { ok: true, notOk: false, error: '' }
  }
  var chunk = (steps && steps.chunk) || {}
  var error = (z && z.error) || chunk.error || 'INDEX_FAILED'
  return { ok: false, notOk: true, error: error }
}
