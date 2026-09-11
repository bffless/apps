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
// The path is matched RAW — percent-encoded exactly as Express hands it — and that is correct,
// because the handler this rule serves through derives its storage key from the same raw string.
// CE's `file_serve_handler` (repos/ce/apps/backend/src/pipelines/handlers/file-serve.handler.ts):
// `requestPath = context.metadata.path` (:93), which `pipeline-execution.service.ts:136` sets to
// Express's `req.path` (never decoded); path-derived mode slices the `/api/uploads/<subDir>/`
// prefix off it (:127-131), strips `..` and collapses `//` (:151), and builds
// `storageKey = <owner>/<repo>/uploads/<subDir>/<filePath>` (:155). No `decodeURIComponent`
// anywhere on that route. So `%2F` is a literal two-character sequence in the key, not a
// separator: `runs/run_X%2Fother/o.png` names a DIFFERENT object than `runs/run_X/other/o.png`,
// and this grammar reads it the same way the handler does — one segment, `run_X%2Fother`, which
// `RUN_ID_PATTERN` refuses (no `%`), so the request is runless and stays member-wide. It reaches
// no run-owned object, because no run-owned object has a `%` in its run segment. `%2e%2e` is the
// same story: a literal key the storage adapter never resolves, not a `..` this check missed.
// Pinned by `uploadsConfine.fn.parity.test.ts`'s percent-encoding rows.
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
