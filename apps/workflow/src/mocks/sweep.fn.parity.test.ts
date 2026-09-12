/**
 * Parity for the nightly retention sweep (spec 05 §Retention, apps#615) between
 * the rule's two functions — `cutoff.fn.js` and `targets.fn.js` under
 * `.bffless/proxy-rules/workflow/rules/api/workflow/sweep/post/` (the real
 * `function_handler` code — cannot import) — and the mock's twins in `sweep.ts`,
 * reached through `POST /api/workflow/sweep`. `new Function` is test-only
 * tooling to execute the authored `.fn.js` source in isolation; it is never
 * used by the app or the mock at runtime. Same shape as
 * `expiry.fn.parity.test.ts`.
 *
 * What is decided: which due rows a pass sweeps (terminal AND expired — never
 * `running`, never a run without a numeric `expiresAt`, never a row whose
 * segments could not be a safe `file_delete` template), the prefixes the one
 * `file_delete` purges, the exact `sub_dir`s the `workflow_files` delete names,
 * and — only when the scan was not truncated — the ids whose rows go. Plus the
 * link the functions cannot test for themselves: the rule YAML that wires each
 * list to its step, with no validator, no run gate and no `condition`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { MOCK_OTHER, db, fileRecordsMatching, filesUnder, resetDb, seedFinishedRun, seedObject, seedWaitingRun, setMockUser, stepsOf } from './db'
import { DUE_LIMIT, SCAN_LIKE, SCAN_LIMIT, TERMINAL, sweepCutoff, sweepTargets, type DueRow, type SweepTargets } from './sweep'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { WAITING_RUN } from './fixtures/waitingRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RULE_DIR = join(appDir, '.bffless', 'proxy-rules', 'workflow', 'rules', 'api', 'workflow', 'sweep', 'post')
const CUTOFF_FN_PATH = join(RULE_DIR, 'cutoff.fn.js')
const TARGETS_FN_PATH = join(RULE_DIR, 'targets.fn.js')
const RULE_PATH = join(RULE_DIR, 'rule.yaml')

type CutoffHandler = () => { now: number; terminal: string[]; scanLike: string }
type TargetsHandler = (ctx?: { steps?: { cutoff?: unknown; due?: unknown; records?: unknown } }) => SweepTargets

function loadFn<T>(path: string): T {
  const src = readFileSync(path, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory() as T
}

const NOW = 1_700_000_000_000
const PAST = NOW - 1
const CUTOFF = { now: NOW, terminal: TERMINAL }

/** `run_01A` is the boundary case for `run_01AB` below: one prefix must never match the other's rows. */
const A = { id: 'rec_a', runId: 'run_01A', impl: 'hello', workflow: 'hello', status: 'succeeded', expiresAt: PAST }
const B = { id: 'rec_b', runId: 'run_01B', impl: 'hello', workflow: 'hello', status: 'failed', expiresAt: PAST - 5 }
const C = { id: 'rec_c', runId: 'run_01C', impl: 'capture', workflow: 'capture', status: 'cancelled', expiresAt: PAST }

/** The `due` rows as CE's `data_query` hands them (flattened, `id` beside the fields) — one of each decision. */
const DUE: (DueRow | null)[] = [
  A,
  B,
  C,
  // Not swept, not counted: the query would not have returned these, and the
  // function re-decides them anyway.
  { ...A, runId: 'run_01D', status: 'running' },
  { ...A, runId: 'run_01E', expiresAt: NOW },
  { ...A, runId: 'run_01F', expiresAt: undefined },
  { ...A, runId: 'run_01G', expiresAt: String(PAST) },
  // Skipped and reported: a segment that would abort the whole file_delete step.
  { ...A, runId: 'run_01H', impl: '..' },
  { ...A, runId: 'run_01I', workflow: 'a/b' },
  { ...A, runId: 'run_{{J}}' },
  { ...A, runId: 'run 01K' },
  // A duplicate of A and a null row: deduped, ignored.
  { ...A, id: 'rec_a2' },
  null,
]
const RECORDS = [
  { sub_dir: 'workflows/hello/hello/runs/run_01A/greet/0/say' },
  { sub_dir: 'workflows/hello/hello/runs/run_01A/outputs' },
  { sub_dir: 'workflows/hello/hello/runs/run_01A' },
  { sub_dir: 'workflows/hello/hello/runs/run_01AB/outputs' },
  { sub_dir: 'workflows/hello/hello/runs/run_01E/outputs' },
  { sub_dir: 'workflows/hello/hello/inputs' },
  { sub_dir: 'workflows/capture/capture/runs/run_01C/per-video/0/audio' },
  { sub_dir: 'workflows/capture/capture/runs/run_01C/per-video/0/audio' },
  { sub_dir: 42 },
  null,
]
const EXPECTED: SweepTargets = {
  scanLimit: SCAN_LIMIT,
  scanTruncated: false,
  runIds: ['run_01A', 'run_01B', 'run_01C'],
  prefixes: ['workflows/hello/hello/runs/run_01A/', 'workflows/hello/hello/runs/run_01B/', 'workflows/capture/capture/runs/run_01C/'],
  subDirs: [
    'workflows/hello/hello/runs/run_01A/greet/0/say',
    'workflows/hello/hello/runs/run_01A/outputs',
    'workflows/hello/hello/runs/run_01A',
    'workflows/capture/capture/runs/run_01C/per-video/0/audio',
  ],
  rowRunIds: ['run_01A', 'run_01B', 'run_01C'],
  count: 3,
  swept: 3,
  deferred: 0,
  skipped: 4,
}
const EMPTY: SweepTargets = {
  scanLimit: SCAN_LIMIT,
  scanTruncated: false,
  runIds: [],
  prefixes: [],
  subDirs: [],
  rowRunIds: [],
  count: 0,
  swept: 0,
  deferred: 0,
  skipped: 0,
}
const truncatedScan = (n: number) => Array.from({ length: n }, (_, i) => ({ sub_dir: `workflows/other/other/runs/run_x${i}/outputs` }))

describe('sweep cutoff.fn.js', () => {
  let handler: CutoffHandler
  beforeAll(() => {
    handler = loadFn<CutoffHandler>(CUTOFF_FN_PATH)
  })

  it('fixes now, the terminal list and the scan pattern — the same three the mock fixes', () => {
    const before = Date.now()
    const result = handler()
    const after = Date.now()
    expect(result.now).toBeGreaterThanOrEqual(before)
    expect(result.now).toBeLessThanOrEqual(after)
    expect(result.terminal).toEqual(['succeeded', 'failed', 'cancelled'])
    expect(result.terminal).toEqual([...TERMINAL])
    expect(result.scanLike).toBe(SCAN_LIKE)
    expect(sweepCutoff(NOW)).toEqual({ now: NOW, terminal: TERMINAL, scanLike: SCAN_LIKE })
  })

  it('never lists running — a parked driven run is protected by status alone (07)', () => {
    expect(handler().terminal).not.toContain('running')
  })
})

describe('sweep targets.fn.js', () => {
  let handler: TargetsHandler
  beforeAll(() => {
    handler = loadFn<TargetsHandler>(TARGETS_FN_PATH)
  })

  it('decides the same rows, prefixes, sub_dirs and ids as the mock', () => {
    const result = handler({ steps: { cutoff: CUTOFF, due: DUE, records: RECORDS } })
    expect(result).toEqual(EXPECTED)
    expect(sweepTargets(DUE, RECORDS, CUTOFF)).toEqual(EXPECTED)
  })

  it('reads the envelope forms older CE versions answer with', () => {
    expect(handler({ steps: { cutoff: CUTOFF, due: { records: DUE }, records: { data: RECORDS } } })).toEqual(EXPECTED)
  })

  it('a quiet night: nothing due, nothing scanned — every list empty, every count zero', () => {
    expect(handler({ steps: { cutoff: CUTOFF, due: [], records: [] } })).toEqual(EMPTY)
    expect(sweepTargets([], [], CUTOFF)).toEqual(EMPTY)
  })

  it('a truncated scan keeps every row for the next pass — bytes and found records still go', () => {
    const scan = [...RECORDS, ...truncatedScan(SCAN_LIMIT - RECORDS.length)]
    const deferred: SweepTargets = { ...EXPECTED, scanTruncated: true, rowRunIds: [], swept: 0, deferred: 3 }
    expect(handler({ steps: { cutoff: CUTOFF, due: DUE, records: scan } })).toEqual(deferred)
    expect(sweepTargets(DUE, scan, CUTOFF)).toEqual(deferred)
    // One row short of the limit is a complete scan.
    const complete = [...RECORDS, ...truncatedScan(SCAN_LIMIT - RECORDS.length - 1)]
    expect(handler({ steps: { cutoff: CUTOFF, due: DUE, records: complete } }).scanTruncated).toBe(false)
  })

  it('never throws on the empty call CE makes of a bundle, and falls back to its own now', () => {
    expect(() => handler()).not.toThrow()
    expect(handler({})).toEqual(EMPTY)
    expect(handler({ steps: { cutoff: null, due: null, records: 'nope' } })).toEqual(EMPTY)
    // No cutoff at all: `Date.now()` stands in, so an expired row still sweeps.
    expect(handler({ steps: { due: [A], records: [] } }).runIds).toEqual(['run_01A'])
  })
})

/**
 * The link the functions cannot test for themselves: the rule that carries
 * their lists onto the delete steps. A typo in any expression would deploy
 * green and silently sweep nothing — or, worse, everything a bare `prefix`
 * could be steered to.
 */
describe('the rule wires the lists onto the deletes', () => {
  interface Step {
    id: string
    handler: string
    code?: string
    config?: {
      limit?: number
      prefixes?: string
      filterLogic?: string
      filters?: Record<string, { op: string; value: string }>
      condition?: string
      body?: string
    }
  }
  const doc = parse(readFileSync(RULE_PATH, 'utf8')) as { order: number; pipeline: { steps: Step[]; validators: unknown[] } }
  const step = (id: string) => doc.pipeline.steps.find((s) => s.id === id)!

  it('is schedule-fired: no validator, no run gate, no caller read, no condition', () => {
    expect(doc.pipeline.validators).toEqual([])
    const text = JSON.stringify(doc.pipeline.steps)
    expect(text).not.toMatch(/runGate|\buser\./)
    for (const s of doc.pipeline.steps) expect(s.config?.condition, s.id).toBeUndefined()
  })

  it('runs the steps in run/delete’s order: cutoff → due → records → targets → files → recs → stepRows → rows → respond', () => {
    expect(doc.pipeline.steps.map((s) => s.id)).toEqual(['cutoff', 'due', 'records', 'targets', 'files', 'recs', 'stepRows', 'rows', 'respond'])
    expect(step('cutoff').code).toBe('./cutoff.fn.js')
    expect(step('targets').code).toBe('./targets.fn.js')
  })

  it('due: expired AND terminal, from the cutoff’s own values, bounded to DUE_LIMIT', () => {
    const due = step('due')
    expect(due.handler).toBe('data_query')
    expect(due.config?.limit).toBe(DUE_LIMIT)
    expect(due.config?.filterLogic).toBe('and')
    expect(due.config?.filters).toEqual({
      expiresAt: { op: 'lt', value: 'steps.cutoff.now' },
      status: { op: 'in', value: 'steps.cutoff.terminal' },
    })
  })

  it('records: the anchored scan, its limit equal to the function’s SCAN_LIMIT', () => {
    const records = step('records')
    expect(records.handler).toBe('data_query')
    expect(records.config?.filters).toEqual({ sub_dir: { op: 'like', value: 'steps.cutoff.scanLike' } })
    expect(records.config?.limit).toBe(SCAN_LIMIT)
    expect(loadFn<TargetsHandler>(TARGETS_FN_PATH)({}).scanLimit).toBe(SCAN_LIMIT)
  })

  it('files: ONE file_delete in prefixes mode over the function’s list — never a bare prefix', () => {
    const files = step('files')
    expect(files.handler).toBe('file_delete')
    expect(files.config).toEqual({ prefixes: 'steps.targets.prefixes' })
  })

  it('recs / stepRows / rows: each an `in` over the function’s own list, in that order', () => {
    expect(step('recs').config?.filters).toEqual({ sub_dir: { op: 'in', value: 'steps.targets.subDirs' } })
    expect(step('stepRows').config?.filters).toEqual({ runId: { op: 'in', value: 'steps.targets.rowRunIds' } })
    expect(step('rows').config?.filterLogic).toBe('and')
    expect(step('rows').config?.filters).toEqual({
      runId: { op: 'in', value: 'steps.targets.rowRunIds' },
      status: { op: 'in', value: 'steps.cutoff.terminal' },
      expiresAt: { op: 'lt', value: 'steps.cutoff.now' },
    })
  })

  it('respond reports every count, numbers only', () => {
    const body = step('respond').config?.body ?? ''
    for (const key of ['targets.swept', 'targets.deferred', 'targets.skipped', 'files.deleted', 'recs.count', 'stepRows.count', 'rows.count']) {
      expect(body).toContain(`{{steps.${key}}}`)
    }
    // Rendered with every count at 0, it is JSON.
    const rendered = body.replace(/\{\{steps\.[\w.]+\}\}/g, '0')
    expect(JSON.parse(rendered)).toEqual({ ok: true, swept: 0, deferred: 0, skipped: 0, deleted: { files: 0, records: 0, steps: 0, runs: 0 } })
  })
})

describe('POST /api/workflow/sweep (mock)', () => {
  const RUN_ID = FINISHED_RUN.run.runId
  const PREFIX = `workflows/hello/hello/runs/${RUN_ID}/`
  const KEEP_ID = 'run_01keepforever000000000000'
  const KEEP_PREFIX = `workflows/hello/hello/runs/${KEEP_ID}/`
  const WAITING_PREFIX = `workflows/hello/hello/runs/${WAITING_RUN.run.runId}/`
  const INPUT_KEY = 'workflows/hello/hello/inputs/photo.png'
  const png = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }
  const post = () => fetch('/api/workflow/sweep', { method: 'POST' })

  beforeEach(() => {
    resetDb()
    // Someone who owns none of these runs: the sweep has no caller, so this must not matter.
    setMockUser(MOCK_OTHER)
    // Expired and finished: swept.
    seedFinishedRun()
    db.runs.set(RUN_ID, { ...db.runs.get(RUN_ID)!, expiresAt: Date.now() - 1 })
    seedObject(`${PREFIX}greet/0/say/poster.png`, png)
    seedObject(`${PREFIX}outputs/summary.md`, { bytes: new Uint8Array([4]), contentType: 'text/markdown' })
    // Its kickoff input, outside the prefix (D18): kept.
    seedObject(INPUT_KEY, png)
    // Finished, no keep — no expiresAt: kept.
    db.runs.set(KEEP_ID, { ...FINISHED_RUN.run, runId: KEEP_ID, _id: 'rec_keep' })
    seedObject(`${KEEP_PREFIX}outputs/summary.md`, png)
    // Expired but still running (parked on its form): kept.
    seedWaitingRun()
    db.runs.set(WAITING_RUN.run.runId, { ...db.runs.get(WAITING_RUN.run.runId)!, expiresAt: Date.now() - 1 })
    seedObject(`${WAITING_PREFIX}greet/0/say/poster.png`, png)
  })

  it('sweeps the expired finished run — bytes, records, step rows, run row — and nothing else', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      ok: true,
      swept: 1,
      deferred: 0,
      skipped: 0,
      deleted: { files: 2, records: 2, steps: FINISHED_RUN.steps.length, runs: 1 },
    })
    expect(db.runs.has(RUN_ID)).toBe(false)
    expect(stepsOf(RUN_ID)).toEqual([])
    expect(filesUnder(PREFIX)).toEqual([])
    expect(fileRecordsMatching(`${PREFIX}%`)).toEqual([])
    // Untouched: the input, the keep-forever run, the parked run.
    expect(db.files.has(INPUT_KEY)).toBe(true)
    expect(db.fileRecords.has(INPUT_KEY)).toBe(true)
    expect(db.runs.has(KEEP_ID)).toBe(true)
    expect(filesUnder(KEEP_PREFIX)).toHaveLength(1)
    expect(db.runs.get(WAITING_RUN.run.runId)?.status).toBe('running')
    expect(filesUnder(WAITING_PREFIX)).toHaveLength(1)
  })

  it('is idempotent: the next pass reports zeros', async () => {
    await post()
    expect(await (await post()).json()).toEqual({
      ok: true,
      swept: 0,
      deferred: 0,
      skipped: 0,
      deleted: { files: 0, records: 0, steps: 0, runs: 0 },
    })
  })

  it('a quiet night — nothing expired — deletes nothing', async () => {
    db.runs.set(RUN_ID, { ...db.runs.get(RUN_ID)!, expiresAt: Date.now() + 60_000 })
    expect((await (await post()).json()).deleted).toEqual({ files: 0, records: 0, steps: 0, runs: 0 })
    expect(filesUnder(PREFIX)).toHaveLength(2)
  })
})
