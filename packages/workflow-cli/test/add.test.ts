/**
 * `workflow add <name> [--step <path>]…` (src/verbs/add.ts) — apps#420, plan
 * Decision 11 (docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:27,
 * task-5-brief.md). The load-bearing assertion (Step 1 of the brief): after
 * `workflow add summarize --step summarize` on the fixture tree, `workflow
 * lint` reports **zero** `rule-missing` findings — the scaffolded workflow's
 * pipeline step path and the scaffolded rule stub line up exactly per
 * workflow-lint's naming contract (packages/workflow-lint/src/checks/rules.ts,
 * src/rules/scan.ts).
 *
 * `--path-prefix /api/hello` is required for that lint check to resolve
 * correctly: the fixture's rule set (test/fixtures/hello-tree/.bffless/
 * proxy-rules/hello/) is authored bare (rules/echo/post/, no api/hello/
 * segments on disk — the same convention the real `bffless/
 * workflow-implementations` hello set uses), so — exactly as
 * test/rename.test.ts's post-rename validation does — the prefix has to be
 * supplied rather than guessed, same as the real deploy pipeline would.
 *
 * Every test works on a fresh temp copy of test/fixtures/hello-tree — never
 * in-place in the fixture itself (test/rewrite.test.ts's `freshCopy`
 * pattern, duplicated locally since it isn't exported).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRuleSet, lintFile } from '@bffless/workflow-lint'
import { beforeAll, describe, expect, test } from 'vitest'
import { readIdentity } from '../src/identity.js'
import { parseAdd, runAdd, type AddArgs } from '../src/verbs/add.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/hello-tree', import.meta.url))

function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-add-'))
  cpSync(fixtureDir, dir, { recursive: true })
  return dir
}

/** Zero `rule-missing` findings for `file`, checked against `dir`'s `hello` rule set — the brief's Step-1 bar. */
function ruleMissingFindings(dir: string, file: string): unknown[] {
  const rules = resolveRuleSet({
    file,
    rulesDir: join(dir, '.bffless/proxy-rules/hello'),
    pathPrefix: '/api/hello',
  })
  return lintFile(file, { rules }).findings.filter((f) => f.rule === 'rule-missing')
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

describe('parseAdd', () => {
  test('parses <name> with no --step', () => {
    expect(parseAdd(['summarize'])).toEqual({ name: 'summarize', steps: [] })
  })

  test('parses one or more --step flags, in order', () => {
    expect(parseAdd(['summarize', '--step', 'summarize'])).toEqual({ name: 'summarize', steps: ['summarize'] })
    expect(parseAdd(['studio', '--step', 'foo', '--step', 'bar/baz'])).toEqual({
      name: 'studio',
      steps: ['foo', 'bar/baz'],
    })
  })

  test('errors on missing <name>', () => {
    expect(parseAdd([])).toEqual({ error: expect.stringContaining('add') })
  })

  test('errors on too many positionals', () => {
    expect(parseAdd(['summarize', 'extra'])).toEqual({ error: expect.any(String) })
  })

  test('errors on an unknown flag', () => {
    expect(parseAdd(['summarize', '--nope'])).toEqual({ error: expect.stringContaining('--nope') })
  })

  test('errors on --step with no value', () => {
    expect(parseAdd(['summarize', '--step'])).toEqual({ error: expect.stringContaining('--step') })
  })
})

describe('runAdd', () => {
  test('Step 1: add summarize --step summarize scaffolds the workflow + rule stub, and workflow lint reports zero rule-missing findings', () => {
    const dir = freshCopy()
    const lines: string[] = []
    const status = runAdd(dir, { name: 'summarize', steps: ['summarize'] }, (l) => lines.push(l), () => {})
    expect(status).toBe(0)

    const workflowFile = join(dir, '.bffless/workflows/summarize.workflow.yaml')
    expect(existsSync(workflowFile)).toBe(true)
    const workflow = readFileSync(workflowFile, 'utf8')
    expect(workflow).toContain('path: summarize')
    expect(workflow).toMatch(/jobs:\n\s+summarize:/)

    const ruleDir = join(dir, '.bffless/proxy-rules/hello/rules/summarize/post')
    expect(existsSync(join(ruleDir, 'rule.yaml'))).toBe(true)
    expect(existsSync(join(ruleDir, 'summarize.fn.js'))).toBe(true)
    expect(existsSync(join(ruleDir, 'summarize.fn.test.yaml'))).toBe(true)
    expect(readFileSync(join(ruleDir, 'rule.yaml'), 'utf8')).toContain('code: ./summarize.fn.js')
    expect(readFileSync(join(ruleDir, 'summarize.fn.test.yaml'), 'utf8')).toContain('handler: ./summarize.fn.js')

    // The load-bearing assertion: rule-missing is green from the first lint.
    expect(ruleMissingFindings(dir, workflowFile)).toEqual([])

    // The whole lint run is clean too (only an "outputs-omitted" notice is
    // expected, same as the "solo" fixture in workflow-lint's own corpus).
    const rules = resolveRuleSet({ file: workflowFile, rulesDir: join(dir, '.bffless/proxy-rules/hello'), pathPrefix: '/api/hello' })
    const result = lintFile(workflowFile, { rules })
    expect(result.counts.errors).toBe(0)
    expect(result.counts.warnings).toBe(0)

    expect(lines.join('\n')).toContain('add .bffless/workflows/summarize.workflow.yaml')
  })

  test('omitting --step defaults to a single step whose path is <name>', () => {
    const dir = freshCopy()
    const status = runAdd(dir, { name: 'summarize', steps: [] }, () => {}, () => {})
    expect(status).toBe(0)
    const workflowFile = join(dir, '.bffless/workflows/summarize.workflow.yaml')
    expect(readFileSync(workflowFile, 'utf8')).toContain('path: summarize')
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello/rules/summarize/post/rule.yaml'))).toBe(true)
    expect(ruleMissingFindings(dir, workflowFile)).toEqual([])
  })

  test('multiple --step flags scaffold one job with one pipeline step + rule stub per step', () => {
    const dir = freshCopy()
    const status = runAdd(dir, { name: 'multi', steps: ['foo', 'bar/baz'] }, () => {}, () => {})
    expect(status).toBe(0)

    const workflowFile = join(dir, '.bffless/workflows/multi.workflow.yaml')
    const workflow = readFileSync(workflowFile, 'utf8')
    expect(workflow).toContain('path: foo')
    expect(workflow).toContain('path: bar/baz')
    expect(workflow).toContain('id: foo')
    expect(workflow).toContain('id: baz')

    expect(existsSync(join(dir, '.bffless/proxy-rules/hello/rules/foo/post/rule.yaml'))).toBe(true)
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello/rules/bar/baz/post/rule.yaml'))).toBe(true)
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello/rules/bar/baz/post/baz.fn.js'))).toBe(true)

    expect(ruleMissingFindings(dir, workflowFile)).toEqual([])
  })

  test('an existing workflow name exits 2 and writes nothing', () => {
    const dir = freshCopy()
    const errors: string[] = []
    // "hello" already exists as .bffless/workflows/hello.workflow.yaml in the fixture.
    const status = runAdd(dir, { name: 'hello', steps: [] }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('hello.workflow.yaml')
    // Untouched: the fixture's original content is still there.
    expect(readFileSync(join(dir, '.bffless/workflows/hello.workflow.yaml'), 'utf8')).toBe(
      readFileSync(join(fixtureDir, '.bffless/workflows/hello.workflow.yaml'), 'utf8'),
    )
    expect(existsSync(join(dir, '.bffless/proxy-rules/hello/rules/hello'))).toBe(false)
  })

  test('re-running add with the same name after success exits 2, naming the rule-stub conflicts, and writes nothing new', () => {
    const dir = freshCopy()
    const first = runAdd(dir, { name: 'summarize', steps: ['summarize'] }, () => {}, () => {})
    expect(first).toBe(0)

    const errors: string[] = []
    const second = runAdd(dir, { name: 'summarize', steps: ['summarize'] }, () => {}, (l) => errors.push(l))
    expect(second).toBe(2)
    const message = errors.join('\n')
    expect(message).toContain('summarize.workflow.yaml')
    expect(message).toContain('rule.yaml')
  })

  test('an invalid --step path exits 2, citing the value', () => {
    const dir = freshCopy()
    const errors: string[] = []
    const status = runAdd(dir, { name: 'summarize', steps: ['Not Valid!'] }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('Not Valid!')
    expect(existsSync(join(dir, '.bffless/workflows/summarize.workflow.yaml'))).toBe(false)
  })

  test('an invalid <name> exits 2 before touching disk', () => {
    const dir = freshCopy()
    const errors: string[] = []
    const status = runAdd(dir, { name: 'Not-Valid', steps: [] } as AddArgs, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('Not-Valid')
    expect(existsSync(join(dir, '.bffless/workflows'))).toBe(true) // pre-existing hello.workflow.yaml dir, untouched
    expect(existsSync(join(dir, '.bffless/workflows/Not-Valid.workflow.yaml'))).toBe(false)
  })

  test('no rule set at .bffless/proxy-rules/<alias> exits 2', () => {
    const dir = freshCopy()
    execFileSync('rm', ['-rf', join(dir, '.bffless/proxy-rules/hello')])
    const errors: string[] = []
    const status = runAdd(dir, { name: 'summarize', steps: [] }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toContain('proxy-rules/hello')
  })

  test('a missing identity file exits 2', () => {
    const dir = freshCopy()
    execFileSync('rm', ['-rf', join(dir, '.bffless/workflow.json')])
    const errors: string[] = []
    const status = runAdd(dir, { name: 'summarize', steps: [] }, () => {}, (l) => errors.push(l))
    expect(status).toBe(2)
    expect(errors.join('\n')).toMatch(/ENOENT|no such file/)
  })
})

describe('workflow add (CLI wiring)', () => {
  test('exits 0, is no longer in the unimplemented-verb list, and the tree lints clean through the actual CLI', () => {
    const dir = freshCopy()
    const r = run(['add', 'summarize', '--step', 'summarize'], dir)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('not implemented')
    expect(readIdentity(dir)).toEqual({ alias: 'hello', harness: 'workflow' })

    const workflowFile = join(dir, '.bffless/workflows/summarize.workflow.yaml')
    const rulesDir = join(dir, '.bffless/proxy-rules/hello')
    const lint = run(['lint', workflowFile, '--rules', rulesDir, '--path-prefix', '/api/hello'], dir)
    expect(lint.status).toBe(0)
    expect(lint.stdout).not.toContain('rule-missing')
  })

  test('an existing workflow name exits 2 through the CLI', () => {
    const dir = freshCopy()
    const r = run(['add', 'hello'], dir)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('hello.workflow.yaml')
  })
})
