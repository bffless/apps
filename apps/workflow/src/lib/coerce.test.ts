/**
 * The coercers are the single seam between "whatever the server sent" and the
 * types the engine works with (09: real and mock go through one `toX()`), so
 * every shape CE has been observed to answer with is pinned here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { writeScope } from './scope'
import { downloadHref } from './url'
import {
  fileUrl,
  toAliasList,
  toFileRef,
  toImplementation,
  toRunRow,
  toStepRow,
  toWhoami,
  unwrapRows,
  workflowId,
} from './coerce'

describe('workflowId', () => {
  it('strips the workflow file suffix (R1)', () => {
    expect(workflowId('hello.workflow.yaml')).toBe('hello')
    expect(workflowId('long-to-short.yaml')).toBe('long-to-short')
    expect(workflowId('nested/dir/build.workflow.yml')).toBe('build')
  })
})

describe('unwrapRows', () => {
  it('accepts a bare array and both list envelopes', () => {
    expect(unwrapRows([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(unwrapRows({ records: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(unwrapRows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }])
    expect(unwrapRows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }])
  })

  it('answers [] for anything else', () => {
    expect(unwrapRows(null)).toEqual([])
    expect(unwrapRows('nope')).toEqual([])
    expect(unwrapRows({ records: 'nope' })).toEqual([])
  })
})

describe('toAliasList', () => {
  it('accepts the three envelopes', () => {
    const expected = [{ name: 'hello', isAutoPreview: false }]
    expect(toAliasList([{ name: 'hello', isAutoPreview: false }])).toEqual(expected)
    expect(toAliasList({ aliases: [{ name: 'hello' }] })).toEqual(expected)
    expect(toAliasList({ data: [{ name: 'hello', isAutoPreview: 0 }] })).toEqual(expected)
  })

  it('reads the preview flag and drops nameless entries', () => {
    expect(toAliasList([{ name: 'studio-pr-12', isAutoPreview: true }, { id: 7 }])).toEqual([
      { name: 'studio-pr-12', isAutoPreview: true },
    ])
  })
})

describe('toImplementation', () => {
  const index = {
    spec: 1,
    impl: 'hello',
    name: 'Hello',
    description: 'Smoke tests',
    version: '0.0.0',
    commit: 'mock',
    workflows: [
      { file: 'hello.workflow.yaml', name: 'Hello workflow', description: 'd', inputs: 4, jobs: 4, headlessSafe: true },
    ],
  }

  it('maps the index.json shape', () => {
    expect(toImplementation('hello', false, index)).toEqual({
      alias: 'hello',
      name: 'Hello',
      description: 'Smoke tests',
      version: '0.0.0',
      commit: 'mock',
      preview: false,
      workflows: [
        { file: 'hello.workflow.yaml', name: 'Hello workflow', description: 'd', inputs: 4, jobs: 4, headlessSafe: true },
      ],
    })
  })

  it('falls back to the alias for the name and carries the preview flag', () => {
    const impl = toImplementation('hello-pr-12', true, { spec: 1, workflows: [] })
    expect(impl.name).toBe('hello-pr-12')
    expect(impl.preview).toBe(true)
    expect(impl.error).toBeUndefined()
  })

  it('reports an unusable index instead of hiding it (08 empty states)', () => {
    for (const raw of ['nope', null, { spec: 2, workflows: [] }, { spec: 1 }]) {
      const impl = toImplementation('hello', false, raw)
      expect(impl.error, JSON.stringify(raw)).toBeTruthy()
      expect(impl.name).toBe('hello')
      expect(impl.workflows).toEqual([])
    }
  })

  it('defaults a listing’s counts and drops entries with no file', () => {
    const impl = toImplementation('hello', false, {
      spec: 1,
      workflows: [{ file: 'a.workflow.yaml' }, { name: 'no file' }],
    })
    expect(impl.workflows).toEqual([
      { file: 'a.workflow.yaml', name: 'a', inputs: 0, jobs: 0, headlessSafe: false },
    ])
  })
})

describe('toRunRow', () => {
  const flat = {
    id: 'rec_1',
    runId: 'run_1',
    impl: 'hello',
    workflow: 'hello',
    workflowName: 'Hello workflow',
    definition: { name: 'Hello workflow' },
    yaml: 'name: Hello workflow',
    inputs: { greeting: 'Hello' },
    status: 'succeeded',
    headless: false,
    startedBy: 'user_1',
    startedAt: 1000,
    finishedAt: 2000,
    outputs: { lines: ['a'] },
    annotations: [{ level: 'notice', message: 'hi' }],
  }

  it('reads `unattended` (07), and reads an older row without the column as false', () => {
    expect(toRunRow({ ...flat, unattended: true }).unattended).toBe(true)
    expect(toRunRow(flat).unattended).toBe(false)
  })

  // A fork's lineage (apps#501): present only when the row carries it — a
  // kickoff run has no parent, and `''` would read as one.
  it('reads `forkedFrom` / `forkJob` from a forked row, and leaves both absent otherwise', () => {
    const forked = toRunRow({ ...flat, forkedFrom: 'run_0', forkJob: 'slow' })
    expect(forked.forkedFrom).toBe('run_0')
    expect(forked.forkJob).toBe('slow')
    expect('forkedFrom' in toRunRow(flat)).toBe(false)
    expect('forkJob' in toRunRow({ ...flat, forkJob: '' })).toBe(false)
  })

  // The list endpoint's join (apps#473): present only when the row carries it.
  it('reads `waitingOn` from a listed row, and leaves it absent on a row without the column', () => {
    expect(toRunRow({ ...flat, waitingOn: ['confirm/0/review', 'greet/1/say'] }).waitingOn).toEqual([
      'confirm/0/review',
      'greet/1/say',
    ])
    expect(toRunRow({ ...flat, waitingOn: [] }).waitingOn).toEqual([])
    expect(toRunRow({ ...flat, waitingOn: '["confirm/0/review"]' }).waitingOn).toEqual(['confirm/0/review'])
    expect(toRunRow({ ...flat, waitingOn: ['confirm/0/review', 7, ''] }).waitingOn).toEqual(['confirm/0/review'])
    expect('waitingOn' in toRunRow(flat)).toBe(false)
    expect('waitingOn' in toRunRow({ ...flat, waitingOn: null })).toBe(false)
  })

  // Spec 11 (D28/D26): a denormalised owner email is read like any other optional
  // string, but `driveKey` — the driver's nonce — must never reach the client row.
  it('reads `startedByEmail` when present, and never coerces `driveKey` onto the row', () => {
    const row = toRunRow({ ...flat, startedByEmail: 'user@example.test', driveKey: 'nonce-abc' })
    expect(row.startedByEmail).toBe('user@example.test')
    expect('driveKey' in row).toBe(false)
    expect('startedByEmail' in toRunRow(flat)).toBe(false)
  })

  it('reads a flat record and keeps the server id at _id (R4)', () => {
    const row = toRunRow(flat)
    expect(row._id).toBe('rec_1')
    expect(row.runId).toBe('run_1')
    expect(row.status).toBe('succeeded')
    expect(row.startedAt).toBe(1000)
    expect(row.outputs).toEqual({ lines: ['a'] })
    expect(row.annotations).toEqual([{ level: 'notice', message: 'hi' }])
  })

  // apps#526: the machine-attached annotation round-trips — `kind` and its
  // opaque `data` must survive a reload, or replace-not-stack has nothing to
  // match on. A kind this client does not know is dropped, not invented.
  it('keeps a diagnostics annotation’s kind and data, and drops a kind it does not know', () => {
    const row = toRunRow({
      ...flat,
      annotations: [
        { level: 'notice', message: 'attached', kind: 'diagnostics', data: { buildSha: 'dev', errors: [] } },
        { level: 'warning', message: 'other', kind: 'mystery', data: undefined },
      ],
    })
    expect(row.annotations).toEqual([
      { level: 'notice', message: 'attached', kind: 'diagnostics', data: { buildSha: 'dev', errors: [] } },
      { level: 'warning', message: 'other' },
    ])
  })

  it('reads the same row nested under .fields', () => {
    const { id, ...fields } = flat
    expect(toRunRow({ id, fields })).toEqual(toRunRow(flat))
  })

  it('parses JSON columns handed back as strings', () => {
    const row = toRunRow({ ...flat, definition: '{"name":"Hello workflow"}', inputs: '{"greeting":"Hello"}' })
    expect(row.definition).toEqual({ name: 'Hello workflow' })
    expect(row.inputs).toEqual({ greeting: 'Hello' })
  })

  it('fills defaults for a half-empty row', () => {
    const row = toRunRow({ runId: 'run_2' })
    expect(row).toMatchObject({
      runId: 'run_2',
      impl: '',
      status: 'running',
      headless: false,
      startedAt: 0,
      inputs: {},
    })
    expect(row._id).toBeUndefined()
  })
})

describe('toRunRow — annotationCounts (Task 20)', () => {
  it('reads the rollup, completing a partial one with zeroes', () => {
    expect(toRunRow({ runId: 'r', annotationCounts: { warning: 2 } }).annotationCounts).toEqual({
      error: 0,
      warning: 2,
      notice: 0,
    })
  })

  it('parses it back from a stringified json column', () => {
    expect(
      toRunRow({ runId: 'r', annotationCounts: '{"error":1,"warning":0,"notice":3}' })
        .annotationCounts,
    ).toEqual({ error: 1, warning: 0, notice: 3 })
  })

  it('leaves it absent on a row written before the column existed', () => {
    expect(toRunRow({ runId: 'r' })).not.toHaveProperty('annotationCounts')
    expect(toRunRow({ runId: 'r', annotationCounts: null })).not.toHaveProperty('annotationCounts')
  })
})

describe('toWhoami', () => {
  it('reads the session user', () => {
    expect(toWhoami({ id: 'user_1', email: 'a@b.test', role: 'admin' })).toEqual({
      id: 'user_1',
      email: 'a@b.test',
      role: 'admin',
    })
  })

  it("treats CE's empty strings for an API-key caller as unknown, not as values", () => {
    expect(toWhoami({ id: '', email: '', role: '', projectRole: '' })).toEqual({ id: '' })
  })

  // The project role (spec 11 §Why `projectRole`) — what the SPA renders the
  // "All runs" toggle from. An older CE sends no such key at all, and CE sends
  // an empty string for a caller with no permission row for this project;
  // both mean "no toggle", so both must drop rather than arrive as a value.
  it('reads the project role, and drops it when there is none to read', () => {
    expect(toWhoami({ id: 'user_1', role: 'user', projectRole: 'owner' })).toEqual({
      id: 'user_1',
      role: 'user',
      projectRole: 'owner',
    })
    expect('projectRole' in toWhoami({ id: 'user_1', projectRole: '' })).toBe(false)
    expect('projectRole' in toWhoami({ id: 'user_1' })).toBe(false)
  })

  it('never throws on a body that is not an object', () => {
    expect(toWhoami(null)).toEqual({ id: '' })
    expect(toWhoami('nope')).toEqual({ id: '' })
  })
})

describe('toStepRow', () => {
  it('reads flat and nested rows and defaults the counters', () => {
    const flat = {
      id: 'rec_9',
      runId: 'run_1',
      key: 'greet/0/say',
      job: 'greet',
      index: 0,
      step: 'say',
      kind: 'pipeline',
      status: 'succeeded',
      attempt: 2,
      outputs: '{"line":"Hello, world!"}',
    }
    const row = toStepRow(flat)
    expect(row._id).toBe('rec_9')
    expect(row.key).toBe('greet/0/say')
    expect(row.attempt).toBe(2)
    expect(row.outputs).toEqual({ line: 'Hello, world!' })

    const { id, ...fields } = flat
    expect(toStepRow({ id, fields })).toEqual(row)
    expect(toStepRow({ runId: 'run_1', key: 'a/0/b' })).toMatchObject({ status: 'queued', attempt: 1, index: 0 })
  })

  // apps#527: the recorded `ctx.log` tail is a `json` column, so it can come
  // back parsed or as text; a row without it must stay without it, not gain `[]`.
  it('carries the `log` tail through, however the json column came back', () => {
    const base = { runId: 'run_1', key: 'make/0/poster', kind: 'script' }
    expect(toStepRow({ ...base, log: ['frame 1', 'frame 2'] }).log).toEqual(['frame 1', 'frame 2'])
    expect(toStepRow({ ...base, log: '["frame 1","frame 2"]' }).log).toEqual(['frame 1', 'frame 2'])
    expect('log' in toStepRow(base)).toBe(false)
    expect('log' in toStepRow({ ...base, log: null })).toBe(false)
  })

  // apps#528: the execution log id is a plain string column; a row without it
  // (older rows, a response that named no log) must stay without it.
  it('carries `logId` through, and leaves it absent when the column is empty', () => {
    const base = { runId: 'run_1', key: 'greet/0/say', kind: 'pipeline' }
    expect(toStepRow({ ...base, logId: 'plog_1' }).logId).toBe('plog_1')
    expect('logId' in toStepRow(base)).toBe(false)
    expect('logId' in toStepRow({ ...base, logId: null })).toBe(false)
    expect('logId' in toStepRow({ ...base, logId: '' })).toBe(false)
  })

  // Task 13: hydration is `workflowApi`'s job, so the coercer must hand the
  // pointer through untouched — parsed out of its JSON text, but never
  // dereferenced, reshaped or dropped.
  it('keeps an offloaded {"$file"} output exactly as the row stored it', () => {
    const ref = {
      path: 'workflows/hello/hello/runs/run_1/slow/0/start/report.json',
      name: 'report.json',
      contentType: 'application/json',
      size: 300_000,
      url: '/api/uploads/workflows/hello/hello/runs/run_1/slow/0/start/report.json',
    }
    const row = toStepRow({
      runId: 'run_1',
      key: 'slow/0/start',
      outputs: JSON.stringify({ report: { $file: ref }, poster: null }),
    })

    expect(row.outputs).toEqual({ report: { $file: ref }, poster: null })
  })
})

describe('toFileRef', () => {
  it('fills defaults from the storage path', () => {
    expect(toFileRef({ path: 'workflows/hello/hello/inputs/u1/cat.png' })).toEqual({
      path: 'workflows/hello/hello/inputs/u1/cat.png',
      name: 'cat.png',
      contentType: 'application/octet-stream',
      size: 0,
      url: '/api/uploads/workflows/hello/hello/inputs/u1/cat.png',
    })
  })

  it('keeps everything the server did send', () => {
    expect(
      toFileRef({ path: 'workflows/a/b.png', name: 'poster.png', contentType: 'image/png', size: 12, url: '/x' }),
    ).toEqual({ path: 'workflows/a/b.png', name: 'poster.png', contentType: 'image/png', size: 12, url: '/x' })
  })

  it('maps a storage path onto the serve route the same way the rule does', () => {
    expect(fileUrl('workflows/hello/hello/runs/run_1/slow/0/start/poster.png')).toBe(
      '/api/uploads/workflows/hello/hello/runs/run_1/slow/0/start/poster.png',
    )
  })
})

/**
 * The widened ask has to reach the serve route too (spec 11 D27/D29), and an
 * `<img src>`, a `<video>` and a download `href` are sinks the browser fetches
 * itself — no header can ride on them. The gate reads `request.query.scope` as
 * readily as the header (`mcp/runGate.ts`'s `scopeAsked`), so the ask goes on
 * the query string, which is the one channel available here.
 */
describe('fileUrl and the all-scope ask (D27)', () => {
  const PATH = 'workflows/hello/hello/runs/run_1/slow/0/start/poster.png'
  const PLAIN = `/api/uploads/${PATH}`

  afterEach(() => {
    writeScope('mine')
  })

  it('carries no query while the viewer has not widened — the ask is never implicit', () => {
    expect(fileUrl(PATH)).toBe(PLAIN)
  })

  it('carries scope=all while the viewer has widened', () => {
    writeScope('all')

    expect(fileUrl(PATH)).toBe(`${PLAIN}?scope=all`)
  })

  it('composes with the Download action, which appends to the query it finds', () => {
    expect(downloadHref(fileUrl(PATH))).toBe(`${PLAIN}?download=1`)

    writeScope('all')
    expect(downloadHref(fileUrl(PATH))).toBe(`${PLAIN}?scope=all&download=1`)
  })
})
