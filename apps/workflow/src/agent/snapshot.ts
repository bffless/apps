/**
 * The run snapshot for the run this tab holds (spec 10): `window.__workflow`'s
 * shape (07, `snapshotOf`) plus `waitingOn` — for each `waiting` step, its
 * key, kind, the inputs it was shown with, an island's declared outputs and
 * its resolved `src`. The catalog derives the same shape from rows
 * (`snapshotFromRows`) for runs this tab is not driving; this one is richer
 * only in that it knows the island's resolved URL, off the launch handle.
 *
 * Types come off the store's own state rather than `lib/runner` — the agent
 * layer binds to the store, never to the engine (D19; the eslint fence).
 */
import type { RunSnapshot, WaitingStep } from '@bffless/workflow-agent-tools'
import { snapshotOf } from '../lib/workflowGlobal'
import type { RootState } from '../store'
import { getIslandHandle } from '../store/islandLaunch'

export type LiveRunState = NonNullable<RootState['run']['state']>
export type LiveDefinition = NonNullable<RootState['run']['meta']>['def']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function runSnapshotOf(def: LiveDefinition, state: LiveRunState): RunSnapshot {
  const waitingOn: WaitingStep[] = []
  for (const step of Object.values(state.steps)) {
    if (step.status !== 'waiting' || (step.kind !== 'form' && step.kind !== 'island')) continue
    const declared = def.jobs[step.job]?.steps.find((candidate) => candidate.id === step.stepId)
    const raw: Record<string, unknown> = isPlainObject(declared?.raw) ? declared.raw : {}
    const entry: WaitingStep = { key: step.key, kind: step.kind, inputs: step.inputs ?? {} }
    if (step.kind === 'island') {
      if (isPlainObject(raw.outputs)) entry.outputs = raw.outputs
      const declaredSrc = isPlainObject(raw.with) && typeof raw.with.src === 'string' ? raw.with.src : undefined
      const src = getIslandHandle(state.runId, step.key)?.src ?? declaredSrc
      if (src !== undefined) entry.src = src
    }
    waitingOn.push(entry)
  }
  return { ...snapshotOf(state), waitingOn }
}
