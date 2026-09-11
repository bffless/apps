/**
 * Unit coverage for `run/update/post/merge.fn.js`'s `driveKey` handling (spec
 * 11 D28) — the one branch nothing else in this suite exercises. The mock's
 * own `/api/workflow/run/update` handler does not mirror `driveKey` clearing
 * (Task B4 lands the gate and the write-side rule only; the mock's read-merge-
 * write stays byte-for-byte what it was before), so there is no fetch-side
 * path that would otherwise reach this logic.
 *
 * `new Function` is test-only tooling to run the authored `.fn.js` source in
 * isolation, the same as `deleteGate.fn.parity.test.ts`'s `loadFnHandler`; it
 * is never used by the app or the mock at runtime.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'run',
  'update',
  'post',
  'merge.fn.js',
)

type MergeHandler = (ctx: {
  steps: { run: unknown }
  request: { body: Record<string, unknown> }
}) => { found: boolean; missing: boolean; recordId: string | null; fields: Record<string, unknown> }

function loadFnHandler(): MergeHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory() as MergeHandler
}

const ROW = { id: 'rec_1', runId: 'run_x', status: 'running' }

describe('run/update/post/merge.fn.js — driveKey (spec 11 D28)', () => {
  const handler = loadFnHandler()

  it('clears driveKey once the patch lands the run on a terminal status', () => {
    const result = handler({
      steps: { run: [{ ...ROW, driveKey: 'dk_1' }] },
      request: { body: { id: 'run_x', patch: { status: 'succeeded' } } },
    })

    expect(result.fields.driveKey).toBe('')
  })

  it('keeps a live run’s driveKey', () => {
    const result = handler({
      steps: { run: [{ ...ROW, driveKey: 'dk_1' }] },
      request: { body: { id: 'run_x', patch: {} } },
    })

    expect(result.fields.driveKey).toBe('dk_1')
  })

  it('is "" when the row carries no driveKey at all', () => {
    const result = handler({
      steps: { run: [{ ...ROW }] },
      request: { body: { id: 'run_x', patch: {} } },
    })

    expect(result.fields.driveKey).toBe('')
  })

  it('ignores a driveKey the body patch carries — only the row is trusted', () => {
    const result = handler({
      steps: { run: [{ ...ROW, driveKey: 'dk_real' }] },
      request: { body: { id: 'run_x', patch: { driveKey: 'dk_injected' } } },
    })

    expect(result.fields.driveKey).toBe('dk_real')
  })
})
