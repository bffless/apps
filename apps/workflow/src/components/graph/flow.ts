/**
 * Which graph chips light up for the value under the pointer (08: hovering a
 * payload chip highlights where it came from and where it goes). Pure, on top
 * of `dataFlowEdges` — `GraphView` only wires this to the store's
 * `ui.hoveredValue`.
 */
import { dataFlowEdges, jobOutputSteps } from '../../lib/runner/graph'
import type { DataFlowEdge } from '../../lib/runner/graph'
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
 * A hover naming a step is that one chip. A hover naming only a job is the job
 * card itself plus the step its `outputs.<name>` alias reads — traced through
 * `jobOutputSteps`, which falls back to every output-declaring step of the job
 * only when the alias names none of them (apps#382).
 *
 * `edges` is `def`'s own data-flow edge list, which depends on nothing else —
 * `GraphView` passes the copy it memoizes on `def` alone so a hover tick never
 * re-walks the workflow (apps#380). Callers with no such cache (tests, any
 * one-shot use) can leave it out and get the same answer.
 */
export function flowFor(
  def: Definition,
  hovered: HoveredValue | null,
  edges?: readonly DataFlowEdge[],
): GraphFlow {
  if (!hovered) return NONE

  const sourceSteps = new Set<string>()
  const sourceJobs = new Set<string>()
  const targetSteps = new Set<string>()

  if (hovered.step !== undefined) {
    sourceSteps.add(`${hovered.job}::${hovered.step}`)
  } else {
    sourceJobs.add(hovered.job)
    for (const step of jobOutputSteps(def, hovered.job, hovered.output)) {
      sourceSteps.add(`${hovered.job}::${step}`)
    }
  }

  for (const edge of edges ?? dataFlowEdges(def)) {
    const sameSource =
      edge.from.job === hovered.job &&
      edge.from.output === hovered.output &&
      (edge.from.step ?? null) === (hovered.step ?? null)
    if (sameSource) targetSteps.add(`${edge.to.job}::${edge.to.step}`)
  }

  return { sourceSteps, sourceJobs, targetSteps }
}
