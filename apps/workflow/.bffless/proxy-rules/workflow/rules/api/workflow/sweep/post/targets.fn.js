/**
 * What this pass of the nightly sweep deletes (spec 05 §Retention, apps#615).
 *
 * Reads the expired terminal runs `due` selected (`expiresAt lt now AND status
 * in terminal`, capped by that query's `limit`), the workflow `plan` chose for
 * this pass, and the `workflow_files` rows the `records` scan returned for
 * that workflow, and answers the lists the four delete steps consume — in
 * `run/delete`'s order, bytes first. Due runs of any OTHER workflow are left
 * for a later pass and counted as `waiting`.
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
 *   rowRunIds — the runs whose step rows and run row go this pass.
 *
 * Deferral is WHOLE-RUN. When the scan is TRUNCATED (it came back `scanLimit`
 * rows long) or BLIND (it returned rows but not one carries a string
 * `sub_dir` — the shape a schema projection would leave), this pass cannot
 * know which records belong to the due runs, so it deletes NOTHING: every
 * list is empty, every due run is reported as `deferred`, and the next pass
 * selects the same runs again. Never bytes without rows — that is the state a
 * `run/delete` only reaches by FAILING after `files`, and a sweep must not
 * reach it by design. A `deferred` that never drops to 0 means the live table
 * has outgrown the scan: raise the `records` limit and SCAN_LIMIT together.
 *
 * What CE guarantees, cited because a mock twin cannot prove it: `data_query`
 * passes `limit` through verbatim — `data-query.handler.ts` builds its own
 * query and calls `.limit(this.resolveNumericExpression(config.limit, 100, …))`,
 * which returns a numeric config value as-is; there is no maximum anywhere in
 * the handler — so a scan shorter than SCAN_LIMIT really is the whole table
 * for that pattern, which is what makes `scanTruncated` a detector and not a
 * guess; `data_query` also spreads every stored column into each record
 * (`data-query.handler.ts` "Return all fields": `{ id, alias, version,
 * ...data, createdAt, updatedAt }` — no projection through the declared
 * schema, so `sub_dir` comes back whether or not the live schema has adopted
 * it); `data_delete` accepts `in`
 * through the shared `filter-where.util.ts` since bffless/ce#675 (2026-08-16,
 * first in v0.3.3, far below this app's `ceMin`), and an empty list compiles
 * to a match-nothing predicate (`in-filter.util.spec.ts` "compiles an empty
 * array to a match-nothing predicate"), never to no predicate; `file_delete`
 * in `prefixes` mode answers `{ deleted, prefixes, dryRun }` and treats an
 * empty list as `deleted: 0` (`file-delete.handler.ts` deleteManyPrefixes,
 * ce#792 / v0.4.58 — the `ceMin`).
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
  const plan = steps.plan || {}
  const now = typeof cutoff.now === 'number' ? cutoff.now : Date.now()
  const terminal = Array.isArray(cutoff.terminal) ? cutoff.terminal : ['succeeded', 'failed', 'cancelled']
  const chosen = plan.any === true && typeof plan.impl === 'string' && typeof plan.workflow === 'string'

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
  let waiting = 0
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
    if (!chosen || r.impl !== plan.impl || r.workflow !== plan.workflow) {
      waiting += 1
      continue
    }
    runIds.push(r.runId)
    prefixes.push('workflows/' + r.impl + '/' + r.workflow + '/runs/' + r.runId + '/')
  }

  const scan = rows(steps.records)
  const scanTruncated = scan.length >= SCAN_LIMIT
  const subDirs = []
  const seenDir = {}
  let dirsSeen = 0
  for (const rec of scan) {
    const dir = rec && rec.sub_dir
    if (typeof dir !== 'string') continue
    dirsSeen += 1
    if (seenDir[dir]) continue
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

  // Blind: rows came back but none shows a `sub_dir` — fail closed.
  const scanBlind = scan.length > 0 && dirsSeen === 0
  const defer = scanTruncated || scanBlind
  const swept = defer ? [] : runIds
  return {
    scanLimit: SCAN_LIMIT,
    scanTruncated,
    scanBlind,
    runIds,
    prefixes: defer ? [] : prefixes,
    subDirs: defer ? [] : subDirs,
    rowRunIds: swept,
    count: runIds.length,
    swept: swept.length,
    deferred: defer ? runIds.length : 0,
    skipped,
    waiting,
  }
}
