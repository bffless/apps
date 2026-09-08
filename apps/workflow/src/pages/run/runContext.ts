/**
 * What the run's layout route (`RunShell`) knows, handed down to the pages it
 * renders through its outlet (spec 2026-09-08).
 *
 * A React context rather than the outlet's own context because the shell also
 * renders things *beside* the outlet — the backstage islands, the fullscreen
 * strip — and because a page reached through a nested outlet later should
 * still be able to ask.
 */
import { createContext, useContext } from 'react'
import type { YamlSource } from '../../components/run/YamlDrawer'
import type { ServerRunRow, ServerStepRow } from '../../lib/coerce'
import type { Annotation, Definition, RunState, StepKey } from '../../lib/runner/types'
import type { RunSelection } from '../../lib/runRoutes'

export interface RunContextValue {
  /** `/<impl>/<workflow>` — every navigation this run makes hangs off it. */
  base: string
  runId: string
  def: Definition
  state: RunState
  /** The run row; `null` on the live path, which never fetches one. */
  run: ServerRunRow | null
  steps: ServerStepRow[]
  isLive: boolean
  /** `implForView`, trust-gated (apps#364). */
  impl: string | undefined
  annotations: Annotation[]
  yamlSource: YamlSource
  workflowName: string
  selection: RunSelection
  /** The follow logic's value: null | job id | step key (Decision 1). */
  selectedStep: StepKey | string | null
  /** A person's navigation to a selection: pushes, pins. */
  select: (selection: RunSelection, tab?: 'Input' | 'Output') => void
  /** Up one level (Esc, crumbs): pushes, pins. */
  back: () => void
  toRun: () => void
  forkable: (job: string) => boolean
  fork: (job: string) => Promise<void>
}

export const RunContext = createContext<RunContextValue | null>(null)

export function useRunContext(): RunContextValue {
  const value = useContext(RunContext)
  if (!value) throw new Error('useRunContext: no RunShell above this page')
  return value
}
