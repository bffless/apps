/**
 * A workflow, loaded the way the kickoff page loads one (08): discovery → the
 * alias's listing → its YAML → `loadWorkflow`. Lifted into a thunk so the two
 * callers that must agree on every refusal — the kickoff page's `?auto=1`
 * path and the agent tools' `workflow.start` / `workflow.describe` (spec 10)
 * — are one function: a driver, an agent and a person are never judged
 * differently (07/D12, extended by D19).
 *
 * Every refusal comes back keyed as `window.__workflow.errors` keys it —
 * `discovery` or `workflow` — with the very strings the kickoff page renders
 * (`START_REFUSALS`), never a throw: the callers turn it into a page state or
 * a tool result, and both need the words, not a stack.
 *
 * The RTK Query subscriptions are released on the way out: the page has its
 * own hooks-driven subscriptions, and an agent call must not pin cache entries
 * for the life of the tab.
 */
import type { Implementation, WorkflowListing } from '../lib/coerce'
import { workflowId } from '../lib/coerce'
import { START_REFUSALS } from '../lib/autoStart'
import { loadWorkflow } from '../lib/runner/definition'
import type { Definition } from '../lib/runner/types'
import type { AppThunk } from './index'
import { workflowApi } from './workflowApi'

export type LoadedTarget =
  | { ok: true; impl: Implementation; listing: WorkflowListing; workflow: string; def: Definition; yaml: string }
  | { ok: false; errors: Partial<Record<'discovery' | 'workflow', string>> }

export function loadWorkflowDefinition(a: { impl: string; workflow: string }): AppThunk<Promise<LoadedTarget>> {
  return async (dispatch) => {
    const discovery = dispatch(workflowApi.endpoints.discover.initiate())
    try {
      const found = await discovery
      if (found.error || !found.data) return { ok: false, errors: { discovery: START_REFUSALS.discovery } }

      // One guard, because the listing is derived from the implementation's
      // own workflows: no such alias, or no workflow by that id in it.
      const impl = found.data.find((candidate) => candidate.alias === a.impl)
      const listing = impl?.workflows.find((candidate) => workflowId(candidate.file) === a.workflow)
      if (!impl || !listing) return { ok: false, errors: { workflow: START_REFUSALS.noWorkflow } }

      const yaml = dispatch(workflowApi.endpoints.getWorkflowYaml.initiate({ impl: impl.alias, file: listing.file }))
      try {
        const text = await yaml
        if (text.error || typeof text.data !== 'string') {
          return { ok: false, errors: { workflow: START_REFUSALS.fileUnreadable } }
        }
        const loaded = loadWorkflow(text.data, listing.file)
        if (!loaded.ok || !loaded.def) return { ok: false, errors: { workflow: START_REFUSALS.doesNotLint } }
        return { ok: true, impl, listing, workflow: a.workflow, def: loaded.def, yaml: loaded.yaml }
      } finally {
        yaml.unsubscribe()
      }
    } finally {
      discovery.unsubscribe()
    }
  }
}
