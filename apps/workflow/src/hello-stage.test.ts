/**
 * `scripts/stage-hello.mjs` is what a real implementation's CI runs (06): lint
 * every workflow YAML, build the islands, then stage
 * `.bffless/workflows/{*.workflow.yaml,index.json}` plus `islands/*.html`.
 * These tests run the actual script against a temp dir — no re-implementing its
 * logic here — and hold the result to the same shape the MSW mock's `HELLO_INDEX`
 * asserts, so the two can never quietly drift apart (parity test below).
 *
 * This suite is its own script (`pnpm --filter workflow test:stage`,
 * vitest.stage.config.ts) rather than part of `test:run`: it runs a `tsc` pass
 * and two Vite builds, minutes of work the unit suite should not carry. Run
 * `pnpm --filter workflow stage` first — the parity test reads the staged
 * `hello-dist/islands/*.html` through the mock's glob and fails, by design,
 * when nothing has been staged.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintSource } from '@bffless/workflow-lint'
import { HELLO_INDEX } from './mocks/handlers'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(appDir, 'scripts', 'stage-hello.mjs')
const examples = join(appDir, 'docs', 'spec', 'examples')

interface StagedWorkflow {
  file: string
  name: string
  description: string
  inputs: number
  jobs: number
  headlessSafe: boolean
}

interface StagedIndex {
  spec: number
  impl: string
  name: string
  description: string
  workflows: StagedWorkflow[]
  islands: string[]
  scripts: string[]
}

/** The staged bundle's own files — the deploy uploads exactly this tree. */
const staged = (outDir: string, ...parts: string[]) => join(outDir, ...parts)

/**
 * Something each island's own `index.html` carries and the single-file build
 * must keep — so an empty-but-well-formed shell cannot pass as "built".
 */
const ISLAND_MARKERS: Record<string, string> = {
  'islands/pick-line.html': 'data-testid="submit-nothing"',
  'islands/line-viewer.html': 'data-testid="viewer-value"',
}

/** Files a re-used local `hello-dist` may carry from an earlier stage. */
const STALE = {
  workflow: ['.bffless', 'workflows', 'renamed.workflow.yaml'],
  script: ['scripts', 'gone.mjs'],
  island: ['islands', 'gone.html'],
}

describe('stage-hello.mjs', () => {
  let outDir: string
  let index: StagedIndex

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hello-stage-'))
    // A previous stage's leftovers: the stager must clear every directory it
    // owns, not only `islands/` (CI is always fresh; a local `hello-dist` is not).
    for (const parts of Object.values(STALE)) {
      mkdirSync(staged(outDir, ...parts.slice(0, -1)), { recursive: true })
      writeFileSync(staged(outDir, ...parts), 'stale\n')
    }
    // The island build is a real Vite build (two single-file bundles): slower
    // than the rest of this suite by an order of magnitude, hence the timeout.
    execFileSync('node', [script, '--out', outDir], { stdio: 'pipe' })
    index = JSON.parse(readFileSync(staged(outDir, '.bffless', 'workflows', 'index.json'), 'utf8'))
  }, 180_000)

  it('stages an index.json with the hello workflow shape', () => {
    expect(index.impl).toBe('hello')
    expect(index.workflows).toHaveLength(2)
    const hello = index.workflows.find((w) => w.file === 'hello.workflow.yaml')!
    expect(hello.jobs).toBe(4)
    expect(hello.inputs).toBe(4)
    expect(hello.headlessSafe).toBe(true)
  })

  // The description is what the Implementations screen shows for the bundle;
  // it must describe what the bundle now is, not what M1 shipped.
  it('describes the whole M2 bundle, not just the M1 workflow', () => {
    expect(index.description).toMatch(/interactive/i)
    expect(index.description).toMatch(/island/i)
    expect(index.description).not.toMatch(/M1 test implementation/)
  })

  it('stages the M2 interactive workflow alongside the M1 one', () => {
    const interactive = index.workflows.find((w) => w.file === 'interactive.workflow.yaml')
    expect(interactive).toBeDefined()
    expect(interactive!.name).toBe('Interactive hello')
    expect(interactive!.jobs).toBe(3)
    expect(interactive!.inputs).toBe(2)
    // The island step declares `headless: skip` with the outputs its job reads.
    expect(interactive!.headlessSafe).toBe(true)
  })

  it('stages both workflow yamls byte-identical to the spec examples', () => {
    for (const file of ['hello.workflow.yaml', 'interactive.workflow.yaml']) {
      const out = readFileSync(staged(outDir, '.bffless', 'workflows', file))
      const source = readFileSync(join(examples, file))
      expect(out.equals(source), `${file} is not byte-identical`).toBe(true)
    }
  })

  it('clears every directory it owns before staging into a re-used out dir', () => {
    for (const [what, parts] of Object.entries(STALE)) {
      expect(existsSync(staged(outDir, ...parts)), `stale ${what} survived`).toBe(false)
    }
  })

  // The stager refuses to publish a workflow that fails lint (06); this asserts
  // the two shipped YAMLs are actually clean rather than trusting the exit code.
  it('ships only lint-clean workflows', () => {
    for (const file of ['hello.workflow.yaml', 'interactive.workflow.yaml']) {
      const { counts } = lintSource(readFileSync(join(examples, file), 'utf8'), { file })
      expect({ file, errors: counts.errors, warnings: counts.warnings }).toEqual({
        file,
        errors: 0,
        warnings: 0,
      })
    }
  })

  it('builds both islands as single self-contained HTML files', () => {
    expect(index.islands).toEqual(['islands/pick-line.html', 'islands/line-viewer.html'])
    expect(index.scripts).toEqual([])
    for (const island of index.islands) {
      const html = readFileSync(staged(outDir, island), 'utf8')
      expect(html).toContain('<!doctype html>')
      // Single-file: no leftover `<script src>` / `<link href>` to a sibling —
      // an opaque-origin frame cannot fetch one (04).
      expect(html).not.toMatch(/<script[^>]+\ssrc=/)
      expect(html).not.toMatch(/<link[^>]+\shref="\.\//)
      // …and it is *this* island, with its script inlined — not an empty shell.
      expect(html, `${island} lost its markup`).toContain(ISLAND_MARKERS[island])
      expect(html, `${island} has no inlined module`).toMatch(/<script type="module"[^>]*>[^<]/)
    }
  })

  it('stages a landing page so the bundle alias is not a 404', () => {
    const landing = staged(outDir, 'index.html')
    expect(existsSync(landing)).toBe(true)
    expect(readFileSync(landing, 'utf8')).toContain('bundle-only alias')
  })

  // Parity: the staged bundle's counts must equal what the MSW mock backend
  // (which every unit/integration test runs against) reports, or a passing
  // test suite could still mask a real-vs-mock drift in the discovery listing.
  it('matches the MSW mock index counts', () => {
    expect(index.workflows.map((w) => w.file)).toEqual(HELLO_INDEX.workflows.map((w) => w.file))
    for (const stagedWorkflow of index.workflows) {
      const mockWorkflow = HELLO_INDEX.workflows.find((w) => w.file === stagedWorkflow.file)!
      expect(stagedWorkflow.jobs).toBe(mockWorkflow.jobs)
      expect(stagedWorkflow.inputs).toBe(mockWorkflow.inputs)
      expect(stagedWorkflow.headlessSafe).toBe(mockWorkflow.headlessSafe)
    }
    // The mock lists whatever `hello-dist/islands/` holds (glob order, not the
    // stager's listing order), so compare the sets.
    expect(
      HELLO_INDEX.islands.length,
      'the mock sees no staged islands — run `pnpm --filter workflow stage` before `test:stage`',
    ).toBeGreaterThan(0)
    expect([...HELLO_INDEX.islands].sort()).toEqual([...index.islands].sort())
  })
})
