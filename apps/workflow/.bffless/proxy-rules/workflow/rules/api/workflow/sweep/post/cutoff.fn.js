/**
 * The nightly sweep's cutoff (spec 05 §Retention, apps#615): the instant every
 * run's `expiresAt` is measured against, the statuses a run may be swept in,
 * and the pattern the `workflow_files` scan is anchored on. One function, so
 * the three values the rule's filters compare against come from one place —
 * every filter `value` is evaluated as an expression (CE filter-where.util.ts,
 * via data_query / data_delete), so neither `Date.now()` nor a list can be a
 * YAML literal there.
 *
 * Terminal only: `running` is deliberately absent. A parked driven run keeps
 * `status: running` while it waits on a form (07), and this list is what keeps
 * a `keep:` that elapses during the wait from deleting it under the driver.
 * Same refusal `run/delete`'s gate makes (409 `running`), spelled once here.
 *
 * Fired by a `pipeline_schedule` with NO user (a system run), so nothing here
 * reads the caller. Never throws.
 */
function handler() {
  return {
    now: Date.now(),
    terminal: ['succeeded', 'failed', 'cancelled'],
    // Anchored on the run layout of 06 (`workflows/<impl>/<workflow>/runs/<id>/…`),
    // so kickoff `inputs/` records — one level up, D18 — never enter the scan.
    scanLike: 'workflows/%/runs/%',
  }
}
