import { describe, expect, it } from 'vitest'
import { parseWalkArgs, UsageError } from '../src/args.js'

describe('parseWalkArgs', () => {
  it('defaults harness, out and timeout', () => {
    const a = parseWalkArgs(['walk', 'hello'])
    expect(a.walk).toBe('hello')
    expect(a.harness).toBe('https://workflow.j5s.dev')
    expect(a.out).toMatch(/workflow-live\/hello\//)
    expect(a.dispatch).toBe(false)
    expect(a.timeoutMs).toBe(90 * 60_000)
  })
  it('reads every flag', () => {
    const a = parseWalkArgs(['walk', 'studio-headless', '--harness', 'https://h.test/', '--out', '/tmp/o', '--dispatch', '--clip', '/c.mp4', '--run', 'run_1', '--timeout', '30m'])
    expect(a).toEqual({ walk: 'studio-headless', harness: 'https://h.test', out: '/tmp/o', dispatch: true, clip: '/c.mp4', run: 'run_1', timeoutMs: 30 * 60_000 })
  })
  it('rejects a missing walk name, an unknown flag and a non-walk command', () => {
    expect(() => parseWalkArgs(['walk'])).toThrow(UsageError)
    expect(() => parseWalkArgs(['walk', 'hello', '--nope'])).toThrow(UsageError)
    expect(() => parseWalkArgs(['runs'])).toThrow(UsageError)
  })
  it('rejects a bad --timeout value', () => {
    expect(() => parseWalkArgs(['walk', 'hello', '--timeout', '30mm'])).toThrow(UsageError)
  })
  it('rejects a flag as a value', () => {
    expect(() => parseWalkArgs(['walk', 'hello', '--clip', '--dispatch'])).toThrow(UsageError)
  })
})
