// normalize.fn.js — spec 02 promises a pipeline may return a bare uploads-relative path
// where a `file` output is declared, but CE's register_upload only accepts a FULL storage
// key: parseUploadKey (upload-record.service.ts) requires the value to start with
// "<owner>/<repo>/uploads/" and rejects `..`/`//`. `prepare` always returns a full key
// (it mints one), so that case just round-trips; a bare pipeline-output path needs the
// project prefix added here before register_upload ever sees it.
//
// Also (spec 11 D29) locates the run the normalised path names, the same grammar
// `files/sign`'s and the serve rule's `confine.fn.js` apply: a `workflows/<impl>/<workflow>/
// runs/<runId>/…` key names a run; `inputs/` and any other confined key carry none and stay
// member-wide (D18).
var RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/

function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var owner = (deployment && deployment.owner) || ''
  var repo = (deployment && deployment.repo) || ''
  var prefix = owner + '/' + repo + '/uploads/'

  var raw = typeof body.storageKey === 'string' ? body.storageKey : ''
  raw = raw.replace(/^\/+/, '').replace(/^api\/uploads\//, '')

  // Already a full key (round-tripped from `prepare`)? Take what's after the prefix.
  // Otherwise treat the value as already uploads-relative.
  var rel = raw.indexOf(prefix) === 0 ? raw.slice(prefix.length) : raw

  var ok = !!rel && rel.indexOf('workflows/') === 0 && rel.indexOf('..') === -1 && rel.indexOf('//') === -1

  var runMatch = ok ? /^workflows\/[^/]+\/[^/]+\/runs\/([^/]+)/.exec(rel) : null
  var runId = runMatch && RUN_ID_PATTERN.test(runMatch[1]) ? runMatch[1] : ''
  var hasRun = runId !== ''

  return {
    ok: ok,
    notOk: !ok,
    storageKey: ok ? prefix + rel : '',
    error: ok ? '' : 'storageKey must be an uploads-relative path under workflows/ with no traversal',
    hasRun: hasRun,
    runId: runId,
    runless: ok && !hasRun,
  }
}
