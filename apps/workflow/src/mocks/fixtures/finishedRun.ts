/**
 * One completed `hello` run, as the rows a real run would have left behind (05).
 *
 * It is a *record*, not a script: the run page, Past runs and the read-only view
 * all rebuild their state by folding these rows through `replayRun`, so the
 * fixture is only correct if the engine accepts it (see `finishedRun.test.ts`).
 * Shapes therefore follow the write path exactly — `slow/0/start` keeps the BUSY
 * error of the attempt it retried, `flaky/0/boom` has no response because a
 * failed step never writes one, and the form step has no `startedAt` because it
 * went queued → waiting → succeeded.
 */
import { loadWorkflow } from '../../lib/runner/definition'
import type { RunRow, StepRow } from '../../lib/runner/rows'
import type { FileRef } from '../../lib/runner/types'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'

const loaded = loadWorkflow(helloYaml, 'hello.workflow.yaml')
if (!loaded.def) throw new Error('finishedRun fixture: the hello workflow no longer parses')

/** The definition snapshot a run stores is the schema-valid YAML data (D16, R3). */
const definition = loaded.def.raw

export const FIXTURE_RUN_ID = 'run_01hellofixture000000000000'

/** 2026-08-19T12:00:00Z — every stamp below is an offset from it, in ms. */
const T0 = Date.UTC(2026, 7, 19, 12, 0, 0)
const at = (ms: number) => T0 + ms

const RUN_PREFIX = `workflows/hello/hello/runs/${FIXTURE_RUN_ID}`
const SLOW_PREFIX = `${RUN_PREFIX}/slow/0/start`
const POSTER_PATH = `${SLOW_PREFIX}/poster.png`
const JOB_ID = 'job_hello_1'

const LINES = ['Hello, world!', 'Hello, studio!']
const REPORT = `## Hello report\n\n- ${LINES[0]}\n- ${LINES[1]}\n`

const POSTER: FileRef = {
  path: POSTER_PATH,
  name: 'poster.png',
  contentType: 'image/png',
  size: 20_480,
  url: `/api/workflow/files/${POSTER_PATH.replace(/^workflows\//, '')}`,
}

const INPUTS = {
  greeting: 'Hello',
  names: ['world', 'studio'],
  photo: null,
  shout: false,
}

const run: RunRow = {
  runId: FIXTURE_RUN_ID,
  impl: 'hello',
  workflow: 'hello',
  workflowName: 'Hello workflow',
  workflowVersion: '0.0.0',
  definition,
  yaml: helloYaml,
  inputs: INPUTS,
  status: 'succeeded',
  headless: false,
  startedBy: 'user_fixture',
  startedAt: T0,
  finishedAt: at(12_500),
  leaseOwner: null,
  leaseUntil: null,
  outputs: { report: REPORT, poster: POSTER, lines: LINES },
  annotations: [],
}

/** A greeted matrix item: one echo call, its line, and the step's summary. */
function say(index: number, who: string, finishedAt: number): StepRow {
  const line = `Hello, ${who}!`
  return {
    runId: FIXTURE_RUN_ID,
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

  // Attempt 1 answered 503 BUSY and `retry.if` held; attempt 2 enqueued the job,
  // polled it to `done`, registered the poster and evaluated the notice.
  {
    runId: FIXTURE_RUN_ID,
    key: 'slow/0/start',
    job: 'slow',
    index: 0,
    step: 'start',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 2,
    inputs: { path: 'slow', body: { lines: LINES, photo: null, outPrefix: SLOW_PREFIX } },
    response: {
      initial: { jobId: JOB_ID },
      last: { id: JOB_ID, status: 'done', result: { markdown: REPORT, posterPath: POSTER_PATH, ms: 1234 } },
    },
    outputs: { report: REPORT, poster: POSTER },
    error: { code: 'BUSY', message: 'the hello service is busy', status: 503 },
    summary: null,
    annotations: [{ level: 'notice', message: `Job ${JOB_ID} took 1234 ms` }],
    startedAt: at(2_000),
    finishedAt: at(9_000),
    heartbeatAt: null,
  },

  // `continue-on-error`: the job carries on, the run still succeeds.
  {
    runId: FIXTURE_RUN_ID,
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
    runId: FIXTURE_RUN_ID,
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

  // A form step never "runs": it is mounted (`waiting`) and answered.
  {
    runId: FIXTURE_RUN_ID,
    key: 'confirm/0/review',
    job: 'confirm',
    index: 0,
    step: 'review',
    kind: 'form',
    status: 'succeeded',
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
    outputs: { approved: true, report: REPORT },
    error: null,
    summary: null,
    annotations: [],
    startedAt: null,
    finishedAt: at(12_000),
    heartbeatAt: null,
  },
]

export const FINISHED_RUN: { run: RunRow; steps: StepRow[] } = { run, steps }
