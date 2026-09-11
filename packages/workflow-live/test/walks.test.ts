import { describe, expect, it } from 'vitest'
import { USAGE, parseWalkArgs } from '../src/args.js'
import { Report, exitCodeOf } from '../src/report.js'
import { ALL_ORDER, WALKS } from '../src/walks/index.js'
import { isNotAProjectMember, submitStepPastLease, waitForRowWaiting, withReopenedSession } from '../src/walks/ownership.js'

interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
const leaseRefusal: ToolAnswer = { isError: true, content: [{ type: 'text', text: 'A harness tab still drives this run' }], structuredContent: { errors: { lease: 'A harness tab still drives this run (lease until …) — close it or wait for the lease to lapse' } } }
const validationRefusal: ToolAnswer = { isError: true, content: [{ type: 'text', text: 'bad line' }], structuredContent: { errors: { line: 'This field is required' } } }
const ok: ToolAnswer = { isError: false, content: [{ type: 'text', text: 'Submitted ask/0/answer' }], structuredContent: {} }

// Every walk registered so far; a new walk appends its name here.
const REGISTERED = ['m1', 'interactive', 'hello', 'headless', 'studio-audit', 'studio-headless', 'page-tools', 'mcp', 'mcp-app', 'oauth', 'driven', 'ownership']

describe('WALKS', () => {
  it('registers every walk added so far', () => {
    for (const name of REGISTERED) expect(typeof WALKS[name]).toBe('function')
  })
  it('names every registered walk in USAGE, so `walk <name>` is discoverable', () => {
    for (const name of Object.keys(WALKS)) expect(USAGE).toContain(`${name}|`)
  })
  it('all runs the Task 25 walks in order, studio last — page-tools and the Actions-spending driven/ownership walks are not in it', () => {
    expect([...ALL_ORDER]).toEqual(['hello', 'headless', 'studio-audit', 'studio-headless'])
    expect(ALL_ORDER).not.toContain('driven')
    expect(ALL_ORDER).not.toContain('ownership')
  })
})

describe('ownership', () => {
  it('blocks — never fails — when the second member is not configured, before touching the network', async () => {
    const report = new Report('ownership', 'https://x.test')
    const args = parseWalkArgs(['walk', 'ownership', '--out', '/tmp/workflow-live-test/ownership-block'])
    await WALKS.ownership({ args, env: { WORKFLOW_EMAIL: 'a@x.test', WORKFLOW_PASSWORD: 'p' }, report })
    const r = report.finish()
    expect(r.blocked).toBe('second member not configured: set WORKFLOW_EMAIL_2/WORKFLOW_PASSWORD_2 or WORKFLOW_APP_TOKEN_2')
    expect(exitCodeOf(r)).toBe(2)
    expect(Object.keys(r.checks)).toEqual([])
  })
  it("blocks on member A's own login when the second member IS configured but A's is not", async () => {
    const report = new Report('ownership', 'https://x.test')
    const args = parseWalkArgs(['walk', 'ownership', '--out', '/tmp/workflow-live-test/ownership-block-a'])
    await WALKS.ownership({ args, env: { WORKFLOW_EMAIL_2: 'b@x.test', WORKFLOW_PASSWORD_2: 'p' }, report })
    const r = report.finish()
    expect(r.blocked).toBe("WORKFLOW_APP_TOKEN (minted with auth:session) or WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (member A — the walk's usual login)")
    expect(exitCodeOf(r)).toBe(2)
  })
})

describe('submitStepPastLease', () => {
  it('retries past the live-lease refusal (A closed the driving tab, the lease has not lapsed yet) and returns the eventual answer', async () => {
    const calls: Array<Record<string, unknown>> = []
    let attempt = 0
    const call = async (name: string, toolArgs: Record<string, unknown> = {}) => {
      expect(name).toBe('workflow.submitStep')
      calls.push(toolArgs)
      attempt += 1
      return attempt < 3 ? leaseRefusal : ok
    }
    const answer = await submitStepPastLease(call, 'run_1', 'ask/0/answer', { note: 'x' }, 1_000, 1)
    expect(answer).toBe(ok)
    expect(calls).toHaveLength(3)
    expect(calls.every((a) => a.runId === 'run_1' && a.step === 'ask/0/answer' && (a.values as { note: string }).note === 'x')).toBe(true)
  })

  it('stops on the first non-lease refusal instead of masking it with a retry', async () => {
    let attempt = 0
    const call = async () => {
      attempt += 1
      return validationRefusal
    }
    const answer = await submitStepPastLease(call, 'run_1', 'ask/0/answer', {}, 1_000, 1)
    expect(answer).toBe(validationRefusal)
    expect(attempt).toBe(1)
  })

  it('gives up at the timeout and returns the last (still-lease) answer', async () => {
    let attempt = 0
    const call = async () => {
      attempt += 1
      return leaseRefusal
    }
    const answer = await submitStepPastLease(call, 'run_1', 'ask/0/answer', {}, 30, 10)
    expect(answer).toBe(leaseRefusal)
    expect(attempt).toBeGreaterThan(1)
  })
})

describe('waitForRowWaiting', () => {
  it('polls past queued rows (and rows nested under `fields`) to the server-confirmed waiting one', async () => {
    let attempt = 0
    const getRun = async () => {
      attempt += 1
      if (attempt < 3) return { steps: [{ key: 'ask/0/answer', status: 'queued' }] }
      return { steps: [{ fields: { key: 'ask/0/answer', status: 'waiting' } }] }
    }
    const result = await waitForRowWaiting(getRun, 'ask/0/answer', 1_000, 1)
    expect(result).toEqual({ waiting: true, lastStatus: 'waiting', snapshot: { key: 'ask/0/answer', status: 'waiting' } })
    expect(attempt).toBe(3)
  })

  it('gives up at the timeout and reports the last status seen, never a throw', async () => {
    const getRun = async () => ({ steps: [{ key: 'ask/0/answer', status: 'queued' }] })
    const result = await waitForRowWaiting(getRun, 'ask/0/answer', 30, 10)
    expect(result.waiting).toBe(false)
    expect(result.lastStatus).toBe('queued')
  })

  it('reports no status when the run record carries no matching row (e.g. B cannot reach it, or the record is null)', async () => {
    const result = await waitForRowWaiting(async () => null, 'ask/0/answer', 10, 5)
    expect(result).toEqual({ waiting: false, lastStatus: '', snapshot: null })
  })
})

describe('withReopenedSession', () => {
  it('reopens after body succeeds, and returns body\'s own result', async () => {
    let reopened = 0
    const result = await withReopenedSession(
      async () => 'answer',
      async () => {
        reopened += 1
      },
    )
    expect(result).toBe('answer')
    expect(reopened).toBe(1)
  })

  it('reopens even when body throws, then rethrows body\'s error (the reopen must not be skipped by the throw, and must not swallow it)', async () => {
    let reopened = 0
    await expect(
      withReopenedSession(
        async () => {
          throw new Error('submit boom')
        },
        async () => {
          reopened += 1
        },
      ),
    ).rejects.toThrow('submit boom')
    expect(reopened).toBe(1)
  })

  it("a throw from reopen itself wins over body's own error (JS finally semantics) — surfaced, not silently lost", async () => {
    await expect(
      withReopenedSession(
        async () => {
          throw new Error('submit boom')
        },
        async () => {
          throw new Error('reopen boom')
        },
      ),
    ).rejects.toThrow('reopen boom')
  })
})

describe('isNotAProjectMember', () => {
  it('recognizes the 403 "not a member of this project" mint failure', () => {
    const e = new Error('mint app token: https://admin.j5s.dev/api/app-tokens answered 403 {"message":"You are not a member of this project"}')
    expect(isNotAProjectMember(e)).toBe(true)
  })
  it('is false for a different status code', () => {
    const e = new Error('mint app token: https://admin.j5s.dev/api/app-tokens answered 401 {"message":"You are not a member of this project"}')
    expect(isNotAProjectMember(e)).toBe(false)
  })
  it('is false for a 403 with a different reason', () => {
    const e = new Error('mint app token: https://admin.j5s.dev/api/app-tokens answered 403 {"message":"scopes not allowed"}')
    expect(isNotAProjectMember(e)).toBe(false)
  })
  it('is false for a non-Error throw', () => {
    expect(isNotAProjectMember('boom')).toBe(false)
  })
})
