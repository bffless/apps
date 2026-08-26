/**
 * A run or step status, as the one badge every screen uses (08). `data-state`
 * is the headless contract (07) — the label is for people, the attribute is
 * what the driver reads, so they can never drift apart.
 *
 * Two shapes of the same fact: `StatusGlyph` is the 15px circle the prototype
 * puts on every graph card and run bar (green ✓, red ✕, an amber pulse, a
 * hollow ring), `StatusPill` is that glyph with its word beside it. Colour is
 * never the only carrier — the glyph's shape differs per state and it always
 * carries an `aria-label`.
 */
import type { RunStatus, StepStatus } from '../lib/runner/types'

type Status = RunStatus | StepStatus | 'declared'

const LABELS: Record<Status, string> = {
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

/** The mark inside the circle; the pulse and the rings are drawn by CSS. */
const MARKS: Partial<Record<Status, string>> = {
  succeeded: '✓',
  failed: '✕',
  cancelled: '✕',
  skipped: '–',
}

export function StatusGlyph({ status, hidden = false }: { status: Status; hidden?: boolean }) {
  return (
    <span
      className="glyph"
      data-state={status}
      role={hidden ? undefined : 'img'}
      aria-hidden={hidden || undefined}
      aria-label={hidden ? undefined : LABELS[status]}
    >
      {MARKS[status] ?? ''}
    </span>
  )
}

export function StatusPill({ status }: { status: RunStatus | StepStatus }) {
  return (
    <span className="pill" data-state={status}>
      <StatusGlyph status={status} hidden />
      {LABELS[status]}
    </span>
  )
}
