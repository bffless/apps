/**
 * What this pass of the nightly sweep deletes (spec 05 §Retention, apps#615).
 *
 * Reads the expired terminal runs `due` selected (`expiresAt lt now AND status
 * in terminal`, capped by that query's `limit`) and the `workflow_files` rows
 * the `records` scan returned, and answers the lists the four delete steps
 * consume — in `run/delete`'s order, bytes first:
 *
 *   prefixes  — one `workflows/<impl>/<workflow>/runs/<runId>/` per run, for
 *               `file_delete` in `prefixes` mode (CE >= 0.4.58, ce#792): every
 *               object under each, in ONE step — exactly what `run/delete`
 *               does per run with `prefix`. Kickoff `inputs/` live one level
 *               up (D18), outside every prefix built here.
 *   subDirs   — the exact `sub_dir` values the scan found under those
 *               prefixes, for `data_delete workflow_files` with `in`. A `like`
 *               can anchor on ONE prefix; N runs need the exact directories —
 *               and `sub_dir` carries the runId, so an exact match can never
 *               reach another run's rows (the `run_1` / `run_10` case below).
 *   rowRunIds — the runs whose step rows and run row go this pass: all of
 *               them, unless the scan was TRUNCATED (it came back `scanLimit`
 *               rows long), in which case none. Their bytes and the records
 *               found still go; the rows stay, so the next pass selects the
 *               same runs again and finds the records this one could not see.
 *               A deferred run is the state a `run/delete` that failed after
 *               `files` leaves — retryable, never orphaned — and `deferred` in
 *               the 200 makes it visible. A `deferred` that never drops to 0
 *               means the live table has outgrown the scan: raise its `limit`.
 *
 * Every entry of `prefixes` is a `file_delete` TEMPLATE, resolved and guarded
 * before any storage call, and ONE bad entry aborts the WHOLE step
 * (file-delete.handler.ts): a `..`, a `/` or a `{{` in an impl, workflow or
 * runId would fail every other run's delete along with its own. Such a row is
 * left alone entirely — no prefix, no records, no rows — and counted in
 * `skipped`: an operator's row to look at, not the sweep's to guess about.
 *
 * Re-checks `status` and `expiresAt` against `cutoff` although `due` already
 * filtered on both: cheap, and it is what lets the mock's twin and this
 * function be held to the same decision on the same rows
 * (`src/mocks/sweep.fn.parity.test.ts`).
 *
 * Userless (schedule-fired): reads nothing about a caller. Never throws — a
 * throw is CE's generic FUNCTION_ERROR, not a report anyone reads.
 */
function handler(data) {
  // Must equal the `records` step's `limit` in rule.yaml (the parity test holds them equal).
  const SCAN_LIMIT = 5000

  const ctx = data || {}
  const steps = ctx.steps || {}
  const cutoff = steps.cutoff || {}
  const now = typeof cutoff.now === 'number' ? cutoff.now : Date.now()
  const terminal = Array.isArray(cutoff.terminal) ? cutoff.terminal : ['succeeded', 'failed', 'cancelled']

  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts; the envelope forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  // A path segment `file_delete` accepts without aborting the step, and one that
  // cannot reach outside its own run: non-empty, a single segment, no traversal,
  // no template opener, no whitespace.
  const segment = (s) => typeof s === 'string' && /^[^\s/{}]+$/.test(s) && s.indexOf('..') === -1

  const runIds = []
  const prefixes = []
  const seen = {}
  let skipped = 0
  for (const row of rows(steps.due)) {
    const r = row || {}
    if (terminal.indexOf(r.status) === -1) continue
    if (typeof r.expiresAt !== 'number' || !(r.expiresAt < now)) continue
    if (!segment(r.impl) || !segment(r.workflow) || !segment(r.runId)) {
      skipped += 1
      continue
    }
    if (seen[r.runId]) continue
    seen[r.runId] = true
    runIds.push(r.runId)
    prefixes.push('workflows/' + r.impl + '/' + r.workflow + '/runs/' + r.runId + '/')
  }

  const scan = rows(steps.records)
  const scanTruncated = scan.length >= SCAN_LIMIT
  const subDirs = []
  const seenDir = {}
  for (const rec of scan) {
    const dir = rec && rec.sub_dir
    if (typeof dir !== 'string' || seenDir[dir]) continue
    // `dir + '/'`, so a record AT the run root (no segment past the prefix)
    // matches too, and `…/runs/run_1/` can never match `…/runs/run_10/x`.
    for (const prefix of prefixes) {
      if ((dir + '/').indexOf(prefix) === 0) {
        seenDir[dir] = true
        subDirs.push(dir)
        break
      }
    }
  }

  const rowRunIds = scanTruncated ? [] : runIds
  return {
    scanLimit: SCAN_LIMIT,
    scanTruncated,
    runIds,
    prefixes,
    subDirs,
    rowRunIds,
    count: runIds.length,
    swept: rowRunIds.length,
    deferred: scanTruncated ? runIds.length : 0,
    skipped,
  }
}
