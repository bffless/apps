import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeAll, test, expect } from 'vitest'
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
