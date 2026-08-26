/**
 * Which graph chips light up for the value under the pointer (08: hovering a
 * payload chip highlights where it came from and where it goes). Pure, on top
 * of `dataFlowEdges` — `GraphView` only wires this to the store's
 * `ui.hoveredValue`.
 */
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import { dataFlowEdges } from '../../lib/runner/graph'
import type { Definition } from '../../lib/runner/types'

/** Shape-compatible with `UiState['hoveredValue']` — no import needed either way. */
export interface HoveredValue {
  job: string
  step?: string
  output?: string
}

export interface GraphFlow {
  /** `${job}::${step}` keys whose chip declares the hovered value. */
  sourceSteps: ReadonlySet<string>
  /** `${job}::${step}` keys whose chip reads the hovered value. */
  targetSteps: ReadonlySet<string>
  /** Job ids whose card is itself the hovered value's source (job-level output, no one declaring step). */
  sourceJobs: ReadonlySet<string>
}

const NONE: GraphFlow = { sourceSteps: new Set(), targetSteps: new Set(), sourceJobs: new Set() }

/**
 * A hover naming a step is that one chip. A hover naming only a job (a
 * job-level `outputs` alias has no single declaring step) falls back to every
 * step of that job that declares any output, and the job card itself.
 */
export function flowFor(def: Definition, hovered: HoveredValue | null): GraphFlow {
  if (!hovered) return NONE

  const sourceSteps = new Set<string>()
  const sourceJobs = new Set<string>()
  const targetSteps = new Set<string>()

  if (hovered.step !== undefined) {
    sourceSteps.add(`${hovered.job}::${hovered.step}`)
  } else {
    sourceJobs.add(hovered.job)
    for (const step of def.jobs[hovered.job]?.steps ?? []) {
      if ((stepOutputNames(step)?.length ?? 0) > 0) sourceSteps.add(`${hovered.job}::${step.id}`)
    }
  }

  for (const edge of dataFlowEdges(def)) {
    const sameSource =
      edge.from.job === hovered.job &&
      edge.from.output === hovered.output &&
      (edge.from.step ?? null) === (hovered.step ?? null)
    if (sameSource) targetSteps.add(`${edge.to.job}::${edge.to.step}`)
  }

  return { sourceSteps, sourceJobs, targetSteps }
}
