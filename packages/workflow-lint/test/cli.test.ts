import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, test, expect } from 'vitest'
import { runCli } from '../src/cli.js'

const fixture = (n: string) => fileURLToPath(new URL(`./fixtures/broken/${n}.workflow.yaml`, import.meta.url))
const example = (n: string) =>
  fileURLToPath(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url))
// studio.workflow.yaml moved with its implementation to
// bffless/workflow-implementations (M4) — the CLI runs that used to read it
// out of the removed workflow-studio app now run against the vendored fixtures below
// (plain-impl for the publisher-flag smokes, hello-workspace for --alias),
// exactly as the hello rule set was vendored when hello moved out (M3 Task 7).
/**
 * A self-contained fixture (R35: this package must not depend on another
 * workspace's app) vendored from the pre-extraction
 * `apps/workflow/.bffless/proxy-rules/hello` tree (git a74e339, before M3 Task 7
 * moved hello to bffless/workflow-hello) — the `api/hello/*` layout these tests
 * were written against, alongside a minimal `workflow` set so the "search finds
 * several" / `--alias` semantics have a real second set to disambiguate from.
 */
const helloRules = fileURLToPath(new URL('./fixtures/hello-workspace/.bffless/proxy-rules/hello', import.meta.url))
/** Lives inside the fixture so the CLI's upward search for `.bffless/proxy-rules` finds the fixture's own two sets (hello, workflow), not the real app's (now down to one). */
const helloWorkspaceExample = fileURLToPath(new URL('./fixtures/hello-workspace/hello.workflow.yaml', import.meta.url))

function run(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(argv, (l) => out.push(l), (l) => err.push(l))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const tmpDirs: string[] = []

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
  const r = run(['lint', '--alias', 'hello', helloWorkspaceExample])
  expect(r.code).toBe(0)
  expect(r.out).not.toMatch(/no rule serves|skipping the rule check/)
})

test('no rule set in sight: a notice, never a failure', () => {
  // The fixture's own search root: two real sets, no --alias to pick one —
  // ambiguous, same as genuinely finding none (checkRules degrades either way).
  const r = run(['lint', helloWorkspaceExample])
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
  // `--alias workflow` resolves the hello-workspace fixture's minimal
  // `workflow` set for real (it serves only /api/workflow/ping), so on top of
  // the broken fixture's 2 errors this run reports every hello path as
  // rule-missing. Assert a floor, not the exact count; hello's one deliberate
  // notice (boom omits outputs) rides along, so file 2's findings are
  // rule-missing errors plus that notice and nothing else.
  const r = run(['lint', '--json', '--alias', 'workflow', fixture('skip-missing-output'), helloWorkspaceExample])
  expect(r.code).toBe(1)
  const data = JSON.parse(r.out)
  expect(data.version).toBe(1)
  expect(data.files).toHaveLength(2)
  expect(data.summary.errors).toBeGreaterThanOrEqual(2)
  expect(data.files[0].findings.map((f: { rule: string }) => f.rule)).toContain('headless-skip-outputs')
  const rules = data.files[1].findings.map((f: { rule: string }) => f.rule)
  expect(rules).toContain('rule-missing')
  expect(rules.every((r2: string) => r2 === 'rule-missing' || r2 === 'outputs-omitted')).toBe(true)
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

/**
 * execFileSync throws on a non-zero exit; unwrap it so a test can assert the
 * exit status as well as the output, instead of only ever seeing the success
 * case — or, worse, swallowing a failing exit behind a text match.
 */
function execBin(args: string[]): { stdout: string; status: number } {
  try {
    return { stdout: execFileSync(process.execPath, args, { encoding: 'utf8' }), status: 0 }
  } catch (e) {
    const err = e as { stdout: string; status: number | null }
    return { stdout: err.stdout, status: err.status ?? -1 }
  }
}

// The publisher's invocation shape (the one bffless/publish-workflow@v1 runs
// at deploy time), against the vendored prefix-free fixture: --path-prefix
// supplies the prefix and the lint passes — exit 0, no errors or warnings,
// exactly the fixture's one known notice (plain's `echo` step declares no
// outputs). (The real studio workflow gets this exact treatment in
// bffless/workflow-implementations' own CI.)
const publisherArgs = (workflow: string) => [
  'lint', '--quiet', '--rules', plainImpl('.bffless/proxy-rules/plain'), '--path-prefix', '/api/plain', workflow,
]

test('built dist/cli.js runs and lints the plain fixture workflow clean', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  // A bin-wiring smoke: does the built CLI run, does it print a summary line
  // at all. A silent no-op (exit 0, no output) prints nothing, so requiring
  // the summary line catches that failure mode; asserting the status catches
  // a lint that runs but fails.
  const r = execBin([cli, ...publisherArgs(plainImpl('.bffless/workflows/plain.workflow.yaml'))])
  expect(r.status).toBe(0)
  expect(r.stdout).toMatch(/0 error\(s\), 0 warning\(s\), 1 notice\(s\)/)
})

// A published `bin` is invoked through a symlink (npm) or shim (pnpm) whose
// realpath differs from argv[1] — Node resolves the main module through the
// link before import.meta.url is set. The self-invocation guard at the
// bottom of cli.ts must compare realpaths, not raw paths, or the CLI
// silently no-ops (exit 0, no output) exactly like `npx @bffless/workflow-lint --help` did.
test('runs when invoked through a bin symlink, same as invoked directly', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'workflow-lint-bin-'))
  tmpDirs.push(dir)
  const link = join(dir, 'workflow')
  symlinkSync(cli, link)

  // The point is parity: the symlink invocation must behave exactly like the
  // realpath one — same status, same summary — not merely "print something".
  const workflow = plainImpl('.bffless/workflows/plain.workflow.yaml')
  const viaSymlink = execBin([link, ...publisherArgs(workflow)])
  expect(viaSymlink.status).toBe(0)
  expect(viaSymlink.stdout).toMatch(/0 error\(s\), 0 warning\(s\), 1 notice\(s\)/)

  const viaRealPath = execBin([cli, ...publisherArgs(workflow)])
  expect(viaRealPath.status).toBe(viaSymlink.status)
  expect(viaRealPath.stdout).toBe(viaSymlink.stdout)
})

// ---------------------------------------------------------------------------
// `workflow index` — the publish-side verb a separate implementation repo runs
// ---------------------------------------------------------------------------

const plainImpl = (rel: string) => fileURLToPath(new URL(`./fixtures/plain-impl/${rel}`, import.meta.url))

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

test('a --path-prefix the publisher would never apply fails the lint, naming /api/<alias>', () => {
  // #560: the value used to cancel out of the rule-missing comparison, so
  // `/nonsense` linted as clean as `/api/plain`. Now it is its own error.
  const r = run([
    'lint',
    '--rules', plainImpl('.bffless/proxy-rules/plain'),
    '--path-prefix', '/nonsense',
    plainImpl('.bffless/workflows/plain.workflow.yaml'),
  ])
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/path-prefix-mismatch/)
  expect(r.out).toMatch(/\/api\/plain/)
})

test('a mismatched --path-prefix fails the index, and nothing is written', () => {
  const out = outDir()
  expect(indexRun(out).code).toBe(0) // sanity: the matching prefix still publishes
  const out2 = outDir()
  const bad = run([
    'index', plainImpl('.bffless/workflows'),
    '--out', out2, '--impl', 'plain', '--name', 'Plain',
    '--rules', plainImpl('.bffless/proxy-rules/plain'),
    '--path-prefix', '/api',
  ])
  expect(bad.code).toBe(1)
  expect(bad.err).toMatch(/path-prefix-mismatch/)
  expect(existsSync(join(out2, '.bffless/workflows/index.json'))).toBe(false)
})

test('--path-prefix needs a value', () => {
  expect(run(['lint', '--path-prefix']).err).toMatch(/--path-prefix needs a value/)
})

test('an explicit --rules that does not resolve fails loudly, before anything is written', () => {
  const out = outDir()
  const r = run([
    'index', plainImpl('.bffless/workflows'),
    '--out', out, '--impl', 'plain', '--name', 'Plain',
    '--rules', plainImpl('.bffless/proxy-rules/nope'),
  ])
  // Exit 2, not the rule-missing notice: the caller named the set, so failing to
  // read it is an environment error and the paths were never actually checked.
  expect(r.code).toBe(2)
  expect(r.err).toMatch(/proxy-rules\/nope/)
  expect(existsSync(join(out, '.bffless/workflows/index.json'))).toBe(false)
})

test('no --rules and nothing to auto-resolve stays a notice — the index still publishes', () => {
  const src = outDir()
  const out = outDir()
  writeFileSync(
    join(src, 'plain.workflow.yaml'),
    readFileSync(plainImpl('.bffless/workflows/plain.workflow.yaml'), 'utf8'),
  )
  const r = run(['index', src, '--out', out, '--impl', 'plain', '--name', 'Plain'])
  expect(r.code).toBe(0)
  expect(existsSync(join(out, '.bffless/workflows/index.json'))).toBe(true)
})
