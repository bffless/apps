import { describe, test, expect } from 'vitest'
import { DriverError, EXIT } from '../src/errors.js'
import type { PageLike } from '../src/page.js'
import {
  formatTransition,
  waitForSettled,
  waitForStart,
  waitForTerminal,
  type Snapshot,
  type Transition,
} from '../src/observe.js'

const snap = (over: Partial<Snapshot>): Snapshot => ({
  runId: 'run_1',
  status: 'running',
  currentSteps: [],
  outputs: {},
  steps: {},
  ...over,
})

/**
 * A page whose `evaluate` just hands back the next scripted `window.__workflow`
 * — the last entry repeats forever, so a "never finishes" case is one short
 * list. No browser is launched anywhere in this suite.
 */
function fakePage(script: Array<Snapshot | undefined>): PageLike & { reads: number } {
  let i = 0
  const page = {
    reads: 0,
    async evaluate() {
      const value = script[Math.min(i, script.length - 1)]
      i += 1
      page.reads += 1
      return value
    },
  } as unknown as PageLike & { reads: number }
  return page
}

/** A clock that only moves when the poll sleeps — no real time passes. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('waitForStart', () => {
  test('polls past the commit where no global is published yet', async () => {
    const clock = fakeClock()
    const page = fakePage([undefined, undefined, snap({ runId: 'run_7' })])
    const started = await waitForStart(page, { timeoutMs: 30_000, pollMs: 1000, ...clock })
    expect(started.runId).toBe('run_7')
    expect(page.reads).toBe(3)
  })

  test('an `invalid` page state resolves too — with the errors, and no runId', async () => {
    const clock = fakeClock()
    const page = fakePage([
      snap({ runId: '', status: 'invalid', errors: { discovery: 'could not list implementations' } }),
    ])
    const started = await waitForStart(page, { timeoutMs: 30_000, pollMs: 1000, ...clock })
    expect(started.status).toBe('invalid')
    expect(started.errors).toEqual({ discovery: 'could not list implementations' })
  })

  test('a page that never publishes anything times out with the driver-timeout code', async () => {
    const clock = fakeClock()
    const page = fakePage([undefined])
    await expect(
      waitForStart(page, { timeoutMs: 5_000, pollMs: 1000, ...clock }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })
  })
})

describe('waitForTerminal', () => {
  test('logs every transition exactly once and resolves on the terminal snapshot', async () => {
    const clock = fakeClock()
    const page = fakePage([
      snap({ status: 'running', steps: { 'a/0/x': 'running' }, currentSteps: ['a/0/x'] }),
      snap({ status: 'running', steps: { 'a/0/x': 'running' }, currentSteps: ['a/0/x'] }),
      snap({
        status: 'running',
        steps: { 'a/0/x': 'succeeded', 'b/0/y': 'running' },
        currentSteps: ['b/0/y'],
      }),
      snap({
        status: 'succeeded',
        steps: { 'a/0/x': 'succeeded', 'b/0/y': 'succeeded' },
        outputs: { poster: { path: 'p' } },
      }),
    ])
    const seen: Transition[] = []
    const terminal = await waitForTerminal(page, {
      timeoutMs: 60_000,
      pollMs: 1000,
      onTransition: (t) => seen.push(t),
      ...clock,
    })

    expect(terminal.status).toBe('succeeded')
    expect(terminal.outputs).toEqual({ poster: { path: 'p' } })
    // Steps before the run, every poll — so the run's terminal line is always
    // the last one in steps.log rather than landing above its final step.
    expect(seen.map((t) => `${t.key} ${t.status}`)).toEqual([
      'a/0/x running',
      'run running',
      'a/0/x succeeded',
      'b/0/y running',
      'b/0/y succeeded',
      'run succeeded',
    ])
    // Every transition is stamped with the clock, for steps.log.
    expect(seen.every((t) => t.at >= 1_700_000_000_000)).toBe(true)
  })

  test('a failed run is terminal too', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'failed', steps: { 'a/0/x': 'failed' } })])
    const terminal = await waitForTerminal(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(terminal.status).toBe('failed')
  })

  test('a run that never finishes rejects with the driver-timeout code', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' })])
    const error = await waitForTerminal(page, { timeoutMs: 4_000, pollMs: 1000, ...clock }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.TIMEOUT)
  })

  test('a global that disappears mid-run (a remount) is polled through, not treated as the end', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' }), undefined, snap({ status: 'succeeded' })])
    const terminal = await waitForTerminal(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(terminal.status).toBe('succeeded')
  })
})

/**
 * `waitForSettled` is `waitForTerminal` plus the two *page* states a driven run
 * can stop at (07 `wait=park`, `resume=1`): a run whose page has stopped
 * driving it is done as far as this driver is concerned, even though the row
 * behind it still says `running`. Waiting for a terminal status there is the
 * hang the whole feature exists to remove.
 */
describe('waitForSettled', () => {
  test('a parked page settles, carrying the keys it waits on', async () => {
    const clock = fakeClock()
    const page = fakePage([
      snap({ status: 'running', steps: { 'ask/0/answer': 'running' } }),
      snap({
        status: 'parked',
        currentSteps: ['ask/0/answer'],
        steps: { 'ask/0/answer': 'waiting' },
      }),
    ])
    const settled = await waitForSettled(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(settled.status).toBe('parked')
    expect(settled.currentSteps).toEqual(['ask/0/answer'])
  })

  test('a busy page settles — someone else holds the lease, so there is nothing to follow', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'busy' })])
    const settled = await waitForSettled(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(settled.status).toBe('busy')
  })

  test.each(['succeeded', 'failed', 'cancelled'])('%s still settles', async (status) => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' }), snap({ status })])
    const settled = await waitForSettled(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(settled.status).toBe(status)
  })

  test('a run that neither ends nor parks rejects with the driver-timeout code', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' })])
    await expect(
      waitForSettled(page, { timeoutMs: 4_000, pollMs: 1000, ...clock }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })
  })

  test('transitions are still logged, steps before the run', async () => {
    const clock = fakeClock()
    const page = fakePage([
      snap({ status: 'running', steps: { 'ask/0/answer': 'running' } }),
      snap({ status: 'parked', steps: { 'ask/0/answer': 'waiting' } }),
    ])
    const seen: Transition[] = []
    await waitForSettled(page, {
      timeoutMs: 60_000,
      pollMs: 1000,
      onTransition: (t) => seen.push(t),
      ...clock,
    })
    expect(seen.map((t) => `${t.key} ${t.status}`)).toEqual([
      'ask/0/answer running',
      'run running',
      'ask/0/answer waiting',
      'run parked',
    ])
  })
})

describe('formatTransition', () => {
  test('is one tab-separated line per transition, timestamped', () => {
    expect(formatTransition({ at: 1_700_000_000_000, key: 'a/0/x', status: 'running' })).toBe(
      '2023-11-14T22:13:20.000Z\ta/0/x\trunning',
    )
  })
})
