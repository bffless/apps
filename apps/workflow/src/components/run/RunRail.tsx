/**
 * The run's own left rail (spec 2026-09-08, Decision 3): inside a run the
 * implementation tree gives way to the run's jobs, the way GitHub's run page
 * swaps the repository nav for the job list.
 *
 * A stub for now — the rail's contents land in the next task; the shell
 * already renders it (and the guards render it too, so the way back out of a
 * failed run is always there).
 */
import type { FC } from 'react'
import type { Definition, RunState } from '../../lib/runner/types'

export interface RunRailProps {
  base: string
  runId: string
  def: Definition | null
  state: RunState | null
  yaml?: string
}

/** The props the real rail will read; the stub renders the landmark only. */
export const RunRail: FC<RunRailProps> = () => <nav className="rail run-rail" aria-label="Run" />
