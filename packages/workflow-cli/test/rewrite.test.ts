/**
 * The identity file (src/identity.ts) and the boundary-aware rename engine
 * (src/rewrite.ts) — plan Decision 6
 * (docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:22). The
 * fixture (test/fixtures/hello-tree/**) is a trimmed copy of
 * `bffless/workflow-implementations` `workflows/hello`, carrying the same
 * identity inventory Decision 6 enumerates, plus planted decoys: `othello`
 * and `shellhello` (adjacent to `[a-z0-9]` on one side — must never be
 * rewritten) and `hello-pr-1` / `hello_jobs` (hyphen/underscore-bounded —
 * must be rewritten). `hello_jobs` is also the schema file's own basename
 * (`schemas/hello_jobs.schema.yaml`) — a structural move as of the fix for
 * apps#420's live-proven bug (schema filenames ARE identity), not just a
 * textual one; a `othello_`-prefixed decoy for that specific move is planted
 * on the fly by its own test rather than checked into the shared tree.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, test } from 'vitest'
import { readIdentity, writeIdentity } from '../src/identity.js'
import { ALIAS_RE, RESERVED_ALIASES, renamePass } from '../src/rewrite.js'

const fixtureDir = fileURLToPath(new URL('./fixtures/hello-tree', import.meta.url))

/**
 * A fresh, disposable copy of the fixture tree for a test to mutate, plus a
 * `node_modules/` decoy synthesized on the fly: `node_modules` is
 * repo-wide-gitignored (.gitignore:2), so — unlike the checked-in
 * `vendor/decoy.js` — it can't live in the tracked fixture tree itself.
 */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-rewrite-'))
  cpSync(fixtureDir, dir, { recursive: true })
  mkdirSync(join(dir, 'node_modules/fake-pkg'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules/fake-pkg/index.js'),
    "// The rename engine must never edit anything under node_modules/, even\n" +
      "// though this file mentions the alias.\n" +
      "module.exports = 'hello-from-node-modules-untouched'\n",
  )
  return dir
}

let dir: string

beforeEach(() => {
  dir = freshCopy()
})

describe('readIdentity / writeIdentity', () => {
  test('reads the fixture identity file', () => {
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })
  })

  test('round-trips through writeIdentity', () => {
    writeIdentity(dir, { alias: 'studio', harness: 'workflow' })
    expect(readIdentity(dir)).toEqual({ alias: 'studio', harness: 'workflow' })
  })
})

describe('ALIAS_RE / RESERVED_ALIASES', () => {
  // Ported verbatim from bffless/publish-workflow scripts/prepare-rules.mjs
  // (fetched read-only into scratchpad; not re-typed from memory) — byte-equal
  // is the whole point, so pin the exact values here too.
  test('are byte-equal to publish-workflow/scripts/prepare-rules.mjs', () => {
    expect(ALIAS_RE.source).toBe('^[a-z][a-z0-9-]*$')
    expect(RESERVED_ALIASES).toEqual(['workflow', 'w', 'auth', '_bffless'])
  })
})

describe('renamePass(dir, "hello", "studio")', () => {
  test('renames the rule-set directory', () => {
    const report = renamePass(dir, 'hello', 'studio', { dryRun: false })
    // The exact full renames list (dir + the schema-filename move) is this
    // describe block's own dedicated test below; here just the directory move.
    expect(report.renames).toContainEqual(['.bffless/proxy-rules/hello', '.bffless/proxy-rules/studio'])
    expect(existsSync(join(dir, '.bffless/proxy-rules/studio'))).toBe(true)
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(false)
  })

  test('rewrites the identity file', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    expect(readIdentity(dir)).toEqual({ alias: 'studio', harness: 'workflow' })
  })

  test('rewrites ruleset.yaml name: and description, leaving the decoys alone', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const content = readFileSync(join(dir, '.bffless/proxy-rules/studio/ruleset.yaml'), 'utf8')
    expect(content).toMatch(/^name: studio$/m)
    expect(content).toContain('othello')
    expect(content).toContain('shellhello')
    expect(content).not.toContain('hello test implementation')
  })

  test('rewrites the _-joined schema name/ref AND renames the schema FILE itself (hello_jobs.schema.yaml -> studio_jobs.schema.yaml)', () => {
    // Schema filenames ARE identity (live-proven bug, apps#420 j5s smoke of
    // `workflow publish`): the `bffless` CLI resolves a `$schema:<name>` ref
    // to `schemas/<name>.schema.yaml` BY FILENAME, so a stale basename
    // breaks `rules push` even though the ref and the file's own `name:`
    // field were already rewritten by the textual pass.
    const report = renamePass(dir, 'hello', 'studio', { dryRun: false })

    expect(
      existsSync(join(dir, '.bffless/proxy-rules/studio/schemas/hello_jobs.schema.yaml')),
    ).toBe(false)
    const schema = readFileSync(join(dir, '.bffless/proxy-rules/studio/schemas/studio_jobs.schema.yaml'), 'utf8')
    expect(schema).toMatch(/^name: studio_jobs$/m)

    const rule = readFileSync(join(dir, '.bffless/proxy-rules/studio/rules/job/get/rule.yaml'), 'utf8')
    expect(rule).toContain('schemaId: $schema:studio_jobs')

    // Reported as a structural move, alongside the rule-set directory.
    expect(report.renames).toEqual([
      ['.bffless/proxy-rules/hello', '.bffless/proxy-rules/studio'],
      [
        '.bffless/proxy-rules/studio/schemas/hello_jobs.schema.yaml',
        '.bffless/proxy-rules/studio/schemas/studio_jobs.schema.yaml',
      ],
    ])
  })

  test('a schema-filename decoy that merely starts with the OLD alias as a substring, not a `<oldAlias>_` prefix, is left alone', () => {
    // othello_extra.schema.yaml's basename starts with "othello_", not
    // "hello_" — the same boundary discipline the textual pass already
    // applies to content, now proven for the new basename-rename move too.
    // Planted on the fly (not checked into the shared fixture) so this test
    // doesn't ripple into every other suite that copies the same tree.
    const decoyDir = join(dir, '.bffless/proxy-rules/hello/schemas')
    const decoyFile = join(decoyDir, 'othello_extra.schema.yaml')
    const decoyContent = 'name: othello_extra\nfields: []\n'
    writeFileSync(decoyFile, decoyContent)

    const report = renamePass(dir, 'hello', 'studio', { dryRun: false })

    expect(existsSync(join(dir, '.bffless/proxy-rules/studio/schemas/othello_extra.schema.yaml'))).toBe(true)
    expect(readFileSync(join(dir, '.bffless/proxy-rules/studio/schemas/othello_extra.schema.yaml'), 'utf8')).toBe(
      decoyContent,
    )
    expect(report.renames.some(([from]) => from.includes('othello_extra'))).toBe(false)
  })

  test('rewrites package.json name and the rules:validate path', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      scripts: { 'rules:validate': string }
    }
    expect(pkg.name).toBe('workflow-studio')
    expect(pkg.scripts['rules:validate']).toBe('npx --yes bffless@0.3.3 rules validate .bffless/proxy-rules/studio')
  })

  test('rewrites build.mjs --impl default and the rule-set path/prefix strings', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const build = readFileSync(join(dir, 'scripts/build.mjs'), 'utf8')
    expect(build).toContain("flagValue('--impl', 'studio')")
    expect(build).toContain("'.bffless/proxy-rules/studio'")
    expect(build).toContain("'/api/studio'")
  })

  test('rewrites README prose, including the hyphenated hello-pr-1 derivative, without touching the decoys', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const readme = readFileSync(join(dir, 'README.md'), 'utf8')
    expect(readme).toContain('studio-pr-<N>')
    expect(readme).toContain('studio-pr-1')
    expect(readme).toContain('othello')
    expect(readme).toContain('shellhello')
    expect(readme).not.toMatch(/\bhello\b/)
  })

  test('leaves the workflow filename untouched but rewrites its text content', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const workflowsDir = join(dir, '.bffless/workflows')
    expect(readdirSync(workflowsDir)).toEqual(['hello.workflow.yaml'])
    const content = readFileSync(join(workflowsDir, 'hello.workflow.yaml'), 'utf8')
    expect(content).toContain('workflow-studio')
    expect(content).toContain('alias `studio`')
    // Capitalized display text ("Hello workflow") is not a lowercase alias
    // token — the regex is case-sensitive (ALIAS_RE only ever allows
    // lowercase), so it is untouched, same as the decoys.
    expect(content).toContain('name: Hello workflow')
    expect(content).toContain('othello')
    expect(content).toContain('shellhello')
  })

  test('never touches vendor/ or node_modules/', () => {
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    expect(readFileSync(join(dir, 'vendor/decoy.js'), 'utf8')).toContain('hello-vendor-untouched')
    expect(readFileSync(join(dir, 'node_modules/fake-pkg/index.js'), 'utf8')).toContain(
      'hello-from-node-modules-untouched',
    )
  })

  test('skips binary files unchanged, byte for byte', () => {
    const before = readFileSync(join(fixtureDir, 'assets/logo.bin'))
    renamePass(dir, 'hello', 'studio', { dryRun: false })
    const after = readFileSync(join(dir, 'assets/logo.bin'))
    expect(after.equals(before)).toBe(true)
  })

  test('the edits report lists every rewritten file with its match count, using post-rename paths', () => {
    const report = renamePass(dir, 'hello', 'studio', { dryRun: false })
    const byFile = Object.fromEntries(report.edits.map((e) => [e.file, e.count]))

    expect(byFile['.bffless/workflow.json']).toBe(1)
    expect(byFile['.bffless/proxy-rules/studio/ruleset.yaml']).toBeGreaterThanOrEqual(2)
    expect(byFile['.bffless/proxy-rules/studio/schemas/studio_jobs.schema.yaml']).toBe(1)
    expect(byFile['.bffless/proxy-rules/studio/rules/job/get/rule.yaml']).toBeGreaterThanOrEqual(1)
    expect(byFile['package.json']).toBe(2)
    expect(byFile['README.md']).toBeGreaterThanOrEqual(2)

    // Never listed: files under skipped dirs, and files with zero matches.
    expect(Object.keys(byFile).some((f) => f.startsWith('vendor/'))).toBe(false)
    expect(Object.keys(byFile).some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(byFile['assets/logo.bin']).toBeUndefined()
  })

  test('dryRun returns the identical report and writes nothing', () => {
    const real = renamePass(dir, 'hello', 'studio', { dryRun: false })

    const dryDir = freshCopy()
    const dry = renamePass(dryDir, 'hello', 'studio', { dryRun: true })

    expect(dry).toEqual(real)
    // Parity extends to the new schema-filename structural move specifically:
    // both reports name the same schema-file rename, dry run just never performs it.
    expect(dry.renames).toContainEqual([
      '.bffless/proxy-rules/studio/schemas/hello_jobs.schema.yaml',
      '.bffless/proxy-rules/studio/schemas/studio_jobs.schema.yaml',
    ])

    // Zero writes: the original tree, byte for byte.
    expect(existsSync(join(dryDir, '.bffless/proxy-rules/hello'))).toBe(true)
    expect(existsSync(join(dryDir, '.bffless/proxy-rules/studio'))).toBe(false)
    expect(existsSync(join(dryDir, '.bffless/proxy-rules/hello/schemas/hello_jobs.schema.yaml'))).toBe(true)
    expect(existsSync(join(dryDir, '.bffless/proxy-rules/hello/schemas/studio_jobs.schema.yaml'))).toBe(false)
    expect(readIdentity(dryDir)).toEqual({ alias: 'hello', harness: 'workflow' })
    expect(readFileSync(join(dryDir, 'README.md'), 'utf8')).toBe(readFileSync(join(fixtureDir, 'README.md'), 'utf8'))
  })
})

describe('renamePass alias validation', () => {
  test('throws on a reserved alias, citing RESERVED_ALIASES', () => {
    expect(() => renamePass(dir, 'hello', 'w', { dryRun: true })).toThrowError(/reserved/i)
    try {
      renamePass(dir, 'hello', 'w', { dryRun: true })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain(RESERVED_ALIASES.join(', '))
    }
  })

  test('throws on an invalid alias, citing ALIAS_RE', () => {
    expect(() => renamePass(dir, 'hello', 'Hello!', { dryRun: true })).toThrowError(/valid alias/i)
    try {
      renamePass(dir, 'hello', 'Hello!', { dryRun: true })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).toContain(ALIAS_RE.source)
    }
  })

  test('validates before any filesystem write, even outside dryRun', () => {
    expect(() => renamePass(dir, 'hello', 'w', { dryRun: false })).toThrow()
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello'))).toBe(true)
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })
  })
})
