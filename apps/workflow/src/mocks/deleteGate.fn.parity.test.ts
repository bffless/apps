/**
 * Parity between the run-delete rule's `gate.fn.js` (the real `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/run/delete/post/`
 * — cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/run/delete` handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the app
 * or the mock at runtime. Same shape as `confine.fn.parity.test.ts`.
 *
 * The gate is the whole access decision for deletion, and it is the one piece of
 * that rule CI could not see at all: the mock mirrored its branches by hand, so
 * the two could drift with nothing to say so. One case table drives both sides —
 * the raw `handler()` call against `gate.fn.js`, and a real request to the mock
 * endpoint — plus the assertion the two counts in the 200 exist to support: that
 * the pattern the gate builds is the pattern that selects this run's
 * `workflow_files` rows and no others (apps#381).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MOCK_ADMIN,
  MOCK_MEMBER,
  MOCK_UPLOADS_ROOT,
  db,
  fileRecordsMatching,
  seedFinishedRun,
  seedObject,
  setMockUser,
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
  forbidden: boolean
  recordId: string | null
  prefix: string
  prefixLike: string
  result?: { ok: boolean; error?: string }
}

type GateHandler = (ctx: {
  steps: { run: unknown }
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
 * The refusal matrix, and the status each flag's own `response_handler` answers.
 * `status: 200` is the success path — no refusal flag, and no `result` at all
 * (only the three refusal responders render `{{{steps.gate.result}}}`).
 */
const CASES: {
  desc: string
  row: Record<string, unknown> | null
  user: { id?: string; email?: string; role?: string } | undefined
  status: number
  error?: string
}[] = [
  { desc: 'an unknown run', row: null, user: { id: OWNER, role: 'user' }, status: 404, error: 'run not found' },
  {
    desc: 'a run that is still running',
    row: { ...ROW, status: 'running' },
    user: { id: OWNER, role: 'user' },
    status: 409,
    error: 'cancel the run first',
  },
  {
    desc: 'a member who did not start it',
    row: ROW,
    user: { id: 'someone_else', role: 'user' },
    status: 403,
    error: 'only the run owner or an admin can delete a run',
  },
  {
    desc: 'an id-less caller against a row with no startedBy',
    row: { ...ROW, startedBy: undefined },
    user: undefined,
    status: 403,
    error: 'only the run owner or an admin can delete a run',
  },
  { desc: 'the owner', row: ROW, user: { id: OWNER, role: 'user' }, status: 200 },
  { desc: 'an admin who did not start it', row: ROW, user: { id: 'user_admin', role: 'admin' }, status: 200 },
  // Global roles are `admin | user | member` (ce `users.dto.ts`), so `owner` is
  // never a role CE hands a pipeline — the allow-list entry is inert, and kept
  // per the M2 plan's wording. This case pins it as *accepted if it ever
  // arrives*, so the branch cannot be dropped by accident or grow teeth
  // unnoticed. It is asserted against the fn only: the mock has no way to
  // produce a role CE does not issue.
  { desc: 'the inert `owner` role in the allow-list', row: ROW, user: { id: 'x', role: 'owner' }, status: 200 },
]

describe('run-delete gate.fn.js parity with the mock re-implementation', () => {
  let handler: GateHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(CASES)('gate.fn.js: $desc', ({ row, user, status, error }) => {
    const result = handler({ steps: { run: row ? [row] : [] }, request: { body: { id: RUN_ID } }, user })

    expect(result.ok).toBe(status === 200)
    expect(result.notFound).toBe(status === 404)
    expect(result.running).toBe(status === 409)
    expect(result.forbidden).toBe(status === 403)
    if (status === 200) {
      expect(result.recordId).toBe(ROW.id)
      expect(result.prefix).toBe(RUN_PREFIX)
      expect(result.prefixLike).toBe(`%${RUN_PREFIX}%`)
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

    it.each(CASES.filter((c) => c.user?.role !== 'owner'))(
      'mock /api/workflow/run/delete: $desc',
      async ({ row, user, status, error }) => {
        if (row === null) {
          db.runs.delete(RUN_ID)
        } else if (row.status === 'running' || row.startedBy === undefined) {
          const seeded = { ...db.runs.get(RUN_ID)!, status: String(row.status) as 'running' | 'succeeded' }
          if (row.startedBy === undefined) delete seeded.startedBy
          db.runs.set(RUN_ID, seeded)
        }
        setMockUser(
          user?.role === 'admin'
            ? MOCK_ADMIN
            : { ...MOCK_MEMBER, id: user?.id ?? '', role: user?.role ?? 'user' },
        )

        const res = await fetch('/api/workflow/run/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: RUN_ID }),
        })

        expect(res.status).toBe(status)
        if (status !== 200) expect((await res.json()).error).toBe(error)
      },
    )

    /**
     * The assertion the 200's `records` count exists for. CE stores an upload
     * record's `storage_path` as the FULL object key, so the gate's pattern
     * carries a leading `%` — and this pins that the pattern selects exactly
     * this run's rows: not the kickoff input one level up (D18), and not
     * nothing, which is what an anchored pattern would select against a
     * project-namespaced key.
     */
    it('the pattern gate.fn.js builds selects this run’s workflow_files rows and no others', () => {
      const gate = handler({ steps: { run: [ROW] }, request: { body: { id: RUN_ID } }, user: { id: OWNER } })

      expect(db.fileRecords.get(INPUT_KEY)?.storage_path).toBe(`${MOCK_UPLOADS_ROOT}${INPUT_KEY}`)
      expect(fileRecordsMatching(gate.prefixLike).sort()).toEqual([
        `${RUN_PREFIX}outputs/report.json`,
        `${RUN_PREFIX}slow/0/start/poster.png`,
      ])
      // And the leading `%` is load-bearing, not decoration: the same pattern
      // anchored — the obvious "tidy-up" — selects nothing at all, because no
      // `storage_path` starts at `workflows/`. That is the silent `records: 0`.
      expect(fileRecordsMatching(`${RUN_PREFIX}%`)).toEqual([])
    })
  })
})
