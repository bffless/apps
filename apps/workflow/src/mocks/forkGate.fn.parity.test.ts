/**
 * Parity between the run-fork rule's `gate.fn.js` (the real `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/run/fork/post/`
 * — cannot import) and the mock's re-implementation in `forkGate.ts`, reached
 * through the `/api/workflow/run/fork` handler. `new Function` is test-only
 * tooling to execute the authored `.fn.js` source in isolation; it is never used
 * by the app or the mock at runtime. Same shape as `deleteGate.fn.parity.test.ts`.
 *
 * `gate.fn.js` is no longer the whole of a fork (spec 11 D26 moved ownership
 * to the shared `runGate` ahead of it — proven in `runGate.fn.parity.test.ts`)
 * — it decides only which rows come along and whether the sent definition can
 * still address them. Two tables drive the two halves that were once one:
 * `FN_CASES` exercises `gate.fn.js` directly (badRequest, the job-not-found
 * case, every conflict, and — since ownership is no longer this function's
 * business — a caller who never started the run succeeding all the same),
 * `MOCK_CASES` exercises the composed `/api/workflow/run/fork` endpoint,
 * where `mockGate` (D26) is back in the picture ahead of `forkGate`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import { MOCK_ADMIN, MOCK_MEMBER, MOCK_OTHER, db, seedFinishedRun, setMockUser, stepRowKey, stepsOf, type MockUser } from './db'
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
  createRun: boolean
  runId: string
  run: Record<string, unknown> | null
  rows: Record<string, unknown>[]
  result?: { ok: boolean; error?: string }
}

type GateHandler = (ctx: {
  steps: { run: unknown; rows: unknown; existing: unknown }
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
const OWNER_EMAIL = FINISHED_RUN.run.startedByEmail!
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
 * What `gate.fn.js` still decides, called directly — badRequest, the
 * job-not-found case, every conflict, and the defensive `!run` branch (`run`
 * only runs when `runGate` is `ok`, so this is unreachable in production, the
 * same shape as `run/delete/post/gate.fn.js`'s `!row`). The caller's identity
 * is irrelevant to every case here now: ownership is the shared gate's
 * answer, proven separately in `runGate.fn.parity.test.ts`.
 */
const FN_CASES: {
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
  {
    desc: 'an unknown run — defensive: `gate` only runs once `runGate` is ok',
    parent: () => null,
    user: { id: OWNER, role: 'user' },
    status: 404,
    error: 'run not found',
  },
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
  { desc: 'the owner', user: { id: OWNER, email: OWNER_EMAIL, role: 'user' }, status: 200 },
  {
    desc: 'a caller who did not start it — ownership is the shared gate’s job now',
    user: { id: 'someone_else', role: 'user' },
    status: 200,
  },
  {
    desc: 'an id-less caller against a row with no startedBy — also passes through now',
    parent: (row) => {
      const { startedBy: _startedBy, ...rest } = row
      void _startedBy
      return rest
    },
    user: undefined,
    status: 200,
  },
  {
    desc: 'a retry: the row the first call made already wears the id',
    existing: { ...ROW, _id: 'rec_99', runId: NEW_ID, forkedFrom: RUN_ID, forkJob: 'slow' },
    user: { id: OWNER, role: 'user' },
    status: 200,
  },
]

describe('run-fork gate.fn.js parity with the mock re-implementation', () => {
  let handler: GateHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(FN_CASES)('gate.fn.js: $desc', ({ parent, steps, existing, body, user, status, error }) => {
    const row = parent ? parent(ROW) : ROW
    const rows = steps ? steps(ROWS) : ROWS
    const result = handler({
      steps: {
        run: row ? [toRecord(row)] : [],
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

    // `startedBy`/`startedByEmail` are the CALLER'S — `caller.id || null` /
    // `caller.email || null` (gate.fn.js) — never the parent's, and never
    // omitted: an id-less caller (the case above) still gets an explicit
    // `null`, not an absent key.
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
      startedBy: user?.id || null,
      startedByEmail: user?.email || null,
      leaseOwner: TAB,
      forkedFrom: RUN_ID,
      forkJob: 'slow',
    })
    expect(result.run!.leaseUntil).toBe((result.run!.startedAt as number) + 60_000)
  })

  /**
   * The composed `/api/workflow/run/fork` endpoint: `mockGate` decides
   * reachability first (spec 11 D26), same as the real rule's `runGate` step
   * ahead of `gate.fn.js`; only then does `forkGate`'s own business get a
   * look-in. The former 403 row (a non-owner) is 404 here — indistinguishable
   * from an unknown id (D26) — and an admin now needs BOTH `projectRole`
   * `owner`/`admin` AND to have asked (`x-workflow-scope: all`, D27): asking
   * is never assumed, even from the role that could ask.
   *
   * `forkGate.ts`'s own refusals (badRequest, the retry conflict, an
   * unfinished adopted row, a definition that no longer addresses one) are
   * caller-agnostic now — ownership moved out of that function entirely — but
   * still need a row here: they are the composed endpoint's behavior too, and
   * `forkGate.ts`'s literal error strings (`:89-93,103,110-111`) have no other
   * coverage that runs them against the real `gate.fn.js`'s matching strings.
   */
  const MOCK_CASES: {
    desc: string
    parent?: (row: ServerRunRow) => ServerRunRow | null
    steps?: (rows: ServerStepRow[]) => ServerStepRow[]
    existing?: ServerRunRow
    body?: Partial<typeof BODY>
    user: MockUser
    headers?: Record<string, string>
    status: number
    error?: string
  }[] = [
    { desc: 'an unknown run', parent: () => null, user: MOCK_MEMBER, status: 404, error: 'run not found' },
    { desc: 'a member who did not start it', user: MOCK_OTHER, status: 404, error: 'run not found' },
    {
      desc: 'the owner: an id that is not a run id (it is rendered into the 200 template)',
      body: { id: 'run_"x' },
      user: MOCK_MEMBER,
      status: 400,
      error: 'id must be a run id',
    },
    {
      desc: 'an id-less caller against a row with no startedBy',
      parent: (row) => {
        const { startedBy: _startedBy, ...rest } = row
        void _startedBy
        return rest
      },
      user: { ...MOCK_OTHER, id: '' },
      status: 404,
      error: 'run not found',
    },
    {
      desc: 'a project admin who did not ask for all-scope',
      user: MOCK_ADMIN,
      status: 404,
      error: 'run not found',
    },
    {
      desc: 'a project admin who asked (x-workflow-scope: all)',
      user: MOCK_ADMIN,
      headers: { 'x-workflow-scope': 'all' },
      status: 200,
    },
    { desc: 'the owner', user: MOCK_MEMBER, status: 200 },
    {
      desc: 'the owner: a job neither definition has',
      body: { job: 'nope' },
      user: MOCK_MEMBER,
      status: 404,
      error: 'job not found: nope',
    },
    {
      desc: 'the owner: a run that is still running',
      parent: (row) => ({ ...row, status: 'running' }),
      user: MOCK_MEMBER,
      status: 409,
      error: 'cancel the run first',
    },
    {
      desc: 'the owner: an id some other run already wears',
      existing: { ...ROW, _id: 'rec_99', runId: NEW_ID, forkedFrom: 'run_other', forkJob: 'slow' },
      user: MOCK_MEMBER,
      status: 409,
      error: 'run id already in use',
    },
    {
      desc: 'the owner: an adopted row that has not finished',
      steps: (rows) => rows.map((row) => (row.key === 'greet/1/say' ? { ...row, status: 'queued' } : row)),
      user: MOCK_MEMBER,
      status: 409,
      error: 'step greet/1/say has not finished',
    },
    {
      desc: "the owner: the sent definition renaming `greet.say`'s output `line`",
      body: { definition: withLineRenamed() },
      user: MOCK_MEMBER,
      status: 409,
      error: 'definition changed: greet/0/say',
    },
    {
      desc: 'the owner: the sent definition dropping the `greet` job',
      body: { definition: withoutGreet() },
      user: MOCK_MEMBER,
      status: 409,
      error: 'definition changed: greet/0/say',
    },
    {
      desc: 'the owner: a retry, the row the first call made already wears the id',
      existing: { ...ROW, _id: 'rec_99', runId: NEW_ID, forkedFrom: RUN_ID, forkJob: 'slow' },
      user: MOCK_MEMBER,
      status: 200,
    },
  ]

  describe('against the mock endpoint', () => {
    beforeEach(() => {
      seedFinishedRun()
    })

    it.each(MOCK_CASES)(
      'mock /api/workflow/run/fork: $desc',
      async ({ parent, steps, existing, body, user, headers, status, error }) => {
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
        setMockUser(user)

        const res = await fetch('/api/workflow/run/fork', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
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
            startedBy: user.id,
            startedByEmail: user.email,
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
