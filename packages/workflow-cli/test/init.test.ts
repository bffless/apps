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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const baseArgs = { harnessAlias: 'workflow', dryRun: false, skipExisting: false } as const

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
      skipExisting: false,
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
        '--skip-existing',
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
      skipExisting: true,
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

    // Generated workflow-drive.yml is one per repo — no alias placeholders in it.
    const drive = readFileSync(join(cwd, '.github/workflows/workflow-drive.yml'), 'utf8')
    expect(drive).toContain('repository_dispatch')
    expect(drive).toContain('types: [workflow-drive]')
    expect(drive).toContain('workflow-headless')
    expect(drive).toContain('WORKFLOW_APP_TOKEN')
    expect(drive).toContain('WORKFLOW_EMAIL')
    expect(drive).not.toMatch(/__[A-Z_]+__/)

    // The source tree is untouched.
    expect(readIdentity(join(src, 'workflows/hello'))).toEqual({ alias: 'hello', harness: 'workflow' })
    expect(existsSync(join(src, 'workflows/hello/.bffless/proxy-rules/hello'))).toBe(true)

    // Report lines were printed.
    const out = lines.join('\n')
    expect(out).toMatch(/rename .*proxy-rules\/hello.*proxy-rules\/studio/)
    expect(out).toContain('generate .github/workflows/deploy-studio.yml')
    expect(out).toContain('generate .github/workflows/preview-studio.yml')
    expect(out).toContain('generate .github/workflows/workflow-drive.yml')
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
    expect(out).toContain('(dry run) generate .github/workflows/workflow-drive.yml')
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
    writeFileSync(join(cwd, '.github/workflows/workflow-drive.yml'), 'hand-edited-drive\n')

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
    expect(readFileSync(join(cwd, '.github/workflows/workflow-drive.yml'), 'utf8')).toBe('hand-edited-drive\n')
    expect(lines.join('\n')).toContain('skip .github/workflows/deploy-studio.yml (already exists)')
    expect(lines.join('\n')).toContain('skip .github/workflows/workflow-drive.yml (already exists)')
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
    // I5: the refusal message now also points at the escape hatch.
    expect(errors.join('\n')).toContain('--skip-existing')
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

  // I4 (whole-branch review): unguarded IO must map to the CLI's documented
  // exit-code contract (2, `workflow: <message>` on stderr), never an
  // uncaught exception with a raw Node stack trace and Node's default exit
  // code (1 — coincidentally the lint-errors code, which would be actively
  // misleading here). An unreadable subdirectory inside the source package
  // makes the staging `cpSync` (src/verbs/init.ts) throw EACCES with no
  // init-local try/catch around it — exactly the class cli.ts's new
  // top-level dispatch guard exists to catch.
  test('an unreadable file under the source package fails clean through the CLI, not with a stack trace', () => {
    // Root ignores file-mode read permission, so this EACCES never fires —
    // skip rather than false-fail under a root-run CI container.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const src = monorepoSource()
    const secretDir = join(src, 'workflows', 'hello', 'secret')
    mkdirSync(secretDir)
    writeFileSync(join(secretDir, 'file.txt'), 'shh')
    chmodSync(secretDir, 0o000)
    const cwd = freshCwd()

    try {
      const r = run(['init', 'studio', '--from', src, '--path', 'workflows/hello', '--dest', 'impl', '--project', 'acme/site'], cwd)
      expect(r.status).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr.trim()).toMatch(/^workflow: /)
      // A raw Node stack trace means the exception escaped the top-level
      // catch instead of being turned into the documented error.
      expect(r.stderr).not.toMatch(/\bat .*:\d+:\d+/)
      expect(existsSync(join(cwd, 'impl'))).toBe(false)
    } finally {
      chmodSync(secretDir, 0o755)
    }
  })
})

/**
 * C1 (whole-branch review — critical): `init --dest .` must never run the
 * textual rename pass over the whole destination repo. Before the fix,
 * `runInit` copied the package straight into `destDir` and then called
 * `renamePass(destDir, …)` — for `--dest .`, `destDir` IS the host repo, and
 * the rename pass walks every file under whatever directory it's pointed
 * at, rewriting the old alias wherever it appears as an ordinary word. A
 * host file that was never part of the copy (and has nothing to do with
 * this implementation) would get silently corrupted if it happened to
 * contain the old alias. The fix stages the copy in a disposable temp dir,
 * runs the rename pass there, and only ever writes the already-renamed
 * staged result into `destDir` — so the pass structurally cannot see a file
 * it didn't copy.
 */
describe('C1: the rename pass never touches host files it did not copy', () => {
  test('a host repo file that was never copied, but contains the old alias as an ordinary word, is byte-identical after init --dest .', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostFileContent = 'This host repo file says hello a lot: hello, hello again — nothing to do with the package.\n'
    writeFileSync(join(cwd, 'host-notes.txt'), hostFileContent)

    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site' },
      () => {},
      () => {},
    )
    expect(status).toBe(0)

    // Untouched, byte for byte — the whole point of the regression.
    expect(readFileSync(join(cwd, 'host-notes.txt'), 'utf8')).toBe(hostFileContent)

    // The package's own files were still renamed as usual.
    expect(readIdentity(cwd)).toEqual({ alias: 'studio', harness: 'workflow' })
    expect(existsSync(join(cwd, '.bffless/proxy-rules/studio'))).toBe(true)
  })

  test('same regression, --dry-run: the host file is never even staged for a rewrite', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostFileContent = 'hello, hello, hello — host repo prose, not the package.\n'
    writeFileSync(join(cwd, 'host-notes.txt'), hostFileContent)

    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', dryRun: true },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    expect(readFileSync(join(cwd, 'host-notes.txt'), 'utf8')).toBe(hostFileContent)
    // The report never names the host file — only the package's own paths.
    expect(lines.join('\n')).not.toContain('host-notes.txt')
  })
})

/**
 * I5 (whole-branch review, controller ruling): `--skip-existing`. Default
 * behavior (refuse, exit 2) is unchanged and already covered by the
 * "destination conflict guard" describe block above — this covers the flag
 * itself for NON-tier-1 collisions (#559 narrowed the flag: a tier-1
 * collision — package.json, tsconfig.json, a lockfile, vite.config.* — is
 * now a refusal, see the "tier-1 collision guard" block below): colliding
 * paths are left as the host has them (not copied), everything else still
 * lands renamed, and the report says what was skipped.
 */
describe('--skip-existing', () => {
  test('the Task 8 dogfood shape — nested --path, --dest . into a host repo with BOTH unrelated and non-tier-1 colliding files — succeeds, keeping the host\'s colliding files and copying the rest renamed', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostReadme = "# Host repo\nThis is the host repo's own README, not the package's.\n"
    const hostNotes = 'unrelated host notes, nothing to do with the package\n'
    writeFileSync(join(cwd, 'README.md'), hostReadme)
    writeFileSync(join(cwd, 'notes.txt'), hostNotes)

    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', skipExisting: true },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)

    // Host's colliding file: untouched.
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe(hostReadme)
    // Unrelated host file: untouched (C1's guarantee, still holding here too).
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe(hostNotes)

    // The package's non-colliding files still landed, renamed.
    expect(readIdentity(cwd)).toEqual({ alias: 'studio', harness: 'workflow' })
    expect(existsSync(join(cwd, '.bffless/proxy-rules/studio'))).toBe(true)
    const build = readFileSync(join(cwd, 'scripts/build.mjs'), 'utf8')
    expect(build).toContain("flagValue('--impl', 'studio')")

    // Reported under the skipped section.
    const out = lines.join('\n')
    expect(out).toContain('skipped (already exists) — merge by hand:')
    expect(out).toContain('  README.md')
  })

  test('--dry-run --skip-existing shows the same skip list and writes nothing', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostReadme = "# Host repo\nThis is the host repo's own README, not the package's.\n"
    writeFileSync(join(cwd, 'README.md'), hostReadme)

    const lines: string[] = []
    const status = runInit(
      cwd,
      {
        ...baseArgs,
        alias: 'studio',
        from: src,
        path: 'workflows/hello',
        dest: '.',
        project: 'acme/site',
        skipExisting: true,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
    expect(existsSync(join(cwd, '.github'))).toBe(false)

    const out = lines.join('\n')
    expect(out).toContain('(dry run) skipped (already exists) — merge by hand:')
    expect(out).toContain('(dry run)   README.md')
    // Unchanged: the host file itself was never touched.
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe(hostReadme)
  })
})

/**
 * #559 (found in #420's Phase-4 dogfood): `--skip-existing` used to resolve
 * EVERY file-level collision in the host's favour and exit 0 — but when the
 * skipped set includes a load-bearing file (package.json: the copy's deps
 * and build script never arrive; tsconfig.json: the host's own build breaks
 * sweeping up the copy's test files), that "merge" is an unrecoverable
 * state presented as success. Now a collision on a tier-1 file —
 * package.json, tsconfig.json, a lockfile, vite.config.* — refuses the
 * whole command (exit 2, zero writes) and recommends `--dest <subdir>`;
 * non-tier-1 collisions keep the skip behaviour (block above).
 */
describe('tier-1 collision guard (--skip-existing)', () => {
  test('a host with its own package.json → --dest . --skip-existing exits 2 naming package.json, zero writes', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostPkg = '{"name":"host-repo-package-json"}\n'
    writeFileSync(join(cwd, 'package.json'), hostPkg)

    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', skipExisting: true },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    const message = errors.join('\n')
    expect(message).toContain('package.json')
    // The way out is a subdirectory destination, not a hand-merge.
    expect(message).toContain('--dest')
    // Zero writes: host file untouched, nothing from the package landed.
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(hostPkg)
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
    expect(existsSync(join(cwd, '.github'))).toBe(false)
  })

  test('--dry-run parity: the tier-1 refusal fires identically under --dry-run', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostPkg = '{"name":"host-repo-package-json"}\n'
    writeFileSync(join(cwd, 'package.json'), hostPkg)

    const errors: string[] = []
    const status = runInit(
      cwd,
      {
        ...baseArgs,
        alias: 'studio',
        from: src,
        path: 'workflows/hello',
        dest: '.',
        project: 'acme/site',
        skipExisting: true,
        dryRun: true,
      },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    const message = errors.join('\n')
    expect(message).toMatch(/\(dry run\)/)
    expect(message).toContain('package.json')
    expect(message).toContain('--dest')
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(hostPkg)
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
  })

  test('a mixed collision set (tier-1 package.json + non-tier-1 README.md) still refuses, naming the tier-1 file', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostPkg = '{"name":"host-repo-package-json"}\n'
    const hostReadme = '# Host repo\n'
    writeFileSync(join(cwd, 'package.json'), hostPkg)
    writeFileSync(join(cwd, 'README.md'), hostReadme)

    const errors: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', skipExisting: true },
      () => {},
      (l) => errors.push(l),
    )
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('package.json')
    // Zero writes even though README.md alone would have been skippable.
    expect(readFileSync(join(cwd, 'package.json'), 'utf8')).toBe(hostPkg)
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe(hostReadme)
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
  })
})

/**
 * #559, second half: directory-level merges were invisible — the conflict
 * check is file-level, so copying into a host that already has a `scripts/`
 * (no individual filename clashing) reported nothing at all. The report
 * (real run and --dry-run alike, sharing the one plan) now lists every
 * top-level directory the copy writes into that already exists at the
 * destination, with the count of files added. Not conditional on
 * --skip-existing: a plain successful run can merge too.
 */
describe('directory merge report', () => {
  test('--skip-existing with a colliding README.md plus an existing scripts/ → succeeds, README skipped, scripts/ merge reported', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const hostReadme = '# Host repo\n'
    const hostScript = '#!/bin/sh\necho host\n'
    writeFileSync(join(cwd, 'README.md'), hostReadme)
    mkdirSync(join(cwd, 'scripts'))
    writeFileSync(join(cwd, 'scripts', 'host.sh'), hostScript)

    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site', skipExisting: true },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)

    const out = lines.join('\n')
    expect(out).toContain('skipped (already exists) — merge by hand:')
    expect(out).toContain('  README.md')
    expect(out).toContain('merged into existing scripts/ (1 file added)')

    // The merge really happened: host's file kept, package's file added.
    expect(readFileSync(join(cwd, 'scripts', 'host.sh'), 'utf8')).toBe(hostScript)
    expect(existsSync(join(cwd, 'scripts', 'build.mjs'))).toBe(true)
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe(hostReadme)
  })

  test('--dry-run parity: the same merge line appears, nothing written', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    writeFileSync(join(cwd, 'README.md'), '# Host repo\n')
    mkdirSync(join(cwd, 'scripts'))
    writeFileSync(join(cwd, 'scripts', 'host.sh'), '#!/bin/sh\necho host\n')

    const lines: string[] = []
    const status = runInit(
      cwd,
      {
        ...baseArgs,
        alias: 'studio',
        from: src,
        path: 'workflows/hello',
        dest: '.',
        project: 'acme/site',
        skipExisting: true,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    expect(lines.join('\n')).toContain('(dry run) merged into existing scripts/ (1 file added)')
    // Zero writes.
    expect(existsSync(join(cwd, '.bffless'))).toBe(false)
    expect(existsSync(join(cwd, 'scripts', 'build.mjs'))).toBe(false)
  })

  test('a plain run (no --skip-existing) with no file collisions still reports the merge into an existing directory', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    mkdirSync(join(cwd, 'assets'))
    writeFileSync(join(cwd, 'assets', 'host.css'), 'body {}\n')

    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: '.', project: 'acme/site' },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('merged into existing assets/ (1 file added)')
    // A directory the host did NOT already have is not a "merge".
    expect(out).not.toContain('merged into existing scripts/')
    expect(readFileSync(join(cwd, 'assets', 'host.css'), 'utf8')).toBe('body {}\n')
    expect(existsSync(join(cwd, 'assets', 'logo.bin'))).toBe(true)
  })
})

/**
 * I6 (whole-branch review): generated deploy/preview workflows assume the
 * destination is already a member of the host repo's pnpm workspace
 * (`computeGeneratedPaths`'s `buildLine` reads `pnpm --filter ./<dest> run
 * build` whenever `dest !== '.'`). `printManualSteps` gains a step telling
 * the caller to add `<dest>` to `pnpm-workspace.yaml` and re-run `pnpm
 * install` — advisory only, never gating the exit code.
 */
describe('manual steps: pnpm workspace (I6)', () => {
  test('a subdirectory --dest prints a step to add it to pnpm-workspace.yaml and reinstall', () => {
    const src = monorepoSource()
    const cwd = freshCwd()
    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'workflows/hello', dest: 'impl', project: 'acme/site' },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('pnpm-workspace.yaml')
    expect(out).toContain('impl')
    expect(out).toMatch(/pnpm install/)
  })

  test('--dest . prints no pnpm-workspace step — the generated build line needs no --filter', () => {
    const src = sourceAt('implementations/alpha')
    const cwd = freshCwd()
    const lines: string[] = []
    const status = runInit(
      cwd,
      { ...baseArgs, alias: 'studio', from: src, path: 'implementations/alpha', dest: '.', project: 'acme/site' },
      (l) => lines.push(l),
      () => {},
    )
    expect(status).toBe(0)
    expect(lines.join('\n')).not.toContain('pnpm-workspace.yaml')
  })
})
