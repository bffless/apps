# Workflow: driven runs — parked headless runs, resumed by a dispatched driver

**Date:** 2026-09-05 · **Tracker:** apps#598 · **Parent epic:** apps#554 (M5 agent embedding)
**Status:** design approved in conversation; awaiting spec review, then an implementation plan.

## Context

apps#598 parked "a server-side run driver" as the long-term direction: what would make
`workflow.start` over the MCP endpoint start a run, and what `on.schedule` / `on.webhook`
need. ADR-0005 rejected a server-side driver "for now" as a second engine runtime that
contradicts D11 ("the harness is always in a browser; headless = Playwright").

This design keeps D11 and ADR-0005's rejection intact. **There is no second engine.** The
driver is the existing Playwright driver (`@bffless/workflow-headless`) running on GitHub
Actions, dispatched by the harness's own rule set through CE's `github_api` handler. What
changes is that a headless run may **park** at a step that needs a person instead of failing,
and that a parked run can be **resumed by a fresh driver** from its rows.

Why not host a controller inside CE: `function_handler` is pure compute (no `fetch`, no
timers, 30 s cap — `apps/backend/src/pipelines/function-runner.service.ts` builds the sandbox
with `Math`/`Date`/`JSON`/`Promise` and nothing that reaches the network), and CE has no
"wake me in 3 s" primitive for a `polling` step, only minute-resolution cron
(`pipeline_schedules`). A browser controller already makes the pipeline calls and does the
polling. Why not an owned Node service: ADR-0005's "unowned operational unit" objection
stands. Why not a Playwright sidecar next to CE: CE stays app-agnostic (D22).

## What already exists (the design leans on all of it)

- The engine is pure and event-sourced (D10, spec 09): rows replay into state
  (`apps/workflow/src/lib/runner/replay.ts`), `nextActions` is a pure scheduler
  (`lib/runner/next.ts`), adapters emit events, `eventToWrites` turns events into row writes
  (`lib/runner/rows.ts`). The pipeline adapter takes injected `http`/`clock`
  (`lib/runner/adapters/pipeline.ts`).
- The run record, the lease and Resume are server-side already (spec 05): `workflow_runs`
  carries `lease_owner`/`lease_until` (60 s), a run whose tab goes away stays `running`,
  and whoever opens it with no live lease is offered Resume, which replays the rows and
  relaunches non-terminal steps (`apps/workflow/src/store/lifecycleActions.ts`, `adopt`).
- The headless driver opens `/<impl>/<workflow>/run?auto=1&inputs=<base64url>`
  (`packages/workflow-headless/src/run.ts:71`), the page validates through
  `lib/autoStart.ts` and creates the row, and the driver follows `window.__workflow` (spec 07).
- The endpoint's `workflow.submitStep` writes a person's answer server-side
  (`apps/workflow/src/mcp/reply.ts`); the row goes `waiting → succeeded`. Today nothing
  drives afterwards — that is the gap.
- `workflow.start`, `workflow.resume` and `workflow.cancel` are listed on the endpoint but
  not served (`src/mcp/reply.ts`, `NOT_SERVED`; spec 10 §"not served").
- `.github/workflows/workflow-headless-run.yml` already dispatches one headless run of
  `<impl>/<workflow>` with JSON inputs, and the `headless` live walk drives it with
  `--dispatch` (`packages/workflow-live/src/walks/headless.ts`).
- CE's `github_api` handler has a `dispatch` operation — a **`repository_dispatch`**
  (`POST /repos/{owner}/{repo}/dispatches` with `event_type` + `client_payload`;
  `apps/backend/src/pipelines/handlers/github-api.handler.ts` `dispatch()`). Its token is the
  project's **GitHub integration** (Project Settings → Integrations, `personalAccessToken`,
  read through `integrationsService.getActiveConfig(projectId, 'github')`), not a secret.
- apps#588 gives the driver a session from an app token (D23), so a job needs no relay login.

## Decisions

| # | Decision |
|---|---|
| DR1 | **No second engine.** The driver is `@bffless/workflow-headless` on GitHub Actions, in the implementation's repo. D11 and ADR-0005's rejection stand. |
| DR2 | **Park, don't fail.** With `wait=park`, an `island`/`form` step with no `headless:` declaration parks the run: the step row is `waiting`, the lease is released, the job exits 0. `headless: skip`/`auto` behave as today. Without `wait=park`, CI keeps `HEADLESS_REQUIRED` fail-fast. |
| DR3 | **The rows are the checkpoint.** A parked run is `running` with a `waiting` step and no live lease — no new column. Resume is the existing replay. |
| DR4 | **The browser owns what it claimed.** A person who resumes on the harness page drives to the end in their tab, exactly as today. No hand-back. |
| DR5 | **A server-side submit re-dispatches.** `workflow.submitStep` over the endpoint, after its write, calls `drive`, which dispatches a `resume` job for the run. |
| DR6 | **`drive` is a harness rule.** `POST /api/workflow/run/drive`, in the harness rule set, refuses on a terminal run or a live lease, then `github_api` sends a `repository_dispatch` (`event_type: workflow-drive`) to the implementation's repo. The GitHub token is the project's CE GitHub integration. |
| DR7 | **The implementation declares its driver in `index.json`**, generated by its CI (`driver: { repo }` — the file is fixed by convention, `workflow-drive.yml`), never hand-written. No `driver` ⇒ `drive` refuses with `NO_DRIVER` and `workflow.start` over the endpoint stays not served for that implementation. |
| DR8 | **The endpoint mints the run id.** `workflow.start` over the endpoint mints `run_<ulid>`, dispatches `run` with the id and the inputs, and answers `{ runId }` plus a `pending` snapshot. The page creates the row under the pre-minted id (`runId=` on the page contract). |
| DR9 | **Grace window.** After a park the driver releases the lease, polls the run row for `--grace` (default 5 min), and re-adopts in the same job if the waiting step is answered inside the window. A `drive` that lands during the window finds the lease taken on its re-adopt attempt and exits `busy` — a wasted minute, never a double drive. |
| DR10 | **Identity.** The job's app token is the member; a dispatched run's `started_by` is that member. `drive` runs as its caller (session or app token, scope `workflow:run`). |
| DR11 | **`on.schedule` / `on.webhook` are the same file later.** An Actions `schedule:` cron or a `repository_dispatch` on the implementation's driver workflow. Not built here; this design is what earns them. |

## Run lifecycle

```
                    drive(run)                      park                       drive(resume)
endpoint start ───────────────▶ Actions job ──────────────▶ rows: waiting ──────────────────▶ Actions job ──▶ … ──▶ terminal
                                (Playwright)                 no lease                          (Playwright)
                                                                 │
                                                                 ├── harness page: person resumes, tab drives to the end (DR4)
                                                                 └── step view / MCP: submitStep writes the row, calls drive (DR5)
```

States a driven run passes through, all on existing columns:

| moment | `workflow_runs.status` | waiting step row | lease |
|---|---|---|---|
| job driving | `running` | — | job's owner, heartbeat every 15 s |
| parked | `running` | `waiting` | released (`lease_owner` null) |
| grace window | `running` | `waiting` | released; driver polls the run |
| answered over the endpoint | `running` | `succeeded` (outputs written by `submitStep`) | released → `drive` dispatches |
| answered on the page | `running` → … | `succeeded` | the person's tab |
| resumed by a job | `running` | — | job's owner |

## Page contract (spec 07 additions)

Three query parameters, all additive to the existing `?auto=1&inputs=` start.

1. **`wait=park`** (kickoff, with `auto=1`). Changes one thing in the middleware's headless
   path (`lib/runner/headless.ts`, `HEADLESS_REQUIRED`): an interactive step with no
   `headless:` declaration is queued and mounted as it would be for a person, so the row
   reaches `waiting`; the page then clears the lease (the same `run/update` patch `rows.ts` writes
on `run.finished`, `lease_owner`/`lease_until` null — the status stays `running`) and publishes
   `status: 'parked'` on `window.__workflow`, with `currentSteps` naming the waiting keys.
   `parked` is a **page** state like `invalid`: no row ever carries it. The page stops the
   heartbeat and its scheduler; the island/form stays mounted so a person watching the tab
   can still answer (then the tab re-adopts as a Resume would).
2. **`runId=<run_ulid>`** (kickoff, with `auto=1`). `lib/autoStart.ts` passes the id to the
   `run.started` insert instead of minting one. The rule that inserts the run
   (`POST /api/workflow/runs`) refuses a duplicate id (`RUN_EXISTS`), which the page publishes
   as `status: 'invalid'`, `errors.runId`. Malformed ids (not `run_<26 ulid chars>`) are
   refused the same way.
3. **`resume=1`** (run page). The page adopts the lease without the confirm
   (`adopt(runId, owner, takeover = false)`) and relaunches non-terminal steps through the
   existing Resume path. A live lease held by someone else ⇒ `status: 'busy'` on the global
   (another page state), nothing driven. A terminal run ⇒ the page shows it and publishes its
   terminal status; the driver treats that as "nothing to do", exit 0.

`window.__workflow.status` gains `'parked' | 'busy'`. Both are page states, deliberately
absent from the persisted `RunStatus` vocabulary (05).

**`data-testid`s:** `run-status[data-state=parked|busy]` on the run page. Contract, as all
testids are (spec 07).

## The driver (`@bffless/workflow-headless`)

`run` gains two flags and one behaviour:

| flag | |
|---|---|
| `--wait <fail\|park>` | `fail` (default, today's CI behaviour) or `park` (adds `wait=park` to the start url) |
| `--run-id <run_ulid>` | pre-minted id (adds `runId=`) |
| `--grace <5m>` | after a park, how long to poll the run row for an answer before exiting (only with `--wait park`) |

New verb **`resume <harness> <runId>`**: log in (app token, apps#588; relay login stays the
fallback), open `/<impl>/<workflow>/run/<runId>?resume=1` (the impl/workflow come from the
run row, read first through `/api/workflow/run?id=`), then follow the global exactly as `run`
does — to terminal, or to a park, with the same `--grace`, `--timeout` and `--out` handling.

**Grace loop.** On `parked`: record the waiting keys, poll `GET /api/workflow/run?id=` every
10 s until `--grace` elapses. If every recorded waiting row is terminal (`succeeded` after a
`submitStep`, or `failed`/`cancelled`) and `lease_owner` is null, navigate with `resume=1`
and keep driving in the same job. If the lease is live (a person opened the page), exit 0
with `parked` — their tab owns it (DR4). If the window elapses, exit 0 with `parked`.

**Exit codes.** Existing codes stand (`EXIT` in `packages/workflow-headless/src/errors.ts`: 0 ok,
1 run failed, 2 usage, 3 refused start, 4 driver timeout, 130 interrupted). New: `parked` exits **0** with `run.json.status = 'parked'` and
the waiting keys; `busy` exits **5**. A parked run is not a failure: the job is green, the
artifact says where it stopped.

**Artifacts.** `run.json` gains `parkedOn: string[]` and `resumedFrom?: string` (the
dispatch that produced this job). Outputs are only saved on a terminal run, as today.

## The `drive` rule

`POST /api/workflow/run/drive` `{ id, mode: 'run' | 'resume', impl?, workflow?, inputs? }` — harness rule
set, `auth_required`, scope `workflow:run`. `resume` names an existing run; `run` carries a
pre-minted `id` plus the implementation, workflow and kickoff values for a run that has no row yet.

Pipeline: `data_query` the run row → `http_request` the implementation's `index.json` (in-process,
like the endpoint's `index` step) → `function_handler` gate → `github_api` dispatch → `response`.

Refusals (400, `{ code, message }`, the harness's usual shape):

| code | when |
|---|---|
| `RUN_NOT_FOUND` | `resume` and no row |
| `RUN_EXISTS` | `run` and a row already carries the id |
| `RUN_TERMINAL` | `status` ≠ `running` |
| `LEASE_LIVE` | `lease_until` in the future — a tab or a job is driving; nothing to dispatch |
| `NO_DRIVER` | the implementation's `index.json` has no `driver` |
| `DISPATCH_FAILED` | GitHub answered non-204, or the project has no GitHub integration (`GITHUB_NOT_CONFIGURED`); the body is echoed |

Success: `202 { dispatched: true, runId, repo, eventType: 'workflow-drive' }`. A `repository_dispatch`
always runs the workflow file at the repo's default branch, which is where `workflow-drive.yml` lives.

The implementation's `index.json` is read the way discovery reads it
(`/w/<alias>/.bffless/workflows/index.json`, spec 06); `driver` is
`{ "repo": "<owner>/<name>" }`, filled in by the publish step from `github.repository`; the
workflow file is `workflow-drive.yml` by convention. The GitHub token is the project's CE GitHub
integration (a fine-grained PAT with `contents: write` on the implementation repos — what
`repository_dispatch` needs); `github_api` reads it server-side, so it never reaches a browser. The
`client_payload` is `{ mode: 'resume', run_id, harness_url }` or
`{ mode: 'run', run_id, workflow, inputs, harness_url }` (`inputs` a JSON object; GitHub caps a
payload at ten top-level keys — five are used).

**Start over the endpoint (DR8).** `mcp-tools/start` becomes served when the implementation
has a `driver`: validate that the workflow exists and lints (the same `START_REFUSALS`
spellings, spec 10 §Refusals — the input *values* are still validated by the page, and an
invalid start surfaces as the job's exit 3 and no row), mint the id, call `drive`'s dispatch
path with `mode: 'run'`, and answer `{ runId, pending: true }` with a snapshot whose `status`
is `pending`. `workflow.status` on a run with no row yet answers the same `pending` snapshot
rather than `RUN_NOT_FOUND` for **10 minutes** after the mint (the id carries its time), so an
agent can poll or `workflow.await` through the cold start. `workflow.resume` over the endpoint
becomes `drive` by another name (same refusals). `workflow.cancel` stays not served: a
cancel needs an engine to stop, and a parked run has none — cancelling a parked run is a row
patch the page already knows how to make; a later item.

**Submit over the endpoint (DR5).** `mcp-tools/submitStep`, after its row write succeeds,
calls `drive` in-process and reports the outcome in its result text (`dispatched`, or the
refusal code — `LEASE_LIVE` is the normal case when a person's tab is on the run, and is
reported as "a page is driving this run", not as an error).

## The Actions workflow in the implementation repo

`workflow-drive.yml`, written into `workflow-<impl>` repos by `@bffless/workflow init` (a new
`drive.yml.tmpl` beside `deploy.yml.tmpl` and `preview.yml.tmpl` in
`packages/workflow-cli/src/templates/`); `index.json`'s `driver` is filled by the publish step
(`bffless/publish-workflow`, and `@bffless/workflow publish`) from `github.repository`. Modelled
on `.github/workflows/workflow-headless-run.yml`, but triggered by the event CE can send:

```yaml
on:
  repository_dispatch:
    types: [workflow-drive]
  # client_payload: { mode: run|resume, run_id, harness_url, workflow?, inputs? }
concurrency: { group: "drive-${{ github.event.client_payload.run_id }}", cancel-in-progress: false }
```

The job installs `@bffless/workflow-headless` and Chromium, writes `inputs` to a file through
the environment (never interpolated into `run:`), and runs either
`workflow-headless run <harness> <workflow> --inputs inputs.json --run-id <id> --wait park`
or `workflow-headless resume <harness> <id>`, with `WORKFLOW_APP_TOKEN` from the repo's
secrets. `run.json` is uploaded as the job artifact. The concurrency group is per run id, so
two dispatches for one run queue rather than race.

The same file is where `on.schedule` (an Actions `schedule:` block dispatching `mode: run`)
and `on.webhook` (`repository_dispatch`) will live (DR11).

## Identity and auth (DR10)

- The job's `WORKFLOW_APP_TOKEN` is a CE app token (D23): the run's `started_by` is that
  member, `run.headless = true`, and every row write the page makes carries that identity.
- `drive` is `auth_required` with scope `workflow:run` (added to `RULE_SCOPES` in
  `packages/workflow-agent-tools/src/scopes.ts`, which the rule-set fence test holds equal); a session is unscoped, an app token
  intersects with the member's permissions (D23). The step view's token therefore needs
  `workflow:run` to trigger a resume — the scope it already needs to submit.
- The GitHub token is the project's CE GitHub integration (Project Settings → Integrations). It
  is the one credential that must be provisioned by hand per instance (`install-app` verifies,
  never provisions, per its own contract); without it `drive` answers `DISPATCH_FAILED` with
  CE's `GITHUB_NOT_CONFIGURED` message.
- Nothing new reaches the browser: the page never sees the GitHub token, and the app token is
  the job's environment, as apps#588 specifies.

## Failure modes

| what | behaviour |
|---|---|
| dispatch accepted (204), job never starts (Actions outage, the file missing on the default branch) | `workflow.status` reads `pending` for 10 min, then `RUN_NOT_FOUND`; nothing was written. The agent re-issues `start`. |
| job dies mid-run (runner killed) | lease expires in 60 s; the run is `running` with no lease — Resume or `drive` from any surface. Same as a closed tab today. |
| `resume` finds a live lease | exit 5 `busy`; the row's driver keeps it. |
| two `drive`s for one run | the concurrency group queues the second; it then finds a live lease or a terminal run and exits 5 or 0. |
| person answers on the page during a grace window | the driver's next poll sees `lease_owner` set, exits 0 `parked`; the tab drives (DR4). |
| `submitStep` write succeeds, `drive` fails | the answer is recorded; the result text names the refusal; `workflow.resume` retries the dispatch. |
| the implementation has no `driver` | `start` not served (refusal names it), `submitStep` reports `NO_DRIVER`; the run waits for a person on the page, as today. |

## Docs

- **ADR-0006** "Driven runs: parked headless runs, resumed by a dispatched driver" — the
  decision table above; states that ADR-0005's rejection of a second engine runtime stands
  and that D11 is unchanged.
- **spec 00**: D24's "a server-side driver is the long-term direction" → "a *dispatched
  headless* driver resumes parked runs (ADR-0006)"; the §What this is not non-goal narrows
  from "no `on.schedule`/`on.webhook` without a browser" to "no engine outside a browser —
  schedules and webhooks dispatch a headless browser (ADR-0006)". D11 keeps its wording.
- **spec 01**: `on.schedule`/`on.webhook` move from "out of scope" to "later: dispatched
  through the implementation's driver workflow".
- **spec 05**: a paragraph under Resume: "a parked run is a `running` run with a `waiting`
  step and no lease; the driver's `resume` is a Resume".
- **spec 07**: the page contract additions (`wait=park`, `runId=`, `resume=1`, the new page
  states, the grace window, the exit codes); a "Driven runs" section.
- **spec 10**: `workflow.start`/`resume` served when the implementation declares a driver;
  `submitStep` dispatches; the `pending` snapshot.
- `packages/workflow-headless/README.md`: the `resume` verb and the new flags.
- apps#598 closes on the ADR landing; the build items are filed as issues from the plan.

## Testing

- **Unit (vitest, `apps/workflow`)**: `runnerMiddleware.headless.test.ts` gains the park
  path (undeclared interactive step under `wait=park` → `waiting` row, lease released,
  `parked` published; without the flag → `HEADLESS_REQUIRED` unchanged); `autoStart` with
  `runId=` (accepted, malformed, duplicate); `resume=1` adopt (granted, `busy`, terminal).
- **Endpoint (vitest, `src/mcp`)**: `start` mints and dispatches when `driver` exists, refuses
  otherwise; `status` answers `pending` inside the window; `submitStep` calls `drive` and
  reports each refusal code; `drive` rule fixtures for every refusal.
- **Driver (vitest, `packages/workflow-headless`)**: `resume` against the MSW mock harness
  (`--mocks`): to terminal, to park, `busy`; the grace loop with a scripted row change.
- **Live (`workflow-live`)**: a `driven` walk — `workflow.start` over the endpoint →
  `pending` → the dispatched job parks on hello's island → `submitStep` over the endpoint →
  a second job → terminal, asserting both jobs' `run.json` artifacts through the existing
  `--dispatch` machinery. Needs `gh` auth and the `hello` implementation repo carrying
  `workflow-drive.yml`.
- **Gates**: `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`,
  `pnpm --filter @bffless/workflow-headless test`, `pnpm workflow-live:walk driven`.

## Out of scope

- `on.schedule` / `on.webhook` themselves (DR11 says where they go).
- Cancelling a parked run over the endpoint.
- A self-hosted driver loop (`workflow-headless serve`): the same binary polling for runs
  wanting a driver, for instances without GitHub or with latency needs. The `drive` contract
  is written so that executor can replace the dispatch later.
- Running `script` steps anywhere but a browser (they already run in the driven job's
  browser — nothing changes for them).
- Any CE change. None is needed.
