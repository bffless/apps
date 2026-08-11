# Studio Headless Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `workflow_dispatch` GitHub Actions workflow that drives the real Studio site with Playwright + headless Firefox through Import → Prep → Auto Build, so the user opens the finished project at the Build step and only does thumbnail/blog/export by hand.

**Architecture:** Three pieces in `bffless/apps`: (1) a `data-testid` pass over Studio's load-bearing controls plus an env toggle for the studio MSW mocks; (2) a new workspace package `apps/studio/headless/` holding a Playwright scenario that clicks the real UI with state-based waits; (3) two workflows — a dispatch-only real run and a PR smoke test that replays the same click-script against a local dev server with mocks.

**Tech Stack:** `@playwright/test` (Firefox), Vitest for runner helpers, GitHub Actions, system ffmpeg (Firefox H.264/AAC decode + smoke fixture generation).

**Spec:** `docs/superpowers/specs/2026-08-11-studio-headless-run-design.md` (also published to https://handoff.bffless.dev/tree/epics/studio-headless).

## Global Constraints

- Repo: `/home/rico/bffless/repos/apps` (pnpm monorepo `bffless-apps`, pnpm 10.33.0, node >= 20). Work on a branch (suggested: `studio/headless-run`) created via a worktree — the `repos/apps` checkout may be shared.
- Workspace rule: **ask the user before any commit/push/PR** — the commit steps below are checkpoints, not standing approval.
- Studio app rules (from `apps/studio/CLAUDE.md`): `pnpm --filter studio build`, `lint`, `test:run` must pass; mock and real endpoints must return the same shape; never stream large files through a pipeline (the runner uploads via the app's own presigned flow, so this holds automatically).
- Base URL default `https://studio.j5s.dev`, later flipped to `https://studio.bffless.dev` — only the `STUDIO_BASE_URL` repo variable and the two secrets change at flip time.
- Real runs are **dispatch-only** (they spend Replicate/Anthropic credits). The smoke test must never hit the real site.
- Workflow YAML: single-line `curl` commands only (no backslash continuations) if any are needed.
- New workspace package must be excluded from the app's own `build`/`lint`/`test:run` (it is a sibling package, not part of `apps/studio`'s Vite project).

## File Structure

```
apps/studio/src/mocks/handlers.ts            # MOCK_STUDIO ← env toggle (modify)
apps/studio/src/components/Studio/*.tsx      # data-testid pass (modify ~7 files)
apps/studio/src/pages/Studio.tsx             # data-testid pass (modify)
apps/studio/headless/package.json            # new workspace package "studio-headless"
apps/studio/headless/playwright.config.ts    # firefox, trace, outputDir
apps/studio/headless/src/config.ts           # env parsing (unit-tested)
apps/studio/headless/src/download.ts         # URL → disk (unit-tested)
apps/studio/headless/src/run.spec.ts         # the one long scenario
apps/studio/headless/src/__tests__/          # vitest for config/download
apps/studio/headless/README.md               # local usage + env reference
.github/workflows/studio-headless-run.yml    # real run (workflow_dispatch)
.github/workflows/studio-headless-smoke.yml  # PR smoke (mock mode)
apps/studio/stories/14-headless-run.md       # story doc pointing at spec+plan
apps/studio/CLAUDE.md                        # test-id contract + runner pointer
```

---

### Task 1: Studio test-id pass + `VITE_MOCK_STUDIO` env toggle

**Files:**
- Modify: `apps/studio/src/mocks/handlers.ts:11`
- Modify: `apps/studio/src/components/Studio/ProjectList.tsx` (New project button)
- Modify: `apps/studio/src/components/Studio/MediaImport.tsx` (file input)
- Modify: `apps/studio/src/components/Studio/SourceQueue.tsx` (rows, stage badges, Process all)
- Modify: `apps/studio/src/components/Studio/DirectorPanel.tsx` (textarea, submit button)
- Modify: `apps/studio/src/components/Studio/AutoBuildBoard.tsx` (board root, start button, halt block)
- Modify: `apps/studio/src/components/Studio/StageCard.tsx` (stage action button)
- Modify: `apps/studio/src/components/Studio/StudioStepper.tsx` (phase buttons)
- Modify: `apps/studio/src/pages/Studio.tsx` (save indicator, continue-plan, continue-build, auto-mode toggle, sources-ready banner)
- Test: `apps/studio/src/mocks/handlers.test.ts` (new), `apps/studio/src/components/Studio/AutoBuildBoard.test.tsx` (new), `apps/studio/src/components/Studio/DirectorPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the selector contract every later task relies on:
  - `new-project` (button), `media-import-input` (file input), `source-row` (one per source), `stage-<upload|extract|transcribe|thumbnails|director>` badges with `data-state="pending|running|done|error"`, `process-all` (button)
  - `sources-ready` (banner div), `continue-plan` (button), `stage-action` (current PipelineBoard stage's button), `director-input` (textarea), `director-run` (submit button), `continue-build` (button)
  - `auto-mode-toggle` (button), `auto-build-board` (div with `data-state="idle|running|paused|halted|done"`), `auto-build-start` (button), `auto-build-halt` (halt message block)
  - `save-indicator` (span with `data-state="saving|saved|error"`), `stepper-<import|prep|build|export>` (buttons)
  - Env toggle: `VITE_MOCK_STUDIO=true` enables the studio MSW handlers (default off, matching today's hardcoded `false`).

- [ ] **Step 1: Write the failing test for the env toggle**

`apps/studio/src/mocks/handlers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// MOCK_STUDIO is resolved at module load, so each case re-imports the module
// with a fresh env.
describe('studio mock gate', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllEnvs())

  it('includes studio handlers only when VITE_MOCK_STUDIO=true', async () => {
    vi.stubEnv('VITE_MOCK_STUDIO', 'true')
    const on = (await import('./handlers')).handlers.length
    vi.resetModules()
    vi.stubEnv('VITE_MOCK_STUDIO', 'false')
    const off = (await import('./handlers')).handlers.length
    expect(on).toBeGreaterThan(off)
  })
})
```

(If the exported array in `handlers.ts` is named differently, use the actual exported name — the array that spreads `...(MOCK_STUDIO ? studioHandlers : [])`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio exec vitest run src/mocks/handlers.test.ts`
Expected: FAIL — both imports return the same length (the constant is hardcoded `false`).

- [ ] **Step 3: Make the gate env-driven**

In `apps/studio/src/mocks/handlers.ts` replace line 11:

```ts
// before
const MOCK_STUDIO = false
// after — CI smoke + local mock runs flip this without a code edit
const MOCK_STUDIO = import.meta.env.VITE_MOCK_STUDIO === 'true'
```

Update the nearby comment (line ~594) that says "Set `MOCK_STUDIO = false` above" to say the toggle is `VITE_MOCK_STUDIO`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter studio exec vitest run src/mocks/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing component tests for the two stateful test-ids**

New `apps/studio/src/components/Studio/AutoBuildBoard.test.tsx` (follow the render-helper style of `SceneList.test.tsx` in the same folder):

```tsx
import { render, screen } from '@testing-library/react'
import { AutoBuildBoard } from './AutoBuildBoard'

const idleRun = { status: 'idle', active: [], halt: null } as never

it('exposes the run status for automation', () => {
  render(
    <AutoBuildBoard scenes={[]} run={idleRun} selectedId={null}
      onSelect={() => {}} onStart={() => {}} onPause={() => {}}
      onResume={() => {}} onStop={() => {}} />,
  )
  expect(screen.getByTestId('auto-build-board').dataset.state).toBe('idle')
  expect(screen.getByTestId('auto-build-start')).toBeInTheDocument()
})
```

(Match `run`'s real shape from `useAutoBuild` — copy the minimal fixture used in `useAutoBuild.test.tsx` rather than casting if that's cleaner.)

Extend `DirectorPanel.test.tsx` with:

```tsx
expect(screen.getByTestId('director-input')).toBeInTheDocument()
expect(screen.getByTestId('director-run')).toBeInTheDocument()
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter studio exec vitest run src/components/Studio/AutoBuildBoard.test.tsx src/components/Studio/DirectorPanel.test.tsx`
Expected: FAIL — test-ids don't exist yet.

- [ ] **Step 7: Add all test-ids**

Mechanical additions (attribute only — zero behavior change):

- `ProjectList.tsx:19` — `+ New project` button → `data-testid="new-project"`.
- `MediaImport.tsx:62` — the `<input ref={inputRef} accept="video/*" multiple>` → `data-testid="media-import-input"` (Playwright `setInputFiles` works on hidden inputs).
- `SourceQueue.tsx` — each source row root → `data-testid="source-row"`; each per-stage badge (the elements labeled via `STAGE_LABELS`) → `data-testid={`stage-${stageId}`}` and `data-state` reflecting the stage status the row already renders (map whatever the component's status value is onto `pending|running|done|error`); the `Process all` button (line ~273) → `data-testid="process-all"`.
- `StageCard.tsx:62` — the action button → `data-testid="stage-action"`.
- `DirectorPanel.tsx` — textarea (line ~51) → `data-testid="director-input"`; the submit button wired to `onSubmit` → `data-testid="director-run"` (the button whose label is the run/rerun CTA; not the secondary button beside it).
- `AutoBuildBoard.tsx` — root container → `data-testid="auto-build-board" data-state={run.status}`; `Start auto build` button (line ~75) → `data-testid="auto-build-start"`; the halted block (line ~97) → `data-testid="auto-build-halt"`.
- `StudioStepper.tsx` — each phase `<button>` (line ~61) → `data-testid={`stepper-${p.id}`}`.
- `Studio.tsx`:
  - save indicator `<span>` (line ~452) → `data-testid="save-indicator" data-state={saveStatus}`
  - the `sourcesReady && !showPlan` banner div (line ~517) → `data-testid="sources-ready"`; its `Continue →` button → `data-testid="continue-plan"`
  - the `pipe.ready` banner's `Continue to build →` button (line ~558) → `data-testid="continue-build"`
  - the `autoMode` toggle button (line ~646, label `Auto build ▶`) → `data-testid="auto-mode-toggle"`

- [ ] **Step 8: Run the full app gate**

Run: `pnpm --filter studio test:run && pnpm --filter studio build && pnpm --filter studio lint`
Expected: tests + build pass; lint introduces **no new** problems (baseline may already be non-zero — compare counts against `main` before judging).

- [ ] **Step 9: Commit (after user approval)**

```bash
git add apps/studio/src
git commit -m "feat(studio): test-id contract + VITE_MOCK_STUDIO env toggle for headless automation"
```

---

### Task 2: Runner package scaffold — config + download helpers

**Files:**
- Create: `apps/studio/headless/package.json`
- Create: `apps/studio/headless/tsconfig.json`
- Create: `apps/studio/headless/src/config.ts`
- Create: `apps/studio/headless/src/download.ts`
- Test: `apps/studio/headless/src/__tests__/config.test.ts`, `apps/studio/headless/src/__tests__/download.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (pure Node).
- Produces (used verbatim by Task 3):
  - `type RunnerConfig = { baseUrl: string; videoUrls: string[]; fixturePaths: string[]; directorPrompt: string; projectTitle: string | null; mockMode: boolean; credentials: { email: string; password: string } | null; buildTimeoutMs: number; prepTimeoutMs: number; directorTimeoutMs: number }`
  - `loadConfig(env?: NodeJS.ProcessEnv): RunnerConfig` — throws with a readable message on missing/invalid input.
  - `parseVideoUrls(raw: string): string[]`
  - `downloadAll(urls: string[], destDir: string): Promise<string[]>` — returns absolute file paths in input order.
  - `fileNameFor(url: string, index: number): string`

- [ ] **Step 1: Scaffold the package**

`apps/studio/headless/package.json` (align dep versions with what the monorepo already resolves — check `pnpm why vitest` / studio's `package.json` and reuse those ranges):

```json
{
  "name": "studio-headless",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "scenario": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "typescript": "~5.6.2",
    "vitest": "^2.1.1"
  }
}
```

`tsconfig.json`: `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true, "types": ["node"] }, "include": ["src"] }` (add `@types/node` to devDependencies).

Run `pnpm install` at the repo root (the package matches the existing `apps/*` workspace glob). Confirm `pnpm --filter studio-headless exec vitest --version` works.

- [ ] **Step 2: Write failing tests for config parsing**

`src/__tests__/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseVideoUrls, loadConfig } from '../config'

describe('parseVideoUrls', () => {
  it('splits on newlines and commas, trims, drops blanks', () => {
    expect(parseVideoUrls('https://a/x.mp4\n https://b/y.mp4 ,\n'))
      .toEqual(['https://a/x.mp4', 'https://b/y.mp4'])
  })
  it('rejects empty input', () => {
    expect(() => parseVideoUrls('  \n')).toThrow(/video_urls/i)
  })
  it('rejects non-http(s) URLs', () => {
    expect(() => parseVideoUrls('ftp://a/x.mp4')).toThrow(/protocol/i)
  })
})

describe('loadConfig', () => {
  const base = {
    STUDIO_BASE_URL: 'https://studio.example.dev',
    VIDEO_URLS: 'https://a/x.mp4',
    STUDIO_USER_EMAIL: 'u@example.com',
    STUDIO_USER_PASSWORD: 'pw',
  }
  it('builds a real-mode config', () => {
    const cfg = loadConfig(base as never)
    expect(cfg.mockMode).toBe(false)
    expect(cfg.credentials).toEqual({ email: 'u@example.com', password: 'pw' })
    expect(cfg.buildTimeoutMs).toBe(90 * 60_000) // default
  })
  it('requires credentials outside mock mode', () => {
    expect(() => loadConfig({ ...base, STUDIO_USER_EMAIL: '' } as never)).toThrow(/STUDIO_USER_EMAIL/)
  })
  it('mock mode takes FIXTURE_PATHS instead of URLs and needs no credentials', () => {
    const cfg = loadConfig({ STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4' } as never)
    expect(cfg.mockMode).toBe(true)
    expect(cfg.fixturePaths).toEqual(['/tmp/f.mp4'])
    expect(cfg.credentials).toBeNull()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter studio-headless test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `config.ts`**

```ts
export type RunnerConfig = {
  baseUrl: string
  videoUrls: string[]
  fixturePaths: string[]
  directorPrompt: string
  projectTitle: string | null
  mockMode: boolean
  credentials: { email: string; password: string } | null
  buildTimeoutMs: number
  prepTimeoutMs: number
  directorTimeoutMs: number
}

export function parseVideoUrls(raw: string): string[] {
  const urls = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
  if (urls.length === 0) throw new Error('video_urls is empty — pass at least one source video URL')
  for (const u of urls) {
    let parsed: URL
    try { parsed = new URL(u) } catch { throw new Error(`video_urls entry is not a valid URL: ${u}`) }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`video_urls entry has an unsupported protocol (need http/https): ${u}`)
    }
  }
  return urls
}

const minutes = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key]
  if (!raw) return fallback * 60_000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number of minutes, got: ${raw}`)
  return n * 60_000
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const baseUrl = (env.STUDIO_BASE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) throw new Error('STUDIO_BASE_URL is required')
  const mockMode = env.MOCK_MODE === 'true'
  const fixturePaths = mockMode
    ? (env.FIXTURE_PATHS ?? '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
    : []
  if (mockMode && fixturePaths.length === 0) throw new Error('FIXTURE_PATHS is required in mock mode')
  const videoUrls = mockMode ? [] : parseVideoUrls(env.VIDEO_URLS ?? '')
  let credentials: RunnerConfig['credentials'] = null
  if (!mockMode) {
    if (!env.STUDIO_USER_EMAIL) throw new Error('STUDIO_USER_EMAIL is required')
    if (!env.STUDIO_USER_PASSWORD) throw new Error('STUDIO_USER_PASSWORD is required')
    credentials = { email: env.STUDIO_USER_EMAIL, password: env.STUDIO_USER_PASSWORD }
  }
  return {
    baseUrl,
    videoUrls,
    fixturePaths,
    directorPrompt: env.DIRECTOR_PROMPT ?? '',
    projectTitle: env.PROJECT_TITLE || null,
    mockMode,
    credentials,
    prepTimeoutMs: minutes(env, 'PREP_TIMEOUT_MINUTES', 30),
    directorTimeoutMs: minutes(env, 'DIRECTOR_TIMEOUT_MINUTES', 10),
    buildTimeoutMs: minutes(env, 'BUILD_TIMEOUT_MINUTES', 90),
  }
}
```

- [ ] **Step 5: Run config tests to verify they pass**

Run: `pnpm --filter studio-headless test`
Expected: config tests PASS.

- [ ] **Step 6: Write failing tests for download**

`src/__tests__/download.test.ts` — real HTTP against an in-process server, no mocking library:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileNameFor, downloadAll } from '../download'

let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok/clip.mp4') { res.writeHead(200); res.end(Buffer.alloc(1024, 7)) }
    else if (req.url === '/empty.mp4') { res.writeHead(200); res.end() }
    else { res.writeHead(404); res.end('nope') }
  })
  await new Promise<void>((r) => server.listen(0, () => r()))
  const addr = server.address() as { port: number }
  origin = `http://127.0.0.1:${addr.port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('fileNameFor', () => {
  it('keeps a video filename from the URL path, prefixed for ordering', () => {
    expect(fileNameFor('https://x/recordings/demo%20day.mp4', 0)).toBe('00-demo day.mp4')
  })
  it('falls back to source-N.mp4 for extensionless paths', () => {
    expect(fileNameFor('https://x/dl?id=123', 2)).toBe('source-2.mp4')
  })
})

describe('downloadAll', () => {
  it('downloads to destDir and returns paths in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    const [p] = await downloadAll([`${origin}/ok/clip.mp4`], dir)
    expect((await stat(p)).size).toBe(1024)
  })
  it('fails on non-200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    await expect(downloadAll([`${origin}/missing.mp4`], dir)).rejects.toThrow(/404/)
  })
  it('fails on an empty body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dl-'))
    await expect(downloadAll([`${origin}/empty.mp4`], dir)).rejects.toThrow(/empty/i)
  })
})
```

- [ ] **Step 7: Run to verify failure, then implement `download.ts`**

Run: `pnpm --filter studio-headless test` → FAIL (module not found). Then:

```ts
import { createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i

export function fileNameFor(url: string, index: number): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (VIDEO_EXT.test(last)) return `${String(index).padStart(2, '0')}-${last}`
  return `source-${index}.mp4`
}

/** Fetch every URL to destDir (streaming — recordings can be GBs). */
export async function downloadAll(urls: string[], destDir: string): Promise<string[]> {
  const out: string[] = []
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`)
    const path = join(destDir, fileNameFor(url, i))
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
    if ((await stat(path)).size === 0) throw new Error(`downloaded file is empty: ${url}`)
    out.push(path)
  }
  return out
}
```

- [ ] **Step 8: Run all runner tests to verify they pass**

Run: `pnpm --filter studio-headless test`
Expected: PASS (config + download).

- [ ] **Step 9: Confirm the app gate is untouched**

Run: `pnpm --filter studio test:run`
Expected: PASS — the new package is invisible to the app.

- [ ] **Step 10: Commit (after user approval)**

```bash
git add apps/studio/headless pnpm-lock.yaml
git commit -m "feat(studio): headless runner package — config + download helpers"
```

---

### Task 3: The Playwright scenario (login → import → prep → auto build)

**Files:**
- Create: `apps/studio/headless/playwright.config.ts`
- Create: `apps/studio/headless/src/run.spec.ts`
- Create: `apps/studio/headless/README.md`

**Interfaces:**
- Consumes: `loadConfig`, `downloadAll` from Task 2; the Task 1 selector contract (`new-project`, `media-import-input`, `source-row`, `process-all`, `sources-ready`, `continue-plan`, `stage-action`, `director-input`, `director-run`, `continue-build`, `auto-mode-toggle`, `auto-build-board[data-state]`, `auto-build-start`, `auto-build-halt`, `save-indicator[data-state]`).
- Produces: artifact files consumed by Task 5's summary step — `run-summary.json` (`{ ok: boolean, projectId: string | null, buildUrl: string | null, phase: string, error: string | null, timings: Record<string, number> }`) and `console.log` in the Playwright output dir; milestone PNGs via `testInfo.attach`.

- [ ] **Step 1: Write `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './src',
  testMatch: '**/run.spec.ts',
  timeout: 0, // per-phase expect timeouts govern; the CI job timeout is the backstop
  retries: 0, // a retry re-spends real AI credits — never
  workers: 1,
  outputDir: './output',
  reporter: [['list'], ['json', { outputFile: 'output/report.json' }]],
  use: {
    ...devices['Desktop Firefox'],
    browserName: 'firefox',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
})
```

- [ ] **Step 2: Write `src/run.spec.ts`**

The full scenario. Key rules: every wait targets a `data-testid` state, `run-summary.json` is written in a `finally` so a failure still reports the resumable project link, and the console/failed responses stream to `output/console.log`.

```ts
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'
import { downloadAll } from './download'

const cfg = loadConfig()
const OUT = join(import.meta.dirname, '..', 'output')

test('studio headless run', async ({ page }, testInfo) => {
  const timings: Record<string, number> = {}
  let phase = 'start'
  let projectId: string | null = null
  const t0 = Date.now()
  const mark = (name: string) => { timings[name] = Date.now() - t0 }
  const shot = async (name: string) => {
    const path = join(OUT, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const logLine = (line: string) => appendFile(join(OUT, 'console.log'), line + '\n').catch(() => {})
  page.on('console', (m) => logLine(`[console:${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logLine(`[pageerror] ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 400) logLine(`[http ${r.status()}] ${r.url()}`) })

  try {
    // ---- files ----
    const files = cfg.mockMode
      ? cfg.fixturePaths
      : await downloadAll(cfg.videoUrls, await mkdtemp(join(tmpdir(), 'studio-src-')))
    mark('download')

    // ---- login (real mode only; the site 302s /api/* to the admin relay) ----
    phase = 'login'
    await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' })
    if (!cfg.mockMode) {
      // Either we land authenticated (rare in CI) or the first project fetch
      // bounces us to the admin login page on the admin origin.
      await page.waitForURL(/\/login/, { timeout: 30_000 }).catch(() => {})
      if (/\/login/.test(page.url())) {
        await page.fill('input[type="email"], input[name="email"]', cfg.credentials!.email)
        await page.fill('input[type="password"]', cfg.credentials!.password)
        await page.click('button[type="submit"]')
        const studioOrigin = new URL(cfg.baseUrl).origin
        await page.waitForURL((u) => u.origin === studioOrigin, { timeout: 60_000 })
      }
    }
    await shot('01-landed')
    mark('login')

    // ---- create project ----
    phase = 'create-project'
    await page.getByTestId('new-project').click()
    await page.waitForURL(/\/project\//, { timeout: 30_000 })
    projectId = page.url().match(/\/project\/([0-9a-f-]+)/)?.[1] ?? null

    // ---- import ----
    phase = 'import'
    await page.getByTestId('media-import-input').setInputFiles(files)
    await expect(page.getByTestId('source-row')).toHaveCount(files.length, { timeout: 60_000 })
    await shot('02-imported')
    mark('import')

    // ---- prep: per-source stages ----
    phase = 'prep-sources'
    await page.getByTestId('process-all').click()
    // sources-ready renders exactly when every per-source stage is done
    await expect(page.getByTestId('sources-ready'))
      .toBeVisible({ timeout: cfg.prepTimeoutMs * files.length })
    await shot('03-sources-processed')
    mark('prep-sources')

    // ---- prep: global plan (contact sheets → director) ----
    phase = 'prep-plan'
    await page.getByTestId('continue-plan').click()
    // The board surfaces one current stage at a time; click stage actions until
    // the director panel (which owns its own run button) is on screen.
    const directorInput = page.getByTestId('director-input')
    const deadline = Date.now() + cfg.prepTimeoutMs
    while (!(await directorInput.isVisible().catch(() => false))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the director panel')
      const action = page.getByTestId('stage-action')
      if (await action.isVisible().catch(() => false)) await action.click()
      await page.waitForTimeout(5_000)
    }
    if (cfg.directorPrompt) await directorInput.fill(cfg.directorPrompt)
    await shot('04-director-ready')
    await page.getByTestId('director-run').click()
    await expect(page.getByTestId('continue-build')).toBeVisible({ timeout: cfg.directorTimeoutMs })
    await shot('05-prep-complete')
    mark('prep-plan')

    // ---- build: auto build ----
    phase = 'build'
    await page.getByTestId('continue-build').click()
    await page.getByTestId('auto-mode-toggle').click()
    await page.getByTestId('auto-build-start').click()
    const board = page.getByTestId('auto-build-board')
    await expect(board).toHaveAttribute('data-state', /^(done|halted)$/, { timeout: cfg.buildTimeoutMs })
    if ((await board.getAttribute('data-state')) === 'halted') {
      const msg = await page.getByTestId('auto-build-halt').innerText().catch(() => 'halted (no message)')
      await shot('06-halted')
      throw new Error(`auto build halted: ${msg}`)
    }
    await shot('06-build-done')
    mark('build')

    // ---- settle: autosave ----
    phase = 'settle'
    await expect(page.getByTestId('save-indicator')).toHaveAttribute('data-state', 'saved', { timeout: 120_000 })
    mark('settle')
    phase = 'done'
  } finally {
    const buildUrl = projectId ? `${cfg.baseUrl}/project/${projectId}/build` : null
    await writeFile(join(OUT, 'run-summary.json'), JSON.stringify({
      ok: phase === 'done',
      projectId,
      buildUrl,
      phase,
      error: phase === 'done' ? null : `failed during: ${phase}`,
      timings,
    }, null, 2))
  }
})
```

- [ ] **Step 3: Type-check the package**

Run: `pnpm --filter studio-headless exec tsc --noEmit`
Expected: clean. (Playwright executes TS directly; `tsc` is the correctness gate.)

- [ ] **Step 4: Write `README.md`**

Document: what the runner is, the full env reference (`STUDIO_BASE_URL`, `VIDEO_URLS`, `DIRECTOR_PROMPT`, `PROJECT_TITLE`, `STUDIO_USER_EMAIL`, `STUDIO_USER_PASSWORD`, `MOCK_MODE`, `FIXTURE_PATHS`, `PREP_TIMEOUT_MINUTES`, `DIRECTOR_TIMEOUT_MINUTES`, `BUILD_TIMEOUT_MINUTES`), and the two invocations:

```bash
# mock mode against a local dev server (no credits spent)
VITE_MOCK_STUDIO=true pnpm --filter studio dev &   # port 5173
MOCK_MODE=true STUDIO_BASE_URL=http://localhost:5173 FIXTURE_PATHS=/tmp/fixture.mp4 pnpm --filter studio-headless scenario

# real run (spends AI credits!)
STUDIO_BASE_URL=https://studio.j5s.dev VIDEO_URLS=https://…/recording.mp4 STUDIO_USER_EMAIL=… STUDIO_USER_PASSWORD=… pnpm --filter studio-headless scenario
```

Note the Firefox codec requirement: system ffmpeg must be installed for H.264/AAC decode (`sudo apt-get install ffmpeg`), and `pnpm --filter studio-headless exec playwright install firefox`.

- [ ] **Step 5: Commit (after user approval)**

```bash
git add apps/studio/headless
git commit -m "feat(studio): headless Playwright scenario — login, import, prep, auto build"
```

---

### Task 4: Mock-mode smoke — fixture + local verification + PR workflow

**Files:**
- Create: `apps/studio/headless/scripts/make-fixture.sh`
- Create: `.github/workflows/studio-headless-smoke.yml`
- Modify: `apps/studio/headless/src/run.spec.ts` (smoke stop-point)
- Modify: `apps/studio/headless/src/config.ts` + `src/__tests__/config.test.ts` (`smokeStopAfterStart`)

**Interfaces:**
- Consumes: Task 3's scenario; Task 1's `VITE_MOCK_STUDIO` toggle.
- Produces: a green PR check named `studio-headless-smoke`; `SMOKE_STOP_AFTER_START=true` env flag on `RunnerConfig` as `smokeStopAfterStart: boolean`.

- [ ] **Step 1: Add the smoke stop-point to config (test-first)**

Add to `config.test.ts`:

```ts
it('reads the smoke stop flag', () => {
  const cfg = loadConfig({ STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4', SMOKE_STOP_AFTER_START: 'true' } as never)
  expect(cfg.smokeStopAfterStart).toBe(true)
})
```

Run `pnpm --filter studio-headless test` → FAIL. Then add to `RunnerConfig` and `loadConfig`: `smokeStopAfterStart: env.SMOKE_STOP_AFTER_START === 'true'`. Re-run → PASS.

In `run.spec.ts`, inside the build phase, right after `auto-build-start` is clicked:

```ts
if (cfg.smokeStopAfterStart) {
  // Smoke asserts the full click-path is intact; the mocked build itself is
  // not the subject. Leaving idle proves the runner engaged.
  await expect(board).not.toHaveAttribute('data-state', 'idle', { timeout: 60_000 })
  await shot('06-smoke-autobuild-engaged')
  phase = 'done'
  return
}
```

(`phase = 'done'` before the early return so the summary reports ok.)

- [ ] **Step 2: Write the fixture generator**

`apps/studio/headless/scripts/make-fixture.sh`:

```bash
#!/usr/bin/env bash
# Tiny H.264+AAC clip for mock-mode smoke runs. Requires system ffmpeg.
set -euo pipefail
out="${1:-/tmp/studio-fixture.mp4}"
ffmpeg -y -loglevel error -f lavfi -i "testsrc=duration=4:size=640x360:rate=30" -f lavfi -i "sine=frequency=440:duration=4" -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$out"
echo "$out"
```

`chmod +x` it.

- [ ] **Step 3: Run the smoke locally end-to-end**

```bash
pnpm --filter studio-headless exec playwright install firefox
apps/studio/headless/scripts/make-fixture.sh /tmp/studio-fixture.mp4
VITE_MOCK_STUDIO=true pnpm --filter studio dev &
MOCK_MODE=true SMOKE_STOP_AFTER_START=true STUDIO_BASE_URL=http://localhost:5173 FIXTURE_PATHS=/tmp/studio-fixture.mp4 pnpm --filter studio-headless scenario
```

Expected: PASS with `output/run-summary.json` `ok: true`. **This step is the real integration test of Tasks 1–4 — debug here, not in CI.** Likely first-run issues: a selector that landed on the wrong element (fix the test-id placement), the MSW worker not registering (check `VITE_MOCK_STUDIO` reached the dev server env), or mock handlers missing a route the UI calls in this path (extend `src/mocks/handlers.ts` with the same-shape response, per the app's mock-first rule). Kill the dev server after.

- [ ] **Step 4: Write the smoke workflow**

`.github/workflows/studio-headless-smoke.yml`:

```yaml
name: Studio Headless Smoke

# Drift canary for the headless runner: replays the click-script against a
# local dev server with MSW mocks. Spends zero AI credits, never touches the
# real site.
on:
  pull_request:
    paths:
      - 'apps/studio/**'
      - '.github/workflows/studio-headless-smoke.yml'

jobs:
  smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Install ffmpeg (fixture + Firefox H.264 decode)
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - name: Install Firefox for Playwright
        run: pnpm --filter studio-headless exec playwright install firefox --with-deps
      - name: Runner unit tests
        run: pnpm --filter studio-headless test
      - name: Generate fixture clip
        run: apps/studio/headless/scripts/make-fixture.sh /tmp/studio-fixture.mp4
      - name: Start dev server (mock mode)
        run: |
          VITE_MOCK_STUDIO=true pnpm --filter studio dev &
          npx wait-on --timeout 120000 http://localhost:5173
      - name: Run smoke scenario
        env:
          MOCK_MODE: 'true'
          SMOKE_STOP_AFTER_START: 'true'
          STUDIO_BASE_URL: http://localhost:5173
          FIXTURE_PATHS: /tmp/studio-fixture.mp4
        run: pnpm --filter studio-headless scenario
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-output
          path: apps/studio/headless/output/
```

- [ ] **Step 5: Verify the drift canary actually catches drift**

Temporarily rename `data-testid="process-all"` to `data-testid="process-all-x"` in `SourceQueue.tsx`, re-run the local smoke command from Step 3, and confirm it FAILS at the prep phase. Revert the rename, re-run, confirm PASS. (Success criterion 4 of the spec.)

- [ ] **Step 6: Commit (after user approval)**

```bash
git add apps/studio/headless .github/workflows/studio-headless-smoke.yml
git commit -m "feat(studio): mock-mode smoke for the headless runner (PR drift canary)"
```

---

### Task 5: Real-run workflow — `studio-headless-run.yml`

**Files:**
- Create: `.github/workflows/studio-headless-run.yml`

**Interfaces:**
- Consumes: the runner package + env contract from Tasks 2–3 (`VIDEO_URLS`, `DIRECTOR_PROMPT`, `PROJECT_TITLE`, `STUDIO_BASE_URL`, `BUILD_TIMEOUT_MINUTES`, `STUDIO_USER_EMAIL`, `STUDIO_USER_PASSWORD`); `output/run-summary.json`.
- Produces: the user-facing workflow. Requires repo secrets `STUDIO_USER_EMAIL` + `STUDIO_USER_PASSWORD` and (optional) repo variable `STUDIO_BASE_URL` — the flip to `studio.bffless.dev` later is: update the variable + secrets, nothing else.

- [ ] **Step 1: Write the workflow**

```yaml
name: Studio Headless Run

# Unattended Import → Prep → Auto Build against the real Studio site.
# Dispatch-only: every run spends real AI credits (transcribe, director,
# refine, voice). The finished project appears in your own project list via
# server sync; the job summary links straight to its Build page.
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
      project_title:
        description: 'Optional project name'
        required: false
        type: string
        default: ''
      base_url:
        description: 'Studio deployment to drive (blank = repo var / studio.j5s.dev)'
        required: false
        type: string
        default: ''
      timeout_minutes:
        description: 'Overall job timeout'
        required: false
        type: number
        default: 120

concurrency:
  group: studio-headless-run
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${{ fromJSON(inputs.timeout_minutes) }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Install ffmpeg (Firefox H.264/AAC decode)
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - name: Install Firefox for Playwright
        run: pnpm --filter studio-headless exec playwright install firefox --with-deps
      - name: Run scenario
        env:
          STUDIO_BASE_URL: ${{ inputs.base_url != '' && inputs.base_url || vars.STUDIO_BASE_URL != '' && vars.STUDIO_BASE_URL || 'https://studio.j5s.dev' }}
          VIDEO_URLS: ${{ inputs.video_urls }}
          DIRECTOR_PROMPT: ${{ inputs.director_prompt }}
          PROJECT_TITLE: ${{ inputs.project_title }}
          STUDIO_USER_EMAIL: ${{ secrets.STUDIO_USER_EMAIL }}
          STUDIO_USER_PASSWORD: ${{ secrets.STUDIO_USER_PASSWORD }}
        run: pnpm --filter studio-headless scenario
      - name: Job summary
        if: always()
        run: |
          node -e '
            const fs = require("fs");
            const p = "apps/studio/headless/output/run-summary.json";
            let s = { ok: false, phase: "no-summary", buildUrl: null, timings: {} };
            try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
            const lines = [
              s.ok ? "## ✅ Studio headless run complete" : `## ❌ Studio headless run failed (during: ${s.phase})`,
              "",
              s.buildUrl ? `**Open the project:** ${s.buildUrl}` : "_No project was created._",
              s.ok ? "" : s.buildUrl ? "\nThe project is resumable — open the link and continue from where the run halted." : "",
              "",
              "| Phase | Elapsed |", "| --- | --- |",
              ...Object.entries(s.timings).map(([k, v]) => `| ${k} | ${Math.round(v / 1000)}s |`),
            ];
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
          '
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: run-output
          path: apps/studio/headless/output/
```

- [ ] **Step 2: Lint the workflow**

Run: `npx --yes @action-validator/cli .github/workflows/studio-headless-run.yml` (or `actionlint` if installed: `actionlint .github/workflows/studio-headless-run.yml`).
Expected: no errors. (Watch the `timeout-minutes` expression — if the validator rejects `fromJSON(inputs.timeout_minutes)`, use `${{ inputs.timeout_minutes }}` directly; `type: number` inputs interpolate as numbers.)

- [ ] **Step 3: Commit (after user approval)**

```bash
git add .github/workflows/studio-headless-run.yml
git commit -m "feat(studio): dispatch workflow for unattended headless runs"
```

---

### Task 6: Docs — story, CLAUDE.md contract, live verification

**Files:**
- Create: `apps/studio/stories/14-headless-run.md`
- Modify: `apps/studio/CLAUDE.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–5.
- Produces: the durable design record + the test-id contract note that protects the runner from future UI work.

- [ ] **Step 1: Write the story doc**

`apps/studio/stories/14-headless-run.md`, following the house pattern (see `stories/03s-auto-build.md` for tone): Why (babysitting → CI), What shipped (test-id contract, `VITE_MOCK_STUDIO`, `headless/` runner, two workflows), pointers to the spec (`docs/superpowers/specs/2026-08-11-studio-headless-run-design.md`) and this plan, and the secrets/vars a forker must set (`STUDIO_USER_EMAIL`, `STUDIO_USER_PASSWORD`, optional `STUDIO_BASE_URL`).

- [ ] **Step 2: Add the contract note to `apps/studio/CLAUDE.md`**

Append to the "Non-negotiable patterns" section:

```markdown
- **`data-testid`s are a contract.** The headless runner (`headless/`, story 14)
  drives the real site by these ids; renaming or removing one breaks unattended
  runs. The PR smoke workflow (`studio-headless-smoke.yml`) is the canary — if
  it fails after a UI change, restore the id rather than updating the runner.
```

- [ ] **Step 3: Run the full gate one last time**

Run: `pnpm --filter studio build && pnpm --filter studio test:run && pnpm --filter studio-headless test && pnpm --filter studio-headless exec tsc --noEmit`
Expected: all PASS.

- [ ] **Step 4: Commit (after user approval), then open the PR**

```bash
git add apps/studio/stories/14-headless-run.md apps/studio/CLAUDE.md
git commit -m "docs(studio): headless run story + test-id contract"
```

PR title (conventional-commit — it becomes the squash commit): `feat(studio): unattended headless run (import → prep → auto build) via GitHub Actions`. Push every commit **before** opening the PR.

- [ ] **Step 5: Live verification (after merge, with the user)**

1. User adds `STUDIO_USER_EMAIL` / `STUDIO_USER_PASSWORD` secrets to `bffless/apps`.
2. Dispatch `Studio Headless Run` with a real recording URL + a director prompt.
3. Verify: job summary deep-links to `…/project/<id>/build`; opening it in the user's own browser shows every scene assembled and the stitched final cut; the director prompt is visible in the prompt-transparency disclosure (spec success criterion 2).
4. Force a failure (dispatch with a 404 URL): job fails fast with artifacts and no project link (criterion 3a).

---

## Self-Review Notes

- **Spec coverage:** intake via URLs (T2/T5), pure UI clicking on the selector contract (T1/T3), director prompt input (T3/T5), configurable base URL with flip path (T5), Firefox+ffmpeg (T4/T5), mock smoke + drift canary (T4), failure→resumable summary (T3/T5), docs (T6). `project_title` is accepted and threaded through env (T2/T5) but v1 does not rename the project in-UI — the default derived name stands; noted for the story doc as a known cut (rename lives on the projects list, a separate click-path not worth its brittleness now).
- **Type consistency:** `RunnerConfig` fields used in T3/T4 match T2's definition (`smokeStopAfterStart` added in T4 with its own test); summary JSON keys in T5's step match T3's writer.
- **Known judgment calls surfaced to the executor:** exact badge markup in `SourceQueue.tsx` and the `run` fixture shape in `AutoBuildBoard.test.tsx` are adapted in place; the admin login page's selectors are generic (`input[type=email]` etc.) and should be confirmed against the real login page during live verification.
