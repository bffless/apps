/**
 * The definition a stored run row describes — the one every screen that reads
 * a `workflow_runs` row rebuilds its graph, labels and step order from.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import type { ServerRunRow } from './coerce'
import { loadWorkflow } from './runner/definition'
import type { Definition } from './runner/types'

/**
 * The definition the run stored, or the one its YAML snapshot parses to.
 * `toDefinition` assumes schema-valid data, so a row written by an older or
 * broken writer is caught here rather than by a crash three components down.
 */
export function definitionOf(run: ServerRunRow): Definition | null {
  const raw = run.definition
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      const def = toDefinition(raw)
      if (Object.keys(def.jobs).length > 0) return def
    } catch {
      // fall through to the YAML snapshot
    }
  }
  return run.yaml ? loadWorkflow(run.yaml, `${run.workflow}.workflow.yaml`).def : null
}
