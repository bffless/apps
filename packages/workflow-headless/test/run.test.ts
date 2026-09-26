import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { DRIVE_KEY_HEADER } from '../src/driveKey.js'
import { EXIT } from '../src/errors.js'
import type { RouteLike } from '../src/page.js'
import { graceVerdict, leaseLapsed, runWorkflow } from '../src/run.js'
import { fakeBrowser, fakeClock, fakeRoute, helloRoutes, type Route } from './fakes.js'

const out = () => mkdtempSync(join(tmpdir(), 'wfh-run-'))

const options = (timeoutMs: number, dir?: string) => ({
  harnessUrl: 'https://harness.test',
  impl: 'hello',
  workflow: 'demo',
  inputs: {},
  ...(dir === undefined ? {} : { out: dir }),
  timeoutMs,
  mocks: true,
})

describe('runWorkflow — a start that never settles', () => {
  /**
   * Exit 4 before a run id exists is the un-diagnosable case: every refusal the
   * page can explain arrives as `invalid`, so if the start timeout wrote
   * nothing there would be no evidence at all of an auth bounce loop or a run
   * page that threw. The artifacts are the whole diagnosis.
   */
  test('still writes failed.png, console.log and steps.log before it throws', async () => {
    const dir = out()
    const { browser, page } = fakeBrowser({
      globals: [undefined],
      routes: helloRoutes('succeeded'),
      consoleLines: ['error: Uncaught TypeError: cannot read properties of undefined'],
    })

    await expect(
      runWorkflow(options(50, dir), { browser, log: () => {}, warn: () => {} }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })

    expect(existsSync(join(dir, 'failed.png'))).toBe(true)
    expect(readFileSync(join(dir, 'console.log'), 'utf8')).toContain('Uncaught TypeError')
    // Empty, because nothing ever transitioned — but present, so the artifact
    // set a passing run leaves and a start-timeout leaves are the same shape.
    expect(readFileSync(join(dir, 'steps.log'), 'utf8')).toBe('')
    // Not the milestone shot: the start never settled.
    expect(page.screenshots.map((p) => p.split('/').pop())).toEqual(['failed.png'])
  })

  test('writes nothing when there is no --out to write to', async () => {
    const { browser, page } = fakeBrowser({ globals: [undefined], routes: helloRoutes('succeeded') })

    await expect(
      runWorkflow(options(50), { browser, log: () => {}, warn: () => {} }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })

    expect(page.screenshots).toEqual([])
  })
})

describe('runWorkflow — a login that never returns', () => {
  /**
   * The relay login is the driver's least-covered path — `--mocks` skips it
   * entirely — and it runs before any artifact exists, so its first live
   * failure (a GitHub runner, 2026-08-28) produced an empty `output/` and no
   * way to tell a bot challenge from a wrong password. What the browser is
   * *looking at* is the whole diagnosis, so it goes into both the message and
   * the artifacts.
   */
  test('captures the page it is stuck on, in the error and on disk', async () => {
    const dir = out()
    const { browser, page } = fakeBrowser({
      globals: [undefined],
      routes: helloRoutes('succeeded'),
      login: 'stuck',
      pageText: 'Just a moment… | Checking your browser before accessing workflow.j5s.dev',
      consoleLines: ['error: challenge script'],
    })

    const live = { ...options(50, dir), mocks: false, credentials: { email: 'a@b.c', password: 'x' } }

    // One call, not two: a second run into the same `--out` would rewrite the
    // very console.log this asserts on.
    const error = await runWorkflow(live, { browser, log: () => {}, warn: () => {} }).then(
      () => null,
      (thrown: unknown) => thrown as { code: number; message: string },
    )

    expect(error?.code).toBe(EXIT.USAGE)
    // The URL it is stuck on and the page's own words — enough to tell a
    // challenge from a refusal without re-running anything.
    expect(error?.message).toContain('https://admin.test/login')
    expect(error?.message).toContain('Checking your browser')

    expect(existsSync(join(dir, 'failed.png'))).toBe(true)
    expect(readFileSync(join(dir, 'console.log'), 'utf8')).toContain('challenge script')
    expect(page.clicks).toContain('button[type="submit"]')
  })
})

describe('runWorkflow — --wait park', () => {
  /**
   * The whole point of a driven run (DR9): the driver reaches a step that needs
   * a person, hands the run back — the row stays `running`, the lease is
   * released — and says where it stopped, instead of failing the run or waiting
   * out the timeout on something no unattended process can answer.
   */
  const RECORD = '/api/workflow/run?id=run_1'
  const parked = [
    { runId: 'run_1', status: 'running', steps: { 'ask/0/answer': 'running' } },
    { runId: 'run_1', status: 'parked', currentSteps: ['ask/0/answer'] },
  ]
  const record = (over: { run?: Record<string, unknown>; steps?: unknown[] } = {}): Route => ({
    status: 200,
    text: JSON.stringify({
      run: {
        runId: 'run_1',
        status: 'running',
        impl: 'hello',
        workflow: 'demo',
        leaseOwner: null,
        leaseUntil: null,
        outputs: {},
        ...over.run,
      },
      steps: over.steps ?? [{ key: 'ask/0/answer', status: 'waiting' }],
    }),
  })
  const park = (dir: string | undefined, over: Record<string, unknown> = {}) => ({
    ...options(5_000, dir),
    wait: 'park' as const,
    graceMs: 0,
    ...over,
  })

  test('a parked page ends the job at exit-zero, saying which steps wait on a person', async () => {
    const dir = out()
    const { browser } = fakeBrowser({ globals: parked, routes: helloRoutes('running') })

    const report = await runWorkflow(park(dir), { browser, log: () => {}, warn: () => {} })

    expect(report).toMatchObject({ status: 'parked', parkedOn: ['ask/0/answer'] })
    // The record is *not* sealed and must not be reported as if it were: what
    // run.json carries is the row as it stands, `running`, which is exactly
    // what a later `resume` has to find.
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('running')
    expect(readFileSync(join(dir, 'steps.log'), 'utf8')).toContain('\trun\tparked')
  })

  test('the page is told to park, and to use the pre-minted id when there is one', async () => {
    const { browser } = fakeBrowser({ globals: parked, routes: helloRoutes('running') })
    const plain = await runWorkflow(park(undefined), { browser, log: () => {}, warn: () => {} })
    expect(plain.url).toContain('&wait=park')
    expect(plain.url).not.toContain('&runId=')

    const second = fakeBrowser({ globals: parked, routes: helloRoutes('running') })
    const withId = await runWorkflow(park(undefined, { runId: 'run_1' }), {
      browser: second.browser,
      log: () => {},
      warn: () => {},
    })
    // One id shared by the run and its `resume`, minted before the page opens.
    expect(withId.url).toContain('&runId=run_1')
  })

  /**
   * The grace window (DR9): the person the run is waiting on is often right
   * there. Rather than end the job and make CI schedule a second one, the
   * driver watches the record — and the moment every parked step has an answer
   * and nobody else has taken the lease, it re-opens the page with `resume=1`
   * and drives the rest of the run in the same job.
   */
  test('an answer inside the window is picked up: the page is resumed and the run followed home', async () => {
    const routes = helloRoutes('running')
    routes[RECORD] = [
      record(),
      // The answered read comes back as a `{ fields }` envelope, which is how
      // the data table hands rows back through the query endpoint.
      record({ steps: [{ fields: { key: 'ask/0/answer', status: 'succeeded' } }] }),
      record({ run: { status: 'succeeded' } }),
    ]
    const { browser, page } = fakeBrowser({
      globals: [
        ...parked,
        { runId: 'run_1', status: 'running' },
        { runId: 'run_1', status: 'succeeded' },
      ],
      routes,
    })

    const report = await runWorkflow(park(undefined, { graceMs: 60_000 }), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(page.gotos).toContain('https://harness.test/hello/demo/runs/run_1?resume=1&wait=park')
    expect(report.status).toBe('succeeded')
    expect(report.parkedOn).toBeUndefined()
  })

  test('a lease taken while the driver waited is left alone', async () => {
    const routes = helloRoutes('running')
    routes[RECORD] = record({
      run: { leaseOwner: 'tab_x', leaseUntil: Date.now() + 60_000 },
      steps: [{ key: 'ask/0/answer', status: 'succeeded' }],
    })
    const { browser, page } = fakeBrowser({ globals: parked, routes })

    const report = await runWorkflow(park(undefined, { graceMs: 60_000 }), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    // Answered, but somebody else is driving it now — a person's tab (DR4) or a
    // second job. Two drivers on one run is the one thing the lease exists to
    // prevent, so this one reports the park and leaves.
    expect(report.status).toBe('parked')
    expect(page.gotos.some((url) => url.includes('resume=1'))).toBe(false)
  })
})

describe('runWorkflow — a page that stopped driving (apps#716)', () => {
  /**
   * The bug this closes (#712): a run page that stopped heartbeating — the tab
   * was throttled, the SPA paused itself, the lease lapsed — looked merely slow
   * to the driver, which waited out the whole `--timeout` on a page that would
   * never move again and then reported 4, "the run may still be going". Two
   * signals say otherwise, and either ends the leg as `stalled`: the page's
   * own `paused` (apps#715), read every second like every other page state, and
   * the record's lease — an owner, and a `leaseUntil` already past while the
   * row still says `running` — re-read every 10 s.
   */
  const RECORD = '/api/workflow/run?id=run_1'
  const stuck = [{ runId: 'run_1', status: 'running', currentSteps: ['work/0/x'], steps: { 'work/0/x': 'running' } }]
  const quiet = (browser: import('../src/page.js').BrowserLike, clock: ReturnType<typeof fakeClock>) => ({
    browser,
    log: () => {},
    warn: () => {},
    ...clock,
  })

  test('a lapsed lease on a page still saying `running` ends the leg `stalled` within 10 s, well before --timeout', async () => {
    const dir = out()
    const clock = fakeClock()
    const { browser, page } = fakeBrowser({
      globals: stuck,
      routes: helloRoutes('running', 'run_1', { leaseOwner: 'tab', leaseUntil: clock.now() - 1 }),
    })

    const report = await runWorkflow(options(60_000, dir), quiet(browser, clock))

    expect(report).toMatchObject({ status: 'stalled', stalledOn: ['work/0/x'] })
    expect(report.parkedOn).toBeUndefined()
    // First ask is one interval in, on the injected clock — not the deadline.
    expect(clock.now() - 1_700_000_000_000).toBe(10_000)
    // Nothing was clicked: no Cancel, no resume. The row is left as it was.
    expect(page.clicks).toEqual([])
    expect(page.gotos.some((url) => url.includes('resume=1'))).toBe(false)
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { run: { status: string } }
    expect(written.run.status).toBe('running')
    // The usual artifacts, plus the stall's own shot; no outputs — nothing ended.
    expect(existsSync(join(dir, '03-stalled.png'))).toBe(true)
    expect(existsSync(join(dir, 'failed.png'))).toBe(false)
    expect(report.artifacts.written).toEqual([])
    // steps.log ends on the run's own line, saying why the leg did.
    expect(readFileSync(join(dir, 'steps.log'), 'utf8').trimEnd().split('\n').pop()).toMatch(/\trun\tstalled$/)
  })

  test('a page that publishes `paused` ends the leg `stalled` on the next read, with no record round trip', async () => {
    const clock = fakeClock()
    const { browser, page } = fakeBrowser({
      // The start read, one follow read that still says `running`, then `paused`.
      globals: [...stuck, ...stuck, { runId: 'run_1', status: 'paused', currentSteps: ['work/0/x'] }],
      routes: helloRoutes('running'),
    })

    const report = await runWorkflow(options(60_000), quiet(browser, clock))

    expect(report).toMatchObject({ status: 'stalled', stalledOn: ['work/0/x'] })
    // One page poll — the stall check's first ask was still nine seconds away.
    expect(clock.now() - 1_700_000_000_000).toBe(1_000)
    // Only `collect`'s single read of the record — the stall check never fell due.
    expect(page.fetched.filter((k) => k === RECORD)).toHaveLength(1)
    expect(page.clicks).toEqual([])
  })

  test('`--wait fail` stalls the same way — `paused` is not a status any wait can follow past', async () => {
    const clock = fakeClock()
    const { browser } = fakeBrowser({
      globals: [...stuck, { runId: 'run_1', status: 'paused', currentSteps: ['work/0/x'] }],
      routes: helloRoutes('running'),
    })
    const report = await runWorkflow({ ...options(60_000), wait: 'fail' }, quiet(browser, clock))
    expect(report.status).toBe('stalled')
  })

  test.each([
    ['a null lease (a park in progress)', {}],
    ['a live lease (the page is driving)', { leaseOwner: 'tab', leaseUntil: 1_700_000_000_000 + 3_600_000 }],
  ])('%s changes nothing: --timeout still exits 4', async (_name, lease) => {
    const clock = fakeClock()
    const { browser, page } = fakeBrowser({ globals: stuck, routes: helloRoutes('running', 'run_1', lease) })

    await expect(runWorkflow(options(30_000), quiet(browser, clock))).rejects.toMatchObject({ code: EXIT.TIMEOUT })
    // The record *was* asked, on the 10 s cadence — it just never said stalled.
    expect(page.fetched.filter((k) => k === RECORD)).toHaveLength(3)
  })

  test('a terminal record under a page still saying `running` is not a stall either', async () => {
    const clock = fakeClock()
    const { browser } = fakeBrowser({
      globals: stuck,
      routes: helloRoutes('succeeded', 'run_1', { leaseOwner: 'tab', leaseUntil: clock.now() - 1 }),
    })
    await expect(runWorkflow(options(30_000), quiet(browser, clock))).rejects.toMatchObject({ code: EXIT.TIMEOUT })
  })
})

describe('leaseLapsed', () => {
  const now = 1_700_000_000_000
  const body = (run: Record<string, unknown>) => ({
    run: { runId: 'run_1', status: 'running', leaseOwner: null, leaseUntil: null, ...run },
    steps: [],
  })

  test('a running row whose owned lease is in the past', () => {
    expect(leaseLapsed(body({ leaseOwner: 'tab', leaseUntil: now - 1 }), now)).toBe(true)
  })

  test('a live lease, a null lease, and a lease at exactly now are not', () => {
    expect(leaseLapsed(body({ leaseOwner: 'tab', leaseUntil: now + 1 }), now)).toBe(false)
    expect(leaseLapsed(body({}), now)).toBe(false)
    expect(leaseLapsed(body({ leaseOwner: 'tab', leaseUntil: now }), now)).toBe(false)
    // An owner with no expiry is malformed, not lapsed.
    expect(leaseLapsed(body({ leaseOwner: 'tab' }), now)).toBe(false)
  })

  test('only a `running` row can stall', () => {
    for (const status of ['succeeded', 'failed', 'cancelled', 'pending']) {
      expect(leaseLapsed(body({ status, leaseOwner: 'tab', leaseUntil: now - 1 }), now)).toBe(false)
    }
  })

  test('a body that is not a record at all is not a stall, never a crash', () => {
    expect(leaseLapsed(null, now)).toBe(false)
    expect(leaseLapsed('<!doctype html>', now)).toBe(false)
    expect(leaseLapsed({ run: null }, now)).toBe(false)
  })
})

describe('graceVerdict', () => {
  const body = (run: Record<string, unknown>, steps: unknown[]) => ({
    run: { runId: 'run_1', status: 'running', leaseOwner: null, leaseUntil: null, ...run },
    steps,
  })
  const now = 1_700_000_000_000

  test('an unanswered step is still worth waiting for', () => {
    expect(graceVerdict(body({}, [{ key: 'ask/0/answer', status: 'waiting' }]), ['ask/0/answer'], now)).toBe('wait')
  })

  test('every parked step answered, and the lease free, is a resume', () => {
    const answered = body({}, [
      { key: 'ask/0/answer', status: 'succeeded' },
      { fields: { key: 'ask/1/sign', status: 'skipped' } },
    ])
    expect(graceVerdict(answered, ['ask/0/answer', 'ask/1/sign'], now)).toBe('answered')
    // One of the two still waiting is not an answer.
    expect(graceVerdict(answered, ['ask/0/answer', 'ask/2/other'], now)).toBe('wait')
  })

  test('a live lease is `held`, whatever the steps say', () => {
    const held = body({ leaseOwner: 'tab_x', leaseUntil: now + 1 }, [
      { key: 'ask/0/answer', status: 'succeeded' },
    ])
    expect(graceVerdict(held, ['ask/0/answer'], now)).toBe('held')
    // A lapsed lease is nobody's: the owner's tab went away.
    expect(graceVerdict(body({ leaseOwner: 'tab_x', leaseUntil: now }, [
      { key: 'ask/0/answer', status: 'succeeded' },
    ]), ['ask/0/answer'], now)).toBe('answered')
  })

  test('a run that ended under the driver reports its own status', () => {
    expect(graceVerdict(body({ status: 'cancelled' }, []), ['ask/0/answer'], now)).toBe('cancelled')
    // Even held: a terminal run has nothing left for either driver to do.
    expect(graceVerdict(body({ status: 'succeeded', leaseOwner: 'tab_x', leaseUntil: now + 1 }, []), [], now)).toBe('succeeded')
  })

  test('a body that is not a record at all is a wait, never a crash', () => {
    expect(graceVerdict(null, ['ask/0/answer'], now)).toBe('wait')
    expect(graceVerdict('<!doctype html>', ['ask/0/answer'], now)).toBe('wait')
  })
})

describe('runWorkflow — a record that seals after the page does', () => {
  /**
   * The page's terminal pill and the run record's status are written by two
   * different actors: the pill by the run page's render, the record by the
   * SPA's sealing `POST /api/workflow/run/update` — which #539 made
   * `keepalive`, a promise that survives a tab close but not `browser.close()`
   * of the whole process. The live `headless` walk of 2026-08-30 proved the
   * window: the driver saw "Succeeded", exited 0, and left
   * run_01M1BREJZK5V77ZRPXKTG7ZG7C `running` forever. So after the page shows
   * terminal, the driver must hold the browser open until the *record* agrees.
   */
  const key = '/api/workflow/run?id=run_1'
  const record = (status: string) => ({
    status: 200,
    text: JSON.stringify({ run: { runId: 'run_1', status, outputs: {} }, steps: [] }),
  })
  const globals = [
    { runId: 'run_1', status: 'running' },
    { runId: 'run_1', status: 'succeeded' },
  ]

  test('polls the record until it reports a terminal status, and run.json carries it', async () => {
    const dir = out()
    const routes = helloRoutes('succeeded')
    routes[key] = [record('running'), record('running'), record('running'), record('succeeded')]
    const { browser, page } = fakeBrowser({ globals, routes })

    const report = await runWorkflow(options(5_000, dir), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report.status).toBe('succeeded')
    // The record was re-read until it sealed — not snapshotted mid-race.
    expect(page.fetched.filter((k) => k === key).length).toBeGreaterThanOrEqual(4)
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('succeeded')
  })

  test('waits for the seal even with no --out — closing early is the race itself', async () => {
    const routes = helloRoutes('succeeded')
    routes[key] = [record('running'), record('succeeded')]
    const { browser, page } = fakeBrowser({ globals, routes })

    const report = await runWorkflow(options(5_000), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report.status).toBe('succeeded')
    expect(page.fetched.filter((k) => k === key).length).toBeGreaterThanOrEqual(2)
  })

  test('a record that never seals: bounded, warned, freshest read written, page status kept', async () => {
    const dir = out()
    const routes = helloRoutes('succeeded')
    routes[key] = record('running')
    const { browser } = fakeBrowser({ globals, routes })

    const warns: string[] = []
    const report = await runWorkflow(options(5_000, dir), {
      browser,
      log: () => {},
      warn: (line) => warns.push(line),
      sleep: async () => {},
    })

    // The exit vocabulary is untouched: the page saw `succeeded`, so the
    // report says `succeeded` — the unsealed record is a warning, not a code.
    expect(report.status).toBe('succeeded')
    expect(warns.some((line) => line.includes('run_1') && line.includes('running'))).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('running')
  })
})

describe('runWorkflow — which login', () => {
  const EXCHANGE = 'https://admin.test/api/auth/session/from-app-token'
  const live = (over: Record<string, unknown>) => ({ ...options(5_000), mocks: false, ...over })
  const quiet = (browser: import('../src/page.js').BrowserLike) => ({ browser, log: () => {}, warn: () => {} })

  /**
   * apps#588: an app token is a whole credential. With one set, the session
   * comes from CE's exchange — no relay form, no password — and the same token
   * rides every `/api/workflow/*` call as a Bearer. The Bearer half is the bug
   * this pins: `cli.ts` used to spread `appToken` into a `RunOptions` that had
   * no such field, so `run` alone silently sent none.
   */
  test('an app token signs in through the exchange and is the Bearer on every harness call', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    const report = await runWorkflow(live({ appToken: 'bfat_x' }), quiet(browser))
    expect(report.status).toBe('succeeded')
    expect(page.posts).toEqual([{ url: EXCHANGE, headers: { Authorization: 'Bearer bfat_x' } }])
    expect(page.clicks).not.toContain('button[type="submit"]')
    const record = page.requests.find((r) => r.key === '/api/workflow/run?id=run_1')
    expect(record?.headers).toMatchObject({ Authorization: 'Bearer bfat_x' })
  })

  test('the token wins when email and password are set too — the relay form is never filled', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow(live({ appToken: 'bfat_x', credentials: { email: 'a@b.c', password: 'x' } }), quiet(browser))
    expect(page.posts).toHaveLength(1)
    expect(page.clicks).not.toContain('button[type="submit"]')
  })

  test('without a token the relay login is the fallback', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow(live({ credentials: { email: 'a@b.c', password: 'x' } }), quiet(browser))
    expect(page.posts).toEqual([])
    // The fake never lands on the relay's form, so the visit to it is the proof the relay path ran.
    expect(page.gotos.some((u) => u.includes('/login?redirect='))).toBe(true)
  })

  test('with neither, and no --mocks, it is a usage fault that names both ways in', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    const error = await runWorkflow(live({}), quiet(browser)).then(
      () => null,
      (thrown: unknown) => thrown as { code: number; message: string },
    )
    expect(error?.code).toBe(EXIT.USAGE)
    expect(error?.message).toContain('WORKFLOW_APP_TOKEN')
    expect(error?.message).toContain('WORKFLOW_EMAIL')
    expect(page.gotos).toEqual([])
  })

  test("a refused exchange is exit 2 with CE's code, and writes the failure artifacts", async () => {
    const dir = out()
    const { browser } = fakeBrowser({
      globals: [{ runId: 'run_1', status: 'succeeded' }],
      routes: helloRoutes('succeeded'),
      exchange: { status: 403, text: JSON.stringify({ code: 'insufficient_scope', missingScopes: ['auth:session'] }) },
    })
    const error = await runWorkflow({ ...live({ appToken: 'bfat_x' }), out: dir }, quiet(browser)).then(
      () => null,
      (thrown: unknown) => thrown as { code: number; message: string },
    )
    expect(error?.code).toBe(EXIT.USAGE)
    expect(error?.message).toContain('insufficient_scope')
    expect(error?.message).toContain('auth:session')
    // No "stuck at about:blank": nothing was navigated, so there is no page to describe.
    expect(error?.message).not.toContain('about:blank')
    expect(existsSync(join(dir, 'failed.png'))).toBe(true)
  })
})

describe('runWorkflow — driveKey', () => {
  test('with a driveKey, installs one route whose matcher accepts the harness API paths and rejects everything else', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow({ ...options(5_000), driveKey: 'dk_abc123' }, { browser, log: () => {}, warn: () => {} })

    expect(page.routes).toHaveLength(1)
    const { matcher } = page.routes[0]!
    expect(matcher(new URL('https://harness.test/api/workflow/runs'))).toBe(true)
    expect(matcher(new URL('https://harness.test/api/uploads/x'))).toBe(true)
    expect(matcher(new URL('https://bucket.example/o'))).toBe(false)
    expect(matcher(new URL('https://harness.test/w/hello/x'))).toBe(false)
    // The bucket is never matched because no presigned URL's path begins `/api/` —
    // the harness mints keys under `workflows/<impl>/<workflow>/<scope>/`, so a
    // virtual-host GCS URL is `/workflows/…`, not because of the origin.
    expect(matcher(new URL('https://storage.googleapis.com/b/workflows/hello/demo/inputs/x.png'))).toBe(false)
  })

  test('the handler adds x-workflow-drive-key and preserves the request’s existing headers', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow({ ...options(5_000), driveKey: 'dk_abc123' }, { browser, log: () => {}, warn: () => {} })

    const { handler } = page.routes[0]!
    const { route, calls } = fakeRoute({ 'content-type': 'application/json' })
    await handler(route)
    expect(calls).toEqual([
      { headers: { 'content-type': 'application/json', [DRIVE_KEY_HEADER]: 'dk_abc123' } },
    ])
  })

  test('a handler whose route.continue rejects (page/browser gone) does not throw', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow({ ...options(5_000), driveKey: 'dk_abc123' }, { browser, log: () => {}, warn: () => {} })

    const { handler } = page.routes[0]!
    const route: RouteLike = {
      request: () => ({ headers: () => ({}) }),
      continue: async () => {
        throw new Error('Target page, context or browser has been closed')
      },
    }
    await expect(handler(route)).resolves.toBeUndefined()
  })

  test('without a driveKey, no route is installed', async () => {
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow(options(5_000), { browser, log: () => {}, warn: () => {} })
    expect(page.routes).toEqual([])
  })

  test('the route is installed before the first goto', async () => {
    // Ordering, not just presence: a refactor that moved `installDriveKey`
    // below the navigation would leave the SPA's own first calls (the
    // `runs/post` among them) unkeyed, and every other test here would pass.
    const { browser, page } = fakeBrowser({ globals: [{ runId: 'run_1', status: 'succeeded' }], routes: helloRoutes('succeeded') })
    await runWorkflow({ ...options(5_000), driveKey: 'dk_abc123' }, { browser, log: () => {}, warn: () => {} })

    expect(page.gotos.length).toBeGreaterThan(0)
    expect(page.calls[0]).toEqual({ kind: 'route' })
    expect(page.calls.findIndex((c) => c.kind === 'route')).toBeLessThan(
      page.calls.findIndex((c) => c.kind === 'goto'),
    )
  })
})
