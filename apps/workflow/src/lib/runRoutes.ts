/**
 * The run's routes (spec 2026-09-08, Decision 1): the Summary at
 * `/runs/:runId`, a job at `/job/:job`, a matrix item at `/job/:job/:index`,
 * and `?step=<key>` on a job page for the expanded step row. Pure — the shell
 * derives its selection from these and writes navigations through them, so
 * the two directions cannot disagree.
 */
import type { StepKey } from './runner/types'
import { parseStepKey } from './runner/types'

export type RunSelection =
  | { kind: 'run' }
  | { kind: 'job'; job: string; index?: number }
  | { kind: 'step'; key: StepKey }

export const STEP_PARAM = 'step'
export const TAB_PARAM = 'tab'

export function runPath(base: string, runId: string): string {
  return `${base}/runs/${runId}`
}

export function jobPath(base: string, runId: string, job: string, index?: number): string {
  const item = index === undefined ? '' : `/${index}`
  return `${runPath(base, runId)}/job/${encodeURIComponent(job)}${item}`
}

export function stepPath(base: string, runId: string, key: StepKey): string {
  const parts = parseStepKey(key)
  if (!parts) return runPath(base, runId)
  return `${jobPath(base, runId, parts.job, parts.index)}?${STEP_PARAM}=${encodeURIComponent(key)}`
}

/** The URL for a selection, keeping every query parameter that is not ours (`?mocks=`, `?resume=1`). */
export function pathForSelection(
  base: string,
  runId: string,
  selection: RunSelection,
  search: URLSearchParams,
  tab?: 'Input' | 'Output',
): string {
  const next = new URLSearchParams(search)
  next.delete(STEP_PARAM)
  next.delete(TAB_PARAM)
  let path: string
  if (selection.kind === 'run') path = runPath(base, runId)
  else if (selection.kind === 'job') path = jobPath(base, runId, selection.job, selection.index)
  else {
    const parts = parseStepKey(selection.key)
    path = parts ? jobPath(base, runId, parts.job, parts.index) : runPath(base, runId)
    if (parts) next.set(STEP_PARAM, selection.key)
  }
  if (tab && selection.kind !== 'run') next.set(TAB_PARAM, tab)
  const query = next.toString()
  return query === '' ? path : `${path}?${query}`
}

export function selectionFromRoute(
  params: { job?: string; index?: string },
  search: URLSearchParams,
): RunSelection {
  const step = search.get(STEP_PARAM)
  if (params.job === undefined) {
    // No job on the route, but a `?step=` on it: an old Summary link. The
    // shell redirects it to where that level lives now — and until it does,
    // the selection is already the one the person asked for, so nothing
    // (the follow logic least of all) treats the URL as a bare run view.
    if (step === null || step === '') return { kind: 'run' }
    return parseStepKey(step) ? { kind: 'step', key: step } : { kind: 'job', job: step }
  }
  if (step !== null && parseStepKey(step)) return { kind: 'step', key: step }
  const index = params.index === undefined ? undefined : Number(params.index)
  return index !== undefined && Number.isInteger(index) && index >= 0
    ? { kind: 'job', job: params.job, index }
    : { kind: 'job', job: params.job }
}

/** The one value the follow logic reads: `null` (run), a bare job id, or a step key. */
export function selectionKey(selection: RunSelection): StepKey | string | null {
  if (selection.kind === 'run') return null
  return selection.kind === 'job' ? selection.job : selection.key
}

/** An old `?step=` on the Summary URL → where it lives now; `null` when there is nothing to redirect. */
export function redirectFor(base: string, runId: string, search: URLSearchParams): string | null {
  const step = search.get(STEP_PARAM)
  if (step === null) return null
  const parts = parseStepKey(step)
  const selection: RunSelection = parts ? { kind: 'step', key: step } : { kind: 'job', job: step }
  return pathForSelection(base, runId, selection, search)
}
