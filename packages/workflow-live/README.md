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
| `hello` | Task 25 Step 1: `D5.helloDiscoveredViaForwarder`, `run.succeeded`, `D6.viewerImgIsPresigned`, `D6.noSignError`, `D4.scriptSandboxed`, `page.noConsoleErrors` — `D4.scriptSandboxed` is expected red until bffless/workflow-hello#5 merges and deploys (the `hello-pr-5` preview already carries the log line), so `walk hello`/`walk all` exit 1 until then | nothing |
| `headless` | Task 25 Step 2: `driver.exit0`, `driver.wroteRunJson` (failure-branch only), the five `checkHeadlessHello` checks (`run.succeeded`, `run.headlessFlag`, `D7.islandSelfSubmitted`, `D11.reviewSkippedWithOutputs`, `run.posterIsFileRef`), `driver.savedPoster`, `driver.wrongTypeIsExit3`, and — with `--dispatch` — the same five re-scoped as `dispatch.*` plus `dispatch.jobGreen`, `dispatch.artifactDownloaded`, `dispatch.artifactHasRunJson` (failure-branch only), `dispatch.savedPoster` | nothing (CI minutes with `--dispatch`) |
| `studio-audit` | Task 25 Step 3, as an *audit* of the by-hand run `run_01M17CG3W0YTA4T0ZVRTD88VE7` (`STUDIO_AUDIT_RUN`, override with `--run <id>` once that run is deleted — the walk then `BLOCK`s with a hint): `run.succeeded`, `R.scenesCarrySourceSpans`, `D2.sheetsDrawn`, `trim.keepRecorded`, `outputs.shortBlogCoverAreFileRefs`, `D16.wordsNotOffloaded`, `run.interactiveFlag` | nothing |
| `studio-headless` | Task 25 Step 4: the six common Studio checks (`checkStudioCommon`: `run.succeeded`, `R.scenesCarrySourceSpans`, `D2.sheetsDrawn`, `trim.keepRecorded`, `outputs.shortBlogCoverAreFileRefs`, `D16.wordsNotOffloaded`) plus `run.headlessFlag`, `D11.blogReviewSkippedWithPost`, `D11.coverFormsSkipped`, `cover.rendered`, `D7.trimAutoAccepted`, `driver.exit0`, `driver.wroteRunJson` (failure-branch only), `driver.savedShort`, `driver.savedCover`, `driver.savedBlogZip` (failure-branch only), and on the saved zip `blog.zipHasFrames` + `blog.zipHasOnePost` (`blog.zipReadable`, failure-branch only) — not the `studio-audit` checks (that walk alone adds `run.interactiveFlag`) | **one Studio kickoff**: WhisperX, Gemini director + refiner, Claude describe/blog, nano-banana ×2 |
| `page-tools` | the M5 Phase-1 gate (spec 10, D19–D21; apps#554): `hello/interactive` driven end to end through the page's WebMCP tools alone — `D21.onlyWorkflowTools`, `D19.readOnlyHints`, `D19.listsHello`, `D20.describeInteractive`, `spec07.refusalVerbatim`, `D21.startNavigates`, `spec10.awaitWaitingIsland`, `D21.submitIslandStep`, `spec10.awaitWaitingForm`, `D21.submitFormStep`, `run.succeeded`, `D6.signIsPresigned`, `spec10.runsListsIt`, `record.matchesPage` (asserted on the `run.json` it writes), then a second run for `D21.resumeAdopts` (after a reload) and `D21.cancelIsCancelled`, and `page.noConsoleErrors` — see `src/walks/page-tools.ts`. Not part of `all` | two hello runs (nothing metered) |
| `mcp` | the M5 Phase-2 walk (spec 10, D19/D22/D23; apps#554 stories 5–6): the MCP endpoint over the official SDK's stateless Streamable HTTP — `D22.getIs405`, `D22.initialize`, `D19.toolsListParity` (the catalog byte for byte), `spec10.appOnlyHidden`, `D19.listsHello`, `D20.describeInteractive`, `spec10.runsRequiresImpl`, `spec10.statusRequiresRunId`, `spec10.outputsOfRun`, `D6.signIsPresigned`, `spec10.notServedHonest`, `spec10.resourcesList` (CSP derived from the instance), `D22.unknownMethod`; then the Story 6 island round trip — `spec10.parkIsland` (a `hello/interactive` run parked on its island **through the page tools**, the browser then closed), `spec10.leaseLapses`, `spec10.resourcesReadIsland`, `spec10.cspDerived`, `spec10.stepViewMounts`, `spec10.pipelineFenced`, `spec10.annotateWrites`, `spec10.submitRefusesBad`, `spec10.submitWrites`, `record.stepSucceeded` (with `ADMIN_API_KEY`; the snapshot stands in without), `spec10.submitTwiceRefused` — then (Phase 3 story 7) `D23.bearerIsMember` (anonymous `initialize` → 401; `workflow.runs` shows the parked run `startedBy` the signed-in member) and `D23.readOnlyCannotSubmit` (a `workflow:read`-only token's `workflow.submit` → `errors.scope` naming `workflow:run`; its `workflow.status` still answers) — see `src/walks/mcp.ts`. The endpoint runs as the caller: the walk signs in through the relay, mints two app tokens through that browser context (`admin.<domain>/api/app-tokens`, 1 day, revoked at the end) and sends the first as `Authorization: Bearer`; `WORKFLOW_APP_TOKEN` skips the mint. The member credentials are needed for the mint and the park. `--run <id>` skips the park; `--park-only` parks, prints the run id and stops (how a person hands a fresh run to claude.ai). Not part of `all` | one hello run, left `running` with its island submitted |
| `oauth` | the M5 Phase-3 walk (spec 10, D23 rung 3; apps#554 story 9): claude.ai's connector flow, headless — `D23.prmServed` (the harness's `/.well-known/oauth-protected-resource` and CE's RFC 8414 metadata), `D23.anon401Hints` (an anonymous `initialize` → 401 with `resource_metadata`), `D23.dcr` (RFC 7591 registration), `D23.consentGrants` (the signed-in member's browser lands on `/oauth/consent`, three checkboxes, Allow → the local callback with the state), `D23.tokenIsAppToken` (`bfat_…`, 3600 s, a refresh token), `D23.statusAsMember` (a run parked through the page tools reads back through the token with `startedBy` the member), `D23.refreshRotates` (a new pair; the old refresh token → `invalid_grant`), `D23.narrowedConsent` (untick `workflow:run` + `workflow:files` → the token's `workflow.submit` is refused naming `workflow:run`; `workflow.status` still answers), `D23.revoke` (RFC 7009 → the next call is 401). Needs the member credentials and CE ≥ the story-9 release. Not part of `all` | one hello run, left waiting on its island |
| `mcp-app` | the M5 Phase-4 walk (spec 10, D24 as amended; apps#554 stories 10–11, apps#586): the served step view (`ui://bffless/workflow/step-view.<rev>.html`, read off `tools/list`) mounted in an **emulated MCP Apps host** (`src/host-emu.ts`: a sandboxed frame, `document.write`, `ui/initialize` answered, `tools/call` proxied with the walk's Bearer token) — `D24.parkIsland`, `D24.stepViewUriIsRevisioned`, `D24.hostHandshake`, `D24.islandMountsInHost`, `D24.islandSubmitsThroughBridge`, then a second run parked on its `review` form: `D24.parkForm`, `D24.formRendersInHost`, `D24.formRefusesBlankRequired`, `D24.formSubmitsThroughBridge`, and `D24.runResumesOnHarness` (the harness page's Resume finishes the run the widget advanced). `--park-only` parks on the form and prints the id (the person's claude.ai gate). Not part of `all` | two hello runs (one left `running` after its island; one completed) |

`all` runs `hello → headless → studio-audit → studio-headless` in that order, writing
each walk's `report.json`/`report.md` under `<out>/<name>/` rather than directly under
`<out>` (`src/cli.ts`), and stops at the first `BLOCKED` (a failed check does not stop
the sequence; a missing precondition does).

## Usage

```bash
source ~/.config/bffless/workflow-ci.env
pnpm workflow-live:walk hello --harness https://workflow.j5s.dev --out /tmp/walk-hello
pnpm workflow-live:walk page-tools --harness https://workflow.j5s.dev --out /tmp/walk-page-tools
pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp
pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --park-only --out /tmp/park   # a run parked on its island for claude.ai
pnpm workflow-live:walk mcp-app --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp-app
pnpm workflow-live:walk mcp-app --harness https://workflow-mcp.j5s.dev --park-only --out /tmp/park   # a run parked on its form for claude.ai
pnpm workflow-live:walk oauth --harness https://workflow.j5s.dev --out /tmp/walk-oauth            # the Phase-3 gate's automatable half
```

Flags: `--harness <url>` (default `https://workflow.j5s.dev`), `--out <dir>` (default a
timestamped dir under the OS tmpdir), `--dispatch` (also drive the workflow through
GitHub Actions, `headless` walk only — dispatches `main`'s `workflow-headless-run.yml`
and `main`'s driver — never this branch's), `--run <id>` (`studio-audit`'s run to read;
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
was missing (credentials, harness unreachable, fixture clip missing or sha-mismatched, `gh` unauthenticated) or
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
as-is, unverified. The committed file is the only source: there is no download
fallback, and a checkout where it is missing or its sha256 does not match the pin
`BLOCK`s the walk (`fixture clip missing: …` / `fixture clip sha256 mismatch: …`)
instead of fetching anything.

## The Studio cap

`studio-headless` allows at most **one Studio kickoff**, plus **one retry only after a
driver-fault exit (2 or 4)** — never after a run failure (exit 1). Exceeding the cap
reports `BLOCKED` rather than retrying again. See `test/studio-headless.test.ts` for
the enforced cases (no retry on exit 1; one retry on exit 2 that then succeeds; two
driver faults in a row caps at 2 kickoffs and blocks).

## Deferred by design

Known limits of what the walks prove, recorded here rather than carried as issues
(from apps#496):

- **`D6.viewerImgIsPresigned` would false-FAIL on a local-FS harness.** The check
  expects a presigned storage URL; a CE instance on local filesystem storage presigns
  on its own origin, so the `hello` walk is only meaningful against a bucket-backed
  deployment such as `workflow.j5s.dev`.
- **A legitimately frameless blog post FAILs `blog.zipHasFrames` by spec.** The Studio
  contract says a headless blog ships its frames; a post that genuinely needed none
  reads as a failure, and the walk does not try to tell the two apart.
- **`--dispatch` always runs `main`'s `workflow-headless-run.yml`, never the branch's.**
  The dispatch path proves CI end to end, but for `main`'s workflow and `main`'s
  driver — a change to either on a branch is only exercised after it merges.

## Adding a walk

One file in `src/walks/`, registered in `src/walks/index.ts`'s `WALKS` map (and
`ALL_ORDER` if it belongs in `all`). Name checks after the Decision they prove (e.g.
`D7.trimAutoAccepted`) and keep names stable once shipped — this README's rows and any
report a human pastes cite them by name.
