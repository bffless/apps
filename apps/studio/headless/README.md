# studio-headless

A Playwright scenario that drives the real Studio app end-to-end — login, project creation,
media import, prep (per-source stages → director), and auto build — for unattended CI runs and
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
6. Waits for the autosave indicator to report `saved`.

Every wait targets a `data-testid` element's visibility or `data-state` attribute — no fixed
sleeps gate progress (a short poll interval is used only while stepping through prep stage
actions). On success or failure, `output/run-summary.json` is written from a `finally` block so a
failed run still reports the phase it reached and the project's resumable build URL. Milestone
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
| `PREP_TIMEOUT_MINUTES`      | no (default `30`)     | Ceiling per prep stage / per source file.                                    |
| `DIRECTOR_TIMEOUT_MINUTES`  | no (default `10`)     | Ceiling for the master director run.                                         |
| `BUILD_TIMEOUT_MINUTES`     | no (default `90`)     | Ceiling for the full auto build run.                                         |

See `src/config.ts` for the exact parsing/validation rules (`loadConfig`).

## Running it

### Mock mode (local dev server, no AI credits spent)

```bash
VITE_MOCK_STUDIO=true pnpm --filter studio dev &   # port 5173
MOCK_MODE=true STUDIO_BASE_URL=http://localhost:5173 FIXTURE_PATHS=/tmp/fixture.mp4 pnpm --filter studio-headless scenario
```

### Real run (spends AI credits!)

```bash
STUDIO_BASE_URL=https://studio.j5s.dev VIDEO_URLS=https://…/recording.mp4 STUDIO_USER_EMAIL=… STUDIO_USER_PASSWORD=… pnpm --filter studio-headless scenario
```

## Setup notes

- **Firefox codec support**: the scenario runs on Firefox (`playwright.config.ts`). System
  `ffmpeg` must be installed for H.264/AAC decode (`sudo apt-get install ffmpeg`), and the
  Firefox browser binary must be installed for Playwright:
  `pnpm --filter studio-headless exec playwright install firefox`.
- Retries are disabled (`retries: 0`) — a retry would re-spend real AI credits against the live
  director/build pipeline in real mode.
- `workers: 1` — the scenario is a single end-to-end run, not a suite.
- Output (screenshots, `console.log`, `run-summary.json`, the JSON reporter output) is written to
  `output/`, which is gitignored.
