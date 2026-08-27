import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, test, expect } from 'vitest'
import { runCli } from '../src/cli.js'

const fixture = (n: string) => fileURLToPath(new URL(`./fixtures/broken/${n}.workflow.yaml`, import.meta.url))
const example = (n: string) =>
  fileURLToPath(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url))
/** workflow-hello's real rule set — what `pnpm stage` lints the examples against. */
const helloRules = fileURLToPath(
  new URL('../../../apps/workflow/.bffless/proxy-rules/hello', import.meta.url),
)

function run(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(argv, (l) => out.push(l), (l) => err.push(l))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('clean file (notice only) exits 0', () => {
  const r = run(['lint', '--rules', helloRules, example('hello.workflow.yaml')])
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/0 error\(s\), 0 warning\(s\), 1 notice\(s\)/)
  expect(r.out).toMatch(/outputs-omitted/)
  // every relative path in the example is served by a rule in that set
  expect(r.out).not.toMatch(/no rule serves/)
})

test('a path with no rule behind it is an error naming the file to add', () => {
  const r = run(['lint', '--rules', helloRules, fixture('rule-missing')])
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/no rule serves `POST \/api\/hello\/echoo`/)
  expect(r.out).toMatch(/rules\/api\/hello\/echoo\/post\/rule\.yaml/)
  expect(r.out).toMatch(/rules\/api\/hello\/jobs\/get\/rule\.yaml/)
  expect(r.out).toMatch(/2 error\(s\)/)
})

test('--alias picks the set when the search finds several', () => {
  const r = run(['lint', '--alias', 'hello', example('hello.workflow.yaml')])
  expect(r.code).toBe(0)
  expect(r.out).not.toMatch(/no rule serves|skipping the rule check/)
})

test('no rule set in sight: a notice, never a failure', () => {
  const r = run(['lint', example('studio.workflow.yaml')])
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/notice\s+rule-missing\s+no rule set found/)
})

test('--rules and --alias need a value', () => {
  expect(run(['lint', '--rules']).err).toMatch(/--rules needs a value/)
  expect(run(['lint', '--alias', '--json', 'f.yaml']).err).toMatch(/--alias needs a value/)
})

test('errors exit 1 with line:col in the human output', () => {
  const r = run(['lint', fixture('forward-reference')])
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/upstream-reference/)
  expect(r.out).toMatch(/\d+:\d+\s+error/)
})

test('warnings alone also exit 1', () => {
  expect(run(['lint', fixture('file-ref-body')]).code).toBe(1)
})

test('--quiet hides notices but keeps the summary', () => {
  const r = run(['lint', '--quiet', '--rules', helloRules, example('hello.workflow.yaml')])
  expect(r.code).toBe(0)
  expect(r.out).not.toMatch(/outputs-omitted/)
  expect(r.out).toMatch(/1 notice\(s\)/)
})

test('--json emits the stable shape', () => {
  const r = run(['lint', '--json', fixture('skip-missing-output'), example('studio.workflow.yaml')])
  expect(r.code).toBe(1)
  const data = JSON.parse(r.out)
  expect(data.version).toBe(1)
  expect(data.files).toHaveLength(2)
  expect(data.summary.errors).toBe(2)
  expect(data.files[0].findings.map((f: { rule: string }) => f.rule)).toContain('headless-skip-outputs')
})

test('missing file exits 2', () => {
  const r = run(['lint', '/no/such/file.yaml'])
  expect(r.code).toBe(2)
  expect(r.err).toMatch(/no such file/)
})

test('unknown command / no files exit 2 with usage', () => {
  expect(run(['frobnicate']).code).toBe(2)
  const r = run(['lint'])
  expect(r.code).toBe(2)
  expect(r.err).toMatch(/Usage: workflow lint/)
})

// One smoke on the actual built binary, so `bin` wiring stays honest.
beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: fileURLToPath(new URL('..', import.meta.url)) })
}, 120_000)

test('built dist/cli.js runs and exits 0 on the studio example', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'lint', '--quiet', example('studio.workflow.yaml')], {
    encoding: 'utf8',
  })
  expect(out).toMatch(/0 error\(s\), 0 warning\(s\)/)
})

// ---------------------------------------------------------------------------
// `workflow index` — the publish-side verb a separate implementation repo runs
// ---------------------------------------------------------------------------

const plainImpl = (rel: string) => fileURLToPath(new URL(`./fixtures/plain-impl/${rel}`, import.meta.url))
const tmpDirs: string[] = []

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-index-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

function indexRun(out: string, extra: string[] = []) {
  return run([
    'index',
    plainImpl('.bffless/workflows'),
    '--out', out,
    '--impl', 'plain',
    '--name', 'Plain',
    '--rules', plainImpl('.bffless/proxy-rules/plain'),
    '--path-prefix', '/api/plain',
    ...extra,
  ])
}

test('index writes index.json, the YAMLs and a landing page', () => {
  const out = outDir()
  const r = indexRun(out, ['--version', '1.2.3', '--commit', 'deadbee'])
  expect(r.err).toBe('')
  expect(r.code).toBe(0)

  const index = JSON.parse(readFileSync(join(out, '.bffless/workflows/index.json'), 'utf8'))
  expect(index).toMatchObject({
    spec: 1,
    impl: 'plain',
    name: 'Plain',
    description: '',
    version: '1.2.3',
    commit: 'deadbee',
    islands: [],
    scripts: [],
  })
  expect(index.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(index.workflows).toEqual([
    {
      file: 'plain.workflow.yaml',
      name: 'Plain',
      description: 'One echo step, checked against a prefix-free rule set.',
      inputs: 0,
      jobs: 1,
      headlessSafe: true,
    },
  ])

  expect(readFileSync(join(out, '.bffless/workflows/plain.workflow.yaml'), 'utf8')).toMatch(/path: echo/)

  const landing = readFileSync(join(out, 'index.html'), 'utf8')
  expect(landing).toMatch(/<title>workflow-plain<\/title>/)
  expect(landing).toMatch(/\/\^plain\\\./)
})

test('index lists the islands and scripts already staged under --out', () => {
  const out = outDir()
  mkdirSync(join(out, 'islands'), { recursive: true })
  mkdirSync(join(out, 'scripts'), { recursive: true })
  writeFileSync(join(out, 'islands/pick-line.html'), '<!doctype html>')
  writeFileSync(join(out, 'islands/line-viewer.html'), '<!doctype html>')
  writeFileSync(join(out, 'islands/notes.txt'), 'not an island')
  writeFileSync(join(out, 'scripts/analyze.js'), 'export default {}')
  writeFileSync(join(out, 'scripts/helper.mjs'), 'export default {}')

  expect(indexRun(out).code).toBe(0)
  const index = JSON.parse(readFileSync(join(out, '.bffless/workflows/index.json'), 'utf8'))
  expect(index.islands).toEqual(['islands/line-viewer.html', 'islands/pick-line.html'])
  expect(index.scripts).toEqual(['scripts/analyze.js', 'scripts/helper.mjs'])
})

test('a re-run drops a workflow the implementation removed', () => {
  const out = outDir()
  expect(indexRun(out).code).toBe(0)
  writeFileSync(join(out, '.bffless/workflows/stale.workflow.yaml'), 'spec: 1\n')
  expect(indexRun(out).code).toBe(0)
  expect(existsSync(join(out, '.bffless/workflows/stale.workflow.yaml'))).toBe(false)
})

test('a workflow whose path no rule serves fails the index, and nothing is written', () => {
  const out = outDir()
  const r = run([
    'index', plainImpl('broken-workflows'),
    '--out', out, '--impl', 'plain', '--name', 'Plain',
    '--rules', plainImpl('.bffless/proxy-rules/plain'),
    '--path-prefix', '/api/plain',
  ])
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/rule-missing/)
  expect(r.err).toMatch(/renamed\.workflow\.yaml/)
  expect(existsSync(join(out, '.bffless/workflows/index.json'))).toBe(false)
})

test('index needs --out, --impl and --name, and reports a missing directory', () => {
  expect(run(['index', plainImpl('.bffless/workflows')]).err).toMatch(/--out is required/)
  expect(run(['index', '--out', '/tmp/x']).err).toMatch(/no workflows directory given/)
  expect(run(['index', '/no/such/dir', '--out', '/tmp/x', '--impl', 'p', '--name', 'P']).code).toBe(2)
  const r = run(['index', plainImpl('.bffless/workflows'), '--out', '/tmp/x', '--impl', 'p'])
  expect(r.code).toBe(2)
  expect(r.err).toMatch(/--name is required/)
})

test('lint accepts --path-prefix, resolving a prefix-free set the way the publisher will', () => {
  const r = run([
    'lint',
    '--rules', plainImpl('.bffless/proxy-rules/plain'),
    '--path-prefix', '/api/plain',
    plainImpl('.bffless/workflows/plain.workflow.yaml'),
  ])
  expect(r.code).toBe(0)
  expect(r.out).not.toMatch(/no rule serves/)
})

test('--path-prefix needs a value', () => {
  expect(run(['lint', '--path-prefix']).err).toMatch(/--path-prefix needs a value/)
})
