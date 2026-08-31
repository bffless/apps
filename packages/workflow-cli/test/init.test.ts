/**
 * `workflow init <alias> --from <owner>/<repo>|<path> [--path <dir>] [--ref
 * <ref>]` (src/verbs/init.ts) — apps#420, plan Decision 3
 * (docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:19). Every
 * test uses a LOCAL directory as `--from` — the offline path `resolveSource`
 * takes without cloning — built from test/fixtures/hello-tree, so these
 * tests never touch the network.
 *
 * Two source shapes are built, mirroring the two real cases the module doc
 * calls out:
 *   - `monorepoSource()`: a `workflows/hello/` package nested in a
 *     multi-implementation repo (workflow-implementations' actual shape,
 *     and this task's required Step-1 invocation).
 *   - `rootSource()`: the fixture IS the whole repo (a single-implementation
 *     repo, e.g. a prior `--dest .` copy) — exercises search-with-no
 *     `--path`, and the one case where workflow generation is skipped.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import { readIdentity } from '../src/identity.js'
import { type InitArgs, parseInit, runInit } from '../src/verbs/init.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/hello-tree', import.meta.url))

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** `<repo>/workflows/hello/**` = the fixture — a multi-implementation monorepo shape. */
function monorepoSource(): string {
  const dir = tempDir('workflow-cli-init-src-')
  cpSync(fixtureDir, join(dir, 'workflows', 'hello'), { recursive: true })
  return dir
}

/** `<repo>/**` IS the fixture — a repo-root, single-implementation shape. */
function rootSource(): string {
  const dir = tempDir('workflow-cli-init-root-src-')
  cpSync(fixtureDir, dir, { recursive: true })
  return dir
}

/**
 * `<repo>/<relPath>/**` = the fixture, under a name other than the
 * conventional default (`workflows/hello`) — for the search-fallback tests,
 * so the default-path shortcut (tried before a repo-wide search) never
 * shadows what's actually being exercised.
 */
function sourceAt(relPath: string): string {
  const dir = tempDir('workflow-cli-init-custom-src-')
  cpSync(fixtureDir, join(dir, ...relPath.split('/')), { recursive: true })
  return dir
}

function freshCwd(): string {
  return tempDir('workflow-cli-init-cwd-')
}

const baseArgs = { harnessAlias: 'workflow', dryRun: false } as const

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

describe('parseInit', () => {
  test('parses <alias> with defaults', () => {
    expect(parseInit(['studio'])).toEqual({
      alias: 'studio',
      from: 'bffless/workflow-implementations',
      path: undefined,
      ref: undefined,
      dest: undefined,
      project: undefined,
      harnessAlias: 'workflow',
      dryRun: false,
    })
  })

  test('parses every flag', () => {
    expect(
      parseInit([
        'studio',
        '--from',
        'acme/repo',
        '--path',
        'workflows/hello',
        '--ref',
        'v1.2.3',
        '--dest',
        'impl',
        '--project',
        'acme/site',
        '--harness-alias',
        'harness',
        '--dry-run',
      ]),
    ).toEqual({
      alias: 'studio',
      from: 'acme/repo',
      path: 'workflows/hello',
      ref: 'v1.2.3',
      dest: 'impl',
      project: 'acme/site',
      harnessAlias: 'harness',
      dryRun: true,
    })
  })

  test('errors on missing alias', () => {
    expect(parseInit([])).toEqual({ error: expect.stringContaining('init') })
  })

  test('errors on too many positionals', () => {
    expect(parseInit(['studio', 'extra'])).toEqual({ error: expect.any(String) })
  })

  test('errors on an unknown flag', () => {
    expect(parseInit(['studio', '--nope'])).toEqual({ error: expect.stringContaining('--nope') })
  })

  test('errors on a value flag with no value', () => {
    expect(parseInit(['studio', '--from'])).toEqual({ error: expect.stringContaining('--from') })
  })
})

describe('runInit', () => {
  test('Step 1: init studio --from <tmp-repo> --path workflows/hello --dest impl --project acme/site', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const lines: string[] = []
    const status = runInit(
      cwd,
      {
        ...baseArgs,
        alias: 'studio',
        from: src,
        path: 'workflows/hello',
        dest: 'impl',
        project: 'acme/site',
      } satisfies InitArgs,
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)

    // Identity file reads studio.
    expect(readIdentity(join(cwd, 'impl'))).toEqual({ alias: 'studio', harness: 'workflow' })

    // Rule set dir is .bffless/proxy-rules/studio.
    expect(existsSync(join(cwd, 'impl/.bffless/proxy-rules/studio'))).toBe(true)
    expect(existsSync(join(cwd, 'impl/.bffless/proxy-rules/hello'))).toBe(false)

    // Generated deploy-studio.yml carries alias: studio, repository: acme/site, paths under impl/.
    const deploy = readFileSync(join(cwd, '.github/workflows/deploy-studio.yml'), 'utf8')
    expect(deploy).toContain('alias: studio')
    expect(deploy).toContain('repository: acme/site')
    expect(deploy).toContain('path: impl/dist')
    expect(deploy).toContain('workflows: impl/.bffless/workflows')
    expect(deploy).toContain('rules: impl/.bffless/proxy-rules/studio')
    expect(deploy).toContain("pnpm --filter ./impl run build")

    const preview = readFileSync(join(cwd, '.github/workflows/preview-studio.yml'), 'utf8')
    expect(preview).toContain('repository: acme/site')
    expect(preview).toContain('alias: studio-pr-${{ github.event.number }}')
    expect(preview).toContain('path: impl/dist')

    // The source tree is untouched.
    expect(readIdentity(join(src, 'workflows/hello'))).toEqual({ alias: 'hello', harness: 'workflow' })
    expect(existsSync(join(src, 'workflows/hello/.bffless/proxy-rules/hello'))).toBe(true)

    // Report lines were printed.
    const out = lines.join('\n')
    expect(out).toMatch(/rename .*proxy-rules\/hello.*proxy-rules\/studio/)
    expect(out).toContain('generate .github/workflows/deploy-studio.yml')
    expect(out).toContain('generate .github/workflows/preview-studio.yml')
    expect(out).toContain('BFFLESS_API_KEY')
  })

  test('--dry-run prints the copy/rename/generate plan and writes nothing', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: 'impl', project: 'acme/site', dryRun: true },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)

    // Zero writes.
    expect(existsSync(join(cwd, 'impl'))).toBe(false)
    expect(existsSync(join(cwd, '.github'))).toBe(false)

    const out = lines.join('\n')
    expect(out).toMatch(/\(dry run\) copy/)
    expect(out).toContain('impl/')
    expect(out).toMatch(/\(dry run\) rename .*proxy-rules\/hello.*proxy-rules\/studio/)
    expect(out).toContain('(dry run) generate .github/workflows/deploy-studio.yml')
    expect(out).toContain('(dry run) generate .github/workflows/preview-studio.yml')
  })

  test('missing --project exits 2 when workflow generation would happen, and writes nothing', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: 'impl' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/--project/)
    expect(existsSync(join(cwd, 'impl'))).toBe(false)
    expect(existsSync(join(cwd, '.github'))).toBe(false)
  })

  test('an invalid alias exits 2 before touching disk', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'workflow', from: src, path: 'workflows/hello', dest: 'impl', project: 'acme/site' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/reserved/)
    expect(existsSync(join(cwd, 'impl'))).toBe(false)
  })

  test('default --dest is ./<alias>', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', project: 'acme/site' },
      () => {},
      () => {},
    )
    expect(status).toBe(0)
    expect(readIdentity(join(cwd, 'studio'))).toEqual({ alias: 'studio', harness: 'workflow' })
    const deploy = readFileSync(join(cwd, '.github/workflows/deploy-studio.yml'), 'utf8')
    expect(deploy).toContain('path: studio/dist')
  })

  test('omitting --path finds the sole candidate via a repo-wide search', () => {
    // Named off the conventional default ("workflows/hello") on purpose —
    // this exercises the search fallback, not the default-path shortcut.
    const src = sourceAt('implementations/alpha')
    const cwd = freshCwd()
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, dest: 'impl', project: 'acme/site' },
      () => {},
      () => {},
    )
    expect(status).toBe(0)
    expect(readIdentity(join(cwd, 'impl'))).toEqual({ alias: 'studio', harness: 'workflow' })
  })

  test('omitting --path with several candidates errors, listing them', () => {
    const src = sourceAt('implementations/alpha')
    cpSync(join(src, 'implementations', 'alpha'), join(src, 'implementations', 'beta'), { recursive: true })
    const cwd = freshCwd()
    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, dest: 'impl', project: 'acme/site' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    const message = errors.join('\n')
    expect(message).toContain('implementations/alpha')
    expect(message).toContain('implementations/beta')
  })

  test('an explicit --path with no identity file there errors, listing what was found instead', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/nope', dest: 'impl', project: 'acme/site' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    const message = errors.join('\n')
    expect(message).toContain('workflows/nope')
    expect(message).toContain('workflows/hello')
  })

  test('a repo-root package copied into a repo-root destination skips generation (no --project needed)', () => {
    const src = rootSource()
    const cwd = freshCwd()
    const lines: string[] = []
    const status = runInit(cwd, { ...baseArgs, alias: 'studio', from: src, path: '.', dest: '.' }, (l) => lines.push(l), () => {})
    expect(status).toBe(0)
    expect(readIdentity(cwd)).toEqual({ alias: 'studio', harness: 'workflow' })
    expect(existsSync(join(cwd, '.github', 'workflows', 'deploy-studio.yml'))).toBe(false)
    expect(existsSync(join(cwd, '.github', 'workflows', 'preview-studio.yml'))).toBe(false)
    expect(lines.join('\n')).not.toContain('generate .github/workflows')
  })

  test('a repo-root package copied under a subdirectory still requires --project and generates', () => {
    const src = rootSource()
    const cwd = freshCwd()
    const errors: string[] = []
    const missingProject = runInit(cwd, { ...baseArgs, alias: 'studio', from: src, path: '.', dest: 'impl' }, () => {}, (l) =>
      errors.push(l),
    )
    expect(missingProject).toBe(2)
    expect(errors.join('\n')).toMatch(/--project/)

    const status = runInit(cwd, { ...baseArgs, alias: 'studio', from: src, path: '.', dest: 'impl', project: 'acme/site' }, () => {}, () => {})
    expect(status).toBe(0)
    expect(existsSync(join(cwd, '.github/workflows/deploy-studio.yml'))).toBe(true)
  })

  test('never overwrites an existing generated workflow file', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const first = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: 'impl', project: 'acme/site' },
      () => {},
      () => {},
    )
    expect(first).toBe(0)
    writeFileSync(join(cwd, '.github/workflows/deploy-studio.yml'), 'hand-edited\n')

    const src2 = monorepoSource()
    const lines: string[] = []
    const second = runInit(
      join(cwd), // re-init into the same cwd (a different --dest to avoid the rename-source collision)
      { ...baseArgs, alias: 'studio', from: src2, path: 'workflows/hello', dest: 'impl2', project: 'acme/site' },
      (l) => lines.push(l),
      () => {},
    )
    expect(second).toBe(0)
    expect(readFileSync(join(cwd, '.github/workflows/deploy-studio.yml'), 'utf8')).toBe('hand-edited\n')
    expect(lines.join('\n')).toContain('skip .github/workflows/deploy-studio.yml (already exists)')
  })
})

/**
 * The destination preflight (`findDestinationConflicts`, src/verbs/init.ts)
 * — added after review flagged that a populated `--dest .` (the Task 8
 * dogfood shape: copying into the real, non-empty `bffless.app` repo) was
 * silently overwritten with no collision check, and that the real-copy
 * filesystem calls had no try/catch, unlike every other fallible step.
 */
describe('destination conflict guard', () => {
  test('a populated --dest . that collides with a package file exits 2, naming the conflict, and leaves it untouched', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    writeFileSync(join(cwd, 'package.json'), '{"name":"host-repo-package-json"}\n')

    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('package.json')
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe('{"name":"host-repo-package-json"}\n')
    // Nothing else from the package landed either — the whole copy was refused up front.
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
  })

  test('--dry-run also surfaces a destination conflict (exit 2, nothing written)', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    writeFileSync(join(cwd, 'package.json'), '{"name":"host-repo-package-json"}\n')

    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', dryRun: true },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/\(dry run\)/)
    expect(errors.join('\n')).toContain('package.json')
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe('{"name":"host-repo-package-json"}\n')
  })

  test('a plain file sitting where --dest should be a directory exits 2 cleanly (no thrown ENOTDIR)', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    writeFileSync(join(cwd, 'impl'), 'not a directory\n')

    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: 'impl', project: 'acme/site' },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/not a directory/)
    expect(readFileSync(join(cwd, 'impl'), 'utf8')).toBe('not a directory\n')
  })

  test('the Task 8 shape — nested --path, --dest . — still succeeds when the destination only has UNRELATED existing files', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    writeFileSync(join(cwd, 'README-host.md'), 'the host repo\'s own readme\n')
    writeFileSync(join(cwd, 'notes.txt'), 'unrelated host notes\n')

    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site' },
      () => {},
      () => {},
    )
    expect(status).toBe(0)
    // Unrelated host files are untouched.
    expect(readFileSync(join(cwd, 'README-host.md'), 'utf8')).toBe('the host repo\'s own readme\n')
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('unrelated host notes\n')
    // The package landed at the repo root, renamed.
    expect(readIdentity(cwd)).toEqual({ alias: 'studio', harness: 'workflow' })
    expect(existsSync(join(cwd, '.bffless/proxy-rules/studio'))).toBe(true)
  })
})

describe('workflow init (CLI wiring)', () => {
  test('exits 0, is no longer in the unimplemented-verb list', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const r = run(['init', 'studio', '--from', src, '--path', 'workflows/hello', '--dest', 'impl', '--project', 'acme/site'], cwd)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('not implemented')
    expect(readIdentity(join(cwd, 'impl'))).toEqual({ alias: 'studio', harness: 'workflow' })
  })

  test('missing --project exits 2 through the CLI', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const r = run(['init', 'studio', '--from', src, '--path', 'workflows/hello', '--dest', 'impl'], cwd)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--project')
  })
})
