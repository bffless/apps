# 14 — Headless run (unattended Import → Prep → Auto Build via GitHub Actions)

> Design: `docs/superpowers/specs/2026-08-11-studio-headless-run-design.md`.
> Plan: `docs/superpowers/plans/2026-08-11-studio-headless-run.md`.

**Status:** ✅ shipped (2026-08-11, branch `studio/headless-run`).

## Why

Story 03s made Build one-press (auto cut → sheets → refine → voice → assemble → stitch), but the
user still babysits Import and Prep by hand every time: upload the recording(s), watch each source
finish its stages, type director guidance, wait for the master director, then go press Auto Build.
None of that requires judgment calls most of the time — the AI defaults are usually fine, and the
only real editorial pass happens after Build, at thumbnail/blog/export. This story moves everything
before that point into CI: dispatch a workflow with a video URL (and optional director guidance),
and come back later to a finished project sitting in your own project list, ready to review at
Build.

## What shipped

**Test-id contract + mock env toggle.** ~20 `data-testid`s were added across the load-bearing
Studio controls — project list (`new-project`), import (`media-import-input`, `source-row`),
per-source stage badges (`StageCard.tsx` root: `data-testid="stage-<id>"` with
`data-state="pending|running|done|error"`), `process-all`, prep (`sources-ready`, `continue-plan`,
`stage-action`, `director-input`, `director-run`, `continue-build`), the stepper
(`stepper-<phase>`), Build (`auto-mode-toggle`, `auto-build-board` with
`data-state="idle|running|paused|halted|done"`, `auto-build-start`, `auto-build-halt`), and the
autosave indicator (`save-indicator` with `data-state="saving|saved|error"`). No behavior changes —
attributes only. `src/mocks/handlers.ts`'s mock gate, previously a hardcoded `const MOCK_STUDIO =
false`, is now `import.meta.env.VITE_MOCK_STUDIO === 'true'` so CI can flip mocks on without editing
source.

**`apps/studio/headless/` — the runner package.** A sibling workspace package (`studio-headless`,
explicit entry in the root `pnpm-workspace.yaml` since it doesn't match the `apps/*` glob after
nesting under `apps/studio/`), excluded from the app's own build/lint/test:

- `src/config.ts` — `loadConfig(env)` parses and validates everything the scenario needs
  (`RunnerConfig`: base URL, video URLs or mock fixture paths, director prompt, project title,
  mock/real mode, credentials, and three timeout ceilings — prep/director/build — plus
  `smokeStopAfterStart` for the PR smoke check). Throws readable errors on missing/invalid input
  rather than letting the scenario fail confusingly mid-run.
- `src/download.ts` — `downloadAll` streams each `VIDEO_URLS` entry to disk (recordings can be
  GBs), failing fast on a non-2xx status or an empty body.
- Both are unit-tested with Vitest (`^4.1.7` — newer than the plan's originally-sketched `^2.1.1`;
  aligned to what the monorepo actually resolved).

**`src/run.spec.ts` — the one scenario.** A single Playwright test: login (real mode only — the
site 302s an unauthenticated `/api/*` call to the admin login relay; mock mode skips this, there's
no gate locally) → create project → import (`setInputFiles` with all downloaded/fixture videos) →
prep (click `process-all`, wait for `sources-ready`, advance to the plan stage by clicking
`stage-action` in a poll loop until the director panel appears, fill `director-prompt` if given, run
the director, wait for `continue-build`) → Build (toggle auto mode, start auto build, poll
`auto-build-board`'s `data-state` until `done` or `halted` — a `halted` state reads the
`auto-build-halt` message and throws) → settle (wait for `save-indicator` to report `saved`). Every
wait targets a `data-testid` state, never a fixed sleep. `output/run-summary.json`
(`{ ok, projectId, buildUrl, phase, error, timings }`) is written from a `finally` block — **on
every exit path, including a config-load failure** (`loadConfig()` itself is now wrapped inside the
`try`, with `cfg` typed nullable so the `finally` block degrades gracefully to
`{ ok: false, projectId: null, buildUrl: null, phase: 'config', error: <message> }` instead of
throwing before it can write anything). Console messages, page errors, and failed (4xx/5xx)
responses stream to `output/console.log`; milestone screenshots attach to the Playwright report.
See `apps/studio/headless/README.md` for the full environment reference and both invocations (mock
and real).

**Two GitHub Actions workflows.**

- `.github/workflows/studio-headless-smoke.yml` — the **drift canary**. Runs on every PR touching
  `apps/studio/**`: builds a tiny fixture clip, starts the app's dev server with
  `VITE_MOCK_STUDIO=true`, and replays the click-script against it with `MOCK_MODE=true
  SMOKE_STOP_AFTER_START=true` (stops right after auto build engages rather than waiting out a full
  mocked build) and a `--timeout=600000` (10 min) Playwright override so a selector/drift failure
  fails fast — well under the job's 20-minute backstop, leaving time for the `finally` block to
  write `run-summary.json` and for the artifact upload step to run. Artifacts (screenshots,
  console log, run summary) upload `if: always()`. Verified locally in both directions: renaming
  `data-testid="process-all"` made the smoke fail at the prep phase; reverting made it pass again.
- `.github/workflows/studio-headless-run.yml` — the **real run**, `workflow_dispatch` only (never
  scheduled or PR-triggered — every run spends real AI credits). Inputs: `video_urls` (required,
  newline-separated), `director_prompt`, `project_title`, `base_url` (falls back to the
  `STUDIO_BASE_URL` repo variable, then `https://studio.j5s.dev`), `timeout_minutes` (default
  **180** — the plan's original default of 120 didn't leave enough headroom over the runner's own
  ceilings, prep 30 min × number of videos + director 10 min + build 90 min (e.g. 130 min for a
  single video, ~222 min for three), so it was raised — dispatches with several videos should raise
  `timeout_minutes` accordingly). Secrets:
  `STUDIO_USER_EMAIL` / `STUDIO_USER_PASSWORD`. Installs `ffmpeg` via apt (for Firefox's H.264/AAC
  decode of real recordings — mock-mode fixtures don't need this, see below) and Firefox via
  Playwright, runs the scenario, then always writes a job summary (✅/❌ heading, the build deep
  link and/or bare project ID depending on what the run reached, the error message when one exists,
  a resumability note when a project exists but the run didn't finish, and a phase-timings table)
  and uploads `output/` as an artifact.

**Deviation from the plan: WebM fixtures, not H.264 mp4.** The plan's `make-fixture.sh` sketch
produced an H.264/AAC mp4 and relied on system `ffmpeg` being present in CI for Firefox to decode
it. The shipped `apps/studio/headless/scripts/make-fixture.sh` instead produces a **VP8+Vorbis
WebM** — Firefox decodes VP8/Vorbis natively, so the smoke path needs no system codec packages at
all. It resolves an ffmpeg *binary* (to encode the fixture, not decode it) in order: `$FFMPEG_BIN` →
`ffmpeg` on `PATH` → the `ffmpeg-static` npm devDependency — so the smoke workflow doesn't even run
`apt-get install ffmpeg`. The real-run workflow still installs system `ffmpeg`, because real
recordings uploaded by users are typically H.264/AAC and Firefox needs the system codec for those.

## Known cut: `project_title` isn't wired to a rename

`project_title` is accepted as a workflow input and threaded through the runner's env/config, but
v1 doesn't use it — there's no in-UI rename click-path in the scenario, so the project keeps
whichever default name the app derives on creation. Renaming lives on the projects list, a separate
click-path judged not worth the added brittleness for v1. The input is left in place so a future
task can wire it without touching the workflow surface.

## Setting this up in your own fork

1. Add repository secrets `STUDIO_USER_EMAIL` / `STUDIO_USER_PASSWORD` — a real user account on the
   target Studio instance. **Use a dedicated machine user** (e.g. `studio-ci@yourdomain`) rather
   than a personal login: Studio's project list is **instance-global**, not per-user
   (`GET /api/projects` has no per-user filter — see story 11d), so every project the CI user
   creates shows up in *everyone's* project list on that instance. A dedicated account keeps CI's
   output visually distinguishable and means rotating/revoking the credential doesn't touch a real
   person's login.
2. Optionally add a repository variable `STUDIO_BASE_URL` if you're not driving
   `https://studio.j5s.dev` (the workflow's `base_url` input, when left blank, falls back to this
   variable, then to that default). Flipping to a new deployment later is: update the variable +
   the two secrets, nothing else in the workflow YAML.
3. Dispatch **Studio Headless Run** from the Actions tab with one or more `video_urls` and,
   optionally, a `director_prompt`.

## Live verification (post-merge)

The admin login page's exact selectors (`input[type="email"], input[name="email"]` /
`input[type="password"]` / `button[type="submit"]`) and the workflow's
`timeout-minutes: ${{ fromJSON(inputs.timeout_minutes) }}` expression were both written against
inspection, not a live dispatch — the mock-mode smoke never exercises the login step (mock mode has
no auth relay) or the numeric-input coercion (the smoke doesn't set `timeout_minutes`). Watch both
on the first real dispatch. Checklist:

1. Add the `STUDIO_USER_EMAIL` / `STUDIO_USER_PASSWORD` secrets (and `STUDIO_BASE_URL` variable, if
   needed) to `bffless/apps`, then dispatch **Studio Headless Run** with a real recording URL and a
   director prompt.
2. Confirm the job summary's deep link opens the project at Build with every scene assembled and
   the stitched final cut playable (spec success criterion 1).
3. Confirm the director prompt text is visible in the project's prompt-transparency disclosure
   (spec success criterion 2, story 03m).
4. Dispatch again with a deliberately broken URL (e.g. one that 404s) to force a failure: confirm
   the job fails fast, artifacts upload, and — because no project was ever created — the summary
   shows "No project was created" rather than a link (spec success criterion 3).
5. Two things are unverifiable before a live run and should be watched closely on the first
   dispatch:
   - **The admin login page's selectors** — `input[type="email"], input[name="email"]` for the
     email field, `input[type="password"]` for the password field, `button[type="submit"]` for the
     submit button. If the real login page's markup doesn't match, `playwright.config.ts`'s
     `actionTimeout: 120_000` now bounds the click/fill itself, so the scenario fails at the
     `login` phase in ~2 minutes with a summarized failure — it does not hang until the job's
     `timeout-minutes` kill.
   - **`fromJSON(inputs.timeout_minutes)`** — the `timeout-minutes:` job field expects a number;
     `type: number` workflow inputs are documented to interpolate as numbers, but if GitHub Actions
     ever passes it as a string this expression fails at job-start with a workflow syntax error
     before any step runs.

## Live verification results (2026-08-12 — verified)

Five real dispatches on 2026-08-11/12 closed out the checklist and reshaped two defaults:

- **End-to-end success — run 31552803617 (Chrome + `?ffmpegCore=st`): ~28 minutes total** for a
  ~9-minute recording. Prep in 2 min (upload + audio + transcribe 25s, contact sheets ~45s,
  director ~40s), then 4 scenes through the full auto-build chain plus final stitch in 25.5 min.
  Deep link opened at Build with the stitched final cut; project autosaved server-side.
- **Admin-login selectors and `fromJSON(inputs.timeout_minutes)` both work** — the two
  pre-merge-unverifiable seams verified on the first dispatch.
- **The multithreaded ffmpeg.wasm core hangs in headless Firefox** (run 31547724192: 34 silent
  minutes after "core: multithreaded"). Forcing single-thread by disabling SharedArrayBuffer at the
  browser level breaks *both* cores (run 31550836845 — the ST build carries atomics opcodes the
  validator then rejects), which is why the explicit `?ffmpegCore=st|mt` app override exists.
- **Chrome decisively beats Firefox for the ST encode**: Firefox+ST could not finish one 232s scene
  cut in 12+ minutes (run 31551738868, cancelled); Chrome+ST built 4 scenes in 25. The workflow's
  `browser` input therefore defaults to `chrome`.
- **Spectating rule confirmed the hard way**: opening a running project in a browser demotes its
  auto build to `paused` in the viewer's tab and autosaves that — watch runs via the CI log or
  `headless/scripts/progress.mjs`, never the project page.
- **The wasm encoder remains the structural bottleneck.** ~25 min of the 28 is build-phase
  encoding that native ffmpeg does in seconds — the follow-up epic is the CE `ffmpeg_handler`
  (server-side slice/concat/extract via the story-03f fire-and-poll pattern); design spec on
  handoff.bffless.dev under `epics/studio-headless` (lands in the CE repo with its
  implementation). **Landed 2026-08-12** — see
  `docs/superpowers/plans/2026-08-12-studio-server-video-ops.md`: four new `/api/video/*` rules
  (`capabilities`, `slice`, `concat`, `extract-audio`) call CE's `ffmpeg_handler` (CE >= 0.4.25),
  with a once-per-session capability probe and transparent `ffmpeg.wasm` fallback on older CE.

## Out of scope (v1)

Everything already listed as out of scope in the design spec still holds: pre-generating
thumbnail/blog drafts, watch-folder/auto-trigger intake, an in-app unattended mode, parallel Auto
Build (story 03u, unapproved), and any change to Prep/Build behavior itself. Renaming the project
from `project_title` (see "Known cut" above) is additionally out of scope for this story.
