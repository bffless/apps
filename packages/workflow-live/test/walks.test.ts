import { describe, expect, it } from 'vitest'
import { USAGE, parseWalkArgs } from '../src/args.js'
import { Report, exitCodeOf } from '../src/report.js'
import { ALL_ORDER, WALKS } from '../src/walks/index.js'

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
