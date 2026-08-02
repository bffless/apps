# Per-App release-please + Single Registry Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let release-please own per-app versions, and make exactly one workflow the sole publisher of the app registry.

**Architecture:** release-please runs in manifest mode with one component per catalog app, bumping `package.json` and mirroring that version into `bffless-app.json` so the manifest and the git tag land in the same commit. A single `release.yml` chains three jobs — `release` → `bundles` → `publish-registry` — with `needs`, so the registry is never published before every bundle is attached. `app-bundles.yml` becomes a reusable bundle builder invoked by that chain (and still dispatchable by hand); `deploy-store.yml` is deleted.

**Tech Stack:** GitHub Actions, `googleapis/release-please-action@v4`, `bffless/upload-artifact@v1`, plain ESM scripts with `node:test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-app-release-please-design.md`.
- **Components exist only for catalog apps** — those shipping `apps/<app>/bffless-app.json`. Today: `reader`, `handoff`. Studio has no manifest and gets no component.
- **Tag format is `<component>-v<version>`** (`reader-v1.0.1`). Set via `component` + `include-component-in-tag: true`. Existing releases and `build-registry.mjs`'s tag lookup depend on this exact shape.
- **`release-type: node`** bumps `apps/<app>/package.json`; `extra-files` mirrors the same version into `apps/<app>/bffless-app.json` at `$.version`. Neither is hand-edited afterwards.
- **`requires.ceMin` stays manual.** It is a judgement about which CE release an app needs and cannot be derived.
- **`.claude-plugin/marketplace.json` / `plugin.json` are untouched** — they version the Claude plugin, on a different cadence.
- **Exactly one workflow may publish to the `app-registry` alias.** This is the property the whole design exists to guarantee.
- **The artifact directory must stay named `registry-staging`** — `bffless/upload-artifact` prefixes every zip entry with the `path` input and CE stores those verbatim as `publicPath`, matched against the live domain mapping's `/registry-staging`. Renaming it breaks the live site.
- Tests: `node --test scripts/<file>.test.mjs`; conventions: `pnpm apps:check`.
- Work in `/home/rico/bffless/repos/apps` on branch `spec/app-release-please` (already created, spec committed at `002fede`).

---

### Task 1: release-please configuration

**Files:**
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`
- Modify: `apps/reader/package.json` (version `0.0.0` → `1.0.1`)
- Modify: `apps/handoff/package.json` (version `0.0.0` → `1.0.2`)
- Modify: `scripts/check-app-conventions.mjs`
- Test: `scripts/check-app-conventions.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```js
  export function checkReleaseComponents(config, appIds, manifest)  // → string[] of errors
  ```
  `config` is the parsed `release-please-config.json`, `appIds` the list of app directory names that ship a `bffless-app.json`, `manifest` the parsed `.release-please-manifest.json`. No later task calls it; `checkManifest`'s caller runs it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/check-app-conventions.test.mjs`, following the file's existing `node:test` style (it already imports `test` from `node:test` and `assert` from `node:assert/strict`, and imports named exports from `./check-app-conventions.mjs`):

```js
import { checkReleaseComponents } from './check-app-conventions.mjs'

const CONFIG = {
  packages: {
    'apps/reader': { component: 'reader', 'include-component-in-tag': true },
    'apps/handoff': { component: 'handoff', 'include-component-in-tag': true },
  },
}
const MANIFEST = { 'apps/reader': '1.0.1', 'apps/handoff': '1.0.2' }

test('accepts a config whose components match the catalog apps', () => {
  assert.deepEqual(checkReleaseComponents(CONFIG, ['reader', 'handoff'], MANIFEST), [])
})

test('rejects a catalog app with no release-please component', () => {
  const errors = checkReleaseComponents(CONFIG, ['reader', 'handoff', 'notes'], {
    ...MANIFEST,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/notes/)
  assert.match(errors[0], /release-please-config\.json/)
})

test('rejects a component for an app that ships no manifest', () => {
  const config = {
    packages: { ...CONFIG.packages, 'apps/studio': { component: 'studio' } },
  }
  const errors = checkReleaseComponents(config, ['reader', 'handoff'], MANIFEST)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/studio/)
})

test('rejects a component missing from .release-please-manifest.json', () => {
  const errors = checkReleaseComponents(CONFIG, ['reader', 'handoff'], {
    'apps/reader': '1.0.1',
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/handoff/)
  assert.match(errors[0], /release-please-manifest/)
})

test('rejects a component whose tag would not match <app>-v<version>', () => {
  const config = {
    packages: {
      'apps/reader': { component: 'rivulet', 'include-component-in-tag': true },
      'apps/handoff': { component: 'handoff', 'include-component-in-tag': true },
    },
  }
  const errors = checkReleaseComponents(config, ['reader', 'handoff'], MANIFEST)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /rivulet/)
})
```

Why this check earns its place: a new catalog app added without a component would silently never be versioned or released, and the failure would surface much later as "my app never appears in the registry."

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-app-conventions.test.mjs`
Expected: FAIL — `checkReleaseComponents` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `scripts/check-app-conventions.mjs`, add near the other exported checkers:

```js
/**
 * The catalog apps and the release-please components must be the same set, and
 * each component's tag must come out as `<app>-v<version>` — the shape
 * build-registry.mjs looks up and every existing release already uses. An app
 * with no component is never versioned or released, and the symptom (it never
 * appears in the registry) shows up far from the cause.
 */
export function checkReleaseComponents(config, appIds, manifest) {
  const errors = []
  const packages = config?.packages ?? {}
  const configured = Object.keys(packages)

  for (const app of appIds) {
    const key = `apps/${app}`
    if (!configured.includes(key)) {
      errors.push(
        `release-please-config.json: no component for ${key} — a catalog app with no component is never released`,
      )
      continue
    }
    if (manifest?.[key] === undefined) {
      errors.push(`.release-please-manifest.json: missing an entry for ${key}`)
    }
    const entry = packages[key]
    if (entry.component !== app || entry['include-component-in-tag'] !== true) {
      errors.push(
        `release-please-config.json: ${key} must set component "${app}" and include-component-in-tag true ` +
          `so its tag is ${app}-v<version> (got component ${JSON.stringify(entry.component)})`,
      )
    }
  }

  for (const key of configured) {
    const app = key.startsWith('apps/') ? key.slice('apps/'.length) : null
    if (app && !appIds.includes(app)) {
      errors.push(
        `release-please-config.json: ${key} has a component but ships no bffless-app.json`,
      )
    }
  }

  return errors
}
```

Wire it into `main()` alongside the existing per-app checks — it is a repo-wide check, not a per-app one, so it belongs next to `checkMarketplaceVersion()` rather than inside `checkApp()`. Read and parse both JSON files there, and derive `appIds` from the app dirs that have a `bffless-app.json` (the same predicate `checkManifest` already uses to decide whether to validate). Push its errors into the same failure list the script already prints and exits on.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/check-app-conventions.test.mjs`
Expected: PASS — the five new cases plus the pre-existing ones.

- [ ] **Step 5: Create the config files**

`release-please-config.json` (mirrors CE's `release-please-config.json`, which is the house pattern):

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    "apps/reader": {
      "release-type": "node",
      "component": "reader",
      "include-component-in-tag": true,
      "extra-files": [{ "type": "json", "path": "bffless-app.json", "jsonpath": "$.version" }]
    },
    "apps/handoff": {
      "release-type": "node",
      "component": "handoff",
      "include-component-in-tag": true,
      "extra-files": [{ "type": "json", "path": "bffless-app.json", "jsonpath": "$.version" }]
    }
  },
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance Improvements" },
    { "type": "revert", "section": "Reverts" },
    { "type": "docs", "section": "Documentation", "hidden": true },
    { "type": "style", "section": "Styles", "hidden": true },
    { "type": "chore", "section": "Miscellaneous Chores", "hidden": true },
    { "type": "refactor", "section": "Code Refactoring", "hidden": true },
    { "type": "test", "section": "Tests", "hidden": true },
    { "type": "build", "section": "Build System", "hidden": true },
    { "type": "ci", "section": "Continuous Integration", "hidden": true }
  ]
}
```

`.release-please-manifest.json` — seeded with the versions currently declared in each manifest, so release-please's next bump starts from the truth:

```json
{
  "apps/reader": "1.0.1",
  "apps/handoff": "1.0.2"
}
```

Then set `apps/reader/package.json`'s `version` to `1.0.1` and `apps/handoff/package.json`'s to `1.0.2`. They are `0.0.0` today; leaving them there would mean release-please's first run jumps them from a value nothing agrees with. Change only the `version` field in each — no other keys.

- [ ] **Step 6: Verify the whole conventions check passes**

Run: `pnpm apps:check`
Expected: `✓ handoff`, `✓ reader`, `✓ studio`, the marketplace line, and the summary — with the new component check silent (no errors).

Then deliberately break it once to prove it bites: temporarily rename `apps/reader`'s key in `release-please-config.json` to `apps/readerx`, re-run `pnpm apps:check`, and confirm it fails naming both `apps/reader` (no component) and `apps/readerx` (no manifest). Restore the file.

- [ ] **Step 7: Commit**

```bash
git add release-please-config.json .release-please-manifest.json \
  apps/reader/package.json apps/handoff/package.json \
  scripts/check-app-conventions.mjs scripts/check-app-conventions.test.mjs
git commit -m "feat(release): release-please components for the catalog apps

Versions in bffless-app.json were hand-edited — the one number the catalog
reads to decide installs and updates. release-please now owns them: node
release-type bumps package.json and extra-files mirrors it into the manifest,
so the version and its tag land in the same commit.

apps:check gains a guard that the component set and the catalog apps stay the
same set, because an app with no component is silently never released."
```

---

### Task 2: Make `app-bundles.yml` a reusable bundle builder

Strip the registry publish out of it, and let it be called by another workflow as well as dispatched by hand.

**Files:**
- Modify: `.github/workflows/app-bundles.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a workflow callable as
  ```yaml
  uses: ./.github/workflows/app-bundles.yml
  with:
    app: <app id>
  secrets: inherit
  ```
  Task 3's `bundles` job calls exactly this.

- [ ] **Step 1: Replace the trigger block**

In `.github/workflows/app-bundles.yml`, replace the whole `on:` block (currently `push: tags: ['*-v*']` plus `workflow_dispatch`) with:

```yaml
on:
  workflow_call:
    inputs:
      app:
        description: 'App id to build and publish (matches apps/<app>/bffless-app.json)'
        required: true
        type: string
  workflow_dispatch:
    inputs:
      app:
        description: 'App id to build and publish (matches apps/<app>/bffless-app.json)'
        required: true
        type: string
```

The tag trigger goes because release-please now creates the tags, and `release.yml` calls this workflow directly for exactly the apps it released — a tag trigger would fire a *second*, redundant build for each of those tags.

- [ ] **Step 2: Simplify the app-id resolution**

Both remaining triggers supply `inputs.app`, so the tag-parsing branch is dead. Replace the `Resolve app id` step's `run:` body with:

```bash
APP="${{ inputs.app }}"
if [ ! -f "apps/$APP/bffless-app.json" ]; then
  echo "::error::apps/$APP/bffless-app.json not found — nothing to publish" >&2
  exit 1
fi
echo "id=$APP" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Delete the registry publish**

Delete these three steps entirely, with their comments:

- `Fetch sha256 sidecars for other published apps`
- `Build store artifact (site + registry.json + assets)`
- `Publish store + registry to BFFless`

The job now ends after `Publish GitHub release`. This is the change that makes the registry single-publisher — everything else in this plan is arrangement.

Delete the `concurrency:` block too (`group: app-bundles`). It existed to serialise runs that each published the registry; with no publish, parallel bundle builds for different apps are independent and the matrix in Task 3 wants them concurrent.

- [ ] **Step 4: Rewrite the header comment**

Replace the file's leading comment block with:

```yaml
# Builds an app-catalog install bundle (scripts/build-app-bundle.mjs) for ONE app and
# publishes it as a GitHub release asset. It does NOT publish the registry — that is
# release.yml's publish-registry job, which is the single publisher of the app-registry
# alias. Two publishers writing the same commit-scoped storage key is what made the
# registry go stale on 2026-08-02; see
# docs/superpowers/specs/2026-08-02-app-release-please-design.md.
#
# Two entry points, both supplying `app`:
#   - workflow_call from release.yml, once per app release-please just released
#   - workflow_dispatch, to rebuild one app's bundle by hand against its existing tag
#     (the release step re-uploads with --clobber)
```

Note what the old comment claimed and this one drops: the old text described a trade-off where a tag-triggered run rebuilt the composite from the tag's commit, "which may be older than main", temporarily reverting site changes until the next push to main healed it. That whole hazard disappears with the publish — `publish-registry` always runs from the pushed commit on main.

- [ ] **Step 5: Verify the YAML parses and says what it should**

Run:
```bash
python3 -c "
import yaml
w = yaml.safe_load(open('.github/workflows/app-bundles.yml'))
assert set(w[True].keys()) == {'workflow_call', 'workflow_dispatch'}, w[True].keys()
assert 'concurrency' not in w
steps = [s.get('name','') for s in w['jobs']['build-and-publish']['steps']]
assert steps[-1] == 'Publish GitHub release', steps
assert not any('registry' in s.lower() for s in steps), steps
print('ok:', steps)
"
```
Expected: prints `ok:` and the step list ending at `Publish GitHub release`.

(`w[True]` is not a typo — PyYAML parses the unquoted key `on` as the boolean `True`.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/app-bundles.yml
git commit -m "refactor(ci): app-bundles builds bundles only, no registry publish

It built one app's bundle and then republished the entire registry, so
releasing two apps published the same global artifact twice from one commit —
and CE drops the second write to a storage key it has already written.

Now callable from release.yml per released app, still dispatchable to rebuild
a single bundle by hand."
```

---

### Task 3: The single `release.yml`

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/workflow-invariants.test.mjs`

**Interfaces:**
- Consumes: `.github/workflows/app-bundles.yml`'s `workflow_call` input `app` (Task 2); `release-please-config.json` and `.release-please-manifest.json` (Task 1).
- Produces: the sole publisher of the `app-registry` alias.

- [ ] **Step 1: Write the failing invariant test**

Create `scripts/workflow-invariants.test.mjs`. This guards the design's central property in a way a reviewer can't accidentally undo:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows')
const read = (f) => readFileSync(join(workflowsDir, f), 'utf8')
const all = () => readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

test('exactly one workflow publishes to the app-registry alias', () => {
  const publishers = all().filter((f) => /alias:\s*app-registry\b/.test(read(f)))
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/workflow-invariants.test.mjs`
Expected: FAIL on all three — `release.yml` does not exist, and `app-bundles.yml`/`deploy-store.yml` still match the alias pattern (Task 2 removed app-bundles' publish, so that one may already pass; `deploy-store.yml` will not).

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

# The single owner of app versioning and of the app-registry alias.
#
#   release          release-please keeps the Release PR current; merging that PR
#                    bumps versions and cuts one tag + GitHub Release per app
#   bundles          builds each released app's bundle, attached to its release
#   publish-registry full snapshot of every app -> registry.json + site + assets
#
# publish-registry is chained with `needs` rather than triggered by an event because
# the registry omits any app whose release has no bundle asset yet: it must not run
# until every bundle is attached. Expressed as needs that is a guarantee; expressed
# as cross-workflow events it is a race — which is the class of bug that produced
# the 2026-08-02 stale registry. See
# docs/superpowers/specs/2026-08-02-app-release-please-design.md.

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest
    outputs:
      releases_created: ${{ steps.release.outputs.releases_created }}
      paths_released: ${{ steps.release.outputs.paths_released }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json

  # One leg per app release-please just released. `paths_released` is a JSON array
  # of package paths ("apps/reader"); app-bundles wants the bare id.
  bundles:
    needs: release
    if: needs.release.outputs.releases_created == 'true'
    strategy:
      matrix:
        path: ${{ fromJSON(needs.release.outputs.paths_released) }}
    uses: ./.github/workflows/app-bundles.yml
    with:
      app: ${{ fromJSON(format('["{0}"]', matrix.path))[0] }}
    secrets: inherit

  publish-registry:
    needs: [release, bundles]
    # always() so this still runs when `bundles` was skipped (a push with no release);
    # the result guards then reject a genuine bundle failure, which must not publish a
    # registry that would omit the app whose bundle failed.
    if: |
      always()
      && needs.release.result == 'success'
      && (needs.bundles.result == 'success' || needs.bundles.result == 'skipped')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      # release-please's release commit touches apps/*/bffless-app.json, so a release
      # always satisfies this; the path list additionally catches store/catalog edits
      # that change the registry or the site without any release.
      - name: Decide whether to publish
        id: decide
        run: |
          if [ "${{ needs.release.outputs.releases_created }}" = "true" ] \
             || [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "publish=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          CHANGED=$(git diff --name-only HEAD^ HEAD || true)
          if echo "$CHANGED" | grep -qE '^(store/|apps/[^/]+/catalog/|apps/[^/]+/bffless-app\.json|scripts/(build-registry|build-store-artifact|fetch-sidecars)\.mjs)'; then
            echo "publish=true" >> "$GITHUB_OUTPUT"
          else
            echo "publish=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Setup pnpm
        if: steps.decide.outputs.publish == 'true'
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        if: steps.decide.outputs.publish == 'true'
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm

      - name: Install dependencies
        if: steps.decide.outputs.publish == 'true'
        run: pnpm install --frozen-lockfile

      - name: Script tests
        if: steps.decide.outputs.publish == 'true'
        run: pnpm scripts:test

      # Best effort: an app whose declared version has no published release is omitted
      # with a ::warning, not an error.
      - name: Fetch published sha256 sidecars
        if: steps.decide.outputs.publish == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: node scripts/fetch-sidecars.mjs --sidecars dist-bundles

      # One composite artifact — site, registry.json and assets together, so a registry
      # entry can never reference an asset that has not been uploaded. The output dir
      # name must stay registry-staging: upload-artifact prefixes zip entries with it and
      # CE matches those publicPaths against the domain mapping's /registry-staging.
      - name: Build store artifact (site + registry.json + assets)
        if: steps.decide.outputs.publish == 'true'
        run: node scripts/build-store-artifact.mjs --sidecars dist-bundles --out registry-staging

      - name: Publish store + registry to BFFless
        if: steps.decide.outputs.publish == 'true'
        uses: bffless/upload-artifact@v1
        with:
          path: registry-staging
          api-url: ${{ vars.BFFLESS_REGISTRY_URL }}
          api-key: ${{ secrets.BFFLESS_REGISTRY_API_KEY }}
          alias: app-registry
          description: 'App store + catalog registry'
```

On the matrix `with:` expression — reusable-workflow inputs cannot call arbitrary functions, but `format` + `fromJSON` is permitted, and `matrix.path` is `apps/reader`. If that proves not to evaluate, the fallback is to have the `release` job emit a second output holding bare ids: add a step after release-please that maps `paths_released` through `sed 's|^apps/||'` into `apps_released`, and matrix over that instead. Prefer the fallback if there is any doubt — it is plainer, and plainness in a workflow expression is worth more than concision.

- [ ] **Step 4: Run the invariant test**

Run: `node --test scripts/workflow-invariants.test.mjs`
Expected: the first two tests PASS; `deploy-store.yml is gone` still FAILS — Task 4 deletes it.

- [ ] **Step 5: Verify the YAML parses and the chain is real**

Run:
```bash
python3 -c "
import yaml
w = yaml.safe_load(open('.github/workflows/release.yml'))
jobs = w['jobs']
assert set(jobs) == {'release','bundles','publish-registry'}, set(jobs)
assert jobs['bundles']['needs'] == 'release'
assert set(jobs['publish-registry']['needs']) == {'release','bundles'}
assert jobs['bundles']['uses'] == './.github/workflows/app-bundles.yml'
print('ok')
"
```
Expected: prints `ok`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml scripts/workflow-invariants.test.mjs
git commit -m "feat(ci): one workflow owns releases and the registry publish

release -> bundles -> publish-registry, chained with needs. The registry omits
an app whose release has no bundle asset, so publish must not start until every
bundle is attached; needs makes that a guarantee where cross-workflow events
would make it a race.

Adds an invariant test that exactly one workflow writes the app-registry alias."
```

---

### Task 4: Delete `deploy-store.yml` and update the docs

**Files:**
- Delete: `.github/workflows/deploy-store.yml`
- Modify: `.claude/skills/publish-app/SKILL.md`
- Modify: `docs/app-pipelines-convention.md`
- Modify: `.agents/skills/publish-app/SKILL.md` (generated — via `pnpm skills:sync`, never by hand)

**Interfaces:**
- Consumes: Task 3's `release.yml`.
- Produces: nothing.

- [ ] **Step 1: Delete the workflow**

```bash
git rm .github/workflows/deploy-store.yml
```

Its store-path publish is now `publish-registry`'s path condition, and its PR-preview deploy goes with it — previewing the store on a PR is a separate concern and nothing in this plan replaces it. Say so in the commit message rather than silently dropping a capability.

**If PR #281 is still open** (it adds a `workflow_dispatch` to this file as a stopgap for the stale-registry incident), close it unmerged — `release.yml` carries its own dispatch. Do not merge both: that restores two registry publishers, which is the bug.

- [ ] **Step 2: Run the invariant test**

Run: `node --test scripts/workflow-invariants.test.mjs`
Expected: PASS, all three.

- [ ] **Step 3: Update the authoring docs**

In `.claude/skills/publish-app/SKILL.md`, find the section documenting `version` in `bffless-app.json` and replace the hand-editing guidance with:

```markdown
**Do not edit `version` by hand.** release-please owns it: a conventional commit
touching `apps/<app>/**` bumps that app on the next Release PR, which writes both
`apps/<app>/package.json` and `apps/<app>/bffless-app.json` and cuts the
`<app>-v<version>` tag in the same commit. Adding a new catalog app means adding a
matching component to `release-please-config.json` and a seed entry to
`.release-please-manifest.json` — `pnpm apps:check` fails if you forget.

`requires.ceMin` is still yours to set. It is a judgement about which CE release the
app depends on and cannot be derived from commit history.
```

Make the same substitution, more briefly, in `docs/app-pipelines-convention.md`'s versioning section, pointing at the SKILL for detail.

Then run `pnpm skills:sync` to regenerate `.agents/skills/publish-app/SKILL.md`, and confirm with `diff .claude/skills/publish-app/SKILL.md .agents/skills/publish-app/SKILL.md` that they are identical. Never hand-edit the `.agents/` copy — it is generated, and an edit there is reverted by the next sync.

- [ ] **Step 4: Full verification**

Run:
```bash
pnpm apps:check
node --test scripts/*.test.mjs
```
Expected: conventions pass for all 3 apps plus the marketplace line; every script test passes.

- [ ] **Step 5: Commit**

```bash
git add -A .github/workflows docs/app-pipelines-convention.md \
  .claude/skills/publish-app/SKILL.md .agents/skills/publish-app/SKILL.md
git commit -m "refactor(ci): delete deploy-store, document release-please versioning

deploy-store.yml was the second publisher of the app-registry alias; its
store-path trigger is now publish-registry's path condition. Its PR store
preview goes with it and is not replaced — worth restoring separately if the
preview is missed.

Authoring docs stop telling people to hand-edit version, which is how a
manifest came to declare a version whose tag did not exist yet."
```

---

### Task 5: First live release — the acceptance test

The workflow chain cannot be exercised locally. This task is the operator's, not the agent's.

**Files:** none.

**Interfaces:**
- Consumes: Tasks 1-4, merged to `main`.
- Produces: a verified registry.

- [ ] **Step 1: Open the PR**

The PR title's commit type must be non-releasing (`ci:` or `chore:`, not `feat(ci):`
or any other `feat`/`fix` type) — see Step 2 for why.

```bash
git push -u origin spec/app-release-please
gh pr create --title "ci: release-please per app, one registry publisher" --body-file - <<'EOF'
Implements docs/superpowers/specs/2026-08-02-app-release-please-design.md.

App versions were hand-edited in `bffless-app.json` — the one number the catalog
reads — while `package.json` carried a dead `0.0.0`. And the registry was
republished once per app release, so releasing two apps published the same global
artifact twice from one commit, which is how handoff vanished from the registry
on 2026-08-02.

- release-please owns per-app versions; the manifest bump and the tag land in one
  commit, closing the window where an app declares a version with no release.
- `release.yml` is the sole publisher of the `app-registry` alias, chaining
  release → bundles → publish-registry with `needs`.
- `app-bundles.yml` builds bundles only; `deploy-store.yml` is deleted.

Does not fix the underlying CE bug where a second write to an already-written
commit-scoped storage key updates the file record without replacing its bytes.
It removes the condition that triggers it. That fix belongs in bffless/ce.
EOF
```

**Ask the operator before pushing** — in this repo a merge is a live manifest and rule deploy.

- [ ] **Step 2: Squash-merge, and expect no release**

This branch's commit `1cf6644` is itself typed `feat(release):` and touches
`apps/reader/package.json` and `apps/handoff/package.json`, with both apps' current
tags pointing at the branch base. A **merge commit** would carry that subject line
into `main`'s history, and release-please would read it as a real feature release —
proposing reader `1.0.1` → `1.1.0` and handoff `1.0.2` → `1.1.0` for what is meant to
be a CI refactor, on the very numbers the catalog reads. So this PR **must be
squash-merged**, using the non-releasing subject from Step 1 (`ci: ...`) as the
squash commit message — never GitHub's default, which is the PR title only if you
edit the default merge-commit strategy, and never a plain merge, which preserves
every original commit subject including `1cf6644`'s.

With a squash merge using a `ci:`/`chore:` subject, release-please should open no
Release PR and `bundles` should skip. `publish-registry` runs (the push changes
`scripts/build-*.mjs`? it does not — so confirm the decide step's verdict either way).

Confirm in the run log: `release` succeeded, `bundles` skipped, and `publish-registry` either published or reported `publish=false` — both are correct outcomes here, and knowing which one happened is the point.

- [ ] **Step 3: Trigger a real release**

Merge any PR carrying a conventional commit scoped to an app, e.g. `fix(reader): …` touching `apps/reader/**`. Confirm release-please opens a Release PR proposing a reader bump and no handoff bump.

- [ ] **Step 4: Merge the Release PR and verify the chain**

On merge, confirm in one run: `release` cut `reader-v<next>`, `bundles` ran one leg, `publish-registry` ran last.

Then verify the outcome:
```bash
curl -s https://apps.bffless.dev/registry.json | python3 -m json.tool | head -20
```
Expected: both `reader` and `handoff` present, reader at its new version, handoff unchanged at `1.0.2` — the unchanged-app case, proving the snapshot is not a delta.

Note the `**/registry.json` cache rule is a 1h TTL, so a stale read shortly after publishing is the cache, not a regression. Re-check with a cache-busting query if in doubt.

- [ ] **Step 5: Confirm the storage write actually landed**

The CE bug this design routes around is invisible from the registry alone when only one app changed. Compare the served bytes against the deployment's file record:

```bash
curl -s https://apps.bffless.dev/registry.json | wc -c
```

and compare with the `registry.json` size reported by `get_deployment` for the deployment holding the `app-registry` alias. They must match. A mismatch means the CE lost-write bug reached this path anyway and the design's assumption — one publish per commit — has a hole worth finding.

---

## Self-Review

**Spec coverage.** Versioning via release-please components → Task 1. `release-type: node` + `extra-files` mirroring → Task 1 Step 5. `ceMin` stays manual → Task 4 Step 3 (documented). Marketplace/plugin versions untouched → no task touches them. Components only for catalog apps → Task 1's checker, both directions. Tag format → Task 1's checker asserts `component` + `include-component-in-tag`. One workflow, three jobs, `needs` ordering → Task 3. Sole publisher of the registry → Task 3 plus the invariant test. Publish condition (releases, paths, dispatch) → Task 3 Step 3's decide step. Unchanged apps included → Task 5 Step 4 verifies it live; `build-registry.mjs` needs no change. Composite artifact stays → Task 3 Step 3 keeps `build-store-artifact.mjs` untouched. `app-bundles.yml` retired to dispatch/call → Task 2. `deploy-store.yml` deleted → Task 4. Error handling: bundle failure blocks publish → Task 3's `needs.bundles.result` guard; omitted app warning → unchanged behaviour, noted. Testing section → Tasks 1, 3 and 5.

**Gap found and closed:** the spec's error-handling case "a bundle build fails → re-run app-bundles by dispatch, then dispatch release.yml to recover" depends on `app-bundles.yml` keeping a `workflow_dispatch`, which Task 2 Step 1 preserves, and on `release.yml` having one, which Task 3 Step 3 includes in its `on:` block. Both present.

**Second gap found and closed:** the spec says nothing about the PR store preview that `deploy-store.yml` currently provides on pull requests. Deleting the file drops it. Task 4 Step 1 now calls that out explicitly rather than losing it silently.

**Placeholder scan.** No TBDs. Every step carries its actual content. Task 3 Step 3 names a concrete fallback for the one expression I am not certain evaluates, rather than leaving it to be discovered.

**Type consistency.** `checkReleaseComponents(config, appIds, manifest)` has the same three-argument shape in its test, its implementation and its call site. The reusable workflow's input is `app` in Task 2's definition and Task 3's `with:`. Job names `release` / `bundles` / `publish-registry` match between the workflow, the invariant test and the YAML assertion.
