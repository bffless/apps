/**
 * The catalog, bound to the store (spec 10, D19/D21): one executor per tool,
 * each reading state **at call time** — nothing here is captured when the
 * tools register, so nothing re-registers as a run progresses and
 * `toolchange` stays quiet.
 *
 * Reads go through what the UI renders from: the discovery cache, the run
 * slice (`runSnapshotOf`), `getRun`/`listRuns`. Mutations dispatch the very
 * thunks a click does. Every answer is a `CallToolResult`; every refusal is
 * `isError` with a map keyed the way spec 07 keys `window.__workflow.errors`.
 *
 * Imports are fenced (eslint): the catalog package, the store, and the three
 * lib modules the page itself reads from — never `lib/runner`, a component or
 * a page. The agent does what a click does; it does not reach past the click.
 */
import {
  errorResult,
  snapshotFromRows,
  textResult,
  type CallToolResult,
  type RunSnapshot,
  type ToolName,
} from '@bffless/workflow-agent-tools'
import { workflowId } from '../lib/coerce'
import { describeWorkflow } from '../lib/describe'
import type { AppStore } from '../store'
import { workflowApi } from '../store/workflowApi'
import { loadWorkflowDefinition } from '../store/workflowLoad'
import { runSnapshotOf } from './snapshot'

export interface ExecutorDeps {
  store: AppStore
  /** Move the page — `workflow.start` and `workflow.resume` navigate like the kickoff form does. */
  navigate: (to: string) => void
  /** Where the page is, read at call time: `/:impl/:workflow/...` supplies the defaults `workflow.runs` needs. */
  location: () => { pathname: string }
  now?: () => number
}

export type Executor = (args: Record<string, unknown>) => Promise<CallToolResult>

type Args = Record<string, unknown>

const NO_RUN = 'No run is on this page — pass runId'

function stringArg(args: Args, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function missing(key: string, what = 'is required'): CallToolResult {
  return errorResult(`\`${key}\` ${what}`, { errors: { [key]: `\`${key}\` ${what}` } })
}

/** `/:impl/:workflow/...` → the pair, when the page is on one. */
function routeTarget(pathname: string): { impl?: string; workflow?: string } {
  const [impl, workflow] = pathname.split('/').filter((segment) => segment !== '')
  return { ...(impl ? { impl } : {}), ...(workflow ? { workflow } : {}) }
}

function describeWaiting(snapshot: RunSnapshot): string {
  if (snapshot.waitingOn.length === 0) return ''
  return `, waiting on ${snapshot.waitingOn.map((step) => `${step.key} (${step.kind})`).join(', ')}`
}

export function snapshotText(snapshot: RunSnapshot): string {
  if (snapshot.status === 'invalid') return 'No run was started'
  return `Run ${snapshot.runId} is ${snapshot.status}${describeWaiting(snapshot)}`
}

type Resolved = { ok: true; snapshot: RunSnapshot; live: boolean } | { ok: false; result: CallToolResult }

/**
 * The run a `runId?` names: the one this tab holds when the id is absent or
 * matches it (the live slice, with the resolved island src), else the record
 * — `getRun`'s rows through the catalog's own derivation. The RTK Query
 * subscription is released on the way out.
 */
export async function resolveSnapshot(deps: ExecutorDeps, runId: string | undefined): Promise<Resolved> {
  const slice = deps.store.getState().run
  if (slice.state && slice.meta && (runId === undefined || runId === slice.state.runId)) {
    return { ok: true, snapshot: runSnapshotOf(slice.meta.def, slice.state), live: slice.mode === 'live' }
  }
  if (runId === undefined) return { ok: false, result: errorResult(NO_RUN, { errors: { runId: NO_RUN } }) }

  const read = deps.store.dispatch(workflowApi.endpoints.getRun.initiate(runId, { forceRefetch: true }))
  try {
    const res = await read
    if (res.error) {
      const message = `The run record could not be read (${JSON.stringify(res.error)})`
      return { ok: false, result: errorResult(message, { errors: { runId: message } }) }
    }
    if (!res.data?.run) {
      return { ok: false, result: errorResult(`No such run: ${runId}`, { errors: { runId: 'No such run' } }) }
    }
    return { ok: true, snapshot: snapshotFromRows(res.data.run, res.data.steps), live: false }
  } finally {
    read.unsubscribe()
  }
}

function notYet(name: ToolName): Executor {
  return async () =>
    errorResult(`${name} arrives with the next story`, { errors: { tool: `${name} is not implemented yet` } })
}

export function createExecutors(deps: ExecutorDeps): Record<ToolName, Executor> {
  const list: Executor = async (args) => {
    const only = stringArg(args, 'impl')
    const found = deps.store.dispatch(workflowApi.endpoints.discover.initiate())
    try {
      const res = await found
      if (res.error || !res.data) {
        return errorResult('The implementations could not be listed', {
          errors: { discovery: 'The implementations could not be listed' },
        })
      }
      const implementations = res.data
        .filter((impl) => only === undefined || impl.alias === only)
        .map((impl) => ({
          alias: impl.alias,
          name: impl.name,
          ...(impl.version === undefined ? {} : { version: impl.version }),
          preview: impl.preview,
          ...(impl.error === undefined ? {} : { error: impl.error }),
          workflows: impl.workflows.map((listing) => ({
            id: workflowId(listing.file),
            file: listing.file,
            name: listing.name,
            ...(listing.description === undefined ? {} : { description: listing.description }),
            headlessSafe: listing.headlessSafe,
          })),
        }))
      if (only !== undefined && implementations.length === 0) {
        return errorResult(`No implementation "${only}" is published here`, {
          errors: { impl: `No implementation "${only}" is published here` },
        })
      }
      const lines = implementations.map((impl) => {
        const workflows = impl.workflows
          .map((workflow) => `${workflow.id}${workflow.headlessSafe ? ' (headless-safe)' : ''}`)
          .join(', ')
        return `${impl.alias} — ${impl.name}${impl.version ? ` v${impl.version}` : ''}${impl.error ? ` (unusable: ${impl.error})` : ''}: ${workflows || 'no workflows'}`
      })
      return textResult(lines.length === 0 ? 'No implementations are published here' : lines.join('\n'), {
        implementations,
      })
    } finally {
      found.unsubscribe()
    }
  }

  const describe: Executor = async (args) => {
    const impl = stringArg(args, 'impl')
    const workflow = stringArg(args, 'workflow')
    if (impl === undefined) return missing('impl')
    if (workflow === undefined) return missing('workflow')
    const loaded = await deps.store.dispatch(loadWorkflowDefinition({ impl, workflow }))
    if (!loaded.ok) return errorResult(Object.values(loaded.errors)[0] ?? 'The workflow could not be loaded', { errors: loaded.errors })
    const described = describeWorkflow({ impl, workflow, listing: loaded.listing, def: loaded.def })
    const interactive = described.jobs.flatMap((job) =>
      job.steps.filter((step) => step.kind === 'island' || step.kind === 'form').map((step) => `${job.id}/${step.id} (${step.kind}${step.headless ? `, headless: ${step.headless}` : ', needs a person'})`),
    )
    const text = `${described.name} (${impl}/${workflow}): ${Object.keys(described.inputs).length} inputs, ${described.jobs.length} jobs, ${Object.keys(described.outputs).length} outputs${interactive.length ? `; interactive steps: ${interactive.join(', ')}` : '; no interactive steps'}${described.headlessSafe ? '; headless-safe' : ''}`
    return textResult(text, { ...described })
  }

  const status: Executor = async (args) => {
    const resolved = await resolveSnapshot(deps, stringArg(args, 'runId'))
    if (!resolved.ok) return resolved.result
    return textResult(snapshotText(resolved.snapshot), { ...resolved.snapshot })
  }

  const outputs: Executor = async (args) => {
    const resolved = await resolveSnapshot(deps, stringArg(args, 'runId'))
    if (!resolved.ok) return resolved.result
    const { runId, status: runStatus, outputs: values } = resolved.snapshot
    const names = Object.keys(values)
    const text =
      names.length === 0
        ? `Run ${runId} is ${runStatus} and has no outputs${runStatus === 'running' ? ' yet' : ''}`
        : `Run ${runId} (${runStatus}) outputs: ${names.join(', ')}`
    return textResult(text, { runId, status: runStatus, outputs: values })
  }

  const runs: Executor = async (args) => {
    const current = deps.store.getState().run.state
    const route = routeTarget(deps.location().pathname)
    const impl = stringArg(args, 'impl') ?? current?.impl ?? route.impl
    const workflow = stringArg(args, 'workflow') ?? current?.workflow ?? route.workflow
    if (impl === undefined || workflow === undefined) {
      const message = 'Pass impl and workflow — this page has no current workflow'
      return errorResult(message, { errors: { workflow: message } })
    }
    const wanted = stringArg(args, 'status')
    const limit = typeof args.limit === 'number' && args.limit >= 1 ? Math.min(Math.floor(args.limit), 50) : 20
    const read = deps.store.dispatch(workflowApi.endpoints.listRuns.initiate({ impl, workflow }, { forceRefetch: true }))
    try {
      const res = await read
      if (res.error || !res.data) {
        const message = `The runs could not be listed (${JSON.stringify(res.error)})`
        return errorResult(message, { errors: { runs: message } })
      }
      const rows = res.data
        .filter((row) => wanted === undefined || row.status === wanted)
        .slice(0, limit)
        .map((row) => ({
          runId: row.runId,
          status: row.status,
          startedAt: row.startedAt,
          ...(typeof row.finishedAt === 'number' ? { finishedAt: row.finishedAt } : {}),
          headless: row.headless,
          ...(row.unattended === undefined ? {} : { unattended: row.unattended }),
          ...(row.startedBy === undefined ? {} : { startedBy: row.startedBy }),
          waitingOn: row.waitingOn ?? [],
        }))
      const lines = rows.map(
        (row) =>
          `${row.runId} ${row.status} (${new Date(row.startedAt).toISOString()})${row.waitingOn.length ? ` waiting on ${row.waitingOn.join(', ')}` : ''}`,
      )
      return textResult(
        lines.length === 0 ? `No runs of ${impl}/${workflow}${wanted ? ` with status ${wanted}` : ''}` : `${lines.length} run${lines.length === 1 ? '' : 's'} of ${impl}/${workflow}:\n${lines.join('\n')}`,
        { impl, workflow, runs: rows },
      )
    } finally {
      read.unsubscribe()
    }
  }

  return {
    'workflow.list': list,
    'workflow.describe': describe,
    'workflow.status': status,
    'workflow.outputs': outputs,
    'workflow.runs': runs,
    'workflow.start': notYet('workflow.start'),
    'workflow.await': notYet('workflow.await'),
    'workflow.submitStep': notYet('workflow.submitStep'),
    'workflow.sign': notYet('workflow.sign'),
    'workflow.cancel': notYet('workflow.cancel'),
    'workflow.resume': notYet('workflow.resume'),
  }
}
