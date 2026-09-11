/**
 * `run/get`'s `shape.fn.js` — the `function_handler` that merges the two
 * queries into `{ run, steps }` (Decision 4, spec 11 D26). Same `new
 * Function` tooling as `runs.shape.fn.parity.test.ts`: the authored `.fn.js`
 * cannot be imported, so it is executed from source here and nowhere else.
 *
 * Follow-up to apps#665: `driveKey` (spec 11 D28) is legitimate on the
 * stored row — the drive door and `driveGate`'s nonce reuse both read it —
 * but must never ride the run this rule answers. It travels only in
 * `client_payload.drive_key` and the `x-workflow-drive-key` request header.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_MEMBER, db, seedFinishedRun, setMockUser } from './db'
import { FIXTURE_RUN_ID } from './fixtures/finishedRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(appDir, '.bffless', 'proxy-rules', 'workflow', 'rules', 'api', 'workflow', 'run', 'get', 'shape.fn.js')

type Handler = (ctx: { steps: { run: unknown; steps: unknown; runGate: { ok: boolean } } }) => { run: unknown; steps: unknown[] }

function loadFnHandler(): Handler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

describe('run/get shape.fn.js', () => {
  let handler: Handler

  beforeEach(() => {
    handler = loadFnHandler()
  })

  it('strips driveKey from the run, flat or nested under `fields`, when the gate admits', () => {
    const flat = handler({ steps: { run: [{ runId: 'r', driveKey: 'k' }], steps: [], runGate: { ok: true } } })
    expect(flat.run).toEqual({ runId: 'r' })

    const nested = handler({
      steps: { run: [{ id: 'rec_1', fields: { runId: 'r', driveKey: 'k' } }], steps: [], runGate: { ok: true } },
    })
    expect(nested.run).toEqual({ id: 'rec_1', fields: { runId: 'r' } })
  })

  it('is a no-op when the row never carried driveKey', () => {
    const out = handler({ steps: { run: [{ runId: 'r' }], steps: [], runGate: { ok: true } } })
    expect(out.run).toEqual({ runId: 'r' })
  })

  it('agrees with the mock run/get endpoint', async () => {
    seedFinishedRun()
    db.runs.set(FIXTURE_RUN_ID, { ...db.runs.get(FIXTURE_RUN_ID)!, driveKey: 'nonce-abc' })
    setMockUser(MOCK_MEMBER)

    const res = await fetch(`/api/workflow/run?id=${FIXTURE_RUN_ID}`)
    const text = await res.clone().text()
    expect(text).not.toContain('driveKey')
    expect(text).not.toContain('nonce-abc')
    const body = (await res.json()) as { run: Record<string, unknown> | null }
    expect(body.run).not.toHaveProperty('driveKey')
    expect(body.run?.runId).toBe(FIXTURE_RUN_ID)
  })
})
