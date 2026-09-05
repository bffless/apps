import { describe, expect, it } from 'vitest'
import { USAGE } from '../src/args.js'
import { ALL_ORDER, WALKS } from '../src/walks/index.js'

// Every walk registered so far; a new walk appends its name here.
const REGISTERED = ['m1', 'interactive', 'hello', 'headless', 'studio-audit', 'studio-headless', 'page-tools', 'mcp', 'mcp-app', 'oauth', 'driven']

describe('WALKS', () => {
  it('registers every walk added so far', () => {
    for (const name of REGISTERED) expect(typeof WALKS[name]).toBe('function')
  })
  it('names every registered walk in USAGE, so `walk <name>` is discoverable', () => {
    for (const name of Object.keys(WALKS)) expect(USAGE).toContain(`${name}|`)
  })
  it('all runs the Task 25 walks in order, studio last — page-tools and the Actions-spending driven walk are not in it', () => {
    expect([...ALL_ORDER]).toEqual(['hello', 'headless', 'studio-audit', 'studio-headless'])
    expect(ALL_ORDER).not.toContain('driven')
  })
})
