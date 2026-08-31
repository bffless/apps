/**
 * `scripts/stage-hello.mjs` is what actually runs in CI (`deploy-workflow.yml`,
 * `workflow-app.yml`): clone `bffless/workflow-implementations` at `hello.ref`,
 * run its hello package's own `pnpm build`, and copy the result into `hello-dist/`. This suite runs
 * the real script against a temp dir — no re-implementing its logic here —
 * and holds the result to the shape the MSW mock's `HELLO_INDEX` asserts, so
 * the two can never quietly drift apart (parity test below).
 *
 * `hello` moved to its own repo for M3 Task 7 (Decision 5, "one source"): this
 * suite therefore asserts *shape*, not the exact counts a implementation
 * detail of hello's own YAMLs would pin (apps#380) — those are that
 * repo's own tests to keep honest, not this monorepo's.
 *
 * This is its own script (`pnpm --filter workflow test:stage`,
 * `vitest.stage.config.ts`) rather than part of `test:run`: it clones a repo,
 * runs its install and its Vite build — minutes of network-dependent work the
 * unit suite should not carry. Run `pnpm --filter workflow stage` first — the
 * parity test reads the staged `hello-dist/islands/*.html` through the mock's
 * glob and fails, by design, when nothing has been staged.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELLO_INDEX } from './mocks/handlers'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(appDir, 'scripts', 'stage-hello.mjs')
const examples = join(appDir, 'docs', 'spec', 'examples')

interface StagedIndex {
  spec: number
  impl: string
  name: string
  description: string
  workflows: { file: string; name: string; description: string; inputs: number; jobs: number; headlessSafe: boolean }[]
  islands: string[]
  scripts: string[]
}

/** The staged bundle's own files — the deploy uploads exactly this tree. */
const staged = (outDir: string, ...parts: string[]) => join(outDir, ...parts)

/**
 * Seeded as `.bffless/workflows/index.json`'s content before staging — the
 * stager's own out-dir-ownership marker (the `--out` guard in
 * `stage-hello.mjs` refuses to clear a non-empty dir unless this exact file
 * exists), so a re-used out dir still passes that guard. Deliberately not
 * valid JSON: if the stager merged into the existing directory instead of
 * clearing it first, this text would still be sitting there — proof
 * `stage-hello.mjs` clears the whole out dir before staging into it.
 */
const STALE_MARKER = 'stale — should never survive a re-stage\n'
const STALE_INDEX_JSON = ['.bffless', 'workflows', 'index.json']

describe('stage-hello.mjs', () => {
  let outDir: string
  let index: StagedIndex

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hello-stage-'))
    mkdirSync(staged(outDir, ...STALE_INDEX_JSON.slice(0, -1)), { recursive: true })
    writeFileSync(staged(outDir, ...STALE_INDEX_JSON), STALE_MARKER)
    // A real clone + install + build over the network: an order of magnitude
    // slower than the rest of the suite, hence the generous timeout.
    execFileSync('node', [script, '--out', outDir], { stdio: 'pipe' })
    index = JSON.parse(readFileSync(staged(outDir, '.bffless', 'workflows', 'index.json'), 'utf8'))
  }, 240_000)

  it('stages an index.json with the hello bundle shape', () => {
    expect(index.spec).toBe(1)
    expect(index.impl).toBe('hello')
    expect(index.workflows.length).toBeGreaterThanOrEqual(2)
    for (const workflow of index.workflows) {
      expect(typeof workflow.file).toBe('string')
      expect(typeof workflow.name).toBe('string')
      expect(typeof workflow.jobs).toBe('number')
      expect(typeof workflow.inputs).toBe('number')
      expect(typeof workflow.headlessSafe).toBe('boolean')
    }
  })

  it('stages both workflow yamls byte-identical to the spec examples (the drift check, `hello-drift.test.ts`, holds the reverse)', () => {
    for (const workflow of index.workflows) {
      const out = readFileSync(staged(outDir, '.bffless', 'workflows', workflow.file))
      const source = readFileSync(join(examples, workflow.file))
      expect(out.equals(source), `${workflow.file} is not byte-identical to docs/spec/examples/`).toBe(true)
    }
  })

  it('clears the whole out dir before staging into a re-used one', () => {
    expect(readFileSync(staged(outDir, ...STALE_INDEX_JSON), 'utf8')).not.toBe(STALE_MARKER)
  })

  it('builds every listed island as a single self-contained HTML file', () => {
    expect(index.islands.length).toBeGreaterThan(0)
    for (const island of index.islands) {
      const path = staged(outDir, island)
      expect(existsSync(path), `${island} is listed but missing`).toBe(true)
      const html = readFileSync(path, 'utf8')
      expect(html).toContain('<!doctype html>')
      // Single-file: no leftover `<script src>` to a sibling file — an
      // opaque-origin srcdoc frame cannot fetch one (04).
      expect(html).not.toMatch(/<script[^>]+\ssrc=/)
    }
  })

  it('copies every listed script verbatim', () => {
    for (const file of index.scripts) {
      expect(existsSync(staged(outDir, file)), `${file} is listed but missing`).toBe(true)
    }
  })

  it('stages a landing page so the bundle alias is not a 404', () => {
    const landing = staged(outDir, 'index.html')
    expect(existsSync(landing)).toBe(true)
  })

  // Parity: the staged bundle's file names must equal what the MSW mock
  // backend (which every unit/integration test runs against) reports, or a
  // passing test suite could still mask a real-vs-mock drift in discovery.
  it('matches the MSW mock index (file names, islands, scripts)', () => {
    expect(index.impl).toBe(HELLO_INDEX.impl)
    expect(index.workflows.map((w) => w.file).sort()).toEqual(HELLO_INDEX.workflows.map((w) => w.file).sort())
    // The mock lists whatever `hello-dist/islands/` holds (glob order, not the
    // stager's listing order), so compare the sets.
    expect(
      HELLO_INDEX.islands.length,
      'the mock sees no staged islands — run `pnpm --filter workflow stage` before `test:stage`',
    ).toBeGreaterThan(0)
    expect([...HELLO_INDEX.islands].sort()).toEqual([...index.islands].sort())
    // The mock serves the scripts from `hello-src/workflows/hello/scripts/` (the source the
    // stager copies), so this compares the two listings the same way.
    expect([...HELLO_INDEX.scripts].sort()).toEqual([...index.scripts].sort())
  })
})
