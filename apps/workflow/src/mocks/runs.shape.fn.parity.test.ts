/**
 * The list rule's `shape.fn.js` — the `function_handler` that joins each run's
 * waiting step keys onto its record (apps#473). Same `new Function` tooling as
 * `whoami.fn.parity.test.ts`: the authored `.fn.js` cannot be imported, so it
 * is executed from source here and nowhere else.
 *
 * What it has to hold: every run in the page comes back, with `waitingOn`
 * always present (`[]` when nothing waits), only *its own* waiting keys, in a
 * stable order, whichever envelope either query answered in — and the mock
 * list endpoint must answer the very same records, or `RunsPage.test.tsx`
 * would be proving the note against a fiction.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, seedFinishedRun, seedWaitingRun, stepsOf, toRecord } from './db'
import { WAITING_RUN_ID, WAITING_STEP_KEY } from './fixtures/waitingRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'runs',
  'get',
  'shape.fn.js',
)

type Handler = (ctx: { steps: { query: unknown; waiting: unknown } }) => Record<string, unknown>[]

function loadFnHandler(): Handler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const run = (runId: string, extra: Record<string, unknown> = {}) => ({ id: `rec_${runId}`, runId, status: 'running', ...extra })
const step = (runId: string, key: string) => ({ id: `rec_${runId}_${key}`, runId, key, status: 'waiting' })

describe('runs shape.fn.js', () => {
  let handler: Handler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it('joins each run its own waiting keys, sorted, and `[]` to a run waiting on nothing', () => {
    const out = handler({
      steps: {
        query: [run('run_a'), run('run_b'), run('run_c', { status: 'succeeded' })],
        waiting: [step('run_b', 'greet/1/say'), step('run_a', 'confirm/0/review'), step('run_b', 'greet/0/say')],
      },
    })

    expect(out).toEqual([
      { id: 'rec_run_a', runId: 'run_a', status: 'running', waitingOn: ['confirm/0/review'] },
      { id: 'rec_run_b', runId: 'run_b', status: 'running', waitingOn: ['greet/0/say', 'greet/1/say'] },
      { id: 'rec_run_c', runId: 'run_c', status: 'succeeded', waitingOn: [] },
    ])
  })

  // The second query is instance-wide (step rows carry no impl/workflow): a
  // waiting step of a run outside the page must not leak in, and a malformed
  // step row must not throw the whole list.
  it('ignores waiting steps of runs outside the page, and rows without a runId or key', () => {
    const out = handler({
      steps: {
        query: [run('run_a')],
        waiting: [step('run_zzz', 'confirm/0/review'), { id: 'x' }, { runId: 'run_a' }, null, step('run_a', 'k/0/s')],
      },
    })

    expect(out).toEqual([{ id: 'rec_run_a', runId: 'run_a', status: 'running', waitingOn: ['k/0/s'] }])
  })

  it.each([
    ['bare arrays', (rows: unknown[]) => rows],
    ['a `records` envelope', (rows: unknown[]) => ({ records: rows })],
    ['a `data` envelope', (rows: unknown[]) => ({ data: rows })],
    ['a `rows` envelope', (rows: unknown[]) => ({ rows })],
  ])('reads both queries from %s', (_desc, wrap) => {
    const out = handler({
      steps: { query: wrap([run('run_a')]), waiting: wrap([step('run_a', 'confirm/0/review')]) },
    })

    expect(out.map((r) => r.waitingOn)).toEqual([['confirm/0/review']])
  })

  it('answers an empty page as an empty list, whatever the waiting query held', () => {
    expect(handler({ steps: { query: [], waiting: [step('run_a', 'k/0/s')] } })).toEqual([])
    expect(handler({ steps: { query: undefined, waiting: undefined } })).toEqual([])
  })

  // CE has kept a record's columns under `fields` in some versions; the join
  // goes where the columns are, so the client reads it with the rest.
  it('puts the column under `fields` when that is where the record keeps its columns', () => {
    const out = handler({
      steps: {
        query: [{ id: 'rec_1', fields: { runId: 'run_a', status: 'running' } }],
        waiting: [{ id: 'rec_2', fields: { runId: 'run_a', key: 'confirm/0/review', status: 'waiting' } }],
      },
    })

    expect(out).toEqual([
      { id: 'rec_1', fields: { runId: 'run_a', status: 'running', waitingOn: ['confirm/0/review'] } },
    ])
  })

  it('agrees with the mock list endpoint', async () => {
    seedFinishedRun()
    seedWaitingRun()

    const query = [...db.runs.values()].map(toRecord)
    const waiting = [...db.runs.keys()]
      .flatMap(stepsOf)
      .filter((row) => row.status === 'waiting')
      .map(toRecord)
    const expected = handler({ steps: { query, waiting } })
    expect(expected.find((r) => r.runId === WAITING_RUN_ID)?.waitingOn).toEqual([WAITING_STEP_KEY])

    const res = await fetch('/api/workflow/runs?impl=hello&workflow=hello')
    expect(((await res.json()) as { records: unknown[] }).records).toEqual(expected)
  })
})
