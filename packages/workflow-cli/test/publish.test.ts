/**
 * `workflow publish` (src/verbs/publish.ts, apps#420, plan Decision 8:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:24). Tests
 * stay entirely OFFLINE per the task brief: `--dry-run` (performs none of
 * the four moves — no fs writes, no spawn, no network), the missing-key
 * fast-fail (exits 2 strictly before move 1, provable by pointing
 * `--api-url` at an unroutable address and asserting the call still
 * resolves fast), and move 3's failure path (a real `rules push` spawn is
 * simulated via an injected `spawnRulesPush`, never `npx`/the network) are
 * exercised against a live-shaped `runPublish` call. Moves 1-2 (index,
 * prepare) run for real in the move-3 test — pure filesystem, already
 * proven independently in test/prepare.test.ts and workflow-lint's own
 * suite — since move 3 only runs once they've both succeeded. Move 4's
 * network calls (attach/resolveRuleSetId/uploadBundle) have their own
 * dedicated offline coverage in test/publish-api.test.ts. The full live
 * index->prepare->push->upload->attach sequence against a real BFFless
 * instance is proved separately (Task 6 Step 5, on j5s) — not from this
 * suite.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { parsePublish, runPublish, type SpawnRulesPush } from '../src/verbs/publish.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/hello-tree', import.meta.url))

// `--driver-repo` defaults to `GITHUB_REPOSITORY` (ADR-0006), which GitHub Actions
// sets on every job — so the exact-shape parse cases below would grow a
// `driverRepo` key in CI and not on a laptop. Every test starts with the
// variable unset; the `--driver-repo` cases set what they need themselves.
const ORIGINAL_GITHUB_REPOSITORY_AT_LOAD = process.env.GITHUB_REPOSITORY
beforeEach(() => {
  delete process.env.GITHUB_REPOSITORY
})
afterEach(() => {
  if (ORIGINAL_GITHUB_REPOSITORY_AT_LOAD === undefined) delete process.env.GITHUB_REPOSITORY
  else process.env.GITHUB_REPOSITORY = ORIGINAL_GITHUB_REPOSITORY_AT_LOAD
})

/** execFileSync throws on a non-zero exit; unwrap it so a test can assert the exit status too. */
function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number } {
  try {
    return { stdout: execFileSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8' }), stderr: '', status: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status: number | null }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 }
  }
}

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: packageRoot })
}, 120_000)

/**
 * A fresh temp copy of the hello-tree fixture, made lintable — same helper
 * as test/rename.test.ts's own `makeLintable` (duplicated locally since it
 * isn't exported): appends a minimal real `on`/`jobs` block referencing the
 * fixture's actual `echo` rule, so `buildIndex` (move 1) actually succeeds
 * instead of failing lint on the fixture's otherwise-bare workflow file —
 * needed here so a test can reach move 3 (rules push) at all.
 */
function freshLintableCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-publish-'))
  cpSync(fixtureDir, dir, { recursive: true })
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
  return dir
}

describe('parsePublish', () => {
  test('applies every default when only the required flags are given', () => {
    expect(parsePublish(['--api-url', 'https://x.example.test', '--project', 'o/n'])).toEqual({
      apiUrl: 'https://x.example.test',
      project: 'o/n',
      alias: undefined,
      harnessAlias: 'workflow',
      path: 'dist',
      workflows: '.bffless/workflows',
      rules: undefined,
      name: undefined,
      description: undefined,
      dryRun: false,
    })
  })

  test('every flag overrides its default', () => {
    expect(
      parsePublish([
        '--api-url',
        'https://x.example.test',
        '--project',
        'o/n',
        '--alias',
        'studio',
        '--harness-alias',
        'harness',
        '--path',
        'build',
        '--workflows',
        'flows',
        '--rules',
        'rules-dir',
        '--name',
        'Studio',
        '--description',
        'A studio implementation.',
        '--dry-run',
      ]),
    ).toEqual({
      apiUrl: 'https://x.example.test',
      project: 'o/n',
      alias: 'studio',
      harnessAlias: 'harness',
      path: 'build',
      workflows: 'flows',
      rules: 'rules-dir',
      name: 'Studio',
      description: 'A studio implementation.',
      dryRun: true,
    })
  })

  test('--name and --description need a value', () => {
    expect(parsePublish(['--name'])).toEqual({ error: '--name needs a value' })
    expect(parsePublish(['--description'])).toEqual({ error: '--description needs a value' })
  })

  test('--dry-run is recognized in any position', () => {
    const front = parsePublish(['--dry-run', '--project', 'o/n'])
    const back = parsePublish(['--project', 'o/n', '--dry-run'])
    expect('error' in front).toBe(false)
    expect('error' in back).toBe(false)
    expect((front as { dryRun: boolean }).dryRun).toBe(true)
    expect((back as { dryRun: boolean }).dryRun).toBe(true)
  })

  test('a value flag with no value errors', () => {
    expect(parsePublish(['--project'])).toEqual({ error: '--project needs a value' })
  })

  test('a value flag followed by another flag errors', () => {
    expect(parsePublish(['--project', '--dry-run'])).toEqual({ error: '--project needs a value' })
  })

  test('an unknown option errors', () => {
    expect(parsePublish(['--nope', 'x'])).toEqual({ error: 'unknown option --nope' })
  })

  test('publish takes no positional arguments', () => {
    expect(parsePublish(['studio'])).toEqual({ error: 'unknown option studio' })
  })
})

describe('parsePublish — --driver-repo (ADR-0006)', () => {
  const REQUIRED = ['--api-url', 'https://x.example.test', '--project', 'o/n']
  const ORIGINAL_GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY

  afterEach(() => {
    if (ORIGINAL_GITHUB_REPOSITORY === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = ORIGINAL_GITHUB_REPOSITORY
  })

  test('an explicit --driver-repo is carried onto driverRepo', () => {
    delete process.env.GITHUB_REPOSITORY
    const r = parsePublish([...REQUIRED, '--driver-repo', 'acme/site'])
    expect('error' in r).toBe(false)
    expect((r as { driverRepo?: string }).driverRepo).toBe('acme/site')
  })

  test('GITHUB_REPOSITORY is the default when no flag is given', () => {
    process.env.GITHUB_REPOSITORY = 'acme/site'
    const r = parsePublish(REQUIRED)
    expect('error' in r).toBe(false)
    expect((r as { driverRepo?: string }).driverRepo).toBe('acme/site')
  })

  test('an explicit flag wins over GITHUB_REPOSITORY', () => {
    process.env.GITHUB_REPOSITORY = 'env/repo'
    const r = parsePublish([...REQUIRED, '--driver-repo', 'flag/repo'])
    expect('error' in r).toBe(false)
    expect((r as { driverRepo?: string }).driverRepo).toBe('flag/repo')
  })

  test('neither flag nor GITHUB_REPOSITORY leaves driverRepo absent', () => {
    delete process.env.GITHUB_REPOSITORY
    const r = parsePublish(REQUIRED)
    expect('error' in r).toBe(false)
    expect((r as { driverRepo?: string }).driverRepo).toBeUndefined()
  })

  test('a malformed explicit --driver-repo is a usage error', () => {
    const r = parsePublish([...REQUIRED, '--driver-repo', 'not-a-repo'])
    expect(r).toEqual({ error: '--driver-repo must look like owner/name, got "not-a-repo"' })
  })

  test('a malformed GITHUB_REPOSITORY default is also a usage error', () => {
    process.env.GITHUB_REPOSITORY = 'not-a-repo'
    const r = parsePublish(REQUIRED)
    expect(r).toEqual({ error: '--driver-repo must look like owner/name, got "not-a-repo"' })
  })
})

describe('runPublish --dry-run', () => {
  test('prints the four resolved moves and performs none of them', () => {
    const lines: string[] = []
    const status = runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: undefined,
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    )
    return status.then((code) => {
      expect(code).toBe(0)
      const body = lines.join('\n')

      // Resolved values, not placeholders: alias defaulted from the identity
      // file (hello), the harness alias, project and api-url flags, and the
      // computed rules dir / workflows dir / out path / path-prefix.
      expect(body).toContain('alias=hello')
      expect(body).toContain('harness-alias=workflow')
      expect(body).toContain('project=acme/site')
      expect(body).toContain('api-url=https://x.example.test')
      expect(body).toContain('.bffless/proxy-rules/hello')
      expect(body).toContain('.bffless/workflows')
      expect(body).toMatch(/--out .*[/\\]dist\b/)
      expect(body).toContain('--path-prefix /api/hello')

      // Move 2: the forwarder's resolved in-process target-url.
      expect(body).toContain('/w/hello/*')
      expect(body).toContain('http://localhost:3000/public/acme/site/alias/hello/dist')

      // Move 3: the exact pinned spawn command, unexecuted.
      expect(body).toContain('npx --yes bffless@0.3.3 rules push')
      expect(body).toContain('--project acme/site')

      // Move 4: the upload endpoint + proxy-rule-set wiring, the resolved
      // commitSha (the fixture lives inside this repo's own git checkout,
      // so it's a real `git rev-parse HEAD`, not the placeholder — see the
      // dedicated tests below for both cases), and the harness attach.
      expect(body).toContain('/api/deployments/zip')
      expect(body).toContain('proxyRuleSetNames=[hello]')
      expect(body).toMatch(/commitSha=[a-f0-9]{40}\b/)
      expect(body).toContain('harness alias "workflow"')

      expect(body).toMatch(/dry run.*nothing was written.*no network/)

      // No writes outside a temp dir it never even created: the fixture's
      // own dist/ (nonexistent) and .bffless/workflows/index.json stay absent.
      expect(existsSync(`${fixtureDir}/dist`)).toBe(false)
      expect(readdirSync(`${fixtureDir}/.bffless/workflows`)).toEqual(['hello.workflow.yaml'])
    })
  })

  test('shows the real resolved commitSha (git rev-parse HEAD) when cwd is inside a git repo', () => {
    // The fixture tree lives inside this very repo's git checkout, so the
    // expected value is computed the same way runPublish resolves it —
    // not re-derived, just independently invoked.
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureDir, encoding: 'utf8' }).trim()
    const lines: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    ).then((code) => {
      expect(code).toBe(0)
      expect(lines.join('\n')).toContain(`commitSha=${expectedSha}`)
    })
  })

  test('shows the format-valid all-zero placeholder when cwd is outside any git repo', () => {
    // A bare temp dir — never `git init`ed — with just the identity file
    // dry-run needs to resolve the alias default; no workflows/rules dir
    // required (dry-run never checks they exist).
    const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-publish-nogit-'))
    mkdirSync(join(dir, '.bffless'), { recursive: true })
    writeFileSync(join(dir, '.bffless', 'workflow.json'), '{ "alias": "hello", "harness": "workflow" }\n')

    const lines: string[] = []
    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: undefined,
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    ).then((code) => {
      expect(code).toBe(0)
      expect(lines.join('\n')).toContain(`commitSha=${'0'.repeat(40)}`)
    })
  })

  test('shows the resolved --name (defaults to the alias) and omits --description when absent', () => {
    const lines: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    ).then((code) => {
      expect(code).toBe(0)
      const body = lines.join('\n')
      // Regression pin: omitting --name/--description keeps today's exact
      // default — the resolved name is still the alias, and no --description
      // fragment appears at all (there's no meaningful default to show).
      expect(body).toContain('--name "hello"')
      expect(body).not.toContain('--description')
    })
  })

  test('shows an explicit --name/--description', () => {
    const lines: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        name: 'Hello Display Name',
        description: 'A friendly description.',
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    ).then((code) => {
      expect(code).toBe(0)
      const body = lines.join('\n')
      expect(body).toContain('--name "Hello Display Name"')
      expect(body).toContain('--description "A friendly description."')
    })
  })

  test('an explicit --alias overrides the identity file default', () => {
    const lines: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'studio',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      {},
    ).then((code) => {
      expect(code).toBe(0)
      const body = lines.join('\n')
      expect(body).toContain('alias=studio')
      expect(body).toContain('--path-prefix /api/studio')
      expect(body).toContain('/w/studio/*')
    })
  })

  test('BFFLESS_API_URL env is used when --api-url is omitted', () => {
    const lines: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: undefined,
        project: 'acme/site',
        alias: 'studio',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      () => {},
      { BFFLESS_API_URL: 'https://env.example.test' },
    ).then((code) => {
      expect(code).toBe(0)
      expect(lines.join('\n')).toContain('api-url=https://env.example.test')
    })
  })

  test('no identity file and no --alias exits 2 (never a dry-run print)', () => {
    const lines: string[] = []
    const errors: string[] = []
    return runPublish(
      fileURLToPath(new URL('./fixtures', import.meta.url)), // has no .bffless/workflow.json
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: undefined,
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      (l) => lines.push(l),
      (l) => errors.push(l),
      {},
    ).then((code) => {
      expect(code).toBe(2)
      expect(lines).toEqual([])
      expect(errors.join('\n')).toMatch(/workflow: /)
    })
  })

  test('a missing --project exits 2', () => {
    const errors: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: 'https://x.example.test',
        project: undefined,
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      () => {},
      (l) => errors.push(l),
      {},
    ).then((code) => {
      expect(code).toBe(2)
      expect(errors.join('\n')).toContain('--project')
    })
  })

  test('a missing --api-url (and no BFFLESS_API_URL) exits 2', () => {
    const errors: string[] = []
    return runPublish(
      fixtureDir,
      {
        apiUrl: undefined,
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: true,
      },
      () => {},
      (l) => errors.push(l),
      {},
    ).then((code) => {
      expect(code).toBe(2)
      expect(errors.join('\n')).toContain('--api-url')
    })
  })
})

describe('runPublish — move 3 (rules push) failure', () => {
  test('a failing rules-push spawn exits 2 with the failure detail, without reaching move 4', () => {
    const dir = freshLintableCopy()
    const errors: string[] = []
    const outLines: string[] = []

    // Simulates the exact live-proven failure (apps#420 j5s smoke): the
    // server rejects a schema ref. execFileSync's real thrown error shape is
    // an Error with .stderr/.stdout Buffers attached; this mirrors that
    // without ever spawning `npx` or touching the network.
    const failingSpawn: SpawnRulesPush = () => {
      const error = new Error('Command failed: npx --yes bffless@0.3.3 rules push') as Error & {
        stderr?: Buffer
        stdout?: Buffer
      }
      error.stderr = Buffer.from(
        'rules push failed: .../rules/job/get/rule.yaml: schema ref "$schema:hello_jobs" has no manifest (schemas/hello_jobs.schema.yaml)',
      )
      throw error
    }

    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: false,
      },
      (l) => outLines.push(l),
      (l) => errors.push(l),
      { BFFLESS_API_KEY: 'fake-key-for-this-test' },
      failingSpawn,
    ).then((code) => {
      expect(code).toBe(2)
      const message = errors.join('\n')
      expect(message).toMatch(/^workflow: rules push failed: /)
      expect(message).toContain('schema ref "$schema:hello_jobs" has no manifest')

      // Moves 1-2 did run (real filesystem work) and reported success before
      // move 3 failed; move 4 (upload/attach) never printed anything.
      expect(outLines.some((l) => l.startsWith('1. indexed'))).toBe(true)
      expect(outLines.some((l) => l.startsWith('2. prepared'))).toBe(true)
      expect(outLines.some((l) => l.startsWith('3.'))).toBe(false)
      expect(outLines.some((l) => l.startsWith('4.'))).toBe(false)
    })
  })
})

describe('runPublish — move 1 (index) --name/--description', () => {
  // A stub that always fails move 3 — moves 1-2 (real filesystem work) have
  // already run and written the bundle by the time it's reached, which is
  // all these tests need to inspect.
  const stopAfterMove2: SpawnRulesPush = () => {
    throw new Error('stub: stops the run right after move 1/2')
  }

  function readIndexJson(dir: string): { name: string; description: string } {
    return JSON.parse(readFileSync(join(dir, 'dist/.bffless/workflows/index.json'), 'utf8')) as {
      name: string
      description: string
    }
  }

  test('an explicit --name/--description flow into the written index.json', () => {
    const dir = freshLintableCopy()
    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        name: 'Hello Display Name',
        description: 'A friendly description.',
        dryRun: false,
      },
      () => {},
      () => {},
      { BFFLESS_API_KEY: 'fake-key-for-this-test' },
      stopAfterMove2,
    ).then((code) => {
      expect(code).toBe(2) // move 3 stubbed to fail — irrelevant to what move 1 already wrote
      const index = readIndexJson(dir)
      expect(index.name).toBe('Hello Display Name')
      expect(index.description).toBe('A friendly description.')
    })
  })

  test('omitted --name/--description default name to the alias and leave description empty (regression pin — today\'s exact defaults)', () => {
    const dir = freshLintableCopy()
    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: false,
      },
      () => {},
      () => {},
      { BFFLESS_API_KEY: 'fake-key-for-this-test' },
      stopAfterMove2,
    ).then((code) => {
      expect(code).toBe(2)
      const index = readIndexJson(dir)
      expect(index.name).toBe('hello')
      expect(index.description).toBe('')
    })
  })
})

describe("runPublish — --driver-repo (ADR-0006) flows into move 1's index.json", () => {
  // Same stub as the --name/--description block above: moves 1-2 (real
  // filesystem work) run to completion, then move 3 is stubbed to fail —
  // all these tests need is what move 1 already wrote.
  const stopAfterMove2: SpawnRulesPush = () => {
    throw new Error('stub: stops the run right after move 1/2')
  }

  function readIndexJson(dir: string): { driver?: { repo: string } } {
    return JSON.parse(readFileSync(join(dir, 'dist/.bffless/workflows/index.json'), 'utf8')) as {
      driver?: { repo: string }
    }
  }

  test('an explicit driverRepo lands on the written index.json as driver.repo', () => {
    const dir = freshLintableCopy()
    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        driverRepo: 'acme/site',
        dryRun: false,
      },
      () => {},
      () => {},
      { BFFLESS_API_KEY: 'fake-key-for-this-test' },
      stopAfterMove2,
    ).then((code) => {
      expect(code).toBe(2) // move 3 stubbed to fail — irrelevant to what move 1 already wrote
      expect(readIndexJson(dir).driver).toEqual({ repo: 'acme/site' })
    })
  })

  test('an omitted driverRepo leaves index.json without a driver key', () => {
    const dir = freshLintableCopy()
    return runPublish(
      dir,
      {
        apiUrl: 'https://x.example.test',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: false,
      },
      () => {},
      () => {},
      { BFFLESS_API_KEY: 'fake-key-for-this-test' },
      stopAfterMove2,
    ).then((code) => {
      expect(code).toBe(2)
      expect(readIndexJson(dir)).not.toHaveProperty('driver')
    })
  })
})

describe('runPublish — missing BFFLESS_API_KEY exits 2 before any network call', () => {
  test('an unroutable --api-url still fails fast (no connection was ever attempted)', () => {
    const errors: string[] = []
    const started = Date.now()
    return runPublish(
      fixtureDir,
      {
        // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — guaranteed unroutable, so a
        // real connection attempt would hang/time out rather than fail fast.
        apiUrl: 'http://192.0.2.1',
        project: 'acme/site',
        alias: 'hello',
        harnessAlias: 'workflow',
        path: 'dist',
        workflows: '.bffless/workflows',
        rules: undefined,
        dryRun: false,
      },
      () => {},
      (l) => errors.push(l),
      {}, // no BFFLESS_API_KEY
    ).then((code) => {
      expect(Date.now() - started).toBeLessThan(2000)
      expect(code).toBe(2)
      expect(errors.join('\n')).toMatch(/BFFLESS_API_KEY/)
    })
  }, 5000)
})

describe('workflow publish (CLI wiring)', () => {
  test('publish is no longer in the unimplemented-verb list', () => {
    const r = run(['publish', '--dry-run', '--api-url', 'https://x.example.test', '--project', 'acme/site'], fixtureDir, {
      ...process.env,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('not implemented')
    expect(r.stdout).toContain('alias=hello')
  })

  test('--dry-run through the real binary prints the four moves and touches nothing', () => {
    const r = run(['publish', '--dry-run', '--api-url', 'https://x.example.test', '--project', 'acme/site'], fixtureDir, {
      ...process.env,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('npx --yes bffless@0.3.3 rules push')
    expect(r.stdout).toMatch(/dry run.*nothing was written.*no network/)
    expect(existsSync(`${fixtureDir}/dist`)).toBe(false)
  })

  test('a missing BFFLESS_API_KEY exits 2 through the real binary, unroutable --api-url included', () => {
    const env = { ...process.env }
    delete env.BFFLESS_API_KEY
    const r = run(['publish', '--api-url', 'http://192.0.2.1', '--project', 'acme/site'], fixtureDir, env)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/workflow: BFFLESS_API_KEY is required/)
  }, 5000)
})
