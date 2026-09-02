import { describe, expect, it } from 'vitest'
import { ACTIVE_STEP_STATUSES, snapshotFromRows, snapshotText } from '../src/snapshot.js'
import type { RunRowLike, StepRowLike } from '../src/snapshot.js'

/** Hello's `interactive` definition, trimmed to what the derivation reads. */
const definition = {
  name: 'Interactive hello',
  jobs: {
    pick: {
      steps: [
        {
          id: 'choose',
          uses: 'island',
          with: { src: 'islands/pick-line.html', title: 'Pick the best line' },
          outputs: { line: { type: 'string', required: true }, index: { type: 'number' } },
          headless: 'auto',
        },
      ],
    },
    review: {
      steps: [{ id: 'confirm', uses: 'form', with: { title: 'Review the card', fields: { cover: { type: 'choice' } } } }],
    },
  },
}

const run = (status: string, extra: Partial<RunRowLike> = {}): RunRowLike => ({
  runId: 'run_1',
  status,
  definition,
  ...extra,
})

const row = (key: string, kind: string, status: string, inputs?: unknown): StepRowLike => {
  const [job = '', , step = ''] = key.split('/')
  return { key, job, step, kind, status, ...(inputs === undefined ? {} : { inputs }) }
}

describe('snapshotFromRows', () => {
  it('exposes the same ACTIVE set window.__workflow uses', () => {
    expect([...ACTIVE_STEP_STATUSES].sort()).toEqual(['polling', 'running', 'waiting'])
  })

  it('describes a waiting island: key, kind, evaluated inputs, declared outputs, declared src', () => {
    const steps = [
      row('greet/0/say', 'pipeline', 'succeeded'),
      row('analyze/0/run', 'pipeline', 'succeeded'),
      row('pick/0/choose', 'island', 'waiting', { lines: ['Hello, world!', 'Hello, studio!'] }),
    ]
    const snapshot = snapshotFromRows(run('running'), steps)
    expect(snapshot.runId).toBe('run_1')
    expect(snapshot.status).toBe('running')
    expect(snapshot.currentSteps).toEqual(['pick/0/choose'])
    expect(snapshot.steps).toEqual({ 'greet/0/say': 'succeeded', 'analyze/0/run': 'succeeded', 'pick/0/choose': 'waiting' })
    expect(snapshot.outputs).toEqual({})
    expect(snapshot.waitingOn).toEqual([
      {
        key: 'pick/0/choose',
        kind: 'island',
        inputs: { lines: ['Hello, world!', 'Hello, studio!'] },
        outputs: { line: { type: 'string', required: true }, index: { type: 'number' } },
        src: 'islands/pick-line.html',
      },
    ])
  })

  it('describes a waiting form without a src, its fields riding in inputs', () => {
    const inputs = { title: 'Review the card', fields: { cover: { type: 'choice', options: [{ path: 'workflows/x' }] } }, submit: 'Approve' }
    const snapshot = snapshotFromRows(run('running'), [row('review/0/confirm', 'form', 'waiting', inputs)])
    expect(snapshot.waitingOn).toEqual([{ key: 'review/0/confirm', kind: 'form', inputs }])
    expect('src' in snapshot.waitingOn[0]!).toBe(false)
  })

  it('a finished run has no waitingOn and carries the row outputs', () => {
    const poster = { path: 'workflows/hello/run_1/poster.svg', name: 'poster.svg', contentType: 'image/svg+xml', size: 12, url: 'https://x' }
    const snapshot = snapshotFromRows(run('succeeded', { outputs: { poster } }), [row('pick/0/choose', 'island', 'succeeded')])
    expect(snapshot.status).toBe('succeeded')
    expect(snapshot.currentSteps).toEqual([])
    expect(snapshot.waitingOn).toEqual([])
    expect(snapshot.outputs).toEqual({ poster })
  })

  it('survives a missing or malformed definition and non-object inputs', () => {
    const steps = [row('pick/0/choose', 'island', 'waiting', 'not-an-object')]
    for (const definitionValue of [undefined, null, 'yaml?', { jobs: { pick: { steps: 'nope' } } }]) {
      const snapshot = snapshotFromRows({ runId: 'run_2', status: 'running', definition: definitionValue }, steps)
      expect(snapshot.waitingOn).toEqual([{ key: 'pick/0/choose', kind: 'island', inputs: {} }])
    }
  })

  it('ignores waiting rows of kinds that do not wait on anyone', () => {
    const snapshot = snapshotFromRows(run('running'), [row('greet/0/say', 'pipeline', 'waiting')])
    expect(snapshot.currentSteps).toEqual(['greet/0/say'])
    expect(snapshot.waitingOn).toEqual([])
  })

  it('a running run with no rows yet is an empty board', () => {
    expect(snapshotFromRows(run('running', { outputs: null }), [])).toEqual({
      runId: 'run_1',
      status: 'running',
      currentSteps: [],
      outputs: {},
      steps: {},
      waitingOn: [],
    })
  })
})

describe('snapshotText', () => {
  it('says what the page says', () => {
    expect(snapshotText({ runId: 'r', status: 'running', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] })).toBe('Run r is running')
    expect(
      snapshotText({
        runId: 'r',
        status: 'running',
        currentSteps: ['pick/0/choose'],
        outputs: {},
        steps: {},
        waitingOn: [
          { key: 'pick/0/choose', kind: 'island', inputs: {} },
          { key: 'review/0/confirm', kind: 'form', inputs: {} },
        ],
      }),
    ).toBe('Run r is running, waiting on pick/0/choose (island), review/0/confirm (form)')
    expect(snapshotText({ runId: '', status: 'invalid', currentSteps: [], outputs: {}, steps: {}, waitingOn: [], errors: { inputs: 'x' } })).toBe('No run was started')
  })
})
