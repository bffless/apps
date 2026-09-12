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
import { db, MOCK_MEMBER, seedFinishedRun, seedWaitingRun, stepsOf, toRecord, toRunRecord } from './db'
import { WAITING_RUN_ID, WAITING_STEP_KEY } from './fixtures/waitingRun'
import { toRunsPageRow } from '../lib/coerce'

/** A run that was dispatched and has not been picked up — a claim, no run row (apps#671). */
const QUEUED_RUN_ID = 'run_queued'

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

type Handler = (ctx: {
  steps: { mine: unknown; waiting: unknown; queuedMine?: unknown; queuedAll?: unknown }
}) => Record<string, unknown>[]

function loadFnHandler(): Handler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const run = (runId: string, extra: Record<string, unknown> = {}) => ({ id: `rec_${runId}`, runId, status: 'running', ...extra })
const step = (runId: string, key: string) => ({ id: `rec_${runId}_${key}`, runId, key, status: 'waiting' })
/** A `workflow_run_claims` row as stored — nonce included, which is the point of half these assertions. */
const claim = (runId: string, extra: Record<string, unknown> = {}) => ({
  id: `rec_claim_${runId}`,
  runId,
  impl: 'hello',
  workflow: 'hello',
  startedBy: 'user_1',
  startedByEmail: 'member@example.com',
  driveKey: 'nonce-abc',
  createdAt: 1_700_000_000_000,
  ...extra,
})

describe('runs shape.fn.js', () => {
  let handler: Handler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it('joins each run its own waiting keys, sorted, and `[]` to a run waiting on nothing', () => {
    const out = handler({
      steps: {
        mine: [run('run_a'), run('run_b'), run('run_c', { status: 'succeeded' })],
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
        mine: [run('run_a')],
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
      steps: { mine: wrap([run('run_a')]), waiting: wrap([step('run_a', 'confirm/0/review')]) },
    })

    expect(out.map((r) => r.waitingOn)).toEqual([['confirm/0/review']])
  })

  it('answers an empty page as an empty list, whatever the waiting query held', () => {
    expect(handler({ steps: { mine: [], waiting: [step('run_a', 'k/0/s')] } })).toEqual([])
    expect(handler({ steps: { mine: undefined, waiting: undefined } })).toEqual([])
  })

  // CE has kept a record's columns under `fields` in some versions; the join
  // goes where the columns are, so the client reads it with the rest.
  it('puts the column under `fields` when that is where the record keeps its columns', () => {
    const out = handler({
      steps: {
        mine: [{ id: 'rec_1', fields: { runId: 'run_a', status: 'running' } }],
        waiting: [{ id: 'rec_2', fields: { runId: 'run_a', key: 'confirm/0/review', status: 'waiting' } }],
      },
    })

    expect(out).toEqual([
      { id: 'rec_1', fields: { runId: 'run_a', status: 'running', waitingOn: ['confirm/0/review'] } },
    ])
  })

  /**
   * The dispatched runs nobody has picked up yet (apps#671). A claim is written
   * before the dispatch and deleted on redemption, so one still standing is a
   * run with no `workflow_runs` row — the window Past runs was blind to.
   */
  describe('the queued half (apps#671)', () => {
    it('stands an unconsumed claim up as a queued entry, from an allow-list', () => {
      const out = handler({ steps: { mine: [], waiting: [], queuedMine: [claim('run_q')] } })

      expect(out).toEqual([
        {
          runId: 'run_q',
          impl: 'hello',
          workflow: 'hello',
          status: 'queued',
          startedAt: 1_700_000_000_000,
          startedBy: 'user_1',
          startedByEmail: 'member@example.com',
          waitingOn: [],
        },
      ])
      // Never spread: the claim row's own nonce (spec 11 D28), and its record
      // id, are not part of the entry it stands for.
      expect(out[0]).not.toHaveProperty('driveKey')
      expect(out[0]).not.toHaveProperty('id')
      expect(JSON.stringify(out)).not.toContain('nonce-abc')
    })

    it('reads the claims from whichever scoped query ran, under any envelope', () => {
      const mineOnly = handler({ steps: { mine: [], waiting: [], queuedMine: { records: [claim('run_q')] } } })
      const allOnly = handler({ steps: { mine: [], waiting: [], queuedAll: { rows: [claim('run_q')] } } })

      expect(mineOnly.map((row) => row.runId)).toEqual(['run_q'])
      expect(allOnly).toEqual(mineOnly)
      // Neither query ran (an older rule set, or a 403 page): the runs still list.
      expect(handler({ steps: { mine: [run('run_a')], waiting: [] } })).toEqual([
        { id: 'rec_run_a', runId: 'run_a', status: 'running', waitingOn: [] },
      ])
    })

    it('drops a claim whose run is already in the page, and keeps one entry per runId', () => {
      const out = handler({
        steps: {
          mine: [run('run_a')],
          waiting: [],
          // `run_a`'s claim is spent but still in its own snapshot; `run_q` was
          // claimed twice (a dispatch that failed and was retried).
          queuedMine: [claim('run_a'), claim('run_q'), claim('run_q', { createdAt: 1_700_000_009_000 })],
        },
      })

      expect(out.map((row) => row.runId)).toEqual(['run_a', 'run_q'])
      expect(out.map((row) => row.status)).toEqual(['running', 'queued'])
    })

    // The rule normalises nothing it does not have to: a run row's `startedAt`
    // travels as stored and is coerced client-side, and a claim's `createdAt`
    // is treated the same way — collapsing a numeric string to `0` here would
    // render 1970 and sort the newest entry to the bottom.
    it('passes `createdAt` through as stored, for the client to coerce', () => {
      const out = handler({
        steps: { mine: [], waiting: [], queuedMine: [claim('run_q', { createdAt: '1700000000000' })] },
      })

      expect(out[0].startedAt).toBe('1700000000000')
      expect(toRunsPageRow(out[0]).startedAt).toBe(1_700_000_000_000)
    })

    it('skips a claim row with no runId rather than putting a nameless entry in the page', () => {
      const out = handler({
        steps: { mine: [], waiting: [], queuedMine: [{ id: 'rec_x' }, null, claim('run_q')] },
      })

      expect(out.map((row) => row.runId)).toEqual(['run_q'])
    })

    it('reads a claim kept under `fields`, like the run rows', () => {
      const { id: _id, ...fields } = claim('run_q')
      void _id
      const out = handler({ steps: { mine: [], waiting: [], queuedMine: [{ id: 'rec_1', fields }] } })

      expect(out).toEqual([
        {
          runId: 'run_q',
          impl: 'hello',
          workflow: 'hello',
          status: 'queued',
          startedAt: 1_700_000_000_000,
          startedBy: 'user_1',
          startedByEmail: 'member@example.com',
          waitingOn: [],
        },
      ])
    })

    it('agrees with the mock list endpoint, claims and all', async () => {
      seedFinishedRun()
      db.claims.set(QUEUED_RUN_ID, {
        runId: QUEUED_RUN_ID,
        impl: 'hello',
        workflow: 'hello',
        startedBy: MOCK_MEMBER.id,
        startedByEmail: MOCK_MEMBER.email,
        driveKey: 'nonce-abc',
        createdAt: 1_700_000_000_000,
      })

      const mine = [...db.runs.values()].map(toRunRecord)
      const queuedMine = [...db.claims.values()].map((row) => ({ ...row }))
      const expected = handler({ steps: { mine, waiting: [], queuedMine } })
      expect(expected.find((row) => row.runId === QUEUED_RUN_ID)?.status).toBe('queued')

      const res = await fetch('/api/workflow/runs?impl=hello&workflow=hello')
      const text = await res.clone().text()
      expect(((await res.json()) as { records: unknown[] }).records).toEqual(expected)
      expect(text).not.toContain('driveKey')
      expect(text).not.toContain('nonce-abc')
    })
  })

  it('agrees with the mock list endpoint', async () => {
    seedFinishedRun()
    seedWaitingRun()

    const mine = [...db.runs.values()].map(toRunRecord)
    const waiting = [...db.runs.keys()]
      .flatMap(stepsOf)
      .filter((row) => row.status === 'waiting')
      .map(toRecord)
    const expected = handler({ steps: { mine, waiting } })
    expect(expected.find((r) => r.runId === WAITING_RUN_ID)?.waitingOn).toEqual([WAITING_STEP_KEY])

    // No `?scope=all`: both fixtures are owned by the default mock user (Decision 12),
    // so `mine` already includes everything this endpoint seeds.
    const res = await fetch('/api/workflow/runs?impl=hello&workflow=hello')
    expect(((await res.json()) as { records: unknown[] }).records).toEqual(expected)
  })

  // The driver's nonce (spec 11 D28) must never leave the harness in a
  // response body: it travels only in `client_payload.drive_key` and the
  // `x-workflow-drive-key` request header. The fn side strips it whichever
  // shape carries it; the mock endpoint must answer the same.
  it('never puts driveKey on the wire, fn side or mock endpoint', () => {
    expect(handler({ steps: { mine: [run('run_a', { driveKey: 'nonce-abc' })], waiting: [] } })).toEqual([
      { id: 'rec_run_a', runId: 'run_a', status: 'running', waitingOn: [] },
    ])
    const nested = handler({
      steps: {
        mine: [{ id: 'rec_1', fields: { runId: 'run_a', status: 'running', driveKey: 'nonce-abc' } }],
        waiting: [],
      },
    })
    expect(nested).toEqual([{ id: 'rec_1', fields: { runId: 'run_a', status: 'running', waitingOn: [] } }])
  })

  it('never puts driveKey on the wire from the mock list endpoint', async () => {
    seedWaitingRun()
    db.runs.set(WAITING_RUN_ID, { ...db.runs.get(WAITING_RUN_ID)!, driveKey: 'nonce-abc' })

    const res = await fetch('/api/workflow/runs?impl=hello&workflow=hello')
    const text = await res.clone().text()
    expect(text).not.toContain('driveKey')
    expect(text).not.toContain('nonce-abc')
    const record = ((await res.json()) as { records: Array<Record<string, unknown>> }).records.find((r) => r.runId === WAITING_RUN_ID)
    expect(record).not.toHaveProperty('driveKey')
  })
})
