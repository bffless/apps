/**
 * Fixtures for the endpoint's function tests: hello's two workflows as
 * `bffless/workflow-implementations` publishes them (vendored from that repo
 * at the `hello.ref` pin), an `index.json` in the shape `workflow index`
 * writes (06), and a mid-run row pair — `hello/interactive` parked on its
 * `pick/0/choose` island — as `GET /api/workflow/run` answers them.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))

export const INTERACTIVE_YAML = readFileSync(join(here, 'interactive.workflow.yaml'), 'utf8')
export const HELLO_YAML = readFileSync(join(here, 'hello.workflow.yaml'), 'utf8')

export const HELLO_INDEX = {
  spec: 1,
  impl: 'hello',
  name: 'Hello',
  description: 'M2 test implementation',
  version: '0.0.0',
  commit: 'abc1234',
  generatedAt: '2026-09-02T00:00:00Z',
  workflows: [
    { file: 'hello.workflow.yaml', name: 'Hello', description: 'echo, slow job + poll, fail-on-purpose', inputs: 1, jobs: 3, headlessSafe: true },
    { file: 'interactive.workflow.yaml', name: 'Interactive hello', description: 'Exercises every interactive feature of the harness (M2) — grows per phase.', inputs: 2, jobs: 5, headlessSafe: true },
  ],
  islands: ['islands/pick-line.html', 'islands/line-viewer.html'],
  scripts: ['scripts/poster-card.js'],
  ceMin: '0.4.32',
}

export const RUN_ID = 'run_01TEST'

/** The `workflow_runs` row of a parked `hello/interactive` run (columns flattened). */
export function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec_run',
    runId: RUN_ID,
    impl: 'hello',
    workflow: 'interactive',
    workflowName: 'Interactive hello',
    definition: parse(INTERACTIVE_YAML),
    yaml: INTERACTIVE_YAML,
    inputs: { greeting: 'Hello', names: ['world', 'studio'] },
    status: 'running',
    headless: false,
    startedBy: 'member@example.com',
    startedAt: 1_756_800_000_000,
    leaseOwner: null,
    leaseUntil: null,
    outputs: {},
    ...overrides,
  }
}

/** The step rows of that run: greet + analyze done, pick waiting on its island. */
export function stepRows(): Record<string, unknown>[] {
  return [
    { id: 'rec_s1', runId: RUN_ID, key: 'greet/0/say', job: 'greet', index: 0, step: 'say', kind: 'pipeline', status: 'succeeded', outputs: { line: 'Hello, world!' } },
    { id: 'rec_s2', runId: RUN_ID, key: 'greet/1/say', job: 'greet', index: 1, step: 'say', kind: 'pipeline', status: 'succeeded', outputs: { line: 'Hello, studio!' } },
    { id: 'rec_s3', runId: RUN_ID, key: 'analyze/0/run', job: 'analyze', index: 0, step: 'run', kind: 'pipeline', status: 'succeeded', outputs: {} },
    {
      id: 'rec_s4',
      runId: RUN_ID,
      key: 'pick/0/choose',
      job: 'pick',
      index: 0,
      step: 'choose',
      kind: 'island',
      status: 'waiting',
      attempt: 1,
      inputs: { lines: ['Hello, world!', 'Hello, studio!'], words: [{ w: 'Hello' }] },
      annotations: [],
      startedAt: 1_756_800_010_000,
    },
  ]
}
