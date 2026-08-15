# Studio Headless GitHub Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/studio/headless/` consumable as a composite GitHub Action (`uses: bffless/apps/apps/studio/headless@studio-vX.Y.Z`) so anyone with an installed Studio can run unattended builds from their own repo.

**Architecture:** Add `action.yml` beside the existing runner (the directory *is* the action). Move the job-summary logic out of the workflow YAML into a tested `scripts/summary.mjs` that also writes step outputs. Rewrite the repo's own `studio-headless-run.yml` to be a thin caller of `./apps/studio/headless` (dogfooding). Runner source (`src/`, `playwright.config.ts`) is unchanged.

**Tech Stack:** GitHub composite action, pnpm 10 workspace (`--filter studio-headless`), Playwright (`@playwright/test`), Node 20 ESM, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-studio-headless-action-design.md`

## Global Constraints

- Work on a branch (`feat/studio-headless-action`) in a git worktree — the `repos/apps` checkout is on `main` and shared. **Ask before committing/pushing** (repo rule); the commit steps below mean "stage and propose", the user approves each commit.
- PR title / commits are conventional commits under the `studio` scope (release-please: `apps/studio` component ⇒ `studio-vX.Y.Z` tags; `headless/` is inside that path). Use `feat(studio): …`.
- Runner code in `apps/studio/headless/src/**` and `playwright.config.ts` is **not** modified.
- Mock/smoke knobs (`MOCK_MODE`, `FIXTURE_PATHS`, `SMOKE_STOP_AFTER_START`) are **not** action inputs. `.github/workflows/studio-headless-smoke.yml` is unchanged.
- Env var names are exactly those in `apps/studio/headless/src/config.ts` (`loadConfig`).
- Node 20, pnpm `10.33.0` (root `package.json` `packageManager`). The action must not depend on the *caller's* `package.json`/lockfile — pin `pnpm/action-setup` `version: 10.33.0`, no `cache: pnpm` on `setup-node`.
- Never trace / print credentials; the run step passes `user-email`/`user-password` only as env.
- The live real-run dispatch spends AI credits: **ask the user before dispatching**.

---

### Task 0: Worktree + branch

**Files:** none

- [ ] **Step 1: Create the worktree**

```bash
cd /home/rico/bffless/repos/apps
git fetch origin
git worktree add ../apps-headless-action -b feat/studio-headless-action origin/main
cd ../apps-headless-action
pnpm install --frozen-lockfile --filter studio-headless
```

Expected: worktree at `/home/rico/bffless/repos/apps-headless-action`, install succeeds (headless has no `workspace:` deps).

- [ ] **Step 2: Copy the spec + plan into the worktree** (they're untracked on `main`)

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp ../apps/docs/superpowers/specs/2026-08-15-studio-headless-action-design.md docs/superpowers/specs/
cp ../apps/docs/superpowers/plans/2026-08-15-studio-headless-action.md docs/superpowers/plans/
```

- [ ] **Step 3: Sanity-run existing unit tests**

Run: `pnpm --filter studio-headless test`
Expected: config/download/jobs tests PASS.

All later paths are relative to `/home/rico/bffless/repos/apps-headless-action`.

---

### Task 1: `scripts/summary.mjs` — job summary + step outputs (TDD)

**Files:**
- Create: `apps/studio/headless/scripts/summary.mjs`
- Test: `apps/studio/headless/src/__tests__/summary.test.ts`

**Interfaces:**
- Consumes: `output/run-summary.json` as written by `src/run.spec.ts` (`{ ok, projectId, openUrl, phase, error, title, description, thumbnail, blogBundle, timings }`) and optional `output/post.md`.
- Produces (used by Task 2's `action.yml`):
  - `buildSummary(summary, postMd: string|null): { markdown: string, outputs: Record<string,string> }`
  - `formatOutputs(outputs: Record<string,string>): string` — `$GITHUB_OUTPUT` text using heredoc delimiters for every value.
  - `DEFAULT_SUMMARY` — the fallback object when the JSON is missing.
  - CLI: `node scripts/summary.mjs` reads `STUDIO_HEADLESS_OUT` (default `<headless>/output`), appends markdown to `$GITHUB_STEP_SUMMARY`, appends outputs to `$GITHUB_OUTPUT`, prints markdown to stdout. Output keys: `ok`, `phase`, `project-url`, `project-id`, `title`, `description`, `output-dir`.

- [ ] **Step 1: Write the failing test**

`apps/studio/headless/src/__tests__/summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
// @ts-expect-error – plain ESM script, no d.ts
import { buildSummary, formatOutputs, DEFAULT_SUMMARY } from '../../scripts/summary.mjs'

const okSummary = {
  ok: true,
  projectId: 'p1',
  openUrl: 'https://studio.example.com/project/p1/export',
  phase: 'done',
  error: null,
  title: 'My Video',
  description: 'line one\nline two',
  thumbnail: true,
  blogBundle: true,
  timings: { import: 1200, prep: 61000 },
}

describe('buildSummary', () => {
  it('renders a success summary with project link, title, description and timings', () => {
    const { markdown, outputs } = buildSummary(okSummary, '# Post body')
    expect(markdown).toContain('## ✅ Studio headless run complete')
    expect(markdown).toContain('**Open the project:** https://studio.example.com/project/p1/export')
    expect(markdown).toContain('**Project ID:** p1')
    expect(markdown).toContain('### My Video')
    expect(markdown).toContain('line one\nline two')
    expect(markdown).toContain('`thumbnail.png`')
    expect(markdown).toContain('<details><summary>Blog post (post.md)</summary>')
    expect(markdown).toContain('# Post body')
    expect(markdown).toContain('| import | 1s |')
    expect(markdown).toContain('| prep | 61s |')
    expect(outputs).toEqual({
      ok: 'true',
      phase: 'done',
      'project-url': 'https://studio.example.com/project/p1/export',
      'project-id': 'p1',
      title: 'My Video',
      description: 'line one\nline two',
    })
  })

  it('renders a failure summary with the phase, error and resume hint', () => {
    const { markdown, outputs } = buildSummary(
      { ...okSummary, ok: false, phase: 'build', error: 'boom', openUrl: 'https://s/project/p1/build', title: null, description: null, thumbnail: false, blogBundle: false },
      null,
    )
    expect(markdown).toContain('## ❌ Studio headless run failed (during: build)')
    expect(markdown).toContain('**Error:** boom')
    expect(markdown).toContain('The project is resumable')
    expect(markdown).not.toContain('thumbnail.png')
    expect(outputs.ok).toBe('false')
    expect(outputs.phase).toBe('build')
    expect(outputs.title).toBe('')
    expect(outputs.description).toBe('')
  })

  it('handles the no-summary fallback (run never wrote the file)', () => {
    const { markdown, outputs } = buildSummary(DEFAULT_SUMMARY, null)
    expect(markdown).toContain('failed (during: no-summary)')
    expect(markdown).toContain('_No project was created._')
    expect(outputs).toMatchObject({ ok: 'false', phase: 'no-summary', 'project-url': '', 'project-id': '' })
  })

  it('truncates a very long blog post', () => {
    const { markdown } = buildSummary(okSummary, 'x'.repeat(100_001))
    expect(markdown).toContain('… (truncated — full post in the artifact)')
  })
})

describe('formatOutputs', () => {
  it('writes every value as a heredoc so multi-line values survive', () => {
    const text = formatOutputs({ a: 'one', description: 'l1\nl2' })
    expect(text).toMatch(/^a<<ghadelim_[a-f0-9]+\none\nghadelim_[a-f0-9]+\n/)
    expect(text).toMatch(/description<<ghadelim_[a-f0-9]+\nl1\nl2\nghadelim_[a-f0-9]+\n/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter studio-headless exec vitest run src/__tests__/summary.test.ts`
Expected: FAIL — cannot resolve `../../scripts/summary.mjs`.

- [ ] **Step 3: Implement `scripts/summary.mjs`**

```js
#!/usr/bin/env node
// Job summary + step outputs for the studio-headless action.
//
// Reads <out>/run-summary.json (written by src/run.spec.ts's `finally` block,
// on success AND failure) and optional <out>/post.md, then:
//   • appends a markdown summary to $GITHUB_STEP_SUMMARY (if set)
//   • appends step outputs to $GITHUB_OUTPUT (if set)
//   • prints the markdown to stdout
// <out> = $STUDIO_HEADLESS_OUT, default ../output relative to this file.
import { readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const MAX_POST_CHARS = 100_000

/** What the summary looks like when the run never got to write one. */
export const DEFAULT_SUMMARY = Object.freeze({
  ok: false,
  phase: 'no-summary',
  openUrl: null,
  projectId: null,
  error: null,
  title: null,
  description: null,
  thumbnail: false,
  blogBundle: false,
  timings: {},
})

/** Load run-summary.json + post.md from outDir; falls back to DEFAULT_SUMMARY. */
export function readSummary(outDir) {
  let summary = DEFAULT_SUMMARY
  try { summary = { ...DEFAULT_SUMMARY, ...JSON.parse(readFileSync(join(outDir, 'run-summary.json'), 'utf8')) } } catch {}
  let postMd = null
  if (summary.blogBundle) {
    try { postMd = readFileSync(join(outDir, 'post.md'), 'utf8') } catch {}
  }
  return { summary, postMd }
}

/** Pure: summary object (+ optional post.md text) → { markdown, outputs }. */
export function buildSummary(s, postMd) {
  const lines = [
    s.ok ? '## ✅ Studio headless run complete' : `## ❌ Studio headless run failed (during: ${s.phase})`,
    '',
  ]
  if (s.openUrl) {
    lines.push(`**Open the project:** ${s.openUrl}`)
    if (s.projectId) lines.push(`**Project ID:** ${s.projectId}`)
  } else if (s.projectId) {
    lines.push(`**Project ID:** ${s.projectId}`)
  } else {
    lines.push('_No project was created._')
  }
  if (s.error) lines.push(`**Error:** ${s.error}`)
  if (!s.ok && s.openUrl) lines.push('\nThe project is resumable — open the link and continue from where the run halted.')
  if (s.title) lines.push('', `### ${s.title}`)
  if (s.description) lines.push('', '**YouTube description**', '', '```', s.description, '```')
  if (s.thumbnail) lines.push('', '**Thumbnail:** `thumbnail.png` in the run-output artifact.')
  if (s.blogBundle) {
    lines.push('', '**Blog bundle:** `blog-bundle.zip` (post.md + images) in the run-output artifact.')
    if (postMd != null) {
      // Image links inside the post point at auth-gated serve paths, so they
      // render only inside the app — the text is still worth reading here.
      const clipped = postMd.length > MAX_POST_CHARS
        ? postMd.slice(0, MAX_POST_CHARS) + '\n\n… (truncated — full post in the artifact)'
        : postMd
      lines.push('', '<details><summary>Blog post (post.md)</summary>', '', clipped, '', '</details>')
    }
  }
  lines.push('', '| Phase | Elapsed |', '| --- | --- |')
  lines.push(...Object.entries(s.timings ?? {}).map(([k, v]) => `| ${k} | ${Math.round(v / 1000)}s |`))

  const outputs = {
    ok: s.ok ? 'true' : 'false',
    phase: s.phase ?? 'no-summary',
    'project-url': s.openUrl ?? '',
    'project-id': s.projectId ?? '',
    title: s.title ?? '',
    description: s.description ?? '',
  }
  return { markdown: lines.join('\n') + '\n', outputs }
}

/** $GITHUB_OUTPUT text. Every value uses a heredoc delimiter (multi-line safe). */
export function formatOutputs(outputs) {
  let text = ''
  for (const [key, value] of Object.entries(outputs)) {
    const delim = 'ghadelim_' + createHash('sha256').update(key + value).digest('hex').slice(0, 16)
    text += `${key}<<${delim}\n${value}\n${delim}\n`
  }
  return text
}

function main() {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(process.env.STUDIO_HEADLESS_OUT || join(here, '..', 'output'))
  const { summary, postMd } = readSummary(outDir)
  const { markdown, outputs } = buildSummary(summary, postMd)
  outputs['output-dir'] = outDir
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(outputs))
  process.stdout.write(markdown)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter studio-headless test`
Expected: all PASS, including the 5 new tests. If vitest complains about the `@ts-expect-error` line being unused, delete that comment line (vitest doesn't typecheck; keep whichever form runs clean).

- [ ] **Step 5: Manual CLI smoke**

```bash
cd apps/studio/headless
mkdir -p /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/sumtest
printf '{"ok":true,"projectId":"p1","openUrl":"https://s/project/p1/export","phase":"done","error":null,"title":"T","description":"d","thumbnail":false,"blogBundle":false,"timings":{"import":1000}}' > /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/sumtest/run-summary.json
STUDIO_HEADLESS_OUT=/tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/sumtest GITHUB_OUTPUT=/tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/sumtest/out.txt node scripts/summary.mjs
cat /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/sumtest/out.txt
```

Expected: markdown printed with `## ✅ …`; `out.txt` has `ok<<ghadelim_…\ntrue\n…` and an `output-dir` entry ending in `/sumtest`.

- [ ] **Step 6: Commit (ask first)**

```bash
git add apps/studio/headless/scripts/summary.mjs apps/studio/headless/src/__tests__/summary.test.ts
git commit -m "feat(studio): headless run summary script with step outputs"
```

---

### Task 2: `action.yml` composite action

**Files:**
- Create: `apps/studio/headless/action.yml`

**Interfaces:**
- Consumes: `scripts/summary.mjs` CLI (Task 1) via `STUDIO_HEADLESS_OUT`, `$GITHUB_STEP_SUMMARY`, `$GITHUB_OUTPUT`; the existing `pnpm scenario` script; env names from `src/config.ts`.
- Produces: action inputs/outputs exactly as in the spec tables (used by Task 3's workflow and Task 4's README).

- [ ] **Step 1: Write `apps/studio/headless/action.yml`**

```yaml
name: 'Studio Headless Run'
description: >-
  Drive an installed BFFless Studio deployment end-to-end (import → prep → auto
  build → export) with Playwright, unattended. Spends real AI credits on the
  target Studio. Writes a job summary, uploads the run output as an artifact
  and exposes the project link/title/description as outputs.
author: 'bffless'
branding:
  icon: 'film'
  color: 'purple'

inputs:
  base-url:
    description: 'Origin of the Studio deployment to drive, e.g. https://studio.example.com'
    required: true
  video-urls:
    description: 'Source video URL(s), comma or newline separated'
    required: true
  user-email:
    description: 'Login email for the Studio admin auth relay (pass a secret)'
    required: true
  user-password:
    description: 'Login password (pass a secret)'
    required: true
  director-prompt:
    description: 'Optional guidance for the master director'
    required: false
    default: ''
  project-title:
    description: 'Optional project name (reserved; not yet applied by the runner)'
    required: false
    default: ''
  thumbnail-prompt:
    description: 'Optional direction for the YouTube thumbnail'
    required: false
    default: ''
  thumbnail-reference-url:
    description: 'Optional image URL attached as the thumbnail reference'
    required: false
    default: ''
  generate-blog:
    description: 'Also generate the blog post (true/false)'
    required: false
    default: 'false'
  blog-direction:
    description: 'Optional direction for the blog post'
    required: false
    default: ''
  browser:
    description: 'chrome (default, preinstalled on ubuntu-latest) or firefox'
    required: false
    default: 'chrome'
  ffmpeg-mt:
    description: 'true to ask Studio for its multithreaded ffmpeg core (?ffmpegCore=mt). Debug escape hatch.'
    required: false
    default: 'false'
  prep-timeout-minutes:
    description: 'Ceiling per prep stage, per source file'
    required: false
    default: '30'
  director-timeout-minutes:
    description: 'Ceiling for the master director run'
    required: false
    default: '10'
  build-timeout-minutes:
    description: 'Ceiling for the full auto build'
    required: false
    default: '90'
  describe-timeout-minutes:
    description: 'Ceiling for the auto-generated title + description'
    required: false
    default: '5'
  thumbnail-timeout-minutes:
    description: 'Ceiling each for the thumbnail prompt draft and the image render'
    required: false
    default: '10'
  blog-timeout-minutes:
    description: 'Ceiling for the blog-post generation'
    required: false
    default: '15'
  upload-artifact:
    description: 'Upload the run output (screenshots, thumbnail, blog bundle, logs) as a workflow artifact'
    required: false
    default: 'true'
  artifact-name:
    description: 'Name of the uploaded artifact'
    required: false
    default: 'studio-run-output'

outputs:
  ok:
    description: '"true" when the run completed'
    value: ${{ steps.summary.outputs.ok }}
  phase:
    description: 'Last phase reached (done on success)'
    value: ${{ steps.summary.outputs.phase }}
  project-url:
    description: 'Deep link to the project (Export page on success, Build page otherwise)'
    value: ${{ steps.summary.outputs.project-url }}
  project-id:
    description: 'Studio project id'
    value: ${{ steps.summary.outputs.project-id }}
  title:
    description: 'Generated title'
    value: ${{ steps.summary.outputs.title }}
  description:
    description: 'Generated YouTube description'
    value: ${{ steps.summary.outputs.description }}
  output-dir:
    description: 'Absolute path of the run output directory'
    value: ${{ steps.summary.outputs.output-dir }}

runs:
  using: 'composite'
  steps:
    # Toolchain is pinned here so the caller's repo needs no package.json/lockfile.
    - uses: pnpm/action-setup@v4
      with:
        version: 10.33.0
    - uses: actions/setup-node@v4
      with:
        node-version: '20'

    # The action is a subdirectory of the bffless/apps monorepo; GitHub clones the
    # whole repo, so the workspace lockfile is present. headless has no
    # workspace: deps → the filtered install skips Studio's own tree.
    - name: Install runner
      shell: bash
      working-directory: ${{ github.action_path }}
      run: pnpm install --frozen-lockfile --filter studio-headless

    # Chrome stable is preinstalled on ubuntu-latest and used via channel: 'chrome'.
    # Firefox needs the Playwright build + system ffmpeg for H.264/AAC decode.
    - name: Install Firefox + ffmpeg
      if: inputs.browser == 'firefox'
      shell: bash
      working-directory: ${{ github.action_path }}
      run: |
        sudo apt-get update && sudo apt-get install -y ffmpeg
        pnpm exec playwright install firefox --with-deps

    - name: Run scenario
      id: run
      shell: bash
      working-directory: ${{ github.action_path }}
      continue-on-error: true
      env:
        STUDIO_BASE_URL: ${{ inputs.base-url }}
        VIDEO_URLS: ${{ inputs.video-urls }}
        STUDIO_USER_EMAIL: ${{ inputs.user-email }}
        STUDIO_USER_PASSWORD: ${{ inputs.user-password }}
        DIRECTOR_PROMPT: ${{ inputs.director-prompt }}
        PROJECT_TITLE: ${{ inputs.project-title }}
        THUMBNAIL_PROMPT: ${{ inputs.thumbnail-prompt }}
        THUMBNAIL_REFERENCE_URL: ${{ inputs.thumbnail-reference-url }}
        GENERATE_BLOG: ${{ inputs.generate-blog }}
        BLOG_DIRECTION: ${{ inputs.blog-direction }}
        RUNNER_BROWSER: ${{ inputs.browser }}
        FFMPEG_MT: ${{ inputs.ffmpeg-mt }}
        PREP_TIMEOUT_MINUTES: ${{ inputs.prep-timeout-minutes }}
        DIRECTOR_TIMEOUT_MINUTES: ${{ inputs.director-timeout-minutes }}
        BUILD_TIMEOUT_MINUTES: ${{ inputs.build-timeout-minutes }}
        DESCRIBE_TIMEOUT_MINUTES: ${{ inputs.describe-timeout-minutes }}
        THUMBNAIL_TIMEOUT_MINUTES: ${{ inputs.thumbnail-timeout-minutes }}
        BLOG_TIMEOUT_MINUTES: ${{ inputs.blog-timeout-minutes }}
      run: pnpm scenario

    - name: Job summary
      id: summary
      if: always()
      shell: bash
      working-directory: ${{ github.action_path }}
      env:
        STUDIO_HEADLESS_OUT: ${{ github.action_path }}/output
      run: node scripts/summary.mjs

    - name: Upload run output
      if: always() && inputs.upload-artifact == 'true'
      uses: actions/upload-artifact@v4
      with:
        name: ${{ inputs.artifact-name }}
        path: ${{ github.action_path }}/output/
        if-no-files-found: ignore

    - name: Fail if the run failed
      if: steps.run.outcome != 'success' || steps.summary.outputs.ok != 'true'
      shell: bash
      run: |
        echo "::error::Studio headless run failed during phase '${{ steps.summary.outputs.phase }}' — see the job summary and artifact."
        exit 1
```

- [ ] **Step 2: Validate the YAML + input/env parity**

```bash
cd apps/studio/headless
python3 -c "import yaml; d=yaml.safe_load(open('action.yml')); print(len(d['inputs']),'inputs', len(d['outputs']),'outputs', len(d['runs']['steps']),'steps')"
# every env var read by config.ts (except the mock/smoke trio) must be set in the run step:
grep -oE "env\.[A-Z_]+" src/config.ts | sort -u | sed 's/env\.//' | grep -vE '^(MOCK_MODE|FIXTURE_PATHS|SMOKE_STOP_AFTER_START)$' > /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/cfg-env.txt
grep -oE "^\s+[A-Z_]+:" action.yml | tr -d ' :' | sort -u > /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/action-env.txt
comm -23 /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/cfg-env.txt /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/action-env.txt
```

Expected: `20 inputs 7 outputs 8 steps`; the `comm` prints nothing (no config env var missing from the run step). If `RUNNER_BROWSER` shows up as missing that's fine — it's read in `playwright.config.ts`, not `config.ts`, and it *is* set. (If python3 lacks `yaml`, use `node -e "require('/home/rico/bffless/repos/apps-headless-action/node_modules/.pnpm/node_modules/yaml')"` or `pnpm dlx yaml` — any parse is fine.)

- [ ] **Step 3: actionlint (best-effort static check)**

```bash
cd /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad
bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) 2>/dev/null || true
```

actionlint only lints workflows, not `action.yml` — so use it in Task 3 on the rewritten workflow. Skip here if download fails.

- [ ] **Step 4: Commit (ask first)**

```bash
git add apps/studio/headless/action.yml
git commit -m "feat(studio): publish the headless runner as a composite GitHub Action"
```

---

### Task 3: Rewrite `studio-headless-run.yml` as a thin caller (dogfood)

**Files:**
- Modify: `.github/workflows/studio-headless-run.yml` (whole `jobs:` block; `on:` block unchanged)

**Interfaces:**
- Consumes: `./apps/studio/headless` action inputs from Task 2.

- [ ] **Step 1: Replace the `jobs:` block**

Keep everything from `name:` through the `concurrency:` block byte-identical (the 10 `workflow_dispatch` inputs, comments included). Replace `jobs:` onward with:

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${{ fromJSON(inputs.timeout_minutes) }}
    steps:
      # The action lives in this repo, so use the local-path form. Other repos
      # use `bffless/apps/apps/studio/headless@studio-vX.Y.Z` — see
      # apps/studio/headless/README.md ("Use as a GitHub Action").
      - uses: actions/checkout@v4
      - name: Studio headless run
        id: studio
        uses: ./apps/studio/headless
        with:
          base-url: ${{ inputs.base_url != '' && inputs.base_url || vars.STUDIO_BASE_URL != '' && vars.STUDIO_BASE_URL || 'https://studio.j5s.dev' }}
          video-urls: ${{ inputs.video_urls }}
          user-email: ${{ secrets.STUDIO_USER_EMAIL }}
          user-password: ${{ secrets.STUDIO_USER_PASSWORD }}
          director-prompt: ${{ inputs.director_prompt }}
          project-title: ${{ inputs.project_title }}
          thumbnail-prompt: ${{ inputs.thumbnail_prompt }}
          thumbnail-reference-url: ${{ inputs.thumbnail_reference_url }}
          generate-blog: ${{ inputs.generate_blog && 'true' || 'false' }}
          blog-direction: ${{ inputs.blog_direction }}
          browser: ${{ inputs.browser }}
          ffmpeg-mt: ${{ vars.STUDIO_FFMPEG_MT == 'true' && 'true' || 'false' }}
          artifact-name: run-output
```

(`artifact-name: run-output` keeps the artifact name today's consumers/docs know.)

- [ ] **Step 2: Lint the workflow**

```bash
cd /home/rico/bffless/repos/apps-headless-action
/tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/actionlint .github/workflows/studio-headless-run.yml || echo "actionlint unavailable — parse-check instead"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/studio-headless-run.yml'))" && echo yaml-ok
git diff --stat
```

Expected: no actionlint errors (a warning about `fromJSON` on a number input is pre-existing and fine); `yaml-ok`; only the `jobs:` block changed (diff should show removals of the inline node script + install steps).

- [ ] **Step 3: Confirm the smoke workflow is untouched**

Run: `git diff --quiet -- .github/workflows/studio-headless-smoke.yml && echo unchanged`
Expected: `unchanged`.

- [ ] **Step 4: Commit (ask first)**

```bash
git add .github/workflows/studio-headless-run.yml
git commit -m "ci(studio): headless run workflow calls the local headless action"
```

---

### Task 4: README — "Use as a GitHub Action"

**Files:**
- Modify: `apps/studio/headless/README.md` (insert a new section before `## Environment reference`; update the `## Running it` intro sentence to mention the action)

**Interfaces:** documents Task 2's inputs/outputs; no code.

- [ ] **Step 1: Insert the section**

Insert directly before the line `## Environment reference`:

````markdown
## Use as a GitHub Action

This directory is also a **composite GitHub Action**. Anyone with a Studio
installed from the app catalog can run unattended builds against it from their
own repo — no fork, no checkout of this monorepo.

Pin the ref to the **Studio version you installed** (release-please tags every
Studio release `studio-vX.Y.Z`; the runner's selectors match that exact build):

```yaml
# .github/workflows/studio-run.yml (in YOUR repo)
name: Studio Run
on:
  workflow_dispatch:
    inputs:
      video_urls:
        description: 'Source video URL(s), newline-separated'
        required: true
        type: string
      director_prompt:
        description: 'Optional guidance for the master director'
        required: false
        type: string
        default: ''
      generate_blog:
        description: 'Also generate the blog post'
        required: false
        type: boolean
        default: false
      timeout_minutes:
        description: 'Job timeout: prep 30 min × videos + director 10 + build 90 + export ~30'
        required: false
        type: number
        default: 210

concurrency:
  group: studio-run
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${{ fromJSON(inputs.timeout_minutes) }}
    steps:
      - name: Studio headless run
        id: studio
        uses: bffless/apps/apps/studio/headless@studio-v1.4.0   # ← your installed Studio version
        with:
          base-url: https://studio.example.com                    # ← your Studio origin
          video-urls: ${{ inputs.video_urls }}
          director-prompt: ${{ inputs.director_prompt }}
          generate-blog: ${{ inputs.generate_blog && 'true' || 'false' }}
          user-email: ${{ secrets.STUDIO_USER_EMAIL }}
          user-password: ${{ secrets.STUDIO_USER_PASSWORD }}
      - run: echo "Project → ${{ steps.studio.outputs.project-url }}"
```

Add two repository secrets: `STUDIO_USER_EMAIL` and `STUDIO_USER_PASSWORD`
(a Studio login on that deployment). Every dispatch **spends real AI credits**
on your Studio.

What the action does for you: pins Node 20 + pnpm, installs the runner,
drives the site with Chrome (preinstalled on `ubuntu-latest`; `browser: firefox`
installs Firefox + ffmpeg instead), writes a **job summary** (project link,
title, description, blog post) and uploads `output/` (screenshots,
`thumbnail.png`, `blog-bundle.zip`, `console.log`, `run-summary.json`) as the
`studio-run-output` artifact.

**Inputs** map 1:1 onto the environment variables below (kebab-case:
`base-url` → `STUDIO_BASE_URL`, `video-urls` → `VIDEO_URLS`, `user-email` /
`user-password` → `STUDIO_USER_EMAIL` / `STUDIO_USER_PASSWORD`,
`director-prompt`, `project-title`, `thumbnail-prompt`,
`thumbnail-reference-url`, `generate-blog`, `blog-direction`, `browser`,
`ffmpeg-mt`, and the six `*-timeout-minutes`), plus `upload-artifact`
(default `true`) and `artifact-name` (default `studio-run-output`). Mock/smoke
knobs are not exposed. See `action.yml` for descriptions.

**Outputs:** `ok`, `phase`, `project-url`, `project-id`, `title`,
`description`, `output-dir`.

The job's `timeout-minutes` is yours to set: it must exceed
`prep-timeout-minutes × number of videos + director-timeout-minutes +
build-timeout-minutes + ~30 min export`. `workflow_dispatch` allows at most 10
inputs — this repo's own `.github/workflows/studio-headless-run.yml` is the
full-featured reference caller (it uses the local-path form
`uses: ./apps/studio/headless`).

````

- [ ] **Step 2: Update the running-locally intro**

Change the `## Running it` heading's first subsection intro so the reader knows there are two ways: replace the line `## Running it` with:

```markdown
## Running it locally (from this monorepo)
```

- [ ] **Step 3: Check rendering + links**

Run: `grep -n "Use as a GitHub Action\|Running it locally\|## Environment reference" apps/studio/headless/README.md`
Expected: the three headings appear in that order.

- [ ] **Step 4: Commit (ask first)**

```bash
git add apps/studio/headless/README.md
git commit -m "docs(studio): document the headless runner GitHub Action"
```

---

### Task 5: Verification + PR + live dispatch

**Files:** none new.

- [ ] **Step 1: Full unit run + install-from-clean check**

```bash
cd /home/rico/bffless/repos/apps-headless-action
pnpm --filter studio-headless test
rm -rf /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/clean && git clone -q --depth 1 --branch feat/studio-headless-action file://$PWD /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/clean 2>/dev/null || cp -r . /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/clean
cd /tmp/claude-1000/-home-rico-bffless/b5a9173f-f09d-4596-848b-970339ce6360/scratchpad/clean/apps/studio/headless && rm -rf node_modules ../../../node_modules && pnpm install --frozen-lockfile --filter studio-headless && pnpm exec playwright --version && node scripts/summary.mjs | head -3
```

Expected: tests PASS; the filtered install from the action directory succeeds without installing Studio (`ls ../node_modules` shouldn't exist / be minimal); `playwright --version` prints; `summary.mjs` prints the `no-summary` fallback.

- [ ] **Step 2: Push + open PR (ask first — push AND PR are user-approved)**

```bash
git push -u origin feat/studio-headless-action
gh pr create --title "feat(studio): headless runner as a reusable GitHub Action" --body-file - <<'EOF'
Makes `apps/studio/headless/` a composite GitHub Action (`uses: bffless/apps/apps/studio/headless@studio-vX.Y.Z`) so anyone with an installed Studio can run unattended builds from their own repo.

- `action.yml`: batteries included (toolchain, install, browser, run, job summary, artifact upload, outputs)
- `scripts/summary.mjs`: summary + step outputs, moved out of the workflow YAML, unit-tested
- `studio-headless-run.yml`: now a thin caller of `./apps/studio/headless` (dogfood)
- README: "Use as a GitHub Action" with a starter workflow

Spec: docs/superpowers/specs/2026-08-15-studio-headless-action-design.md
Smoke workflow unchanged; runner source unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 3: Live dispatch (ASK the user — spends AI credits)**

Once the PR branch is pushed, dispatch the rewritten workflow **from the branch** on a short clip:

```bash
gh workflow run studio-headless-run.yml --ref feat/studio-headless-action -f video_urls='<short clip URL the user provides>' -f timeout_minutes=120
gh run list --workflow studio-headless-run.yml --limit 1
gh run watch <run-id> --exit-status
gh run view <run-id> --log | grep -E "\[[0-9:]+\]" | tail -20
```

Expected: the job summary renders (project link, title, description); artifact `run-output` present; `steps.studio.outputs.project-url` non-empty (visible in the summary). If it fails at install/summary, fix and re-push; a selector-level failure is a runner issue outside this plan's scope (report it).

- [ ] **Step 4: Report** — link the run + PR to the user; note the follow-ups from the spec (version handshake, CLI wrapper, skills/catalog docs).
