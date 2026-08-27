import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows')
const read = (f) => readFileSync(join(workflowsDir, f), 'utf8')
const all = () => readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

test('exactly one workflow publishes to the app-registry alias', () => {
  const publishers = all().filter((f) => /alias:\s*["']?app-registry\b/.test(read(f)))
  assert.deepEqual(
    publishers,
    ['release.yml'],
    `two publishers of one alias is what made the registry go stale; found ${publishers.join(', ')}`,
  )
})

test('publish-registry runs after both release and bundles', () => {
  const src = read('release.yml')
  const job = src.slice(src.indexOf('publish-registry:'))
  const needs = /needs:\s*\[([^\]]+)\]/.exec(job)
  assert.ok(needs, 'publish-registry must declare needs')
  const names = needs[1].split(',').map((s) => s.trim())
  assert.ok(names.includes('release'), names)
  assert.ok(names.includes('bundles'), names)
})

test('deploy-store.yml is gone', () => {
  assert.equal(all().includes('deploy-store.yml'), false)
})

test('the bundles matrix only ever carries catalog apps', () => {
  // release-please releases packages/* components too (workflow-lint, workflow-script).
  // Those have no catalog bundle, so an unfiltered `paths_released` would hand
  // app-bundles.yml a path that is not an app id and fail every package-only release.
  const src = read('release.yml')
  assert.match(
    src,
    /select\(startswith\("apps\/"\)\)/,
    'release.yml must filter paths_released down to apps/ before stripping the prefix',
  )
})

// GitHub refuses to *evaluate* a strategy whose matrix vector is empty — "Matrix vector
// 'app' does not contain any values" fails the entire run, not just the job. So every
// matrix fed from a release-please output needs a non-empty guard in its `if`, or the
// first release that touches only the other half of the manifest kills the run. That is
// exactly what the 2026-08-27 workflow-lint-v1.0.0 / workflow-script-v1.0.0 release did.
// The window has to stop at the *next* job: sliced to the end of the file, or even to
// publish-registry, the bundles case would span publish-packages too and pass on that
// job's guard while bundles had none.
for (const [job, output, endsAt] of [
  ['bundles', 'apps_released', '\n  publish-packages:'],
  ['publish-packages', 'packages_released', '\n  publish-registry:'],
]) {
  test(`${job} skips itself rather than failing the run on an empty matrix`, () => {
    const src = read('release.yml')
    const start = src.indexOf(`\n  ${job}:\n`)
    assert.ok(start > -1, `release.yml must define a ${job} job`)
    const end = src.indexOf(endsAt, start)
    assert.ok(end > start, `release.yml must still define ${endsAt.trim()} after ${job}`)
    const body = src.slice(start, end)
    assert.ok(
      body.includes(`needs.release.outputs.${output} != '[]'`),
      `${job} must guard on ${output} != '[]' — an empty matrix vector fails the whole run`,
    )
  })
}

test('publish-packages publishes the released packages from inside the release run', () => {
  // The publish cannot be driven by the tag: release-please cuts tags with
  // GITHUB_TOKEN, and GitHub raises no push event for those refs.
  const src = read('release.yml')
  const start = src.indexOf('\n  publish-packages:\n')
  assert.ok(start > -1, 'release.yml must define a publish-packages job')
  const body = src.slice(start, src.indexOf('\n  publish-registry:'))
  assert.match(body, /needs:\s*release\b/, 'publish-packages must run after release')
  assert.match(
    body,
    /uses:\s*\.\/\.github\/workflows\/publish-workflow-lint\.yml/,
    'publish-packages must call the publish workflow',
  )
  assert.match(
    body,
    /secrets:\s*\n\s*NPM_TOKEN:/,
    'publish-packages must pass NPM_TOKEN explicitly — this repo does not inherit secrets into called workflows',
  )
  assert.doesNotMatch(body, /secrets:\s*inherit/, 'a called workflow gets only the secret it needs')
})

test('publish-registry does not wait on publish-packages', () => {
  // An npm publish has nothing to do with the registry; chaining them would make an
  // npm outage withhold the app registry.
  const src = read('release.yml')
  const job = src.slice(src.indexOf('publish-registry:'))
  const needs = /needs:\s*\[([^\]]+)\]/.exec(job)
  const names = needs[1].split(',').map((s) => s.trim())
  assert.equal(names.includes('publish-packages'), false, names)
})

test('the package publish workflow is called, never triggered by its tag', () => {
  // Release-please creates the release tags with the default GITHUB_TOKEN, and
  // "events triggered by the GITHUB_TOKEN will not create a new workflow run"
  // (GitHub docs). A `push: tags:` trigger here can therefore never fire — on
  // 2026-08-27 both tags were cut, no run appeared, and npm got nothing.
  const src = read('publish-workflow-lint.yml')
  assert.match(src, /^\s{2}workflow_call:/m, 'release.yml calls this workflow')
  assert.match(src, /^\s{2}workflow_dispatch:/m, 'manual recovery must stay possible')
  assert.doesNotMatch(
    src,
    /^\s{2}push:/m,
    'a tag-push trigger cannot fire for a tag release-please cut with GITHUB_TOKEN',
  )
})

test('every publishable package component is wired into the release run', () => {
  // The contract that replaced "a workflow triggers on the <component>-v* tag":
  // release.yml must be able to resolve the component's tag, and the publish
  // workflow must know its npm package — otherwise the release cuts a tag that
  // nothing publishes, silently.
  const config = JSON.parse(
    readFileSync(join(workflowsDir, '..', '..', 'release-please-config.json'), 'utf8'),
  )
  const packages = Object.keys(config.packages).filter((k) => k.startsWith('packages/'))
  assert.ok(packages.length > 0, 'expected at least one packages/* component')
  const release = read('release.yml')
  const publish = read('publish-workflow-lint.yml')
  for (const key of packages) {
    const component = config.packages[key].component
    assert.ok(
      release.includes(`${key}--tag_name`),
      `release.yml cannot resolve the tag for ${key} — add its ${key}--tag_name output to the map step's env`,
    )
    assert.ok(
      publish.includes(`@bffless/${component}`),
      `publish-workflow-lint.yml does not know the @bffless/${component} package — the release would cut a tag nothing publishes`,
    )
  }
})
