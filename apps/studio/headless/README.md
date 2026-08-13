# studio-headless

> The scenario streams timestamped progress lines to stdout (phase
> transitions, per-clip stage states, auto-build state), so a CI run's live
> log shows where it is at all times; the same lines also land in
> `output/console.log`.

A Playwright scenario that drives the real Studio app end-to-end — login, project creation,
media import, prep (per-source stages → director), auto build, and the Export step
(title/description, YouTube thumbnail, optional blog post) — for unattended CI runs and
local smoke checks. It talks to a live Studio origin (either a local dev server in mock mode, or
the deployed app) exactly the way a human producer would: through the UI, via `data-testid`
selectors.

## What it does

`src/run.spec.ts` is a single Playwright test that:

1. Gathers source video files — either local fixtures (mock mode) or downloads from
   `VIDEO_URLS` (real mode, via `src/download.ts`).
2. Logs in, if not already authenticated (real mode only — mock mode has no auth relay).
3. Creates a new project and imports the source files.
4. Runs prep: kicks off per-source processing, waits for `sources-ready`, advances to the
   global plan stage (clicking `stage-action` until the director panel appears), fills the
   director prompt, and runs the director.
5. Starts auto build and waits for the build board to reach `done` (or throws on `halted`).
6. Continues to Export: waits for the auto-generated title + description, drafts the
   thumbnail prompt (steered by `THUMBNAIL_PROMPT` when set), attaches the optional
   reference image (`THUMBNAIL_REFERENCE_URL`, downloaded up front), renders the
   thumbnail (saved to `output/thumbnail.png`), and — when `GENERATE_BLOG=true` —
   writes the blog post (steered by `BLOG_DIRECTION`) and captures the app's own
   bundle download as `output/blog-bundle.zip` (+ `output/post.md` unzipped for the
   job summary).
7. Waits for the autosave indicator to report `saved`.

Every wait targets a `data-testid` element's visibility or `data-state` attribute — no fixed
sleeps gate progress (a short poll interval is used only while stepping through prep stage
actions). On success or failure, `output/run-summary.json` is written from a `finally` block so a
failed run still reports the phase it reached and a resumable deep link (`openUrl`: the
Export page once the run got that far, the Build page for earlier failures) plus the
generated title/description when the run produced them. Milestone
screenshots (`output/NN-*.png`) are attached to the Playwright report, and browser console
messages, page errors, and failed (4xx/5xx) HTTP responses stream to `output/console.log`.

## Environment reference

| Variable                  | Required            | Description                                                                 |
| -------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `STUDIO_BASE_URL`           | always                | Origin of the Studio app to drive (e.g. `http://localhost:5173`).            |
| `VIDEO_URLS`                | real mode             | One or more source video URLs (comma or newline separated).                  |
| `DIRECTOR_PROMPT`           | no                    | Prompt text filled into the director panel before running it.                |
| `PROJECT_TITLE`             | no                    | Reserved for a future "name this project" step; currently unused by the spec.|
| `STUDIO_USER_EMAIL`         | real mode             | Login email for the admin auth relay.                                        |
| `STUDIO_USER_PASSWORD`      | real mode             | Login password for the admin auth relay.                                     |
| `MOCK_MODE`                 | no (`false` default)  | `true` to skip login and use local fixtures instead of downloading videos.   |
| `FIXTURE_PATHS`             | mock mode             | One or more local file paths to import instead of downloaded videos.         |
| `PREP_TIMEOUT_MINUTES`      | no (default `30`)     | Ceiling per prep stage / per source file. The workflow's `timeout_minutes` must exceed `PREP_TIMEOUT_MINUTES × number of videos + DIRECTOR_TIMEOUT_MINUTES + BUILD_TIMEOUT_MINUTES` — prep scales with `files.length`, not a flat 30 min. |
| `DIRECTOR_TIMEOUT_MINUTES`  | no (default `10`)     | Ceiling for the master director run.                                         |
| `BUILD_TIMEOUT_MINUTES`     | no (default `90`)     | Ceiling for the full auto build run.                                         |
| `THUMBNAIL_PROMPT`          | no                    | Free-text notes typed into "What should the thumbnail be like?" before drafting the image prompt. |
| `THUMBNAIL_REFERENCE_URL`   | no                    | Image URL (e.g. a Handoff share link) downloaded and attached as the thumbnail reference, so the render is built around it. |
| `GENERATE_BLOG`             | no (`false` default)  | `true` also generates the blog post and captures its bundle.                 |
| `BLOG_DIRECTION`            | no                    | Optional direction typed into the blog card before generating.               |
| `DESCRIBE_TIMEOUT_MINUTES`  | no (default `5`)      | Ceiling for the auto-generated title + description.                          |
| `THUMBNAIL_TIMEOUT_MINUTES` | no (default `10`)     | Ceiling each for the thumbnail prompt draft and the image render.            |
| `BLOG_TIMEOUT_MINUTES`      | no (default `15`)     | Ceiling for the blog-post generation.                                        |
| `SMOKE_STOP_AFTER_START`    | no (`false` default)  | `true` to stop right after auto build engages instead of waiting for it to finish — used by the PR smoke check, which asserts the click-path is intact without paying for a full (mocked) build. |
| `FFMPEG_MT`                 | no (`false` default)  | `true` lands on `?ffmpegCore=mt` instead of `?ffmpegCore=st`. By default the runner asks Studio for its single-threaded ffmpeg core via the explicit `?ffmpegCore=st` override — the MT core hung indefinitely on its first exec in headless CI Firefox, and forcing ST by disabling SharedArrayBuffer at the browser level breaks *both* cores (even the ST build carries atomics opcodes the validator then rejects). |

| `RUNNER_BROWSER`            | no (`firefox` default) | `chrome` drives Google Chrome stable instead of Playwright Firefox (preinstalled on ubuntu-latest; `playwright install chrome` locally). The platform for the MT-ffmpeg experiment: MT hangs its first exec in headless Firefox, and wasm threads are better exercised in headless Chromium. Dispatch with `browser: chrome` + `ffmpeg_mt: true` to test. |

See `src/config.ts` for the exact parsing/validation rules (`loadConfig`).

## Checking on a run's progress

Two read-only ways to see where a run is:

1. **The live CI log** — open the run's job and expand the **Run scenario**
   step: it streams timestamped lines (per-clip prep stages, the director's
   chapter list, `N/M scenes built` with the current step) as they happen.
2. **From anywhere, via the server record** — the CI browser autosaves the
   whole project server-side, so:

   ```bash
   BFFLESS_API_KEY=… node scripts/progress.mjs            # newest project
   BFFLESS_API_KEY=… node scripts/progress.mjs <projectId>
   ```

   prints phase, per-source flags, the chapter list with built-status, and the
   auto-build state.

**Do not watch by opening the project page in a browser mid-run**: hydrating a
`running` project demotes it to `paused` in *your* tab (by design — a persisted
run isn't executing in your session) and your tab autosaves that, confusing
anyone else reading the record. The CI browser is unaffected, but use the
project *list*, the CI log, or `progress.mjs` to spectate.

## Running it

### Mock mode (local dev server, no AI credits spent)

```bash
apps/studio/headless/scripts/make-fixture.sh /tmp/studio-fixture.webm
VITE_MOCK_STUDIO=true pnpm --filter studio dev &   # port 5173
MOCK_MODE=true STUDIO_BASE_URL=http://localhost:5173 FIXTURE_PATHS=/tmp/studio-fixture.webm pnpm --filter studio-headless scenario --timeout=600000
```

Add `SMOKE_STOP_AFTER_START=true` to stop right after auto build engages (what the PR smoke
workflow does) instead of waiting for the mocked build to finish. The `--timeout=600000` (10 min)
override is what the PR smoke workflow uses too — it makes a selector/drift failure fail fast
(well under the CI job's 20-min backstop, with time left for `run-summary.json` + the artifact
upload) instead of hanging; a real run against the live site omits it so `playwright.config.ts`'s
`timeout: 0` governs (per-phase expect timeouts, not a blanket ceiling that could cut off a real
multi-hour build).

### Real run (spends AI credits!)

```bash
STUDIO_BASE_URL=https://studio.j5s.dev VIDEO_URLS=https://…/recording.mp4 STUDIO_USER_EMAIL=… STUDIO_USER_PASSWORD=… pnpm --filter studio-headless scenario
```

## Setup notes

- **Firefox codec support**: the scenario runs on Firefox (`playwright.config.ts`). Firefox
  decodes VP8/Vorbis (WebM) natively, so mock-mode fixtures are WebM
  (`scripts/make-fixture.sh`, `-c:v libvpx -c:a libvorbis`) — no system codec packages
  required. The Firefox browser binary must still be installed for Playwright:
  `pnpm --filter studio-headless exec playwright install firefox`.
- **Fixture generation**: `scripts/make-fixture.sh [out-path]` (default
  `/tmp/studio-fixture.webm`) resolves an ffmpeg binary in order: `$FFMPEG_BIN` → `ffmpeg` on
  `PATH` → the `ffmpeg-static` devDependency (no system ffmpeg needed either way).
- Retries are disabled (`retries: 0`) — a retry would re-spend real AI credits against the live
  director/build pipeline in real mode.
- `workers: 1` — the scenario is a single end-to-end run, not a suite.
- Output (screenshots, `console.log`, `run-summary.json`, the JSON reporter output) is written to
  `output/`, which is gitignored.

## PR smoke check

`.github/workflows/studio-headless-smoke.yml` runs the scenario in mock mode
(`SMOKE_STOP_AFTER_START=true`) against a local dev server on every PR touching `apps/studio/**`.
It's a drift canary for the click-path (selectors, MSW mock shapes), not a build verifier — it
spends zero AI credits and never touches the real site.
