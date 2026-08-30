/**
 * One `hello` run still in flight, parked on its form (05, apps#473).
 *
 * The same shape of record as `finishedRun.ts` — rows a real run would have
 * left behind, replayable through the engine (see `waitingRun.test.ts`) — but
 * caught at the moment every job before `confirm` is done and the `review`
 * form is mounted, waiting for a person who is not there. An interactive run
 * waits indefinitely (07), so this is what a run abandoned mid-form looks like
 * on Past runs: `running`, no `finishedAt`, and a `waiting` step row — which
 * is what the list joins onto the run row as `waitingOn`.
 *
 * Its lease is released: the tab that started it has gone, which is the usual
 * way a run ends up parked here.
 */
import { loadWorkflow } from '../../lib/runner/definition'
import type { RunRow, StepRow } from '../../lib/runner/rows'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'

const loaded = loadWorkflow(helloYaml, 'hello.workflow.yaml')
if (!loaded.def) throw new Error('waitingRun fixture: the hello workflow no longer parses')

const definition = loaded.def.raw

export const WAITING_RUN_ID = 'run_01hellowaiting000000000000'

/** The step the run is parked on: the `review` form of the `confirm` job. */
export const WAITING_STEP_KEY = 'confirm/0/review'

/** 2026-08-20T09:00:00Z — every stamp below is an offset from it, in ms. */
const T0 = Date.UTC(2026, 7, 20, 9, 0, 0)
const at = (ms: number) => T0 + ms

const RUN_PREFIX = `workflows/hello/hello/runs/${WAITING_RUN_ID}`
const SLOW_PREFIX = `${RUN_PREFIX}/slow/0/start`
const JOB_ID = 'job_hello_2'

const LINES = ['Hello, world!', 'Hello, studio!']
const REPORT = `## Hello report\n\n- ${LINES[0]}\n- ${LINES[1]}\n`

const INPUTS = {
  greeting: 'Hello',
  names: ['world', 'studio'],
  photo: null,
  shout: false,
}

const run: RunRow = {
  runId: WAITING_RUN_ID,
  impl: 'hello',
  workflow: 'hello',
  workflowName: 'Hello workflow',
  workflowVersion: '0.0.0',
  definition,
  yaml: helloYaml,
  inputs: INPUTS,
  status: 'running',
  headless: false,
  startedBy: 'user_fixture',
  startedAt: T0,
  finishedAt: null,
  leaseOwner: null,
  leaseUntil: null,
  // Run outputs and the annotations rollup are written at `run.finished`,
  // which has not happened.
  outputs: null,
  annotations: [],
}

function say(index: number, who: string, finishedAt: number): StepRow {
  const line = `Hello, ${who}!`
  return {
    runId: WAITING_RUN_ID,
    key: `greet/${index}/say`,
    job: 'greet',
    index,
    step: 'say',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'echo', body: { text: line, upper: false } },
    response: { initial: { text: line } },
    outputs: { line },
    error: null,
    summary: `Said **${line}**`,
    annotations: [],
    startedAt: at(1_000),
    finishedAt,
    heartbeatAt: null,
  }
}

const steps: StepRow[] = [
  say(0, 'world', at(1_500)),
  say(1, 'studio', at(1_600)),

  {
    runId: WAITING_RUN_ID,
    key: 'slow/0/start',
    job: 'slow',
    index: 0,
    step: 'start',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'slow', body: { lines: LINES, photo: null, outPrefix: SLOW_PREFIX } },
    response: {
      initial: { jobId: JOB_ID },
      last: { id: JOB_ID, status: 'done', result: { markdown: REPORT, posterPath: null, ms: 987 } },
    },
    outputs: { report: REPORT, poster: null },
    error: null,
    summary: null,
    annotations: [{ level: 'notice', message: `Job ${JOB_ID} took 987 ms` }],
    startedAt: at(2_000),
    finishedAt: at(8_000),
    heartbeatAt: null,
  },

  // `continue-on-error`: the job carries on.
  {
    runId: WAITING_RUN_ID,
    key: 'flaky/0/boom',
    job: 'flaky',
    index: 0,
    step: 'boom',
    kind: 'pipeline',
    status: 'failed',
    attempt: 1,
    inputs: { path: 'fail', body: { code: 'TEAPOT' } },
    response: null,
    outputs: null,
    error: { code: 'TEAPOT', message: 'fails on purpose', status: 418 },
    summary: null,
    annotations: [],
    startedAt: at(2_000),
    finishedAt: at(2_500),
    heartbeatAt: null,
  },

  {
    runId: WAITING_RUN_ID,
    key: 'flaky/0/after',
    job: 'flaky',
    index: 0,
    step: 'after',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'echo', body: { text: 'boom failed with TEAPOT' } },
    response: { initial: { text: 'boom failed with TEAPOT' } },
    outputs: { note: 'boom failed with TEAPOT' },
    error: null,
    summary: null,
    annotations: [{ level: 'warning', message: 'boom failed with TEAPOT' }],
    startedAt: at(3_000),
    finishedAt: at(3_400),
    heartbeatAt: null,
  },

  // The form is mounted and nobody has answered it. `step.waiting` stamps a
  // `startedAt` (the wait clock's origin, Task 9) and the evaluated `with` as
  // `inputs`; there is no `finishedAt` and no `outputs` yet.
  {
    runId: WAITING_RUN_ID,
    key: WAITING_STEP_KEY,
    job: 'confirm',
    index: 0,
    step: 'review',
    kind: 'form',
    status: 'waiting',
    attempt: 1,
    inputs: {
      title: 'Does the report look right?',
      fields: {
        approved: { type: 'boolean', default: true, required: true },
        report: { type: 'markdown', default: REPORT },
      },
      submit: 'Finish',
    },
    response: null,
    outputs: null,
    error: null,
    summary: null,
    annotations: [],
    startedAt: at(8_100),
    finishedAt: null,
    heartbeatAt: null,
  },
]

export const WAITING_RUN: { run: RunRow; steps: StepRow[] } = { run, steps }
