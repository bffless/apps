/**
 * Parity between the run-delete rule's `gate.fn.js` (the real `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/run/delete/post/`
 * — cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/run/delete` handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the app
 * or the mock at runtime. Same shape as `confine.fn.parity.test.ts`.
 *
 * The gate is no longer the WHOLE access decision (spec 11 D26 moved
 * ownership to the shared `runGate` ahead of it — proven in
 * `runGate.fn.parity.test.ts`) — it decides only whether a run this caller can
 * ALREADY reach may be deleted right now: terminal, and where its bytes live.
 * Two tables drive the two halves that were once one: `FN_CASES` exercises
 * `gate.fn.js` directly, over what it still decides — `notFound` (defensive:
 * `gate` only runs once `runGate` is `ok`, so this is unreachable in
 * production), `running`, and success, whatever the caller — and `MOCK_CASES`
 * exercises the composed `/api/workflow/run/delete` endpoint, where
 * ownership (via `mockGate`) is back in the picture. Plus the assertion the
 * two counts in the 200 exist to support: that the pattern the gate builds is
 * the pattern that selects this run's `workflow_files` rows and no others
 * (apps#381).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MOCK_ADMIN,
  MOCK_MEMBER,
  MOCK_OTHER,
  MOCK_UPLOADS_ROOT,
  db,
  fileRecordsMatching,
  seedFinishedRun,
  seedObject,
  setMockUser,
  type MockUser,
} from './db'
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
  'delete',
  'post',
  'gate.fn.js',
)

interface GateResult {
  ok: boolean
  notFound: boolean
  running: boolean
  recordId: string | null
  prefix: string
  prefixLike: string
  result?: { ok: boolean; error?: string }
}

type GateHandler = (ctx: { steps: { run: unknown } }) => GateResult

function loadFnHandler(): GateHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const RUN_ID = FINISHED_RUN.run.runId
const OWNER = FINISHED_RUN.run.startedBy!
const RUN_PREFIX = `workflows/hello/hello/runs/${RUN_ID}/`
const INPUT_KEY = 'workflows/hello/hello/inputs/photo.png'

/** The `workflow_runs` row `data_query` hands the gate, as CE hands it: a bare array. */
const ROW = {
  id: 'rec_1',
  runId: RUN_ID,
  impl: 'hello',
  workflow: 'hello',
  status: 'succeeded',
  startedBy: OWNER,
}

/**
 * What `gate.fn.js` still decides, called directly — no `runGate` in front of
 * it here, so `notFound` is exercised for completeness (the same defensive
 * `!row` branch `run/lease/post/gate.fn.js` keeps) even though the real
 * pipeline never reaches it that way. Whoever the caller is — even someone
 * who never started the run — is irrelevant to this function now: ownership
 * is the shared gate's answer, proven separately.
 */
const FN_CASES: { desc: string; row: Record<string, unknown> | null; status: number; error?: string }[] = [
  { desc: 'an unknown run', row: null, status: 404, error: 'run not found' },
  { desc: 'a run that is still running', row: { ...ROW, status: 'running' }, status: 409, error: 'cancel the run first' },
  { desc: 'a caller who did not start it — ownership is the shared gate’s job now', row: ROW, status: 200 },
]

/**
 * The composed `/api/workflow/run/delete` endpoint: `mockGate` decides
 * reachability first (spec 11 D26), same as the real rule's `runGate` step
 * ahead of `gate.fn.js`; only then does `running` (409) get a look-in. The
 * former 403 rows (a non-owner, an id-less caller) are 404 here — indistinguishable
 * from an unknown id (D26) — and an admin now needs BOTH `projectRole`
 * `owner`/`admin` AND to have asked (`x-workflow-scope: all`, D27): asking is
 * never assumed, even from the role that could ask.
 */
const MOCK_CASES: {
  desc: string
  row?: Record<string, unknown> | null
  user: MockUser
  headers?: Record<string, string>
  status: number
  error?: string
}[] = [
  { desc: 'an unknown run', row: null, user: MOCK_MEMBER, status: 404, error: 'run not found' },
  {
    desc: 'a member who did not start it',
    user: MOCK_OTHER,
    status: 404,
    error: 'run not found',
  },
  {
    desc: 'an id-less caller against a row with no startedBy',
    row: { ...ROW, startedBy: undefined },
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
    desc: 'the owner, on a run that is still running',
    row: { ...ROW, status: 'running' },
    user: MOCK_MEMBER,
    status: 409,
    error: 'cancel the run first',
  },
  {
    // The shared gate runs BEFORE `running` gets a look-in (`gate`'s own
    // `condition: steps.runGate.ok`) — a non-owner asking about a running run
    // must see the same 404 an unreachable run always gets, never the 409 a
    // reachable one would, or a run's mere existence leaks through the status
    // code alone (D26).
    desc: 'a member who did not start it, on a run that is still running',
    row: { ...ROW, status: 'running' },
    user: MOCK_OTHER,
    status: 404,
    error: 'run not found',
  },
]

describe('run-delete gate.fn.js parity with the mock re-implementation', () => {
  let handler: GateHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(FN_CASES)('gate.fn.js: $desc', ({ row, status, error }) => {
    const result = handler({ steps: { run: row ? [row] : [] } })

    expect(result.ok).toBe(status === 200)
    expect(result.notFound).toBe(status === 404)
    expect(result.running).toBe(status === 409)
    if (status === 200) {
      expect(result.recordId).toBe(ROW.id)
      expect(result.prefix).toBe(RUN_PREFIX)
      expect(result.prefixLike).toBe(`${RUN_PREFIX}%`)
      // The dead `result: { ok: true }` the success path used to carry: nothing
      // ever rendered it, and its presence read as if something did (apps#381).
      expect(result.result).toBeUndefined()
    } else {
      expect(result.result).toEqual({ ok: false, error })
      expect(result.prefix).toBe('')
      expect(result.prefixLike).toBe('')
      expect(result.recordId).toBeNull()
    }
  })

  describe('against the mock endpoint', () => {
    beforeEach(() => {
      seedFinishedRun()
      const file = { bytes: new Uint8Array([1]), contentType: 'application/octet-stream' }
      seedObject(`${RUN_PREFIX}slow/0/start/poster.png`, file)
      seedObject(`${RUN_PREFIX}outputs/report.json`, file)
      seedObject(INPUT_KEY, file)
    })

    it.each(MOCK_CASES)('mock /api/workflow/run/delete: $desc', async ({ row, user, headers, status, error }) => {
      if (row === null) {
        db.runs.delete(RUN_ID)
      } else if (row) {
        const seeded = { ...db.runs.get(RUN_ID)!, status: String(row.status) as 'running' | 'succeeded' }
        if (row.startedBy === undefined) delete seeded.startedBy
        db.runs.set(RUN_ID, seeded)
      }
      setMockUser(user)

      const res = await fetch('/api/workflow/run/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ id: RUN_ID }),
      })

      expect(res.status).toBe(status)
      if (status !== 200) expect((await res.json()).error).toBe(error)
    })

    /**
     * The assertion the 200's `records` count exists for. The sweep is an
     * ANCHORED `sub_dir LIKE '<run prefix>%'` (apps#381): `sub_dir` is the
     * key's uploads-relative directory — no leading slash, no
     * `<owner>/<repo>/uploads/` head (live-confirmed 2026-08-30) — so the
     * anchor holds, and this pins that the pattern selects exactly this run's
     * rows: not the kickoff input one level up (D18), and not nothing, which
     * is what the same anchored pattern would select if it were ever pointed
     * back at the project-namespaced `storage_path`.
     */
    it('the pattern gate.fn.js builds selects this run’s workflow_files rows and no others', () => {
      const gate = handler({ steps: { run: [ROW] } })

      // The two shapes the anchor rides on: `sub_dir` starts at `workflows/`,
      // `storage_path` does not — it carries CE's uploads head. If the mock (or
      // CE) ever drifted to a full-key `sub_dir`, the selection below would
      // come back empty and this test would say so.
      expect(db.fileRecords.get(INPUT_KEY)?.sub_dir).toBe('workflows/hello/hello/inputs')
      expect(db.fileRecords.get(INPUT_KEY)?.storage_path).toBe(`${MOCK_UPLOADS_ROOT}${INPUT_KEY}`)
      expect(fileRecordsMatching(gate.prefixLike).sort()).toEqual([
        `${RUN_PREFIX}outputs/report.json`,
        `${RUN_PREFIX}slow/0/start/poster.png`,
      ])
      // And the anchor is load-bearing, not decoration: unanchored, a `%` or
      // `_` in an implementation or workflow name could reach beyond this
      // run's rows; anchored, the kickoff `inputs/` row one level up stays
      // untouchable because its `sub_dir` never enters `runs/<id>/` (D18).
      expect(fileRecordsMatching(gate.prefixLike)).not.toContain(INPUT_KEY)
    })
  })
})
