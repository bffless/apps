/**
 * One completed `interactive` run, as the rows a real run would have left
 * behind (05) — the Phase-2 counterpart of `finishedRun.ts`.
 *
 * It exists for one reason `finishedRun` cannot serve: a *persisted* `{"$file"}`
 * payload (Decision 5). The `card/0/draw` row holds `outputs.big` as the
 * pointer, exactly as `offloadOutputs` wrote it, so the read path
 * (`workflowApi.getRun` → `hydrateOutputs` → `fetchPayload`) is what turns it
 * back into a value on the run page. The mock db lives in page memory, so a
 * live run's own rows never survive a reload — a seeded record is the only way
 * to exercise the read path in the browser at all.
 *
 * `SCRIPT_RUN_FILES` are the bytes the pointer and the poster ref resolve to;
 * `mocks/browser.ts` puts them in `db.files` when it seeds the rows.
 */
import { fileUrl } from '../../lib/coerce'
import { loadWorkflow } from '../../lib/runner/definition'
import type { RunRow, StepRow } from '../../lib/runner/rows'
import type { FileRef } from '../../lib/runner/types'
import { analyzeLines } from '../analyze'
import interactiveYaml from '../../../docs/spec/examples/interactive.workflow.yaml?raw'

const loaded = loadWorkflow(interactiveYaml, 'interactive.workflow.yaml')
if (!loaded.def) throw new Error('scriptRun fixture: the interactive workflow no longer parses')

const definition = loaded.def.raw

export const SCRIPT_RUN_ID = 'run_01hellofixturescript000000'

/** 2026-08-25T12:00:00Z — every stamp below is an offset from it, in ms. */
const T0 = Date.UTC(2026, 7, 25, 12, 0, 0)
const at = (ms: number) => T0 + ms

const RUN_PREFIX = `workflows/hello/interactive/runs/${SCRIPT_RUN_ID}`
const DRAW_PREFIX = `${RUN_PREFIX}/card/0/draw`
const POSTER_PATH = `${DRAW_PREFIX}/poster.svg`
/** `offloadStore`'s own naming: the output's name, plus `.json`, under the step's prefix. */
const BIG_PATH = `${DRAW_PREFIX}/big.json`

const LINES = ['Hello, world!', 'Hello, studio!']
const LINE = LINES[0]
const ANALYSIS = analyzeLines(LINES)

const POSTER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
  '<rect width="640" height="360" fill="#101828"/>' +
  `<text x="320" y="176" fill="#ffffff" font-size="34" text-anchor="middle">${LINE}</text>` +
  '</svg>'

const POSTER: FileRef = {
  path: POSTER_PATH,
  name: 'poster.svg',
  contentType: 'image/svg+xml',
  size: POSTER_SVG.length,
  url: fileUrl(POSTER_PATH),
}

/**
 * A string no other fixture carries, so a test that finds it on the page knows
 * the bytes came back through the payload fetch rather than off the row.
 */
export const SCRIPT_RUN_BIG_MARKER = 'hydrated-from-payload'

/**
 * Deliberately *small*: what makes this a payload is the `{"$file"}` pointer in
 * the row, not the size of what it points at, and a seeded 400 KB array would
 * only make every read of this fixture slower.
 */
const BIG_VALUE = {
  marker: SCRIPT_RUN_BIG_MARKER,
  rows: Array.from({ length: 12 }, (_, i) => ({ i, line: LINE })),
}

const BIG_JSON = JSON.stringify(BIG_VALUE)

const BIG_REF: FileRef = {
  path: BIG_PATH,
  name: 'big.json',
  contentType: 'application/json',
  size: BIG_JSON.length,
  url: fileUrl(BIG_PATH),
}

/** The objects a bucket would hold for this run; `db.files` is that bucket. */
export const SCRIPT_RUN_FILES: { path: string; text: string; contentType: string }[] = [
  { path: POSTER_PATH, text: POSTER_SVG, contentType: 'image/svg+xml' },
  { path: BIG_PATH, text: BIG_JSON, contentType: 'application/json' },
]

const CHOICE = { line: LINE, index: 0 }

const run: RunRow = {
  runId: SCRIPT_RUN_ID,
  impl: 'hello',
  workflow: 'interactive',
  workflowName: 'Interactive hello',
  workflowVersion: '0.0.0',
  definition,
  yaml: interactiveYaml,
  inputs: { greeting: 'Hello', names: ['world', 'studio'] },
  status: 'succeeded',
  headless: false,
  startedBy: 'user_fixture',
  startedAt: T0,
  finishedAt: at(9_000),
  leaseOwner: null,
  leaseUntil: null,
  outputs: { line: LINE, view: CHOICE, poster: POSTER },
  annotations: [],
}

/** A greeted matrix item: one echo call, its line, and the step's summary. */
function say(index: number, who: string, finishedAt: number): StepRow {
  const line = `Hello, ${who}!`
  return {
    runId: SCRIPT_RUN_ID,
    key: `greet/${index}/say`,
    job: 'greet',
    index,
    step: 'say',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'echo', body: { text: line } },
    response: { initial: { text: line } },
    outputs: { line },
    error: null,
    summary: null,
    annotations: [],
    startedAt: at(500),
    finishedAt,
    heartbeatAt: null,
  }
}

const steps: StepRow[] = [
  say(0, 'world', at(1_000)),
  say(1, 'studio', at(1_100)),

  {
    runId: SCRIPT_RUN_ID,
    key: 'analyze/0/run',
    job: 'analyze',
    index: 0,
    step: 'run',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'analyze', body: { lines: LINES } },
    response: { initial: { ...ANALYSIS } },
    outputs: {
      words: ANALYSIS.words,
      counts: ANALYSIS.counts,
      snippet: ANALYSIS.snippet,
      longest: ANALYSIS.longest,
    },
    error: null,
    summary: null,
    annotations: [],
    startedAt: at(1_200),
    finishedAt: at(2_000),
    heartbeatAt: null,
  },

  // An island step is mounted (`waiting`) and answered — it never "runs" for
  // longer than its pane is up, and the row keeps what was submitted.
  {
    runId: SCRIPT_RUN_ID,
    key: 'pick/0/choose',
    job: 'pick',
    index: 0,
    step: 'choose',
    kind: 'island',
    status: 'succeeded',
    attempt: 1,
    inputs: {
      src: 'islands/pick-line.html',
      title: 'Pick the best line',
      display: 'inline',
      lines: LINES,
      words: ANALYSIS.words,
    },
    response: null,
    outputs: CHOICE,
    error: null,
    summary: `Picked **${LINE}** (#0)`,
    annotations: [{ level: 'notice', message: `Previewed ${LINE}` }],
    startedAt: at(2_100),
    finishedAt: at(6_000),
    heartbeatAt: null,
  },

  // The script step: its `poster` Blob became a File ref under the step's own
  // prefix, and its oversized `big` output was offloaded to `{"$file"}` (05).
  {
    runId: SCRIPT_RUN_ID,
    key: 'card/0/draw',
    job: 'card',
    index: 0,
    step: 'draw',
    kind: 'script',
    status: 'succeeded',
    attempt: 1,
    inputs: { line: LINE, counts: ANALYSIS.counts },
    response: null,
    outputs: { poster: POSTER, big: { $file: BIG_REF } },
    error: null,
    summary: `Card **poster.svg** (${POSTER.size} bytes)`,
    annotations: [{ level: 'notice', message: 'card drawn' }],
    startedAt: at(6_100),
    finishedAt: at(8_000),
    heartbeatAt: null,
  },
]

export const SCRIPT_RUN: { run: RunRow; steps: StepRow[] } = { run, steps }
