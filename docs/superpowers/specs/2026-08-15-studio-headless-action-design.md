# Studio headless runner as a reusable GitHub Action

**Date:** 2026-08-15 · **Status:** approved design, not yet implemented

## Problem

`apps/studio/headless/` drives a live Studio deployment end-to-end with Playwright
(import → prep → auto build → export). It already talks to Studio only over the
wire (`STUDIO_BASE_URL`, `data-testid` selectors, `/api/studio/job` poll traffic)
and imports nothing from `apps/studio/src`, but it is consumable only from inside
this monorepo: it is a pnpm workspace member, and the run workflow
(`.github/workflows/studio-headless-run.yml`) hardcodes install steps, the
job-summary script and the `apps/studio/headless/output` artifact path.
Someone who installed Studio from the app catalog cannot run it without
forking/ejecting.

## Goal

A user with an installed Studio can add one workflow file to any repo and run
unattended builds against their own deployment:

```yaml
- uses: bffless/apps/apps/studio/headless@studio-v1.4.0
  with:
    base-url: https://studio.example.com
    video-urls: ${{ inputs.video_urls }}
    user-email: ${{ secrets.STUDIO_USER_EMAIL }}
    user-password: ${{ secrets.STUDIO_USER_PASSWORD }}
```

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Consumption surface | GitHub Action only (no npm CLI) | The ask is "a workflow in another repo"; a CLI can be layered later. |
| Where it lives / versioning | Composite action **in the subdirectory** `apps/studio/headless/`, referenced as `bffless/apps/apps/studio/headless@studio-vX.Y.Z` | Runner and app are the same commit; the release-please `studio-v*` tag the user installed from is the ref they pin. No second repo, no `dist/`. |
| Scope | Batteries included: installs itself, picks browser, runs, writes job summary, uploads artifact, exposes outputs | "Add one file" story; outputs still allow chaining. |
| Mock / smoke mode | Stays in `config.ts` / spec, **not** exposed as action inputs | It's this repo's PR canary, not a consumer feature. |
| Version handshake | Not now | Follow-up: Studio ships `headless-contract.json`, action fails fast on mismatch. |

## Layout

```
apps/studio/headless/
├── action.yml            # NEW composite action
├── scripts/summary.mjs   # NEW: job summary + step outputs (moved out of the workflow YAML)
├── src/…                 # unchanged runner
├── playwright.config.ts  # unchanged
└── README.md             # + "Use as a GitHub Action" section with a starter workflow
```

## Inputs

Mirror the env vars 1:1 (`src/config.ts` is the source of truth for parsing).

| Input | Required | Default | Env |
| --- | --- | --- | --- |
| `base-url` | yes | | `STUDIO_BASE_URL` |
| `video-urls` | yes | | `VIDEO_URLS` |
| `user-email` | yes | | `STUDIO_USER_EMAIL` |
| `user-password` | yes | | `STUDIO_USER_PASSWORD` |
| `director-prompt` | no | `''` | `DIRECTOR_PROMPT` |
| `project-title` | no | `''` | `PROJECT_TITLE` |
| `thumbnail-prompt` | no | `''` | `THUMBNAIL_PROMPT` |
| `thumbnail-reference-url` | no | `''` | `THUMBNAIL_REFERENCE_URL` |
| `generate-blog` | no | `false` | `GENERATE_BLOG` |
| `blog-direction` | no | `''` | `BLOG_DIRECTION` |
| `browser` | no | `chrome` | `RUNNER_BROWSER` |
| `ffmpeg-mt` | no | `false` | `FFMPEG_MT` |
| `prep-timeout-minutes` | no | `30` | `PREP_TIMEOUT_MINUTES` |
| `director-timeout-minutes` | no | `10` | `DIRECTOR_TIMEOUT_MINUTES` |
| `build-timeout-minutes` | no | `90` | `BUILD_TIMEOUT_MINUTES` |
| `describe-timeout-minutes` | no | `5` | `DESCRIBE_TIMEOUT_MINUTES` |
| `thumbnail-timeout-minutes` | no | `10` | `THUMBNAIL_TIMEOUT_MINUTES` |
| `blog-timeout-minutes` | no | `15` | `BLOG_TIMEOUT_MINUTES` |
| `upload-artifact` | no | `true` | — |
| `artifact-name` | no | `studio-run-output` | — |

`MOCK_MODE`, `FIXTURE_PATHS`, `SMOKE_STOP_AFTER_START` are deliberately not inputs.

## Outputs

Read from `output/run-summary.json` by `scripts/summary.mjs`:
`ok`, `phase`, `project-url`, `project-id`, `title`, `description`, `output-dir`
(absolute path to `output/`).

## Composite steps

1. `pnpm/action-setup@v4` + `actions/setup-node@v4` (node 20). Inside the composite so the caller needs no toolchain setup.
2. `pnpm install --frozen-lockfile --filter studio-headless`, `working-directory: ${{ github.action_path }}`. GitHub clones the whole `bffless/apps` repo for a subdirectory action, so the workspace lockfile is present; `headless` has no `workspace:` deps so the filtered install skips Studio's tree.
3. Browser: nothing for Chrome (preinstalled on `ubuntu-latest`, used via `channel: 'chrome'`). When `browser == firefox`: `apt-get install ffmpeg` (H.264/AAC decode) + `playwright install firefox --with-deps`.
4. Run `pnpm scenario` with the env mapped from inputs, `working-directory: ${{ github.action_path }}`, `continue-on-error: true` (so summary + upload always run).
5. `node scripts/summary.mjs` (`if: always()`): appends the summary to `$GITHUB_STEP_SUMMARY`, writes outputs to `$GITHUB_OUTPUT`. Takes the output dir from env (`STUDIO_HEADLESS_OUT`), removing today's hardcoded `apps/studio/headless/output`.
6. `actions/upload-artifact@v4` of `output/` when `upload-artifact == 'true'` (`if: always()`).
7. Final step fails the action when the run step failed / `ok != true`.

Concurrency, `timeout-minutes` and the `workflow_dispatch` input block remain the
caller's responsibility (documented in the starter workflow; note the
`workflow_dispatch` 10-input cap).

## Dogfooding & docs

- `.github/workflows/studio-headless-run.yml` becomes a thin caller using the local-path form `uses: ./apps/studio/headless` (after `actions/checkout`). Its dispatch inputs are unchanged. This is the file the README tells others to copy, with `./apps/studio/headless` swapped for `bffless/apps/apps/studio/headless@studio-vX.Y.Z`.
- README section "Use as a GitHub Action": starter workflow, required secrets, how to pick the ref (the Studio version you installed), the `timeout-minutes` formula.
- `.github/workflows/studio-headless-smoke.yml` is unchanged (mock mode via pnpm).
- Release process unchanged: release-please already tags `studio-vX.Y.Z`.

## Testing

- Vitest: existing `config/download/jobs` tests + new `summary.test.ts` (summary → outputs mapping; missing/failed summary → `ok=false`, `phase=no-summary`).
- Static: `action.yml` validated (actionlint or schema check); a filtered install from a clean clone.
- Live: one dispatch of the rewritten run workflow on a short clip (spends AI credits — ask before dispatching), confirming outputs, summary and artifact.

## Follow-ups (out of scope)

- Version handshake (`headless-contract.json` served by Studio; fail fast on mismatch).
- npm CLI wrapper for local/agent use.
- Documenting the action in `bffless/skills` / the app catalog entry.
