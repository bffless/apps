/**
 * Which workflow this pass sweeps (spec 05 §Retention, apps#615) — and so
 * what the `workflow_files` scan is anchored on.
 *
 * A pass sweeps ONE workflow: the one the oldest due run belongs to (`due` is
 * ordered by `expiresAt` ascending). The scan then reads only that workflow's
 * run-scoped records, `workflows/<impl>/<workflow>/runs/%` — bounded by what
 * that workflow keeps live, which its own `keep:` bounds — instead of every
 * run-scoped record on the instance, which nothing bounds (runs of a workflow
 * without `keep:` are never swept, so an instance-wide scan only ever grows).
 * Due runs of other workflows wait for a later pass; `targets.fn.js` reports
 * them as `waiting`. A workflow with more due runs than one pass takes drains
 * at 50 a night and the others follow, oldest expiry first.
 *
 * Nothing due: `scanLike` is `-`, a pattern no real `sub_dir` can equal (every
 * record's `sub_dir` is a directory path — or empty), so the scan is a cheap
 * empty read rather than 5000 rows for nothing.
 *
 * The same segment test `targets.fn.js` applies, so a malformed row (one the
 * sweep would `skip`) never gets to pick the workflow either. `%` or `_` in an
 * implementation or workflow name can only WIDEN this scan, never the deletes:
 * `targets` matches exact prefixes over whatever the scan returns.
 *
 * Userless (schedule-fired): reads nothing about a caller. Never throws.
 */
function handler(data) {
  const ctx = data || {}
  const steps = ctx.steps || {}
  const cutoff = steps.cutoff || {}
  const now = typeof cutoff.now === 'number' ? cutoff.now : Date.now()
  const terminal = Array.isArray(cutoff.terminal) ? cutoff.terminal : ['succeeded', 'failed', 'cancelled']

  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const segment = (s) => typeof s === 'string' && /^[^\s/{}]+$/.test(s) && s.indexOf('..') === -1

  for (const row of rows(steps.due)) {
    const r = row || {}
    if (terminal.indexOf(r.status) === -1) continue
    if (typeof r.expiresAt !== 'number' || !(r.expiresAt < now)) continue
    if (!segment(r.impl) || !segment(r.workflow) || !segment(r.runId)) continue
    return { any: true, impl: r.impl, workflow: r.workflow, scanLike: 'workflows/' + r.impl + '/' + r.workflow + '/runs/%' }
  }
  return { any: false, impl: '', workflow: '', scanLike: '-' }
}
