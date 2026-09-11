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
// member-wide (D18). The `runs` segment matches CASE-INSENSITIVELY (fix round 1) — see
// `files/sign`'s `confine.fn.js` banner for why. `RUN_ID_PATTERN` carries the same `i`, and
// `/./` is refused alongside `..` and `//` (fix round 2) — same banner, same reasons.
//
// `impl`/`workflow` are ALSO validated here (fix round 2), not just the key: `register_upload`'s
// `subDir` templates `workflows/{{impl}}/{{workflow}}/{{scope}}` from the raw body, exactly as
// `files/prepare`'s `presigned_upload` does — so this mirrors that rule's `isSegment`.
//
// NOTE the two unrelated `scope`s: the body field `scope` is the STORAGE scope (`inputs/…` or
// `runs/<runId>/<step>`, what `subDir` ends with). It has nothing to do with the run gate's
// all-scope ask (`body.scope === 'all'`, `runGate.fn.js`'s `scopeAsked`) — a caller may send
// either, and narrowing one to fit the other breaks the other.
var RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/i

/** A single path segment: non-empty, no `/`, no `\`, no `..` (mirrors `files/prepare`'s `confine.fn.js`). */
function isSegment(v) {
  return typeof v === 'string' && v !== '' && v.indexOf('/') === -1 && v.indexOf('\\') === -1 && v.indexOf('..') === -1
}

function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var owner = (deployment && deployment.owner) || ''
  var repo = (deployment && deployment.repo) || ''
  var prefix = owner + '/' + repo + '/uploads/'
  var identifiersOk = isSegment(body.impl) && isSegment(body.workflow)

  var raw = typeof body.storageKey === 'string' ? body.storageKey : ''
  raw = raw.replace(/^\/+/, '').replace(/^api\/uploads\//, '')

  // Already a full key (round-tripped from `prepare`)? Take what's after the prefix.
  // Otherwise treat the value as already uploads-relative.
  var rel = raw.indexOf(prefix) === 0 ? raw.slice(prefix.length) : raw

  var ok =
    identifiersOk &&
    !!rel &&
    rel.indexOf('workflows/') === 0 &&
    rel.indexOf('..') === -1 &&
    rel.indexOf('//') === -1 &&
    rel.indexOf('/./') === -1

  var runMatch = ok ? /^workflows\/[^/]+\/[^/]+\/runs\/([^/]+)/i.exec(rel) : null
  var runId = runMatch && RUN_ID_PATTERN.test(runMatch[1]) ? runMatch[1] : ''
  var hasRun = runId !== ''

  return {
    ok: ok,
    notOk: !ok,
    storageKey: ok ? prefix + rel : '',
    error: ok
      ? ''
      : identifiersOk
        ? 'storageKey must be an uploads-relative path under workflows/ with no traversal'
        : 'impl and workflow must each be a single path segment',
    hasRun: hasRun,
    runId: runId,
    runless: ok && !hasRun,
  }
}
