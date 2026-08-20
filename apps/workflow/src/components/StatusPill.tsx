/**
 * A run or step status, as the one badge every screen uses (08). `data-state`
 * is the headless contract (07) — the label is for people, the attribute is
 * what the driver reads, so they can never drift apart.
 */
import type { RunStatus, StepStatus } from '../lib/runner/types'

const LABELS: Record<StepStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  polling: 'Polling',
  waiting: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}

export function StatusPill({ status }: { status: RunStatus | StepStatus }) {
  return (
    <span className="pill" data-state={status}>
      {LABELS[status]}
    </span>
  )
}
