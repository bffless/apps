# Studio Headless Run — Design Spec

- **Date:** 2026-08-11
- **Status:** proposed (user-approved design, spec under review)
- **Repo:** `bffless/apps` (monorepo), app `apps/studio`
- **Deliverable:** a GitHub Actions workflow that runs Import → Prep → Build on the
  **real Studio site** unattended, so the user opens the finished project at the
  Build step and only does thumbnail / blog / export by hand.

## Goal

Today the user babysits Studio through Import, Prep, and Build even though they
almost never change any choice until the export-stage steps (thumbnail, blog,
final export). This feature moves everything before that point into CI:

1. User triggers a `workflow_dispatch` with one or more video URLs (and optional
   director guidance text).
2. A headless browser in GitHub Actions logs into the real site, creates a
   project, imports the video(s), runs Prep, and presses Auto Build.
3. When the run finishes, the project is already in the user's project list
   (server sync). The job summary links straight to
   `<base>/project/<id>/build`. The user reviews the final cut and finishes
   manually.

## Why this is feasible with little new machinery

These already-shipped Studio features carry most of the load:

- **Auto Build (story 03s)** — a one-press in-app mode that drives every pending
  scene through cut → contact sheets → refine → voice → assemble, then stitches
  the final cut (`finalCutUrl`). The Build-phase automation already exists; CI
  only has to press the button and wait.
- **Server-side project sync (story 11d)** — project records live in the
  `studio_projects` data table, addressed by `projectId`. A project created in
  the CI browser appears in the user's own browser via list reconcile.
- **Project autosave (`useProjectAutosave`)** — working state is continuously
  saved to the server, so the CI browser is disposable once the save indicator
  reports saved.
- **Multi-source import** — `MediaImport` already accepts multiple files
  (`<input type="file" multiple>`), and `SourceQueue` runs the per-video stages
  (upload / audio / transcribe / thumbnails) per source with a "process all"
  action.
- **Director guidance textarea (`DirectorPanel`)** — the free-text instructions
  sent to the master director are already a UI input; CI types the workflow's
  `director_prompt` into it.

## Locked decisions (from design review with the user)

| Decision | Choice |
| --- | --- |
| Video intake | **URL(s) as workflow input.** The runner downloads them in Node and feeds the existing file input via Playwright `setInputFiles`. No new import feature in the app. Multiple URLs = multiple sources in one project. |
| Drive style | **Pure UI clicking.** Playwright clicks the same controls a user does. No in-app kiosk/unattended mode. App changes are limited to a `data-testid` pass. |
| AI choices | **Accept all AI defaults** (director cuts, Auto Build's refine + voice), **plus** an optional workflow input carrying the master-director guidance text, typed into the DirectorPanel textarea before running the director. Thumbnail / blog / export remain manual. |
| Target site | **Configurable base URL**, default `https://studio.j5s.dev` for build-out; will flip to `https://studio.bffless.dev` later. Base URL is a workflow input backed by a repo variable so the flip is a one-line change. |
| Browser | **Playwright + headless Firefox** (system ffmpeg installed for H.264/AAC decode). Chrome-stable (`channel: 'chrome'`) is the documented escape hatch if Firefox misbehaves. Playwright's bundled Chromium is ruled out (no proprietary codecs). |

## Architecture

Three pieces, all in `bffless/apps`:

### 1. Workflow — `.github/workflows/studio-headless-run.yml`

`workflow_dispatch` only. Inputs:

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `video_urls` | yes | — | One or more source-video URLs, newline-separated. Must be directly fetchable (signed URL, Handoff share link, public URL). |
| `director_prompt` | no | `''` | Free-text guidance typed into the DirectorPanel textarea before running the master director. |
| `project_title` | no | derived | Project name; default derives from date + first file name. |
| `base_url` | no | `vars.STUDIO_BASE_URL` → `https://studio.j5s.dev` | The Studio deployment to drive. |
| `timeout_minutes` | no | `120` | Overall job timeout (`timeout-minutes`). |

Secrets: `STUDIO_USER_EMAIL`, `STUDIO_USER_PASSWORD` — a real user on the target
instance; the runner logs in through the admin login relay exactly as a person
does. (When the target flips to `studio.bffless.dev`, only the base URL variable
and these secrets change.)

Job shape: `ubuntu-latest` → checkout → install pnpm deps for the runner package
→ `apt-get install ffmpeg` (Firefox H.264/AAC decode) → `playwright install
firefox --with-deps` → download `video_urls` to the runner disk (fail fast on
non-200 / empty body) → run the Playwright scenario → always upload artifacts
(milestone screenshots, Playwright trace, console + failed-request log) → write
the job summary (project deep link, per-phase timings, outcome).

### 2. Runner package — `apps/studio/headless/`

A small workspace package (own `package.json`, dep on `@playwright/test`;
excluded from the app's build/lint/test). One long spec, one scenario:

1. **Login.** Navigate to `base_url`; expect the admin-relay redirect; fill
   credentials; land back on Studio authenticated.
2. **Create project.** Click new-project, set title.
3. **Import.** `setInputFiles` on the file input with all downloaded videos.
4. **Prep.** Click "process all"; wait until every source shows its stages done
   (upload / audio / transcribe / thumbnails). Fill the director textarea with
   `director_prompt` (if non-empty); run the master director; wait for scenes.
5. **Build.** Advance to Build; press Auto Build; poll the AutoBuildBoard until
   status is `done` (success) or `halted` (fail the job, see below).
6. **Settle.** Wait for the autosave indicator to report saved; read the
   project id from the URL; screenshot the final state; emit
   `{ projectId, buildUrl }` for the summary step.

Waits are **state-based, not time-based**: every wait targets a `data-testid`'d
DOM state with a generous per-phase ceiling (upload scaled to file size;
transcribe ~30 min per source; director ~10 min; Auto Build up to the remaining
job budget). Progress is logged as each stage flips, so a stuck run is
diagnosable from the CI log alone.

### 3. App changes — `data-testid` pass (one small PR)

Only 3 test-ids exist today. Add stable ids (and, where a state is only visual,
a `data-state` attribute) to the load-bearing controls:

- project list: new-project button, project card
- import: file input, source rows, per-stage status badges, process-all
- prep: director textarea, run-director button, scene list rendered
- stepper: phase links (Import / Prep / Build / Export)
- build: Auto Build start button, AutoBuildBoard overall status
  (`idle|running|halted|done`), halted-step error text
- autosave indicator: `saving|saved|error`

No behavior changes. The ids are also useful to any future e2e tests.

## Auth

`/api/*` on the live site is session-gated (verified: `GET /api/projects` →
`302` to `admin.j5s.dev/login`). The runner authenticates by driving the real
login redirect with the secrets above — no cookie smuggling, no API-key path.
Session refresh over a multi-hour run is handled by the app (apps#47); if a
mid-run request still lands on a login redirect, the runner fails the job with
the resumable report rather than attempting re-login mid-pipeline.

## Failure handling & resumability

The invariant that makes failures cheap: **all durable state lives server-side**
(bucket assets + autosaved project record), and Auto Build halts at the exact
failed step with resume support. So every failure path ends the same way:

- Screenshot + Playwright trace + console/network dump uploaded as artifacts.
- Job summary **always** includes the project deep link when a project id
  exists — a failed run is still a partially-built project the user can open in
  their own browser and resume manually.
- The job exits non-zero so the failure is visible in the Actions UI.

No automatic retries in v1: a halted Auto Build usually means an upstream AI or
storage error a retry loop would just re-pay for.

## Testing

- **Mock-mode smoke test (cheap, deterministic).** The runner also targets a
  local dev server with `MOCK_STUDIO=true` (MSW mocks exist for every `/api/*`
  and return the same shapes as production — the app's mock-first rule). A PR
  check builds the app, serves it with mocks, and runs the full click-script
  against a tiny fixture video. This protects the automation from UI drift
  without spending Replicate/Anthropic credits. Mock mode skips the login step
  (no gate locally).
- **Real runs are dispatch-only** — never on a schedule or PR trigger, because
  each run costs real AI credits and real minutes.
- Runner helper functions (URL parsing, input validation) get plain unit tests
  inside the runner package.

## Risks

| Risk | Mitigation |
| --- | --- |
| UI drift breaks the click-script | Mock-mode smoke test on PRs; test-ids treated as a contract (noted in `apps/studio/CLAUDE.md`). |
| Firefox codec/SAB quirks in CI | System ffmpeg installed; COOP/COEP already served by the site so SharedArrayBuffer works; ffmpeg.wasm falls back to single-threaded if MT init fails (slower, still correct). Chrome-stable escape hatch. |
| Session expiry mid-run | App refresh logic (apps#47); on a hard 302 the job fails resumably. |
| Long transcribe/build overruns | Per-phase ceilings + `timeout_minutes` input; summary reports which phase timed out; project remains resumable. |
| Memory (3 GiB wasm heap + decode) | `ubuntu-latest` has 16 GB; no parallel scenes (Auto Build is sequential by design, story 03u not shipped). |
| Secrets hygiene | Credentials only in GH secrets; runner never logs them; trace masked via Playwright's `recordHar` omitted / storageState not uploaded. |

## Out of scope (v1)

- Pre-generating thumbnail / blog drafts (user chose to keep these manual).
- Watch-folder / auto-trigger intake.
- An in-app unattended mode (user chose pure UI clicking).
- Parallel Auto Build (03u — separate proposal, unapproved).
- Any change to Prep/Build behavior itself.

## Success criteria

1. Dispatching the workflow with a real recording URL produces, unattended, a
   project whose Build phase shows every scene assembled and a stitched final
   cut, reachable from the user's own browser at the summary's deep link.
2. `director_prompt` demonstrably reaches the master director (guidance visible
   in the project's prompt-transparency disclosure).
3. A forced failure (bad URL, halted build) still yields a non-zero job with
   artifacts and, when a project exists, a working deep link to resume.
4. The mock-mode smoke test passes on PRs and catches a deliberately renamed
   control (drift canary).
