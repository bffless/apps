// @vitest-environment node
/**
 * Parity between the **generated** run gate — `mcp-fn/runGate.fn.js`, the
 * bundle CE's `function_handler` actually runs, executed here in the sandbox
 * CE gives it (`test/ceSandbox`, the same runner `bundle.test.ts` smoke-runs
 * every entry with; the bundle is an esbuild IIFE, so `new Function` would not
 * do) — and the mock's independently written re-implementation in
 * `runGate.ts`. One case table drives both sides, so the harness's answer and
 * the SPA's mocked answer to "may this caller reach this run?" cannot drift
 * with nothing to say so (the `forkGate.fn.parity.test.ts` arrangement).
 *
 * The table is the ownership model of spec 11 (D26–D28): the four doors, and
 * the single refusal — *not found*, never forbidden — behind all of them.
 *
 * The `node` environment, unlike its neighbours here: the generator
 * (`build-mcp.mjs`, reached through `bundle.test`'s sandbox runner) carries a
 * shebang Vite's browser transform will not parse, and nothing on either side
 * of this table needs a DOM — `mockGate` is pure, and reads an MSW `Request`
 * that Node provides itself.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { outFile } from '../../scripts/build-mcp.mjs'
import { runInCeSandbox } from '../test/ceSandbox'
import { MOCK_MEMBER } from './db'
import { DRIVE_KEY_HEADER, SCOPE_HEADER, mockGate, type GateRunRow, type GateUser } from './runGate'

const FN_SRC = readFileSync(outFile('runGate'), 'utf8')

const OWNER = 'user_owner'
const KEY = 'dk_01hzzparity'

/** The row both sides gate, as `workflow_runs` holds it. */
const RUN: GateRunRow = {
  runId: 'run_01parity0000000000000000',
  impl: 'hello',
  workflow: 'hello',
  workflowName: 'Hello',
  definition: { jobs: {} },
  yaml: 'name: Hello\n',
  inputs: {},
  status: 'running',
  headless: false,
  startedBy: OWNER,
  startedAt: 1_700_000_000_000,
}

/** A caller CE could not tie to a person: `user: undefined` in a pipeline, an id-less identity in the mock. */
const ANON: GateUser = { id: '', email: '', role: 'user' }

interface Case {
  desc: string
  /** `null` — no such row; omitted — the base run. */
  row?: GateRunRow | null
  /** `undefined` — the caller CE could not resolve. */
  user?: GateUser
  driveKey?: string
  queryScope?: string
  bodyScope?: string
  scopeHeader?: string
  runless?: boolean
  ok: boolean
  door: string
}

const member = (id: string, projectRole?: string): GateUser => ({ ...MOCK_MEMBER, id, projectRole })

const CASES: Case[] = [
  { desc: 'no such run', row: null, user: member(OWNER), ok: false, door: '' },
  { desc: 'the owner', user: member(OWNER), ok: true, door: 'owner' },
  { desc: 'a member who did not start it', user: member('user_other'), ok: false, door: '' },
  {
    desc: 'an id-less caller against a row with no startedBy',
    row: { ...RUN, startedBy: '' },
    user: undefined,
    ok: false,
    door: '',
  },
  {
    desc: 'an ownerless run, scope=all, project admin',
    row: { ...RUN, startedBy: '' },
    user: member('user_admin', 'admin'),
    queryScope: 'all',
    ok: true,
    door: 'all',
  },
  {
    desc: 'scope=all from a contributor',
    user: member('user_other', 'contributor'),
    queryScope: 'all',
    ok: false,
    door: '',
  },
  {
    // D27: the role is not the door — the asking is.
    desc: 'a project owner who did not ask',
    user: member('user_boss', 'owner'),
    ok: false,
    door: '',
  },
  {
    desc: 'the scope header from a project owner',
    user: member('user_boss', 'owner'),
    scopeHeader: 'all',
    ok: true,
    door: 'all',
  },
  {
    desc: 'scope=all in the body from a project admin',
    user: member('user_admin', 'admin'),
    bodyScope: 'all',
    ok: true,
    door: 'all',
  },
  {
    desc: 'the drive nonce on a live run',
    row: { ...RUN, startedBy: 'user_other', driveKey: KEY },
    user: member('user_driver'),
    driveKey: KEY,
    ok: true,
    door: 'drive',
  },
  {
    desc: 'the drive nonce on a run that has succeeded',
    row: { ...RUN, startedBy: 'user_other', driveKey: KEY, status: 'succeeded' },
    user: member('user_driver'),
    driveKey: KEY,
    ok: false,
    door: '',
  },
  {
    desc: 'a drive nonce that does not match',
    row: { ...RUN, startedBy: 'user_other', driveKey: KEY },
    user: member('user_driver'),
    driveKey: 'dk_wrong',
    ok: false,
    door: '',
  },
  {
    desc: 'a drive nonce against a run that carries none',
    row: { ...RUN, startedBy: 'user_other' },
    user: member('user_driver'),
    driveKey: KEY,
    ok: false,
    door: '',
  },
  { desc: 'a request that names no run', row: null, runless: true, user: member(OWNER), ok: true, door: 'runless' },
]

/** The row each case gates: `null` means the query found nothing. */
const rowOf = (c: Case): GateRunRow | null => (c.row === undefined ? RUN : c.row)

/** The request headers, spelled as Express hands them to CE (lowercase). */
function headersOf(c: Case): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(c.driveKey === undefined ? {} : { [DRIVE_KEY_HEADER]: c.driveKey }),
    ...(c.scopeHeader === undefined ? {} : { [SCOPE_HEADER]: c.scopeHeader }),
  }
}

describe('mcp-fn/runGate.fn.js parity with the mock re-implementation', () => {
  it.each(CASES)('runGate.fn.js: $desc', async (c) => {
    const row = rowOf(c)
    const result = (await runInCeSandbox(FN_SRC, {
      steps: {
        run: row ? [{ id: 'rec_1', ...row }] : [],
        route: { runless: c.runless === true },
      },
      request: {
        body: c.bodyScope === undefined ? {} : { scope: c.bodyScope },
        query: c.queryScope === undefined ? {} : { scope: c.queryScope },
        headers: headersOf(c),
        method: 'POST',
        path: '/api/workflow/run/get',
      },
      user: c.user,
    })) as { ok: boolean; door: string; notFound: boolean }

    expect(result.ok).toBe(c.ok)
    expect(result.door).toBe(c.door)
    // Whatever the reason, an unreachable run is not found (D26).
    expect(result.notFound).toBe(!c.ok)
  })

  it.each(CASES)('the mock: $desc', (c) => {
    const url = `http://localhost/api/workflow/run${c.queryScope === undefined ? '' : `?scope=${c.queryScope}`}`
    const request = new Request(url, { method: 'POST', headers: headersOf(c) })

    expect(mockGate(rowOf(c) ?? undefined, request, c.user ?? ANON, {
      runless: c.runless,
      bodyScope: c.bodyScope,
    })).toEqual({ ok: c.ok, door: c.door })
  })
})
