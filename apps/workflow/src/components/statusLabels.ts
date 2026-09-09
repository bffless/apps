/**
 * A status's word, in one place (08). `StatusPill` puts it beside the glyph;
 * the graph's job node prints it on its own status line — so a node and a pill
 * showing the same run can never spell the same fact two ways.
 *
 * Its own module rather than an export of `StatusPill.tsx`: a component file
 * exports components only (react-refresh/only-export-components).
 */
import type { RunStatus, StepStatus } from '../lib/runner/types'

export type Status = RunStatus | StepStatus | 'declared'

export const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  running: 'Running',
  polling: 'Polling',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  declared: 'Declared',
}
