/**
 * The coercers are the single seam between "whatever the server sent" and the
 * types the engine works with (09: real and mock go through one `toX()`), so
 * every shape CE has been observed to answer with is pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  fileUrl,
  toAliasList,
  toFileRef,
  toImplementation,
  toRunRow,
  toStepRow,
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

  it('reads a flat record and keeps the server id at _id (R4)', () => {
    const row = toRunRow(flat)
    expect(row._id).toBe('rec_1')
    expect(row.runId).toBe('run_1')
    expect(row.status).toBe('succeeded')
    expect(row.startedAt).toBe(1000)
    expect(row.outputs).toEqual({ lines: ['a'] })
    expect(row.annotations).toEqual([{ level: 'notice', message: 'hi' }])
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
})

describe('toFileRef', () => {
  it('fills defaults from the storage path', () => {
    expect(toFileRef({ path: 'workflows/hello/hello/inputs/u1/cat.png' })).toEqual({
      path: 'workflows/hello/hello/inputs/u1/cat.png',
      name: 'cat.png',
      contentType: 'application/octet-stream',
      size: 0,
      url: '/api/workflow/files/hello/hello/inputs/u1/cat.png',
    })
  })

  it('keeps everything the server did send', () => {
    expect(
      toFileRef({ path: 'workflows/a/b.png', name: 'poster.png', contentType: 'image/png', size: 12, url: '/x' }),
    ).toEqual({ path: 'workflows/a/b.png', name: 'poster.png', contentType: 'image/png', size: 12, url: '/x' })
  })

  it('maps a storage path onto the serve route the same way the rule does', () => {
    expect(fileUrl('workflows/hello/hello/runs/run_1/slow/0/start/poster.png')).toBe(
      '/api/workflow/files/hello/hello/runs/run_1/slow/0/start/poster.png',
    )
  })
})
