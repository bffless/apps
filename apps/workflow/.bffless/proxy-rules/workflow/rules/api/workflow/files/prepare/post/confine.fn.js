// confine.fn.js — validates the upload scope and (spec 11 D29) locates the run it names, the
// way `files/sign`'s and the serve rule's `confine.fn.js` do for a full storage path. `scope`
// has no `workflows/<impl>/<workflow>/` head to strip — the rule already templates that ahead
// of it (`prepare`'s `subDir`) — so the grammar here is just `inputs`/`inputs/…` (D18's
// per-workflow reused area, carries no runId, stays member-wide) or `runs/<runId>/<step>`
// (must name a step after the run id, not just the bare run). Anything else — traversal, a
// double slash, an unrecognised head, a malformed run id — is `notOk`, the rule's 400.
var RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/

function handler({ request }) {
  var body = (request && request.body) || {}
  var scope = typeof body.scope === 'string' ? body.scope.replace(/^\/+|\/+$/g, '') : ''
  var clean = scope !== '' && scope.indexOf('..') === -1 && scope.indexOf('//') === -1

  var runMatch = clean ? /^runs\/([^/]+)\/.+/.exec(scope) : null
  var runId = runMatch && RUN_ID_PATTERN.test(runMatch[1]) ? runMatch[1] : ''
  var hasRun = runId !== ''

  var isInputs = clean && (scope === 'inputs' || scope.indexOf('inputs/') === 0)
  var ok = hasRun || isInputs

  return {
    ok: ok,
    notOk: !ok,
    hasRun: hasRun,
    runId: runId,
    runless: ok && !hasRun,
  }
}
