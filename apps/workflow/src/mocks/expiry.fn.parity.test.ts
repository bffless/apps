/**
 * Parity for the retention stamp (spec 05 §Retention, apps#686) between the
 * three places that compute it: `runs/post`'s `expiry.fn.js` and `run/fork`'s
 * `gate.fn.js` (the real `function_handler` code under
 * `.bffless/proxy-rules/workflow/rules/api/workflow/` — cannot import), and the
 * mock's `expiresAtOf` reached through both MSW create handlers. `new Function`
 * is test-only tooling to execute the authored `.fn.js` source in isolation;
 * it is never used by the app or the mock at runtime. Same shape as
 * `admit.fn.parity.test.ts`.
 *
 * What is decided: `expiresAt = startedAt + keep` (epoch ms) when the definition
 * being snapshotted carries a top-level `keep:` in the schema's own `$defs.keep`
 * grammar (`<n>h` | `<n>d`), and no column at all otherwise — a workflow without
 * `keep:` is never swept. "No column" means NO KEY on every leg: CE stores an
 * explicit `null` (pipeline-data.service.ts inserts the evaluated fields as-is)
 * but drops an `undefined` (expression-evaluator.ts `getNestedValue` answers
 * `undefined` for a property the step output lacks, and the JSONB write drops
 * it), so the functions leave the key off rather than writing `null`, the mock
 * does the same, and `toRunRow` reads it back as absent. It is the definition's,
 * never the body's: a caller cannot send its own `expiresAt`, just as it cannot
 * send `startedBy`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { MOCK_MEMBER, db, seedFinishedRun, setMockUser } from './db'
import { expiresAtOf } from './expiry'
import { FINISHED_RUN } from './fixtures/finishedRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RULES = join(appDir, '.bffless', 'proxy-rules', 'workflow', 'rules', 'api', 'workflow')
const EXPIRY_FN_PATH = join(RULES, 'runs', 'post', 'expiry.fn.js')
const GATE_FN_PATH = join(RULES, 'run', 'fork', 'post', 'gate.fn.js')

type ExpiryHandler = (ctx: { request?: { body?: unknown } }) => { expiresAt?: number }
type GateHandler = (ctx: {
  steps: { run: unknown; rows: unknown; existing: unknown }
  request: { body: Record<string, unknown> }
  user?: { id?: string; email?: string }
}) => { ok: boolean; run: Record<string, unknown> | null }

function loadFn<T>(path: string): T {
  const src = readFileSync(path, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory() as T
}

const HOUR = 3_600_000
const DAY = 86_400_000
const STARTED_AT = 1_700_000_000_000
const definition = FINISHED_RUN.run.definition as Record<string, unknown>
const withKeep = (keep: unknown) => (keep === undefined ? { ...definition } : { ...definition, keep })

/** One table for every implementation: the keep, and the offset it adds to `startedAt` (`null` = no key). */
const CASES: { desc: string; keep?: unknown; offset: number | null }[] = [
  { desc: 'keep: 30d', keep: '30d', offset: 30 * DAY },
  { desc: 'keep: 2h', keep: '2h', offset: 2 * HOUR },
  { desc: 'keep: 1d', keep: '1d', offset: DAY },
  { desc: 'no keep — never swept', offset: null },
  // The schema refuses these before a run exists; the rules stay defensive all the same.
  { desc: 'keep: 30m is not a keep (the duration grammar is not this one)', keep: '30m', offset: null },
  { desc: 'keep: 30 (no unit)', keep: '30', offset: null },
  { desc: 'keep: 1d12h (one unit only)', keep: '1d12h', offset: null },
  { desc: 'keep that is not a string', keep: 30, offset: null },
  { desc: 'keep: null', keep: null, offset: null },
]

describe('runs/post expiry.fn.js', () => {
  let handler: ExpiryHandler

  beforeAll(() => {
    handler = loadFn<ExpiryHandler>(EXPIRY_FN_PATH)
  })

  it.each(CASES)('expiry.fn.js: $desc', ({ keep, offset }) => {
    const result = handler({ request: { body: { definition: withKeep(keep), startedAt: STARTED_AT } } })
    if (offset === null) expect(result).not.toHaveProperty('expiresAt')
    else expect(result.expiresAt).toBe(STARTED_AT + offset)
  })

  it('answers the exact stamp the issue names: keep: 30d from 1_700_000_000_000', () => {
    const result = handler({ request: { body: { definition: withKeep('30d'), startedAt: STARTED_AT } } })
    expect(result.expiresAt).toBe(1_702_592_000_000)
  })

  it('never reads an expiresAt off the body', () => {
    const result = handler({
      request: { body: { definition: withKeep(undefined), startedAt: STARTED_AT, expiresAt: STARTED_AT + DAY } },
    })
    expect(result).not.toHaveProperty('expiresAt')
  })

  it('writes no column without a numeric startedAt to measure from', () => {
    expect(handler({ request: { body: { definition: withKeep('30d') } } })).toEqual({})
    expect(handler({ request: { body: { definition: withKeep('30d'), startedAt: '1700000000000' } } })).toEqual({})
  })

  it('never throws on the empty call CE makes of a bundle', () => {
    expect(() => handler({})).not.toThrow()
    expect(handler({})).toEqual({})
    expect(handler({ request: { body: null } })).toEqual({})
    expect(handler({ request: { body: { definition: 'not an object', startedAt: STARTED_AT } } })).toEqual({})
  })
})

describe('run/fork gate.fn.js stamps the same value from the SENT definition', () => {
  let handler: GateHandler
  const NEW_ID = 'run_01forkkeep000000000000000'
  const parent = { ...FINISHED_RUN.run, _id: 'rec_1' }
  const toRecord = (row: Record<string, unknown>) => {
    const { _id, ...fields } = row
    return { id: _id, fields }
  }

  beforeAll(() => {
    handler = loadFn<GateHandler>(GATE_FN_PATH)
  })

  it.each(CASES)('gate.fn.js: $desc', ({ keep, offset }) => {
    // Forking at the root job re-runs everything, so no step rows need adopting.
    const result = handler({
      steps: { run: [toRecord(parent)], rows: [], existing: [] },
      request: {
        body: { id: NEW_ID, from: parent.runId, job: 'greet', definition: withKeep(keep), yaml: parent.yaml, owner: 'tab' },
      },
      user: { id: MOCK_MEMBER.id, email: MOCK_MEMBER.email },
    })
    expect(result.ok).toBe(true)
    const run = result.run!
    // The fork measures from its OWN start (`now`), not the parent's `startedAt`.
    if (offset === null) {
      expect(run).not.toHaveProperty('expiresAt')
    } else {
      expect(run.expiresAt).toBe((run.startedAt as number) + offset)
      expect(run.expiresAt).not.toBe(parent.startedAt + offset)
    }
  })
})

/**
 * The one link the functions cannot test for themselves: the rule YAML that
 * carries their value onto the row. A typo in either `create` expression would
 * deploy green and silently never stamp — and a `request.body.expiresAt` anywhere
 * would let the caller choose its own retention.
 */
describe('the rules wire the stamp onto the row', () => {
  const RUNS_POST = join(RULES, 'runs', 'post', 'rule.yaml')
  const RUN_FORK = join(RULES, 'run', 'fork', 'post', 'rule.yaml')
  type Step = { id: string; handler: string; code?: string; config?: { fields?: Record<string, string> } }
  const stepsOf = (file: string): Step[] => parse(readFileSync(file, 'utf8')).pipeline.steps
  const createOf = (file: string) => stepsOf(file).find((s) => s.id === 'create' && s.handler === 'data_create')!

  it('runs/post: an `expiry` function step before `create`, whose output is the column', () => {
    const steps = stepsOf(RUNS_POST)
    const expiryAt = steps.findIndex((s) => s.id === 'expiry' && s.handler === 'function_handler' && s.code === './expiry.fn.js')
    const createAt = steps.findIndex((s) => s.id === 'create')
    expect(expiryAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(expiryAt)
    expect(createOf(RUNS_POST).config!.fields!.expiresAt).toBe('steps.expiry.expiresAt')
  })

  it('run/fork: the column comes off the gate’s one assembled row', () => {
    expect(createOf(RUN_FORK).config!.fields!.expiresAt).toBe('steps.gate.run.expiresAt')
  })

  it.each([RUNS_POST, RUN_FORK])('%s never reads expiresAt off the request body', (file) => {
    // The parsed document, not the text: a comment may well say "never `request.body.expiresAt`".
    expect(JSON.stringify(parse(readFileSync(file, 'utf8')))).not.toMatch(/request\.body\.expiresAt/)
  })
})

describe('the mock stamps the same value on both create paths', () => {
  it.each(CASES)('expiresAtOf: $desc', ({ keep, offset }) => {
    expect(expiresAtOf(withKeep(keep), STARTED_AT)).toBe(offset === null ? undefined : STARTED_AT + offset)
  })

  describe('POST /api/workflow/runs', () => {
    const RUN_ID = 'run_01kickoffkeep0000000000000'
    const post = (row: Record<string, unknown>) =>
      fetch('/api/workflow/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(row),
      })

    beforeEach(() => setMockUser(MOCK_MEMBER))

    it.each(CASES)('mock: $desc', async ({ keep, offset }) => {
      const res = await post({
        ...FINISHED_RUN.run,
        runId: RUN_ID,
        status: 'running',
        finishedAt: null,
        startedAt: STARTED_AT,
        definition: withKeep(keep),
      })
      expect(res.status).toBe(200)
      const stored = db.runs.get(RUN_ID)!
      if (offset === null) expect(stored).not.toHaveProperty('expiresAt')
      else expect(stored.expiresAt).toBe(STARTED_AT + offset)
    })

    it('mock: no numeric startedAt in the body — no column, not a 1970-based one', async () => {
      const { startedAt: _omitted, ...row } = { ...FINISHED_RUN.run, runId: RUN_ID, status: 'running', finishedAt: null, definition: withKeep('30d') }
      void _omitted
      const res = await post(row)
      expect(res.status).toBe(200)
      expect(db.runs.get(RUN_ID)!).not.toHaveProperty('expiresAt')
    })

    it('mock: an expiresAt in the body is never the one stored', async () => {
      const res = await post({
        ...FINISHED_RUN.run,
        runId: RUN_ID,
        status: 'running',
        finishedAt: null,
        startedAt: STARTED_AT,
        definition: withKeep(undefined),
        expiresAt: STARTED_AT + DAY,
      })
      expect(res.status).toBe(200)
      expect(db.runs.get(RUN_ID)!).not.toHaveProperty('expiresAt')
    })
  })

  describe('POST /api/workflow/run/fork', () => {
    const NEW_ID = 'run_01forkkeepmock00000000000'

    beforeEach(() => {
      setMockUser(MOCK_MEMBER)
      seedFinishedRun()
    })

    it.each(CASES)('mock: $desc', async ({ keep, offset }) => {
      const res = await fetch('/api/workflow/run/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: NEW_ID,
          from: FINISHED_RUN.run.runId,
          job: 'greet',
          definition: withKeep(keep),
          yaml: FINISHED_RUN.run.yaml,
          owner: 'tab',
        }),
      })
      expect(res.status).toBe(200)
      const stored = db.runs.get(NEW_ID)!
      if (offset === null) expect(stored).not.toHaveProperty('expiresAt')
      else expect(stored.expiresAt).toBe(stored.startedAt + offset)
    })
  })
})
