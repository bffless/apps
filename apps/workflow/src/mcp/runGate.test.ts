// @vitest-environment node
/**
 * The shared run gate (spec 11 §The model (D26), §One gate, not twenty-five
 * copies). Every rule that names an existing run imports this one bundle, so
 * every fact about who may reach a run is asserted once, here.
 *
 * Two properties matter more than any single case: a refusal is always a
 * *returned flag* (a throw would be CE's generic FUNCTION_ERROR, not the 404
 * this gate means), and an unreachable run answers `notFound` rather than
 * `forbidden` — a run id in a URL leaks nothing about whether it exists.
 */
import { describe, expect, it } from 'vitest'
import type { FnRequest } from './route'
import {
  DRIVE_KEY_HEADER,
  SCOPE_HEADER,
  TERMINAL_STATUSES,
  admittedRun,
  gateRun,
  hasGrant,
  header,
  isAllScopeRole,
  scopeAsked,
  handler,
  type FnUser,
} from './runGate'

const OWNER = 'user_owner'
const KEY = 'dk_01hzz'

/** A `workflow_runs` record as `data_query` hands it: the record id, then the columns. */
function record(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'rec_1', runId: 'run_1', startedBy: OWNER, status: 'running', ...fields }
}

function request(init: Partial<FnRequest> = {}): FnRequest {
  return { body: undefined, query: undefined, headers: {}, method: 'POST', path: '/api/workflow/run/get', ...init }
}

interface Case {
  desc: string
  row?: Record<string, unknown> | null
  request?: FnRequest
  user?: FnUser
  runless?: boolean
  ok: boolean
  door: string
}

const CASES: Case[] = [
  { desc: 'no row at all', row: null, user: { id: OWNER }, ok: false, door: '' },
  { desc: 'the owner', user: { id: OWNER }, ok: true, door: 'owner' },
  { desc: 'a member who did not start it', user: { id: 'user_other' }, ok: false, door: '' },
  {
    // `undefined === undefined` is `true` — an id-less caller must never own a
    // row that is *also* id-less (`run/delete/post/gate.fn.js`'s `!caller.id`).
    desc: 'an id-less caller against a row with no startedBy',
    row: record({ startedBy: undefined }),
    user: undefined,
    ok: false,
    door: '',
  },
  {
    desc: 'an ownerless row asked for with scope=all by a project admin',
    row: record({ startedBy: '' }),
    request: request({ query: { scope: 'all' } }),
    user: { id: 'user_admin', projectRole: 'admin' },
    ok: true,
    door: 'all',
  },
  {
    desc: 'scope=all asked for by a contributor',
    request: request({ query: { scope: 'all' } }),
    user: { id: 'user_other', projectRole: 'contributor' },
    ok: false,
    door: '',
  },
  {
    // D27: the exemption is asked for, never assumed — the role alone is not a door.
    desc: 'a project owner who did not ask',
    user: { id: 'user_boss', projectRole: 'owner' },
    ok: false,
    door: '',
  },
  {
    desc: 'the scope header asked for by a project owner',
    request: request({ headers: { [SCOPE_HEADER]: 'all' } }),
    user: { id: 'user_boss', projectRole: 'owner' },
    ok: true,
    door: 'all',
  },
  {
    desc: 'scope=all in the body, asked for by a project admin',
    request: request({ body: { scope: 'all' } }),
    user: { id: 'user_admin', projectRole: 'admin' },
    ok: true,
    door: 'all',
  },
  {
    desc: "the drive nonce on a run that is still running",
    row: record({ startedBy: 'user_other', driveKey: KEY, status: 'running' }),
    request: request({ headers: { [DRIVE_KEY_HEADER]: KEY } }),
    user: { id: 'user_driver' },
    ok: true,
    door: 'drive',
  },
  {
    // The key is cleared at a terminal status (D28); a stale one opens nothing.
    desc: 'the drive nonce on a run that has succeeded',
    row: record({ startedBy: 'user_other', driveKey: KEY, status: 'succeeded' }),
    request: request({ headers: { [DRIVE_KEY_HEADER]: KEY } }),
    user: { id: 'user_driver' },
    ok: false,
    door: '',
  },
  {
    desc: 'a drive nonce that does not match the row',
    row: record({ startedBy: 'user_other', driveKey: KEY, status: 'running' }),
    request: request({ headers: { [DRIVE_KEY_HEADER]: 'dk_wrong' } }),
    user: { id: 'user_driver' },
    ok: false,
    door: '',
  },
  {
    desc: 'a drive nonce against a row that carries none',
    row: record({ startedBy: 'user_other', status: 'running' }),
    request: request({ headers: { [DRIVE_KEY_HEADER]: KEY } }),
    user: { id: 'user_driver' },
    ok: false,
    door: '',
  },
  {
    desc: 'a request that names no run at all',
    row: null,
    runless: true,
    user: { id: OWNER },
    ok: true,
    door: 'runless',
  },
]

describe('gateRun', () => {
  it.each(CASES)('$desc', ({ row, request: req, user, runless, ok, door }) => {
    const rowOrDefault = row === undefined ? record() : row
    const gate = gateRun({ run: rowOrDefault ? [rowOrDefault] : [], runless, request: req, user })

    expect(gate.ok).toBe(ok)
    expect(gate.door).toBe(door)
    expect(gate.notFound).toBe(!ok)
    if (!ok) {
      expect(gate.result).toEqual({ ok: false, error: 'run not found' })
      expect(gate.recordId).toBeNull()
      expect(gate.run).toBeNull()
      return
    }
    expect(gate.result).toBeNull()
    if (door === 'runless') {
      expect(gate.recordId).toBeNull()
      expect(gate.run).toBeNull()
      return
    }
    expect(gate.recordId).toBe('rec_1')
    expect(gate.run).toMatchObject({ runId: 'run_1' })
  })

  it('reads a record whose columns are under `fields`, and takes its record id', () => {
    const gate = gateRun({ run: { records: [{ id: 'rec_9', fields: { runId: 'run_1', startedBy: OWNER } }] }, user: { id: OWNER } })
    expect(gate.ok).toBe(true)
    expect(gate.recordId).toBe('rec_9')
    expect(gate.run).toEqual({ runId: 'run_1', startedBy: OWNER })
  })

  it('falls back to the columns own id when the record carries none', () => {
    const gate = gateRun({ run: [{ fields: { runId: 'run_1', id: 'rec_5', startedBy: OWNER } }], user: { id: OWNER } })
    expect(gate.recordId).toBe('rec_5')
  })

  it('answers notFound, never forbidden, whatever the reason (D26)', () => {
    for (const gate of [
      gateRun({ run: [], user: { id: OWNER } }),
      gateRun({ run: [record()], user: { id: 'someone_else' } }),
    ]) {
      expect(gate.notFound).toBe(true)
      expect(gate.door).toBe('')
      expect(gate.result).toEqual({ ok: false, error: 'run not found' })
    }
  })

  it('never throws on garbage', () => {
    for (const run of [undefined, null, 'garbage', 42, [null], [['nested']], { records: 'no' }]) {
      expect(() => gateRun({ run })).not.toThrow()
      expect(gateRun({ run }).ok).toBe(false)
    }
    expect(() => gateRun({ run: [record()], request: { headers: null } as never, user: null as never })).not.toThrow()
  })
})

describe('header', () => {
  it('is case-insensitive over the names CE hands it', () => {
    expect(header(request({ headers: { 'X-Workflow-Scope': 'all' } }), SCOPE_HEADER)).toBe('all')
    expect(header(request({ headers: { 'x-workflow-scope': 'all' } }), 'X-Workflow-Scope')).toBe('all')
  })

  it('takes the first value of a repeated header, and trims it', () => {
    expect(header(request({ headers: { [DRIVE_KEY_HEADER]: [' dk_first ', 'dk_second'] } }), DRIVE_KEY_HEADER)).toBe('dk_first')
  })

  it('answers the empty string for anything it cannot read', () => {
    expect(header(undefined, SCOPE_HEADER)).toBe('')
    expect(header(null as never, SCOPE_HEADER)).toBe('')
    expect(header(request(), SCOPE_HEADER)).toBe('')
    expect(header(request({ headers: null as never }), SCOPE_HEADER)).toBe('')
    expect(header(request({ headers: { [SCOPE_HEADER]: undefined } }), SCOPE_HEADER)).toBe('')
    expect(header(request({ headers: { [SCOPE_HEADER]: [] } }), SCOPE_HEADER)).toBe('')
  })
})

describe('scopeAsked', () => {
  it('reads the query, the body and the header', () => {
    expect(scopeAsked(request({ query: { scope: 'all' } }))).toBe(true)
    expect(scopeAsked(request({ body: { scope: 'all' } }))).toBe(true)
    expect(scopeAsked(request({ headers: { [SCOPE_HEADER]: 'all' } }))).toBe(true)
  })

  it('is false for anything else, and never throws', () => {
    expect(scopeAsked(undefined)).toBe(false)
    expect(scopeAsked(null as never)).toBe(false)
    expect(scopeAsked(request())).toBe(false)
    expect(scopeAsked(request({ query: { scope: 'mine' }, body: 'not an object' }))).toBe(false)
    expect(scopeAsked(request({ query: 'all' as never, body: ['all'] }))).toBe(false)
  })
})

describe('isAllScopeRole', () => {
  it('admits only a project owner or admin', () => {
    expect(TERMINAL_STATUSES).toEqual(['succeeded', 'failed', 'cancelled'])
    expect(isAllScopeRole('owner')).toBe(true)
    expect(isAllScopeRole('ADMIN')).toBe(true)
    expect(isAllScopeRole('contributor')).toBe(false)
    expect(isAllScopeRole('viewer')).toBe(false)
    expect(isAllScopeRole(undefined)).toBe(false)
    expect(isAllScopeRole(null)).toBe(false)
    expect(isAllScopeRole(7)).toBe(false)
  })
})

describe('hasGrant', () => {
  // Sharing is not built (spec 11 §The model): the door exists so landing it
  // does not have to reopen the sweep across ~25 rules.
  it('is false, always', () => {
    expect(hasGrant({ startedBy: OWNER }, { id: OWNER })).toBe(false)
    expect(hasGrant({}, {})).toBe(false)
  })
})

describe('admittedRun', () => {
  /** `steps` as the pipeline holds it: the query's rows, and whatever the gate answered. */
  const steps = (gate?: unknown) => ({ run: [record()], ...(gate === undefined ? {} : { runGate: gate }) })

  it('answers the gate’s own admitted row, not one re-read from the query', () => {
    const fields = gateRun({ run: [record()], user: { id: OWNER } }).run
    expect(admittedRun(steps({ ok: true, door: 'owner', run: fields }))).toBe(fields)
  })

  it('answers undefined on the runless door, whatever `steps.run` still holds', () => {
    // The gate said ok without opening a door onto a run; a helper that
    // re-derived the row from `steps.run` would admit an ungated one here.
    expect(admittedRun(steps({ ok: true, door: 'runless', run: null }))).toBeUndefined()
  })

  it('answers undefined when the gate refused, said nothing, or admitted nothing', () => {
    expect(admittedRun(steps({ ok: false, door: '', run: null }))).toBeUndefined()
    expect(admittedRun(steps(undefined))).toBeUndefined()
    expect(admittedRun({ run: [], runGate: { ok: true } })).toBeUndefined()
    expect(admittedRun(undefined)).toBeUndefined()
    expect(admittedRun({ runGate: { ok: true } })).toBeUndefined()
    expect(admittedRun({ run: 'garbage', runGate: 'garbage' })).toBeUndefined()
    expect(admittedRun({ run: [record()], runGate: { ok: true, run: 'garbage' } })).toBeUndefined()
  })
})

describe('handler', () => {
  it('gates the run `steps.run` names', () => {
    expect(handler({ steps: { run: [record()] }, user: { id: OWNER } })).toMatchObject({ ok: true, door: 'owner' })
    expect(handler({ steps: { run: [record()] }, user: { id: 'user_other' } })).toMatchObject({ ok: false, notFound: true })
  })

  it.each(['route', 'confine', 'normalize'])('reads `runless` from steps.%s', (locator) => {
    expect(handler({ steps: { [locator]: { runless: true } } })).toMatchObject({ ok: true, door: 'runless' })
    expect(handler({ steps: { [locator]: { runless: false } } })).toMatchObject({ ok: false, door: '' })
  })

  it('never throws, whatever CE hands it', () => {
    for (const data of [
      {},
      { steps: { run: 'garbage' } },
      { request: { headers: null } as never },
      { request: null } as never,
      { steps: 'garbage' } as never,
      { steps: { run: [record()], route: 'garbage' }, user: 'garbage' } as never,
      undefined as never,
    ]) {
      expect(() => handler(data)).not.toThrow()
      expect(handler(data)).toBeTypeOf('object')
    }
  })
})
