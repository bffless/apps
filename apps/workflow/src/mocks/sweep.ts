/**
 * The mock's re-implementation of the nightly retention sweep (spec 05
 * §Retention, apps#615) — `POST /api/workflow/sweep`, the rule at
 * `.bffless/proxy-rules/workflow/rules/api/workflow/sweep/post/`. Its two
 * three function twins mirror the rule's function steps — `sweepCutoff` is
 * `cutoff.fn.js`, `sweepPlan` is `plan.fn.js`, `sweepTargets` is
 * `targets.fn.js` — and `sweepExpired` then does what the rule's four delete
 * steps do, in their order (bytes, records, step rows, run rows).
 * `sweep.fn.parity.test.ts` holds the real functions and these together.
 *
 * Userless on purpose: the real rule is fired by a `pipeline_schedule` with no
 * user and carries no validator, so nothing here reads `mockUser()`.
 */
import { db, fileRecordsMatching, filesUnder, stepRowKey, stepsOf, type MockFileRecord } from './db'

/** The statuses a run may be swept in — `running` never, however long parked (07). */
export const TERMINAL: readonly string[] = ['succeeded', 'failed', 'cancelled']
/** The `workflow_files` scan's anchor for one workflow: its run-scoped rows only, never `inputs/` (D18). */
export const scanLikeFor = (impl: string, workflow: string): string => `workflows/${impl}/${workflow}/runs/%`
/** The scan pattern when nothing is due: no real `sub_dir` equals it, so the read is empty. */
export const NO_SCAN = '-'
/** The `due` query's `limit` in rule.yaml — one pass is bounded. */
export const DUE_LIMIT = 50
/** The `records` query's `limit` in rule.yaml, and `targets.fn.js`'s `SCAN_LIMIT`. */
export const SCAN_LIMIT = 5000

export interface SweepCutoff {
  now: number
  terminal: readonly string[]
}

export function sweepCutoff(now = Date.now()): SweepCutoff {
  return { now, terminal: TERMINAL }
}

/** A `workflow_runs` row as `data_query` hands it to the function: flattened, `id` beside the fields. */
export interface DueRow {
  id?: unknown
  runId?: unknown
  impl?: unknown
  workflow?: unknown
  status?: unknown
  expiresAt?: unknown
}

export interface SweepPlan {
  any: boolean
  impl: string
  workflow: string
  scanLike: string
}

export interface SweepTargets {
  scanLimit: number
  scanTruncated: boolean
  scanBlind: boolean
  runIds: string[]
  prefixes: string[]
  subDirs: string[]
  rowRunIds: string[]
  count: number
  swept: number
  deferred: number
  skipped: number
  waiting: number
}

const SEGMENT = /^[^\s/{}]+$/
const segment = (s: unknown): s is string => typeof s === 'string' && SEGMENT.test(s) && !s.includes('..')

/** A due row the sweep could act on: terminal, expired, every segment a safe `file_delete` template. */
const sweepable = (r: DueRow, cutoff: Pick<SweepCutoff, 'now' | 'terminal'>): boolean =>
  cutoff.terminal.includes(String(r.status)) && typeof r.expiresAt === 'number' && r.expiresAt < cutoff.now

/**
 * `plan.fn.js`, in TypeScript: the workflow of the first (oldest-expiry)
 * sweepable, well-formed due row, and the scan pattern for it — or no
 * workflow and the match-nothing pattern.
 */
export function sweepPlan(due: readonly (DueRow | null | undefined)[], cutoff: Pick<SweepCutoff, 'now' | 'terminal'>): SweepPlan {
  for (const row of due) {
    const r = row ?? {}
    if (!sweepable(r, cutoff)) continue
    if (!segment(r.impl) || !segment(r.workflow) || !segment(r.runId)) continue
    return { any: true, impl: r.impl, workflow: r.workflow, scanLike: scanLikeFor(r.impl, r.workflow) }
  }
  return { any: false, impl: '', workflow: '', scanLike: NO_SCAN }
}

/**
 * `targets.fn.js`, in TypeScript: which of the due rows are swept (terminal,
 * expired, every segment safe for a `file_delete` template), their prefixes,
 * the exact `sub_dir`s the scan found under them, and the ids whose rows go
 * this pass. Deferral is whole-run: a scan that is truncated (`SCAN_LIMIT`
 * rows) or blind (rows, but no `sub_dir` on any) empties every list, so the
 * pass deletes nothing and reports every due run as `deferred`.
 */
export function sweepTargets(
  due: readonly (DueRow | null | undefined)[],
  records: readonly (Pick<MockFileRecord, 'sub_dir'> | { sub_dir?: unknown } | null | undefined)[],
  cutoff: Pick<SweepCutoff, 'now' | 'terminal'>,
  plan: SweepPlan,
): SweepTargets {
  const runIds: string[] = []
  const prefixes: string[] = []
  const seen = new Set<string>()
  let skipped = 0
  let waiting = 0
  for (const row of due) {
    const r = row ?? {}
    if (!sweepable(r, cutoff)) continue
    if (!segment(r.impl) || !segment(r.workflow) || !segment(r.runId)) {
      skipped += 1
      continue
    }
    if (seen.has(r.runId)) continue
    seen.add(r.runId)
    if (!plan.any || r.impl !== plan.impl || r.workflow !== plan.workflow) {
      waiting += 1
      continue
    }
    runIds.push(r.runId)
    prefixes.push(`workflows/${r.impl}/${r.workflow}/runs/${r.runId}/`)
  }

  const scanTruncated = records.length >= SCAN_LIMIT
  const subDirs: string[] = []
  const seenDir = new Set<string>()
  let dirsSeen = 0
  for (const rec of records) {
    const dir = rec?.sub_dir
    if (typeof dir !== 'string') continue
    dirsSeen += 1
    if (seenDir.has(dir)) continue
    if (prefixes.some((prefix) => `${dir}/`.startsWith(prefix))) {
      seenDir.add(dir)
      subDirs.push(dir)
    }
  }

  const scanBlind = records.length > 0 && dirsSeen === 0
  const defer = scanTruncated || scanBlind
  const swept = defer ? [] : runIds
  return {
    scanLimit: SCAN_LIMIT,
    scanTruncated,
    scanBlind,
    runIds,
    prefixes: defer ? [] : prefixes,
    subDirs: defer ? [] : subDirs,
    rowRunIds: swept,
    count: runIds.length,
    swept: swept.length,
    deferred: defer ? runIds.length : 0,
    skipped,
    waiting,
  }
}

export interface SweepReport {
  ok: true
  swept: number
  deferred: number
  waiting: number
  skipped: number
  deleted: { files: number; records: number; steps: number; runs: number }
}

/**
 * One pass of the sweep over the mock's tables, the rule's steps in the rule's
 * order: `due` (expired terminal runs, oldest expiry first, `DUE_LIMIT`),
 * `plan` (one workflow), `records` (that workflow's scan, `SCAN_LIMIT`),
 * `targets`, then the four deletes. Idempotent: a second pass over the same
 * tables reports zeros.
 */
export function sweepExpired(now = Date.now()): SweepReport {
  const cutoff = sweepCutoff(now)
  const due = [...db.runs.values()]
    .filter((r) => TERMINAL.includes(r.status) && typeof r.expiresAt === 'number' && r.expiresAt < now)
    .sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number))
    .slice(0, DUE_LIMIT)
  const plan = sweepPlan(due, cutoff)
  const records = fileRecordsMatching(plan.scanLike)
    .map((key) => db.fileRecords.get(key)!)
    .slice(0, SCAN_LIMIT)
  const targets = sweepTargets(due, records, cutoff, plan)

  let files = 0
  for (const prefix of targets.prefixes) {
    for (const key of filesUnder(prefix)) {
      db.files.delete(key)
      files += 1
    }
  }
  let recordCount = 0
  const subDirs = new Set(targets.subDirs)
  for (const [key, row] of [...db.fileRecords.entries()]) {
    if (!subDirs.has(row.sub_dir)) continue
    db.fileRecords.delete(key)
    recordCount += 1
  }
  let steps = 0
  let runs = 0
  for (const runId of targets.rowRunIds) {
    for (const step of stepsOf(runId)) {
      db.steps.delete(stepRowKey(runId, step.key))
      steps += 1
    }
    const run = db.runs.get(runId)
    if (run && TERMINAL.includes(run.status) && typeof run.expiresAt === 'number' && run.expiresAt < now) {
      db.runs.delete(runId)
      runs += 1
    }
  }
  return {
    ok: true,
    swept: targets.swept,
    deferred: targets.deferred,
    waiting: targets.waiting,
    skipped: targets.skipped,
    deleted: { files, records: recordCount, steps, runs },
  }
}
