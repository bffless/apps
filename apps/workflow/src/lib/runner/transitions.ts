/**
 * The step-status transition table (01/09): what a step's `status` may legally
 * move to next. Pure: no imports beyond ./types (spec 09).
 */
import type { StepStatus } from './types'

export const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  queued: ['running', 'waiting' /* form steps */, 'skipped', 'cancelled'],
  running: ['polling', 'waiting', 'succeeded', 'failed', 'queued' /* retry */, 'cancelled'],
  polling: ['succeeded', 'failed', 'queued' /* retry */, 'cancelled'],
  waiting: ['succeeded', 'failed', 'skipped', 'cancelled'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
}

export class IllegalTransition extends Error {}

/**
 * Throws `IllegalTransition` unless `to` is reachable from `from` per
 * `STEP_TRANSITIONS`. `from === to` is always permitted as a payload-refresh
 * no-op — Resume re-emits the current status (e.g. polling -> polling with
 * the recorded initial) without violating the table.
 */
export function assertTransition(from: StepStatus, to: StepStatus, key: string): void {
  if (from === to) return
  if (STEP_TRANSITIONS[from].includes(to)) return
  throw new IllegalTransition(`${key}: illegal step transition ${from} -> ${to}`)
}
