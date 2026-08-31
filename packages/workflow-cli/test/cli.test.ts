/**
 * Bin-wiring smoke test, same shape as workflow-lint's own
 * (packages/workflow-lint/test/cli.test.ts's "built dist/cli.js" case):
 * this package is a thin router in front of @bffless/workflow-lint, so what
 * needs proving here is the routing and the exit-code contract, not lint
 * correctness — that's workflow-lint's test suite's job.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const brokenFixture = fileURLToPath(new URL('./fixtures/broken.workflow.yaml', import.meta.url))
const indexSrcDir = fileURLToPath(new URL('./fixtures/index-src', import.meta.url))

const pkgVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version: string
  }
).version

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: packageRoot })
}, 120_000)

/**
 * execFileSync throws on a non-zero exit; unwrap it so a test can assert the
 * exit status as well as the output, instead of only ever seeing the success
 * case.
 */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    return {
      stdout: execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }),
      stderr: '',
      status: 0,
    }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status: number | null }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 }
  }
}

describe('workflow --version', () => {
  test('prints the installed @bffless/workflow package version', () => {
    const r = run(['--version'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(pkgVersion)
  })
})

describe('workflow lint', () => {
  test('mirrors workflow-lint\'s exit code on a knowingly-bad fixture', () => {
    const r = run(['lint', brokenFixture])
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/error/)
  })
})

describe('unknown verb', () => {
  test('exits 2', () => {
    const r = run(['nope'])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown (command|verb) `nope`/)
  })
})

describe('workflow index', () => {
  // Regression: runIndex's buildIndex-through-writeFileSync sequence must be
  // exception-safe like workflow-lint's own CLI (its runIndex wraps the
  // equivalent writeIndex(...) call in try/catch) — a write failure mid-run
  // (permission error, full disk, `--out` colliding with an existing file)
  // has to surface as the documented `workflow: <message>` / exit 2, not an
  // uncaught exception with a Node stack trace.
  test('a write failure mid-run exits 2 with the message on stderr, not a stack trace', () => {
    // `--out` pointing at a plain file (not a directory) makes the bundle
    // write fail with a real fs error (ENOTDIR) once buildIndex has already
    // succeeded — indexSrcDir's fixture is schema-valid, so this actually
    // reaches the write step rather than failing lint first.
    const tmp = mkdtempSync(join(tmpdir(), 'workflow-cli-index-'))
    const outIsAFile = join(tmp, 'out')
    writeFileSync(outIsAFile, 'not a directory')

    const r = run(['index', indexSrcDir, '--out', outIsAFile, '--impl', 'plain', '--name', 'Plain'])

    expect(r.status).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr.trim()).toMatch(/^workflow: /)
    // A raw Node stack trace ("at ... (file:line:col)") means the exception
    // escaped the try/catch instead of being turned into the documented error.
    expect(r.stderr).not.toMatch(/\bat .*:\d+:\d+/)
  })
})
