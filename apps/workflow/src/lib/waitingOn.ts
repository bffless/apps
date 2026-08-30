/**
 * Which steps a listed run is parked on (08 Past runs, apps#473).
 *
 * The list endpoint joins the *keys* of a run's `waiting` step rows onto the
 * run row (`runs/get/shape.fn.js`); everything else — each step's display
 * name and the order to show several in — comes from the definition the row
 * already carries, so nothing step-level is fetched or persisted. The order is
 * scheduling order (topo job order, then declaration order, then matrix
 * index), the walk `firstWaitingStep` does on the run page, so the step named
 * first here is the one that page would open.
 */
import { stepLabel } from '../components/graph/geometry'
import type { ServerRunRow } from './coerce'
import { definitionOf } from './runDefinition'
import { jobOrder } from './runner/graph'
import type { Definition, StepKey } from './runner/types'

export interface WaitingStep {
  key: StepKey
  /** The step's `name` when it declares one, else its id — as the run page labels it. */
  label: string
}

/** `<job>/<index>/<step>` → its parts; `null` for a key that is not one. */
function parseKey(key: StepKey): { job: string; index: number; stepId: string } | null {
  const parts = key.split('/')
  if (parts.length !== 3) return null
  const index = Number(parts[1])
  if (parts[0] === '' || parts[2] === '' || !Number.isInteger(index)) return null
  return { job: parts[0], index, stepId: parts[2] }
}

/** Each (job, step) of the definition ranked in scheduling order. */
function ranks(def: Definition | null): Map<string, number> {
  const out = new Map<string, number>()
  if (!def) return out
  let jobs: string[]
  try {
    jobs = jobOrder(def)
  } catch {
    // A cyclic definition is unschedulable; declaration order is the honest fallback.
    jobs = Object.keys(def.jobs)
  }
  for (const job of jobs) {
    for (const step of def.jobs[job]?.steps ?? []) out.set(`${job}/${step.id}`, out.size)
  }
  return out
}

export function waitingSteps(run: ServerRunRow): WaitingStep[] {
  const keys = run.waitingOn ?? []
  if (keys.length === 0) return []
  const def = definitionOf(run)
  const rank = ranks(def)

  const entries = keys.map((key) => {
    const parsed = parseKey(key)
    const step = parsed ? def?.jobs[parsed.job]?.steps.find((s) => s.id === parsed.stepId) : undefined
    return {
      key,
      label: step ? stepLabel(step) : (parsed?.stepId ?? key),
      rank: parsed ? (rank.get(`${parsed.job}/${parsed.stepId}`) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
      index: parsed?.index ?? Number.POSITIVE_INFINITY,
    }
  })

  return entries
    .sort((a, b) => a.rank - b.rank || a.index - b.index || a.key.localeCompare(b.key))
    .map(({ key, label }) => ({ key, label }))
}
