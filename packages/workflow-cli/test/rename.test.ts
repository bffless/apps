/**
 * `workflow rename <old> <new>` (src/verbs/rename.ts) — the CLI wrapper
 * around the boundary-aware rename engine (src/rewrite.ts, test/rewrite.test.ts).
 * What's new here, beyond the engine itself: the mismatched-`<old>` guard
 * (the identity file, not the CLI argument, is the source of truth for what
 * a tree's current alias is), `--dry-run` wiring, and the exit-code contract
 * (0 success, 2 usage/config error, matching the CLI's existing pattern —
 * cli.ts's own doc comment).
 *
 * Every test works on a fresh temp copy of test/fixtures/hello-tree — never
 * in-place in the fixture itself (rewrite.test.ts's `freshCopy` pattern,
 * duplicated locally since it isn't exported).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRuleSet, lintFile } from '@bffless/workflow-lint'
import { beforeAll, describe, expect, test } from 'vitest'
import { readIdentity } from '../src/identity.js'
import { parseRename, runRename } from '../src/verbs/rename.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/hello-tree', import.meta.url))

function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-rename-'))
  cpSync(fixtureDir, dir, { recursive: true })
  return dir
}

/**
 * Makes the fixture's `hello.workflow.yaml` schema-valid (`on`/`jobs`) so a
 * real `workflow lint` run — not just the schema-agnostic textual rewrite
 * pass — can meaningfully pass over it. The shared fixture (test/fixtures/
 * hello-tree) is deliberately trimmed to spec/name/description for the
 * rewrite engine's own tests (test/rewrite.test.ts), which only care about
 * text content; this appends a minimal, real `pipeline` step referencing the
 * fixture's actual `echo` rule (POST /api/echo) so post-rename lint exercises
 * rule-set resolution too, against a TEMP COPY only.
 */
function makeLintable(dir: string): void {
  const file = join(dir, '.bffless/workflows/hello.workflow.yaml')
  const content = readFileSync(file, 'utf8')
  writeFileSync(
    file,
    `${content}
on:
  manual: {}
jobs:
  echo:
    steps:
      - id: echo
        uses: pipeline
        with: { path: echo }
`,
  )
}

/**
 * Ported from `bffless/workflow-implementations` `scripts/check-identity.mjs`
 * (fetched read-only via `gh api repos/bffless/workflow-implementations/
 * contents/scripts/check-identity.mjs`): asserts the identity file's alias
 * matches what the caller expects it to be. The original script compares
 * `workflows/<dir>/.bffless/workflow.json`'s alias against `.github/
 * workflows/deploy-<dir>.yml`'s `alias:` line — a multi-implementation-repo
 * shape this single-tree fixture doesn't have. The invariant it's checking —
 * "the identity file's declared alias matches what everything else around it
 * expects" — is exactly what `runRename`'s own mismatched-`<old>` guard
 * enforces going in, so this re-checks it coming out: after a rename to
 * `expectedAlias`, the identity file must say so.
 */
function assertCheckIdentity(dir: string, expectedAlias: string): void {
  const identity = readIdentity(dir)
  if (identity.alias !== expectedAlias) {
    throw new Error(`.bffless/workflow.json alias ${JSON.stringify(identity.alias)} != ${JSON.stringify(expectedAlias)}`)
  }
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  try {
    return { stdout: execFileSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' }), stderr: '', status: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status: number | null }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 }
  }
}

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: packageRoot })
}, 120_000)

describe('parseRename', () => {
  test('parses <old> <new>', () => {
    expect(parseRename(['hello', 'studio'])).toEqual({ oldAlias: 'hello', newAlias: 'studio', dryRun: false })
  })

  test('parses --dry-run in any position', () => {
    expect(parseRename(['--dry-run', 'hello', 'studio'])).toEqual({
      oldAlias: 'hello',
      newAlias: 'studio',
      dryRun: true,
    })
    expect(parseRename(['hello', 'studio', '--dry-run'])).toEqual({
      oldAlias: 'hello',
      newAlias: 'studio',
      dryRun: true,
    })
  })

  test('errors on missing arguments', () => {
    expect(parseRename([])).toEqual({ error: expect.stringContaining('rename') })
    expect(parseRename(['hello'])).toEqual({ error: expect.stringContaining('rename') })
  })

  test('errors on too many positionals', () => {
    expect(parseRename(['hello', 'studio', 'extra'])).toEqual({ error: expect.any(String) })
  })

  test('errors on an unknown flag', () => {
    expect(parseRename(['hello', 'studio', '--nope'])).toEqual({ error: expect.stringContaining('--nope') })
  })
})

describe('runRename', () => {
  test('renames the tree in place: identity + rule-set dir', () => {
    const dir = freshCopy()
    const status = runRename(
      dir,
      { oldAlias: 'hello', newAlias: 'studio', dryRun: false },
      () => {},
      () => {},
    )
    expect(status).toBe(0)
    expect(readIdentity(dir)).toEqual({ alias: 'studio', harness: 'workflow' })
    expect(existsSync(join(dir, '.bffless/proxy-rules/studio'))).toBe(true)
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(false)
  })

  test('prints the diff report on success', () => {
    const dir = freshCopy()
    const lines: string[] = []
    const status = runRename(dir, { oldAlias: 'hello', newAlias: 'studio', dryRun: false }, (l) => lines.push(l), () => {})
    expect(status).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('.bffless/proxy-rules/hello -> .bffless/proxy-rules/studio')
    expect(out).toContain('.bffless/workflow.json')
    expect(out).toMatch(/hello.*studio/)
  })

  test('--dry-run prints the diff report and writes nothing', () => {
    const dir = freshCopy()
    const lines: string[] = []
    const status = runRename(dir, { oldAlias: 'hello', newAlias: 'studio', dryRun: true }, (l) => lines.push(l), () => {})
    expect(status).toBe(0)
    expect(lines.join('\n')).toContain('.bffless/proxy-rules/hello -> .bffless/proxy-rules/studio')

    // Zero writes: the tree is untouched.
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(true)
    expect(existsSync(join(dir, '.bffless/proxy-rules/studio'))).toBe(false)
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(readFileSync(join(fixtureDir, 'README.md'), 'utf8'))
  })

  test('mismatched <old> exits 2 and names the tree\'s actual alias', () => {
    const dir = freshCopy()
    const errors: string[] = []
    const status = runRename(dir, { oldAlias: 'nope', newAlias: 'studio', dryRun: false }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    const message = errors.join('\n')
    expect(message).toContain('nope')
    expect(message).toContain('hello')

    // Nothing was touched — the mismatch is caught before renamePass runs.
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(true)
  })

  test('an invalid new alias exits 2, citing the reason', () => {
    const dir = freshCopy()
    const errors: string[] = []
    const status = runRename(dir, { oldAlias: 'hello', newAlias: 'w', dryRun: false }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/reserved/i)
    // Unchanged: renamePass validates before writing anything.
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })
  })

  test('a missing identity file exits 2', () => {
    const dir = freshCopy()
    writeFileSync(join(dir, '.bffless/workflow.json'), 'not json')
    const errors: string[] = []
    const status = runRename(dir, { oldAlias: 'hello', newAlias: 'studio', dryRun: false }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/not valid JSON/)
  })
})

describe('workflow rename (CLI wiring)', () => {
  test('exits 0 and renames the tree', () => {
    const dir = freshCopy()
    const r = run(['rename', 'hello', 'studio'], dir)
    expect(r.status).toBe(0)
    expect(readIdentity(dir)).toEqual({ alias: 'studio', harness: 'workflow' })
  })

  test('--dry-run exits 0 and writes nothing', () => {
    const dir = freshCopy()
    const r = run(['rename', 'hello', 'studio', '--dry-run'], dir)
    expect(r.status).toBe(0)
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(true)
  })

  test('mismatched <old> exits 2 naming the actual alias', () => {
    const dir = freshCopy()
    const r = run(['rename', 'nope', 'studio'], dir)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('hello')
  })

  test('rename is no longer in the unimplemented-verb list', () => {
    const dir = freshCopy()
    const r = run(['rename'], dir)
    // Missing <old>/<new> is a usage error (2), never the generic
    // "not implemented" stub cli.ts used to return for every rename call.
    expect(r.status).toBe(2)
    expect(r.stderr).not.toContain('not implemented')
  })
})

describe('post-rename validation (the phase-gate checks Task 3 has to prove)', () => {
  test('check-identity and workflow lint both pass on the renamed tree', () => {
    const dir = freshCopy()
    makeLintable(dir)

    const status = runRename(
      dir,
      { oldAlias: 'hello', newAlias: 'studio', dryRun: false },
      () => {},
      () => {},
    )
    expect(status).toBe(0)

    // check-identity (ported): the identity file's alias matches the rename.
    expect(() => assertCheckIdentity(dir, 'studio')).not.toThrow()

    // workflow lint, via the exported lint function (@bffless/workflow-lint,
    // the same API cli.ts's own `lint` verb delegates to): the renamed
    // workflow file, checked against the renamed rule set, is clean.
    // --path-prefix /api/studio matches the fixture's own convention (the
    // renamed scripts/build.mjs now runs `index ... --rules
    // .bffless/proxy-rules/studio --path-prefix /api/studio`, per
    // rewrite.test.ts) — the rule set is authored bare (rules/echo/post/,
    // no api/<alias>/ segments on disk), so the prefix has to be supplied
    // rather than guessed, same as the real build would.
    const workflowFile = join(dir, '.bffless/workflows/hello.workflow.yaml')
    const rulesDir = join(dir, '.bffless/proxy-rules/studio')
    const rules = resolveRuleSet({ file: workflowFile, rulesDir, pathPrefix: '/api/studio' })
    const result = lintFile(workflowFile, { rules })
    expect(result.counts.errors).toBe(0)
    expect(result.counts.warnings).toBe(0)

    // And the same check, through the actual CLI wiring cli.ts now has.
    const r = run(['lint', workflowFile, '--rules', rulesDir, '--path-prefix', '/api/studio'], dir)
    expect(r.status).toBe(0)
  })

  test('check-identity fails loudly if the identity file and the rename disagree', () => {
    const dir = freshCopy()
    // A tree that was never actually renamed still claims the old alias —
    // assertCheckIdentity must not silently pass it off as "studio".
    expect(() => assertCheckIdentity(dir, 'studio')).toThrow(/"hello".*"studio"/)
  })
})
