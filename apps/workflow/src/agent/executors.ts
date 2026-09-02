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
import { signFile } from '../islands/hostDeps'
import { initialValues, validateInputs } from '../lib/autoStart'
import { workflowId } from '../lib/coerce'
import { describeWorkflow } from '../lib/describe'
import { httpJsonWithReauth } from '../lib/http'
import type { AppStore } from '../store'
import { LeaseTransportError, cancelRun, takeOver } from '../store/lifecycleActions'
import { startRun } from '../store/runnerActions'
import { submitStep } from '../store/submitActions'
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
  /** `workflow.await`'s record poll for a run this tab does not drive (default 2 s). */
  pollMs?: number
  /** `workflow.sign`'s exchange; the app's real one by default. */
  sign?: (path: string) => Promise<{ url: string; expiresIn: number }>
}

export type Executor = (args: Record<string, unknown>) => Promise<CallToolResult>

type Args = Record<string, unknown>

const NO_RUN = 'No run is on this page — pass runId'
const NOT_DRIVING = 'This page is not driving that run — workflow.resume it first'
const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])
const AWAIT_DEFAULT_MS = 120_000
const AWAIT_MAX_MS = 600_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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

function notDriving(runId: string): CallToolResult {
  return errorResult(`This page is not driving run ${runId} — workflow.resume it first`, { errors: { runId: NOT_DRIVING } })
}

/** The run this tab holds, as a snapshot — `null` when it holds none. */
function currentSnapshot(deps: ExecutorDeps): RunSnapshot | null {
  const slice = deps.store.getState().run
  return slice.state && slice.meta ? runSnapshotOf(slice.meta.def, slice.state) : null
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

  const now = deps.now ?? Date.now

  /**
   * `workflow.start`: the kickoff form's own sequence — load, resolve the
   * values against the declarations, validate with the one function the form
   * and `?auto=1` use, start, navigate. A person-shaped run (`headless: false`):
   * an agent on the page is the member acting.
   */
  const start: Executor = async (args) => {
    const impl = stringArg(args, 'impl')
    const workflow = stringArg(args, 'workflow')
    if (impl === undefined) return missing('impl')
    if (workflow === undefined) return missing('workflow')
    if (!isPlainObject(args.inputs)) {
      const message = '`inputs` must be an object of input values'
      return errorResult(message, { errors: { inputs: message } })
    }
    const loaded = await deps.store.dispatch(loadWorkflowDefinition({ impl, workflow }))
    if (!loaded.ok) return errorResult(Object.values(loaded.errors)[0] ?? 'The workflow could not be loaded', { errors: loaded.errors })

    const values = initialValues(loaded.def.inputs, args.inputs)
    const errors = validateInputs(loaded.def.inputs, values)
    if (Object.keys(errors).length > 0) return errorResult('These inputs cannot start a run', { errors })

    const runId = deps.store.dispatch(
      startRun({
        impl: loaded.impl.alias,
        workflow,
        def: loaded.def,
        yaml: loaded.yaml,
        workflowName: loaded.def.name,
        ...(loaded.impl.version === undefined ? {} : { workflowVersion: loaded.impl.version }),
        values,
        headless: false,
        unattended: false,
      }),
    )
    deps.navigate(`/${loaded.impl.alias}/${workflow}/runs/${runId}`)
    const snapshot = currentSnapshot(deps) ?? { runId, status: 'running' as const, currentSteps: [], outputs: {}, steps: {}, waitingOn: [] }
    return textResult(`Started ${loaded.def.name}: ${snapshotText(snapshot)}`, { runId, snapshot })
  }

  /**
   * `workflow.await`: the run this tab drives is followed off the store (one
   * subscription, released on resolve); any other run is re-read from its
   * record every `pollMs`. A timeout answers with the snapshot it got to.
   */
  const awaitRun: Executor = async (args) => {
    const until = args.until
    if (until !== 'waiting' && until !== 'terminal') {
      const message = '`until` must be "waiting" or "terminal"'
      return errorResult(message, { errors: { until: message } })
    }
    const timeoutMs =
      typeof args.timeoutMs === 'number' && args.timeoutMs >= 1 ? Math.min(Math.floor(args.timeoutMs), AWAIT_MAX_MS) : AWAIT_DEFAULT_MS
    const satisfied = (snapshot: RunSnapshot) =>
      TERMINAL.has(snapshot.status) || (until === 'waiting' && snapshot.waitingOn.length > 0)

    const first = await resolveSnapshot(deps, stringArg(args, 'runId'))
    if (!first.ok) return first.result
    if (satisfied(first.snapshot)) return textResult(snapshotText(first.snapshot), { ...first.snapshot })

    const runId = first.snapshot.runId
    const fromSlice = (): RunSnapshot | null => {
      const slice = deps.store.getState().run
      return slice.state && slice.meta && slice.state.runId === runId ? runSnapshotOf(slice.meta.def, slice.state) : null
    }

    const settled = await new Promise<RunSnapshot | null>((resolve) => {
      let done = false
      const finish = (value: RunSnapshot | null) => {
        if (done) return
        done = true
        unsubscribe()
        clearTimeout(timer)
        clearInterval(poll)
        resolve(value)
      }
      const check = () => {
        const snapshot = fromSlice()
        if (snapshot && satisfied(snapshot)) finish(snapshot)
      }
      const unsubscribe = deps.store.subscribe(check)
      const timer = setTimeout(() => finish(null), timeoutMs)
      const poll = setInterval(() => {
        if (fromSlice()) return
        void resolveSnapshot(deps, runId).then((read) => {
          if (read.ok && satisfied(read.snapshot)) finish(read.snapshot)
        })
      }, deps.pollMs ?? 2_000)
      check()
    })
    if (settled) return textResult(snapshotText(settled), { ...settled })

    const latest = await resolveSnapshot(deps, runId)
    const snapshot = latest.ok ? latest.snapshot : first.snapshot
    return errorResult(`Timed out after ${timeoutMs} ms waiting for ${until}; ${snapshotText(snapshot)}`, {
      errors: { timeout: `timed out after ${timeoutMs} ms waiting for ${until}` },
      timedOut: true,
      snapshot,
    })
  }

  /** `workflow.submitStep`: the one submit path — `submitStep` picks the validator by the step's kind. */
  const submit: Executor = async (args) => {
    const step = stringArg(args, 'step')
    if (step === undefined) return missing('step')
    if (!isPlainObject(args.values)) {
      const message = '`values` must be an object'
      return errorResult(message, { errors: { values: message } })
    }
    const runId = stringArg(args, 'runId')
    const slice = deps.store.getState().run
    if (!slice.state) return errorResult(NO_RUN, { errors: { runId: NO_RUN } })
    if (runId !== undefined && runId !== slice.state.runId) return notDriving(runId)
    // A read-only replay has no writer behind it: an event folded there would
    // be a state the record never learns about. Resume first.
    if (slice.mode !== 'live') return notDriving(slice.state.runId)

    const result = deps.store.dispatch(submitStep({ key: step, values: args.values, at: now() }))
    if (!result.ok) return errorResult(`Could not submit ${step}`, { errors: result.errors })
    const snapshot = currentSnapshot(deps) ?? { runId: slice.state.runId, status: 'running' as const, currentSteps: [], outputs: {}, steps: {}, waitingOn: [] }
    return textResult(`Submitted ${step}; ${snapshotText(snapshot)}`, { runId: snapshot.runId, step, snapshot })
  }

  /** `workflow.sign`: the same presigned GET islands get (04, D6), through the same confinement. */
  const sign: Executor = async (args) => {
    const path = stringArg(args, 'path')
    if (path === undefined) return missing('path')
    try {
      const signed = await (deps.sign ?? signFile(httpJsonWithReauth))(path)
      return textResult(`Signed ${path} for ${signed.expiresIn} s`, { path, url: signed.url, expiresIn: signed.expiresIn })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(message, { errors: { path: message } })
    }
  }

  /** `workflow.cancel`: only the run this tab drives — `cancelRun` reads the slice; anything else is a resume away. */
  const cancel: Executor = async (args) => {
    const runId = stringArg(args, 'runId')
    const slice = deps.store.getState().run
    if (!slice.state) return errorResult(NO_RUN, { errors: { runId: NO_RUN } })
    if (runId !== undefined && runId !== slice.state.runId) return notDriving(runId)
    if (slice.mode !== 'live') return notDriving(slice.state.runId)
    if (slice.state.status !== 'running') {
      const message = `Run ${slice.state.runId} is already ${slice.state.status}`
      return errorResult(message, { errors: { runId: message } })
    }
    await deps.store.dispatch(cancelRun())
    const snapshot = currentSnapshot(deps)
    return snapshot ? textResult(snapshotText(snapshot), { ...snapshot }) : errorResult(NO_RUN, { errors: { runId: NO_RUN } })
  }

  /** `workflow.resume`: the ResumeBanner's take-over, then the run page — the same words when it cannot. */
  const resume: Executor = async (args) => {
    const runId = stringArg(args, 'runId')
    if (runId === undefined) return missing('runId')
    const read = deps.store.dispatch(workflowApi.endpoints.getRun.initiate(runId, { forceRefetch: true }))
    let record: { run: NonNullable<Awaited<typeof read>['data']>['run'] & object; steps: NonNullable<Awaited<typeof read>['data']>['steps'] }
    try {
      const res = await read
      if (res.error) {
        const message = `The run record could not be read (${JSON.stringify(res.error)})`
        return errorResult(message, { errors: { runId: message } })
      }
      if (!res.data?.run) return errorResult(`No such run: ${runId}`, { errors: { runId: 'No such run' } })
      record = { run: res.data.run, steps: res.data.steps }
    } finally {
      read.unsubscribe()
    }
    if (record.run.status !== 'running') {
      const message = `Run ${runId} is ${record.run.status}; only a running run can be resumed`
      return errorResult(message, { errors: { runId: message } })
    }
    try {
      await deps.store.dispatch(takeOver({ runId, run: record.run, steps: record.steps }))
    } catch (error) {
      if (error instanceof LeaseTransportError) {
        const message = "Couldn't reach the server — try again"
        return errorResult(message, { errors: { runId: message } })
      }
      throw error
    }
    const slice = deps.store.getState().run
    if (slice.mode !== 'live' || slice.state?.runId !== runId) {
      const message = 'Could not take this run over — it is still held elsewhere'
      return errorResult(message, { errors: { runId: message } })
    }
    deps.navigate(`/${record.run.impl}/${record.run.workflow}/runs/${runId}`)
    const snapshot = currentSnapshot(deps)
    return snapshot
      ? textResult(`Resumed ${snapshotText(snapshot)}`, { runId, snapshot })
      : errorResult(NO_RUN, { errors: { runId: NO_RUN } })
  }

  return {
    'workflow.list': list,
    'workflow.describe': describe,
    'workflow.status': status,
    'workflow.outputs': outputs,
    'workflow.runs': runs,
    'workflow.start': start,
    'workflow.await': awaitRun,
    'workflow.submitStep': submit,
    'workflow.sign': sign,
    'workflow.cancel': cancel,
    'workflow.resume': resume,
  }
}
