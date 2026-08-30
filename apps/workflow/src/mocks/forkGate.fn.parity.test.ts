/**
 * Parity between the run-fork rule's `gate.fn.js` (the real `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/run/fork/post/`
 * — cannot import) and the mock's re-implementation in `forkGate.ts`, reached
 * through the `/api/workflow/run/fork` handler. `new Function` is test-only
 * tooling to execute the authored `.fn.js` source in isolation; it is never used
 * by the app or the mock at runtime. Same shape as `deleteGate.fn.parity.test.ts`.
 *
 * The gate is the whole of a fork: who may, which rows come along, and whether
 * the definition the client sends can still address them. One case table drives
 * both sides — the raw `handler()` call against `gate.fn.js`, and a real request
 * to the mock — over the finished hello run forked at `slow` (apps#501, #491).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import { MOCK_ADMIN, MOCK_MEMBER, db, seedFinishedRun, setMockUser, stepRowKey, stepsOf } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'run',
  'fork',
  'post',
  'gate.fn.js',
)

interface GateResult {
  ok: boolean
  badRequest: boolean
  notFound: boolean
  conflict: boolean
  forbidden: boolean
  createRun: boolean
  runId: string
  run: Record<string, unknown> | null
  rows: Record<string, unknown>[]
  result?: { ok: boolean; error?: string }
}

type GateHandler = (ctx: {
  steps: { parent: unknown; rows: unknown; existing: unknown }
  request: { body: Record<string, unknown> }
  user?: { id?: string; email?: string; role?: string }
}) => GateResult

function loadFnHandler(): GateHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const RUN_ID = FINISHED_RUN.run.runId
const OWNER = FINISHED_RUN.run.startedBy!
const NEW_ID = 'run_01forkfixture00000000000000'
const TAB = 'tab_fork'

/** The parent `workflow_runs` row, as `data_query` hands it: a bare array of flat records. */
const ROW: ServerRunRow = { ...FINISHED_RUN.run, _id: 'rec_1' }
const ROWS: ServerStepRow[] = FINISHED_RUN.steps.map((step, i) => ({ ...step, _id: `rec_${i + 2}` }))

/** hello: `greet` → `slow` / `flaky` → `confirm`. Forked at `slow`, these are what comes along. */
const ADOPTED = ['flaky/0/after', 'flaky/0/boom', 'greet/0/say', 'greet/1/say']

type Definition = Record<string, unknown> & { jobs: Record<string, Record<string, unknown>> }
const definition = FINISHED_RUN.run.definition as Definition

/** The sent definition with `greet.say`'s one declared output, `line`, renamed. */
function withLineRenamed(): Definition {
  const jobs = structuredClone(definition.jobs)
  const say = (jobs.greet.steps as Record<string, unknown>[])[0]
  say.outputs = { text: (say.outputs as Record<string, unknown>).line }
  return { ...definition, jobs }
}

/** The sent definition with `greet` gone altogether. */
function withoutGreet(): Definition {
  const { greet: _greet, ...jobs } = definition.jobs
  void _greet
  return { ...definition, jobs }
}

const BODY = {
  id: NEW_ID,
  from: RUN_ID,
  job: 'slow',
  definition,
  yaml: FINISHED_RUN.run.yaml,
  workflowVersion: '0.0.1',
  owner: TAB,
  unattended: false,
}

/** As the record, as `data_query` would: `id`, then the columns. */
const toRecord = <T extends { _id?: string }>(row: T) => {
  const { _id, ...fields } = row
  return { id: _id, ...fields }
}

/**
 * The refusal matrix, and the status each flag's own `response_handler` answers.
 * Each case transforms the seeded parent/steps/existing the same way for both
 * sides, so a case is one fact about the gate, not two hand-kept fixtures.
 */
const CASES: {
  desc: string
  parent?: (row: ServerRunRow) => ServerRunRow | null
  steps?: (rows: ServerStepRow[]) => ServerStepRow[]
  existing?: ServerRunRow
  body?: Partial<typeof BODY>
  user: { id?: string; email?: string; role?: string } | undefined
  status: number
  error?: string
}[] = [
  {
    desc: 'an id that is not a run id (it is rendered into the 200 template)',
    body: { id: 'run_"x' },
    user: { id: OWNER, role: 'user' },
    status: 400,
    error: 'id must be a run id',
  },
  { desc: 'an unknown run', parent: () => null, user: { id: OWNER, role: 'user' }, status: 404, error: 'run not found' },
  {
    desc: 'a job neither definition has',
    body: { job: 'nope' },
    user: { id: OWNER, role: 'user' },
    status: 404,
    error: 'job not found: nope',
  },
  {
    desc: 'a run that is still running',
    parent: (row) => ({ ...row, status: 'running' }),
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'cancel the run first',
  },
  {
    desc: 'a member who did not start it',
    user: { id: 'someone_else', role: 'user' },
    status: 403,
    error: 'only the run owner or an admin can fork a run',
  },
  {
    desc: 'an id-less caller against a row with no startedBy',
    parent: (row) => {
      const { startedBy: _startedBy, ...rest } = row
      void _startedBy
      return rest
    },
    user: undefined,
    status: 403,
    error: 'only the run owner or an admin can fork a run',
  },
  {
    desc: 'an id some other run already wears',
    existing: { ...ROW, _id: 'rec_99', runId: NEW_ID, forkedFrom: 'run_other', forkJob: 'slow' },
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'run id already in use',
  },
  {
    desc: 'an adopted row that has not finished',
    steps: (rows) => rows.map((row) => (row.key === 'greet/1/say' ? { ...row, status: 'queued' } : row)),
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'step greet/1/say has not finished',
  },
  {
    desc: "the sent definition renaming `greet.say`'s output `line`",
    body: { definition: withLineRenamed() },
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'definition changed: greet/0/say',
  },
  {
    desc: 'the sent definition dropping the `greet` job',
    body: { definition: withoutGreet() },
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'definition changed: greet/0/say',
  },
  { desc: 'the owner', user: { id: OWNER, role: 'user' }, status: 200 },
  { desc: 'an admin who did not start it', user: { id: 'user_admin', role: 'admin' }, status: 200 },
  {
    desc: 'a retry: the row the first call made already wears the id',
    existing: { ...ROW, _id: 'rec_99', runId: NEW_ID, forkedFrom: RUN_ID, forkJob: 'slow' },
    user: { id: OWNER, role: 'user' },
    status: 200,
  },
  // Global roles are `admin | user | member` (ce `users.dto.ts`), so `owner` is
  // never a role CE hands a pipeline — the allow-list entry is inert, and kept
  // for parity with the delete gate. Asserted against the fn only: the mock has
  // no way to produce a role CE does not issue.
  { desc: 'the inert `owner` role in the allow-list', user: { id: 'x', role: 'owner' }, status: 200 },
]

describe('run-fork gate.fn.js parity with the mock re-implementation', () => {
  let handler: GateHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(CASES)('gate.fn.js: $desc', ({ parent, steps, existing, body, user, status, error }) => {
    const row = parent ? parent(ROW) : ROW
    const rows = steps ? steps(ROWS) : ROWS
    const result = handler({
      steps: {
        parent: row ? [toRecord(row)] : [],
        rows: rows.map(toRecord),
        existing: existing ? [toRecord(existing)] : [],
      },
      request: { body: { ...BODY, ...body } },
      user,
    })

    expect(result.ok).toBe(status === 200)
    expect(result.badRequest).toBe(status === 400)
    expect(result.notFound).toBe(status === 404)
    expect(result.conflict).toBe(status === 409)
    expect(result.forbidden).toBe(status === 403)
    if (status !== 200) {
      expect(result.result).toEqual({ ok: false, error })
      expect(result.createRun).toBe(false)
      expect(result.run).toBeNull()
      expect(result.rows).toEqual([])
      return
    }

    // The dead `result` the success path never carries (nothing renders it).
    expect(result.result).toBeUndefined()
    expect(result.runId).toBe(NEW_ID)
    expect(result.createRun).toBe(existing === undefined)

    // Exactly the rows outside `slow`'s downstream closure, re-pointed at the new
    // run, deduped on `<runId>/<key>`, without the parent's record id — and with
    // the parent's `outputs` byte for byte (a `failed` row under continue-on-error
    // included: the rule does not re-derive outcomes).
    expect(result.rows.map((r) => r.key).sort()).toEqual(ADOPTED)
    for (const copy of result.rows) {
      const source = ROWS.find((r) => r.key === copy.key)!
      expect(copy.runId).toBe(NEW_ID)
      expect(copy.rowKey).toBe(`${NEW_ID}/${copy.key}`)
      expect(copy.id).toBeUndefined()
      expect(copy.outputs).toEqual(source.outputs)
      expect(copy.status).toBe(source.status)
    }

    expect(result.run).toMatchObject({
      runId: NEW_ID,
      impl: 'hello',
      workflow: 'hello',
      workflowName: ROW.workflowName,
      workflowVersion: '0.0.1',
      inputs: ROW.inputs,
      status: 'running',
      headless: false,
      unattended: false,
      startedBy: user!.id,
      leaseOwner: TAB,
      forkedFrom: RUN_ID,
      forkJob: 'slow',
    })
    expect(result.run!.leaseUntil).toBe((result.run!.startedAt as number) + 60_000)
  })

  describe('against the mock endpoint', () => {
    beforeEach(() => {
      seedFinishedRun()
    })

    it.each(CASES.filter((c) => c.user?.role !== 'owner'))(
      'mock /api/workflow/run/fork: $desc',
      async ({ parent, steps, existing, body, user, status, error }) => {
        if (parent) {
          const row = parent(db.runs.get(RUN_ID)!)
          if (row) db.runs.set(RUN_ID, row)
          else db.runs.delete(RUN_ID)
        }
        if (steps) {
          const rows = steps(stepsOf(RUN_ID))
          for (const row of stepsOf(RUN_ID)) db.steps.delete(stepRowKey(RUN_ID, row.key))
          for (const row of rows) db.steps.set(stepRowKey(RUN_ID, row.key), row)
        }
        if (existing) db.runs.set(NEW_ID, existing)
        setMockUser(
          user?.role === 'admin'
            ? MOCK_ADMIN
            : { ...MOCK_MEMBER, id: user?.id ?? '', role: user?.role ?? 'user' },
        )

        const res = await fetch('/api/workflow/run/fork', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...BODY, ...body }),
        })

        expect(res.status).toBe(status)
        expect(res.headers.get('cache-control')).toBe('no-store')
        if (status !== 200) {
          expect((await res.json()).error).toBe(error)
          // A refusal writes nothing: no run row under the new id (unless the
          // case seeded one), no step rows.
          expect(db.runs.has(NEW_ID)).toBe(existing !== undefined)
          expect(stepsOf(NEW_ID)).toEqual([])
          return
        }

        expect(await res.json()).toEqual({ ok: true, runId: NEW_ID, copied: ADOPTED.length })

        if (existing) {
          // A retry never rewrites the run row the first call made: `create` is
          // skipped, and nothing else touches `workflow_runs`.
          expect(db.runs.get(NEW_ID)).toBe(existing)
        } else {
          expect(db.runs.get(NEW_ID)).toMatchObject({
            impl: 'hello',
            workflow: 'hello',
            workflowVersion: '0.0.1',
            status: 'running',
            headless: false,
            startedBy: user!.id,
            leaseOwner: TAB,
            forkedFrom: RUN_ID,
            forkJob: 'slow',
          })
        }
        // The parent is untouched — the fork is a new run (#491 decision 1).
        expect(db.runs.get(RUN_ID)!.status).toBe('succeeded')
        expect(stepsOf(RUN_ID)).toHaveLength(FINISHED_RUN.steps.length)

        const copies = stepsOf(NEW_ID)
        expect(copies.map((r) => r.key).sort()).toEqual(ADOPTED)
        for (const copy of copies) {
          const source = FINISHED_RUN.steps.find((r) => r.key === copy.key)!
          expect(copy.outputs).toEqual(source.outputs)
          expect(copy.status).toBe(source.status)
          expect(copy._id).not.toBe(db.steps.get(stepRowKey(RUN_ID, copy.key))!._id)
        }
      },
    )
  })
})
