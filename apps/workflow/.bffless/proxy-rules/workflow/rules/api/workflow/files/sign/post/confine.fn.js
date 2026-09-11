// confine.fn.js — mirrors Studio's uploads/sign/resolvePath.fn.js, narrowed to the harness
// prefix, and (spec 11 D29) locates the run a confined path names along the way, so the
// downstream `runGate` step can decide whether THIS caller may reach it. A
// `workflows/<impl>/<workflow>/runs/<runId>/…` path names a run; `inputs/` and every other
// confined path carry none and stay member-wide (D18) — `runless` is `ok` minus `hasRun`,
// not a separate check, so nothing under `workflows/` is ever both.
//
// The `runs` segment matches CASE-INSENSITIVELY (fix round 1): CE's file_serve_handler builds
// the storage key from the same raw path with no case folding, so on a local-filesystem install
// with a case-insensitive volume, `RUNS/run_X/…` and `runs/run_X/…` name the SAME stored object
// — the gate must be at least as strict as that key equality, or an uppercase-cased path reads
// `runless` and is admitted as member-wide when it is really another member's run.
var RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/

function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0] : ''
  var ok = path.indexOf('workflows/') === 0 && path.indexOf('..') === -1 && path.indexOf('//') === -1

  var runMatch = ok ? /^workflows\/[^/]+\/[^/]+\/runs\/([^/]+)/i.exec(path) : null
  var runId = runMatch && RUN_ID_PATTERN.test(runMatch[1]) ? runMatch[1] : ''
  var hasRun = runId !== ''

  return {
    ok: ok,
    notOk: !ok,
    storagePath: ok ? deployment.owner + '/' + deployment.repo + '/uploads/' + path : '',
    hasRun: hasRun,
    runId: runId,
    runless: ok && !hasRun,
  }
}
