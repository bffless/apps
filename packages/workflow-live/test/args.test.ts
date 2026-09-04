import { describe, expect, it } from 'vitest'
import { parseWalkArgs, UsageError, USAGE } from '../src/args.js'

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
    expect(a).toEqual({ walk: 'studio-headless', harness: 'https://h.test', out: '/tmp/o', dispatch: true, clip: '/c.mp4', run: 'run_1', parkOnly: false, timeoutMs: 30 * 60_000 })
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
  it('rejects an empty --harness, a bare-slash --harness and an empty --out', () => {
    expect(() => parseWalkArgs(['walk', 'hello', '--harness', ''])).toThrow(/^--harness needs a value/)
    expect(() => parseWalkArgs(['walk', 'hello', '--harness', '/'])).toThrow(/^--harness needs a value/)
    expect(() => parseWalkArgs(['walk', 'hello', '--out', ''])).toThrow(/^--out needs a value/)
  })
  it('prints USAGE once when --timeout has no value', () => {
    let err: unknown
    try { parseWalkArgs(['walk', 'hello', '--timeout']) } catch (e) { err = e }
    expect(err).toBeInstanceOf(UsageError)
    const message = (err as Error).message
    expect(message).toMatch(/^--timeout needs a value/)
    expect(message.split(USAGE).length - 1).toBe(1)
  })
  it('throws the headless UsageError, which names itself', () => {
    let err: unknown
    try { parseWalkArgs(['runs']) } catch (e) { err = e }
    expect((err as Error).name).toBe('UsageError')
  })
})

describe('--park-only', () => {
  it('parks and stops (the mcp walk hands a fresh run to an agent host)', async () => {
    const { parseWalkArgs } = await import('../src/args.js')
    expect(parseWalkArgs(['walk', 'mcp', '--park-only']).parkOnly).toBe(true)
    expect(parseWalkArgs(['walk', 'mcp']).parkOnly).toBe(false)
  })
})
