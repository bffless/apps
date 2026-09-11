/**
 * Parity between the list rule's `scope.fn.js` (the real `function_handler`
 * code that decides "mine" vs "all" for `runs/get`, at
 * `.bffless/proxy-rules/workflow/rules/api/workflow/runs/get/` — cannot
 * import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/runs` GET handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the
 * app or the mock at runtime. Same shape as `deleteGate.fn.parity.test.ts`.
 *
 * `scope.fn.js` is not the gate (`runGate.ts`): it filters a *list* rather
 * than refusing a request that names one run (spec 11 §Listing). The one
 * case that answers a status other than 200 is an *asked-for* `scope=all`
 * from a caller without the project role for it (D27) — everything else is
 * either `mine` or `all`, both 200s that differ only in which rows come back.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_ADMIN, MOCK_MEMBER, MOCK_OTHER, db, seedFinishedRun, setMockUser, type MockUser } from './db'
import { FINISHED_RUN, FIXTURE_RUN_ID } from './fixtures/finishedRun'

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
  'scope.fn.js',
)

interface ScopeResult {
  isMine: boolean
  isAll: boolean
  forbidden: boolean
  ok: boolean
  result?: { ok: boolean; error?: string; code?: string }
}

type FnRequest = { query?: Record<string, unknown>; headers?: Record<string, string | string[]> }
type FnUser = { id?: string; email?: string; role?: string; projectRole?: string } | undefined

type ScopeHandler = (ctx: { request: FnRequest; user: FnUser }) => ScopeResult

function loadFnHandler(): ScopeHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

/** The 403 body both sides must answer verbatim (rule.yaml's `refuse-403` renders it as-is). */
const FORBIDDEN_RESULT = {
  ok: false,
  error: 'scope=all needs the project owner or admin role',
  code: 'SCOPE_FORBIDDEN',
}

/** The other run in the mock fixtures, seeded owned by someone else so `mine` has something to exclude. */
const OTHER_RUN_ID = 'run_01otherowner00000000000000'

const CASES: {
  desc: string
  request: FnRequest
  fnUser: FnUser
  /** `undefined` mock user models the fn-side `user: undefined` (an id-less caller). */
  mockUser: MockUser
  isMine: boolean
  isAll: boolean
  forbidden: boolean
}[] = [
  {
    desc: 'no scope',
    request: {},
    fnUser: { ...MOCK_MEMBER },
    mockUser: MOCK_MEMBER,
    isMine: true,
    isAll: false,
    forbidden: false,
  },
  {
    desc: '?scope=all as a contributor',
    request: { query: { scope: 'all' } },
    fnUser: { ...MOCK_MEMBER, projectRole: 'contributor' },
    mockUser: { ...MOCK_MEMBER, projectRole: 'contributor' },
    isMine: false,
    isAll: false,
    forbidden: true,
  },
  {
    desc: '?scope=all as a project admin',
    request: { query: { scope: 'all' } },
    fnUser: { ...MOCK_MEMBER, projectRole: 'admin' },
    mockUser: { ...MOCK_MEMBER, projectRole: 'admin' },
    isMine: false,
    isAll: true,
    forbidden: false,
  },
  {
    desc: 'the x-workflow-scope header as a project owner',
    request: { headers: { 'x-workflow-scope': 'all' } },
    fnUser: { ...MOCK_ADMIN, projectRole: 'owner' },
    mockUser: { ...MOCK_ADMIN, projectRole: 'owner' },
    isMine: false,
    isAll: true,
    forbidden: false,
  },
  {
    desc: 'an unresolvable caller asking for scope=all',
    request: { query: { scope: 'all' } },
    fnUser: undefined,
    mockUser: { ...MOCK_MEMBER, id: '', projectRole: undefined },
    isMine: false,
    isAll: false,
    forbidden: true,
  },
  // Fix round 1: header NAMES compared case-sensitively missed a mixed-case
  // ask — CE lowercases what Express hands it, but a rule reached in-process
  // by a sibling may not have (`src/mcp/runGate.ts`'s `header()`).
  {
    desc: 'a mixed-case X-Workflow-Scope header as a project owner',
    request: { headers: { 'X-Workflow-Scope': 'all' } },
    fnUser: { ...MOCK_ADMIN, projectRole: 'owner' },
    mockUser: { ...MOCK_ADMIN, projectRole: 'owner' },
    isMine: false,
    isAll: true,
    forbidden: false,
  },
  // Fix round 1: a repeated `?scope=all&scope=x` arrives as `string[]` and
  // must never silently fall through to `mine` — take the first value, the
  // same rule the header follows.
  {
    desc: 'a repeated ?scope=all&scope=x as a contributor',
    request: { query: { scope: ['all', 'x'] } },
    fnUser: { ...MOCK_MEMBER, projectRole: 'contributor' },
    mockUser: { ...MOCK_MEMBER, projectRole: 'contributor' },
    isMine: false,
    isAll: false,
    forbidden: true,
  },
]

describe('runs/get scope.fn.js parity with the mock re-implementation', () => {
  let handler: ScopeHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(CASES)('scope.fn.js: $desc', ({ request, fnUser, isMine, isAll, forbidden }) => {
    const result = handler({ request, user: fnUser })

    expect(result.isMine).toBe(isMine)
    expect(result.isAll).toBe(isAll)
    expect(result.forbidden).toBe(forbidden)
    expect(result.ok).toBe(!forbidden)
    if (forbidden) {
      expect(result.result).toEqual(FORBIDDEN_RESULT)
    } else {
      // Only the refusal responder renders `{{{steps.scope.result}}}` — a
      // success-path `result` would be dead weight nothing serves.
      expect(result.result).toBeUndefined()
    }
  })

  describe('against the mock endpoint', () => {
    beforeEach(() => {
      seedFinishedRun()
      db.runs.set(OTHER_RUN_ID, {
        ...FINISHED_RUN.run,
        runId: OTHER_RUN_ID,
        startedBy: MOCK_OTHER.id,
        startedByEmail: MOCK_OTHER.email,
        _id: 'rec_other_owner',
      })
    })

    it.each(CASES)(
      'mock GET /api/workflow/runs: $desc',
      async ({ request, mockUser: user, isMine, isAll, forbidden }) => {
        setMockUser(user)

        // Forward `scope` as however many times the case names it — a
        // repeated param and a single one are both exercised this way — and
        // every header verbatim (case included): MSW's `Headers.get` is
        // already case-insensitive, so a mixed-case name only proves
        // something if it is sent mixed-case.
        const params = new URLSearchParams({ impl: 'hello', workflow: 'hello' })
        const scope = request.query?.scope
        for (const s of Array.isArray(scope) ? scope : scope !== undefined ? [scope] : []) {
          params.append('scope', String(s))
        }
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(request.headers ?? {})) {
          const first = Array.isArray(value) ? value[0] : value
          if (typeof first === 'string') headers[key] = first
        }

        const res = await fetch(`/api/workflow/runs?${params}`, { headers })

        if (forbidden) {
          expect(res.status).toBe(403)
          expect(await res.json()).toEqual(FORBIDDEN_RESULT)
          return
        }

        expect(res.status).toBe(200)
        const { records } = (await res.json()) as { records: { runId: string; startedBy?: string }[] }
        if (isMine) {
          expect(records.map((r) => r.runId)).toEqual([FIXTURE_RUN_ID])
          expect(records.every((r) => r.startedBy === user.id)).toBe(true)
        }
        if (isAll) {
          expect(records.map((r) => r.runId).sort()).toEqual([FIXTURE_RUN_ID, OTHER_RUN_ID].sort())
        }
      },
    )
  })
})
