import { describe, expect, it } from 'vitest'
import { ACTIVE_STEP_STATUSES, FILE_REF_HINT, formatBytes, outputsText, snapshotFromRows, snapshotText } from '../src/snapshot.js'
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
    expect(snapshotText({ runId: 'r', status: 'pending', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] })).toBe('Run r is pending — dispatched, not started yet')
    expect(
      snapshotText({
        runId: 'r',
        status: 'running',
        currentSteps: ['pick/0/choose'],
        outputs: {},
        steps: {},
        waitingOn: [
          { key: 'pick/0/choose', kind: 'island', inputs: { lines: [] }, outputs: { line: { type: 'string', required: true }, index: { type: 'number' }, notes: 'expr' }, src: 'islands/pick-line.html' },
          { key: 'review/0/confirm', kind: 'form', inputs: { fields: { cover: { type: 'choice', required: true, options: ['a'] }, notes: { type: 'markdown' }, tags: { type: 'string', list: true } } } },
        ],
      }),
    ).toBe(
      'Run r is running, waiting on pick/0/choose (island; outputs: line (string, required), index (number), notes (json)), review/0/confirm (form; fields: cover (choice, required), notes (markdown), tags (string[]))',
    )
  })
})

describe('outputsText', () => {
  const poster = { path: 'workflows/hello/runs/run_1/poster.png', name: 'poster.png', contentType: 'image/png', size: 1024, url: '/api/uploads/workflows/hello/runs/run_1/poster.png' }
  const text = (outputs: Record<string, unknown>, status = 'succeeded' as const) => outputsText({ runId: 'run_1', status, outputs })

  it('says a run has no outputs, and "yet" only while it runs', () => {
    expect(text({}, 'running')).toBe('Run run_1 is running and has no outputs yet')
    expect(text({})).toBe('Run run_1 is succeeded and has no outputs')
  })

  it('lists the output keys without the hint when none is a file', () => {
    expect(text({ line: 'x', count: 3 })).toBe('Run run_1 (succeeded) outputs: line, count')
  })

  it('names workflow.sign and prints the ref line when an output is a File ref (apps#627)', () => {
    expect(text({ line: 'x', poster })).toBe(
      `Run run_1 (succeeded) outputs: line, poster\n- poster: poster.png (1.0 KB, image/png) — path: workflows/hello/runs/run_1/poster.png\n${FILE_REF_HINT}`,
    )
    expect(FILE_REF_HINT).toBe('File refs, never bytes — pass a ref’s `path` to workflow.sign for a fetchable URL; the ref’s own `url` is the harness page’s session-only path.')
  })

  it('never dumps a non-ref output’s value — only the names line', () => {
    const words = Array.from({ length: 3 }, (_, i) => `word-${i}`)
    expect(text({ words })).toBe('Run run_1 (succeeded) outputs: words')
  })

  it('prints one line per ref in a file + list output, in array order', () => {
    const frame2 = { ...poster, name: 'frame-2.png', path: 'workflows/hello/runs/run_1/frame-2.png' }
    expect(text({ frames: [poster, frame2] })).toBe(
      [
        'Run run_1 (succeeded) outputs: frames',
        '- frames[0]: poster.png (1.0 KB, image/png) — path: workflows/hello/runs/run_1/poster.png',
        '- frames[1]: frame-2.png (1.0 KB, image/png) — path: workflows/hello/runs/run_1/frame-2.png',
        FILE_REF_HINT,
      ].join('\n'),
    )
    expect(text({ frames: [] })).toBe('Run run_1 (succeeded) outputs: frames')
  })

  it('skips non-ref entries in a mixed list, keeping each ref’s own index', () => {
    expect(text({ sheets: ['not-a-ref', poster] })).toBe(
      ['Run run_1 (succeeded) outputs: sheets', '- sheets[1]: poster.png (1.0 KB, image/png) — path: workflows/hello/runs/run_1/poster.png', FILE_REF_HINT].join('\n'),
    )
  })

  it('omits whichever of size/contentType is missing from the parenthesis, or the parenthesis entirely', () => {
    const { size, ...noSize } = poster
    void size
    expect(text({ f: noSize })).toBe(['Run run_1 (succeeded) outputs: f', '- f: poster.png (image/png) — path: workflows/hello/runs/run_1/poster.png', FILE_REF_HINT].join('\n'))

    const { contentType, ...noType } = poster
    void contentType
    expect(text({ f: noType })).toBe(['Run run_1 (succeeded) outputs: f', '- f: poster.png (1.0 KB) — path: workflows/hello/runs/run_1/poster.png', FILE_REF_HINT].join('\n'))

    const { size: _s, contentType: _c, ...bare } = poster
    void _s
    void _c
    expect(text({ f: bare })).toBe(['Run run_1 (succeeded) outputs: f', '- f: poster.png — path: workflows/hello/runs/run_1/poster.png', FILE_REF_HINT].join('\n'))
  })

  it('does not mistake a JSON output with a path key for a file', () => {
    expect(text({ route: { path: '/checkout', hits: 3 } })).toBe('Run run_1 (succeeded) outputs: route')
    expect(text({ routes: [{ path: '/checkout' }] })).toBe('Run run_1 (succeeded) outputs: routes')
  })
})

describe('formatBytes', () => {
  it('renders bytes below 1 KB with no decimal, KB and up with one', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(7215671)).toBe('6.9 MB')
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})

// Only the MCP endpoint mints a pending snapshot, and only it holds a clock —
// so the timing rides in as a second argument rather than a rival sentence
// composed beside this one (D19: one catalog, two adapters). apps#653.
describe('snapshotText with the endpoint\'s pending timing', () => {
  const pending = { runId: 'r', status: 'pending', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] } as const

  it('names the elapsed seconds, the ~60s first row and when pending expires', () => {
    expect(snapshotText(pending, { elapsedMs: 9_400, pendingUntil: Date.parse('2026-09-09T15:16:57.000Z') })).toBe(
      'Run r is pending — dispatched 9s ago, not started yet. The first row usually appears about 60s in.' +
        ' Pending until 2026-09-09T15:16:57Z, then `No such run: r` — that answer, not your poll count, is how a dispatch is failed',
    )
  })

  it('stays in seconds past a minute, and never counts backwards', () => {
    const until = Date.parse('2026-09-09T15:16:57.000Z')
    expect(snapshotText(pending, { elapsedMs: 312_000, pendingUntil: until })).toContain('dispatched 312s ago')
    expect(snapshotText(pending, { elapsedMs: -5_000, pendingUntil: until })).toContain('dispatched 0s ago')
  })
})
