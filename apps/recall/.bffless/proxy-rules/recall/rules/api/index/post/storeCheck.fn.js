// Guards against the "false publish" bug: postSteps never abort on a failed
// step, and a failed step writes NO output -- so without this check, a
// failed embed_store (which deletes the video's prior embeddings BEFORE
// attempting to store the new ones) would fall straight through to
// videoPublished/jobDone with zero embeddings actually stored.
//
// Runs unconditionally (no `condition`), same "never ran" sentinel pattern as
// zipCheck: if zipCheck never passed, embedStore never ran (it's conditioned
// on steps.zipCheck.ok) and steps.embedStore is null here -- that's not a
// NEW failure, it's the SAME failure zipCheck's own error branch
// (jobErr/videoErrBack) already owns, so this returns {ok:false, notOk:false}
// rather than {ok:false, notOk:true} to avoid double-reporting it.
function handler({ steps }) {
  var zipCheck = (steps && steps.zipCheck) || {}
  if (!zipCheck.ok) {
    return { ok: false, notOk: false, error: '' }
  }
  var es = (steps && steps.embedStore) || null
  var ok = !!(es && typeof es.stored === 'number' && es.stored > 0)
  if (ok) {
    return { ok: true, notOk: false, error: '' }
  }
  return { ok: false, notOk: true, error: 'EMBED_STORE_FAILED' }
}
