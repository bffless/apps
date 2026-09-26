import { describe, test, expect } from 'vitest'
import { DriverError, EXIT } from '../src/errors.js'
import type { PageLike } from '../src/page.js'
import {
  formatTransition,
  GRACE_POLL_MS,
  SETTLED,
  TERMINAL,
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

  /**
   * apps#716: `paused` is the page's own word for "I stopped driving" (apps#715).
   * It is not a run status — `TERMINAL` does not gain it — but no `--wait` mode
   * can follow past it, so the terminal wait returns on it rather than waiting
   * out `--timeout` on a page that will never move again.
   */
  test('a paused page returns too — the page stopped driving, whatever the run is doing', async () => {
    const clock = fakeClock()
    const page = fakePage([
      snap({ status: 'running', currentSteps: ['a/0/x'] }),
      snap({ status: 'paused', currentSteps: ['a/0/x'] }),
    ])
    const terminal = await waitForTerminal(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(terminal.status).toBe('paused')
    expect(terminal.currentSteps).toEqual(['a/0/x'])
    expect(TERMINAL.has('paused')).toBe(false)
  })
})

/**
 * The stall seam (apps#716): a slower second question asked while the poll
 * waits on the page — `followRun` answers it off the record's lease. The poll
 * itself only knows the cadence and what a `true` means.
 */
describe('poll — the stall check', () => {
  test('asks once per stallPollMs on the injected clock, first at one interval in, and still times out', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' })])
    const askedAt: number[] = []
    const stalled = async () => {
      askedAt.push(clock.now() - 1_700_000_000_000)
      return false
    }
    await expect(
      waitForSettled(page, { timeoutMs: 35_000, pollMs: 1000, stallPollMs: 10_000, stalled, ...clock }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })
    expect(askedAt).toEqual([10_000, 20_000, 30_000])
  })

  test('a `true` ends the wait with `stalled`, carrying the page’s last snapshot', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running', currentSteps: ['a/0/x'], steps: { 'a/0/x': 'running' } })])
    let asked = 0
    const stalled = async () => {
      asked += 1
      return asked === 2
    }
    const seen: Transition[] = []
    const settled = await waitForTerminal(page, {
      timeoutMs: 60_000,
      pollMs: 1000,
      stallPollMs: 10_000,
      stalled,
      onTransition: (t) => seen.push(t),
      ...clock,
    })
    expect(settled.status).toBe('stalled')
    expect(settled.runId).toBe('run_1')
    expect(settled.currentSteps).toEqual(['a/0/x'])
    expect(asked).toBe(2)
    expect(clock.now() - 1_700_000_000_000).toBe(20_000)
    // The page never said `stalled`, so the poll does not log it as if it had —
    // that line is `followRun`'s to write.
    expect(seen.map((t) => `${t.key} ${t.status}`)).toEqual(['a/0/x running', 'run running'])
  })

  test('the page’s own answer wins on the same tick', async () => {
    const clock = fakeClock()
    // Succeeds on the very read where the first stall ask falls due.
    const script = Array.from({ length: 10 }, () => snap({ status: 'running' }))
    script.push(snap({ status: 'succeeded' }))
    const page = fakePage(script)
    const stalled = async () => true
    const settled = await waitForTerminal(page, { timeoutMs: 60_000, pollMs: 1000, stallPollMs: 10_000, stalled, ...clock })
    expect(settled.status).toBe('succeeded')
  })

  test('without a `stalled`, nothing is asked — a slow-to-mount page is only ever a timeout', async () => {
    const clock = fakeClock()
    // No runId yet: the run page has not mounted, which is `waitForStart`'s
    // whole question. `stallPollMs` alone must not turn that into a stall.
    const page = fakePage([snap({ runId: '', status: '' })])
    await expect(
      waitForStart(page, { timeoutMs: 30_000, pollMs: 1000, stallPollMs: 1000, ...clock }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })
    expect(page.reads).toBe(31)
    expect(GRACE_POLL_MS).toBe(10_000)
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

  test('a paused page settles — it stopped driving without parking (apps#716)', async () => {
    const clock = fakeClock()
    const page = fakePage([snap({ status: 'running' }), snap({ status: 'paused', currentSteps: ['a/0/x'] })])
    const settled = await waitForSettled(page, { timeoutMs: 60_000, pollMs: 1000, ...clock })
    expect(settled.status).toBe('paused')
    expect(settled.currentSteps).toEqual(['a/0/x'])
    expect(SETTLED.has('paused')).toBe(true)
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
