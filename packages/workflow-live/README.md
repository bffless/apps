# @bffless/workflow-live

Live verification walks for the Workflow harness. Private — never published. This
package is the *taste-free gate* behind the `apps-live-walk` agent
(`.claude/agents/apps-live-walk.md`): a walk either proves a decision against a real
deployment or it fails, and nothing about the verdict comes from reading code. See
`docs/superpowers/specs/2026-08-30-apps-live-walk-design.md` for the design.

## Walks

| walk | proves | spends |
|---|---|---|
| `m1` | the M1 first-success checkpoint — `discovery.listsHello`, `run.succeededWithOutputs`, `page.noConsoleErrors`, `page.noFailedRequests` | nothing |
| `interactive` | the M2 Phase 3 walk, 27 checks (29 with `ADMIN_API_KEY`, which adds `whoami.apiKey` + `D7.adminApiKeyIs403`) named after the Decisions they prove (`D2.*`, `D5.*`, `D7.*`, `D8.*`, `D9.*`, `D14.*`, `M3.twoViewerIslands`, `P5.coverIsFileRef`, `renderers`, `whoami.*`, `run.*`, `apps362.download`) — see `src/walks/interactive.ts` | nothing |
| `hello` | Task 25 Step 1: `D5.helloDiscoveredViaForwarder`, `run.succeeded`, `D6.viewerImgIsPresigned`, `D6.noSignError`, `D4.scriptSandboxed`, `page.noConsoleErrors` | nothing |
| `headless` | Task 25 Step 2: `driver.exit0`, `driver.wroteRunJson`, the five `checkHeadlessHello` checks (`run.succeeded`, `run.headlessFlag`, `D7.islandSelfSubmitted`, `D11.reviewSkippedWithOutputs`, `run.posterIsFileRef`), `driver.savedPoster`, `driver.wrongTypeIsExit3`, and — with `--dispatch` — the same five re-scoped as `dispatch.*` plus `dispatch.jobGreen`, `dispatch.artifactHasRunJson`, `dispatch.savedPoster` | nothing (CI minutes with `--dispatch`) |
| `studio-audit` | Task 25 Step 3, as an *audit* of the by-hand run `run_01M17CG3W0YTA4T0ZVRTD88VE7` (`STUDIO_AUDIT_RUN`, override with `--run <id>` once that run is deleted — the walk then `BLOCK`s with a hint): `run.succeeded`, `R.scenesCarrySourceSpans`, `D2.sheetsDrawn`, `trim.keepRecorded`, `outputs.shortBlogCoverAreFileRefs`, `D16.wordsNotOffloaded`, `run.interactiveFlag` | nothing |
| `studio-headless` | Task 25 Step 4: the six common Studio checks (`checkStudioCommon`: `run.succeeded`, `R.scenesCarrySourceSpans`, `D2.sheetsDrawn`, `trim.keepRecorded`, `outputs.shortBlogCoverAreFileRefs`, `D16.wordsNotOffloaded`) plus `run.headlessFlag`, `D11.editSkippedWithPost`, `D11.pickSkippedWithCover`, `D7.trimAutoAccepted`, `driver.exit0`, `driver.wroteRunJson`, `driver.savedShort`, `driver.savedCover`, `driver.savedBlogZip` (`blog.zipHasFrames`) — not the `studio-audit` checks (that walk alone adds `run.interactiveFlag`) | **one Studio kickoff**: WhisperX, Gemini director + refiner, Claude describe/blog, nano-banana ×2 |

`all` runs `hello → headless → studio-audit → studio-headless` in that order, writing
each walk's `report.json`/`report.md` under `<out>/<name>/` rather than directly under
`<out>` (`src/cli.ts`), and stops at the first `BLOCKED` (a failed check does not stop
the sequence; a missing precondition does).

## Usage

```bash
source ~/.config/bffless/workflow-ci.env
pnpm workflow-live:walk hello --harness https://workflow.j5s.dev --out /tmp/walk-hello
```

Flags: `--harness <url>` (default `https://workflow.j5s.dev`), `--out <dir>` (default a
timestamped dir under the OS tmpdir), `--dispatch` (also drive the workflow through
GitHub Actions, `headless` walk only), `--run <id>` (`studio-audit`'s run to read;
defaults to `run_01M17CG3W0YTA4T0ZVRTD88VE7`, the by-hand 2026-08-29 run — only needed
once that run is deleted, at which point the walk `BLOCK`s with a hint to pass one),
`--clip <path>` (override the fixture clip), `--timeout <dur>` (driver timeout,
default `90m`).

## Env

`WORKFLOW_EMAIL`/`WORKFLOW_PASSWORD`, or the `WORKFLOW_CI_EMAIL`/`WORKFLOW_CI_PASSWORD`
aliases (the existing `~/.config/bffless/workflow-ci.env`) — missing either is a
`BLOCKED` walk, not a failed check. `ADMIN_API_KEY` is optional and only used for the
API-key 403 rows in `interactive`. `--dispatch` needs `gh auth status` to already be
authenticated.

## Exit codes

`0` every check passed · `1` at least one check failed · `2` `BLOCKED` — a precondition
was missing (credentials, harness unreachable, fixture absent, `gh` unauthenticated) or
the driver faulted (exit 2/4). A `BLOCKED` walk asserts nothing else.

## Reports

Every walk writes `<out>/report.json` (`{ walk, ok, harness, runIds, checks, spend,
started, finished, notes }`) and `<out>/report.md` (a checklist row per check, in the
READMEs' existing voice — `- [x] **<name> — PASS.** <evidence>`), plus any screenshots
and driver artifacts alongside them. Running `all` writes each walk's pair under
`<out>/<name>/` instead of directly under `<out>`.

## Fixture clip

`fixtures/onboarding-rules.mp4` (3.6 MB, committed, sha256-pinned in
`fixtures/onboarding-rules.sha256`) is the input `studio-headless` kicks off against —
a transcode of the by-hand run's real recording, chosen because a synthetic clip with
no spoken audio fails by design (apps#483). `ensureClip()` verifies the sha256 before
every kickoff, but only for the committed clip — a `--clip <path>` override is used
as-is, unverified — and only falls back to `gh release download
workflow-live-fixtures` when the committed file is missing from the checkout.

## The Studio cap

`studio-headless` allows at most **one Studio kickoff**, plus **one retry only after a
driver-fault exit (2 or 4)** — never after a run failure (exit 1). Exceeding the cap
reports `BLOCKED` rather than retrying again. See `test/studio-headless.test.ts` for
the enforced cases (no retry on exit 1; one retry on exit 2 that then succeeds; two
driver faults in a row caps at 2 kickoffs and blocks).

## Adding a walk

One file in `src/walks/`, registered in `src/walks/index.ts`'s `WALKS` map (and
`ALL_ORDER` if it belongs in `all`). Name checks after the Decision they prove (e.g.
`D7.trimAutoAccepted`) and keep names stable once shipped — this README's rows and any
report a human pastes cite them by name.
