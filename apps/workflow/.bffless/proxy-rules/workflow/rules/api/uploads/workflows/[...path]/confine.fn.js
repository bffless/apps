// confine.fn.js — locates the run named by a served object's path (spec 11 D29), the same
// grammar `files/sign`'s confine.fn.js applies to `request.body.path`, here read off
// `request.path` instead: CE's file_serve_handler answers GET /api/uploads/workflows/… directly,
// so there is no body to read. Same output shape as sign's.
//
// Unlike sign/prepare/register this rule has no 400: a path that fails to parse is simply
// `ok:false`/`hasRun:false`/`runless:false`, and the rule runs `runGate` unconditionally (there
// is no earlier 400 responder a later-run `refuse-404` could clobber) — the gate reads no run
// and no `runless`, so it answers `notFound`, and the route's only failure mode is 404.
//
// The `runs` segment matches CASE-INSENSITIVELY (fix round 1) — see `files/sign`'s
// `confine.fn.js` banner for why: CE's file_serve_handler (the very handler THIS rule's `serve`
// step is) derives the storage key from the same raw path with no case folding, so the gate must
// be at least as strict as a case-insensitive filesystem's key equality. `RUN_ID_PATTERN`
// carries the same `i` for the same reason (fix round 2), and `/./` is refused alongside `..`
// and `//` — see `files/sign`'s `confine.fn.js` banner for both.
var RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/i

function handler({ request, deployment }) {
  var reqPath = (request && typeof request.path === 'string') ? request.path : ''
  var path = reqPath.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0]
  var ok = path.indexOf('workflows/') === 0 && path.indexOf('..') === -1 && path.indexOf('//') === -1 && path.indexOf('/./') === -1

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
