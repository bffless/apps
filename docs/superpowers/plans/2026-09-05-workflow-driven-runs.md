# Workflow driven runs — parked headless runs, resumed by a dispatched driver — Implementation Plan (apps#598)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Apps-only: **no CE change is needed** (the spec's §Out of scope).

**Goal:** Make `workflow.start` over the MCP endpoint start a run, and make a run that a person answers in claude.ai continue to the end — without a second engine. A headless run may **park** at a step that needs a person; a server-side submit **re-dispatches** the existing Playwright driver, which resumes the run from its rows.

**Architecture:** D11 stands: the harness is always in a browser, and the driver is `@bffless/workflow-headless` on GitHub Actions. Four additive pieces. (1) The page contract gains `wait=park` (an undeclared `island`/`form` parks the run instead of `HEADLESS_REQUIRED`: row `waiting`, lease cleared, `window.__workflow.status = 'parked'`), `runId=` (a pre-minted id) and `resume=1` (adopt without the confirm; `busy` when the lease is held). (2) The driver gains `--wait park`, `--run-id`, `--grace` and a `resume <runId>` verb; parked exits 0, busy exits 5. (3) A harness rule `POST /api/workflow/run/drive` reads the implementation's `index.json` `driver.repo` and sends a `repository_dispatch` (`event_type: workflow-drive`) through CE's `github_api` handler, whose token is the project's GitHub integration; the endpoint's `workflow.start` and `workflow.resume` become served by calling it, and `workflow.submitStep` calls it after its write. (4) The implementation repo carries `workflow-drive.yml` (`repository_dispatch` → the driver), written by `@bffless/workflow init`; `index.json`'s `driver` is filled by the publish step.

**Tech Stack:** TypeScript · React 19 + Redux Toolkit (the harness) · Vitest + MSW (`src/mocks`) · esbuild IIFE bundles for CE's `function_handler` (`scripts/build-mcp.mjs`, `bundle.test.ts` sandbox) · Playwright 1.61 (`workflow-headless`, `workflow-live`) · CE ≥ v0.4.48 on j5s (`mcp_handler`, app tokens) · CE's `github_api` handler (`repository_dispatch`) · GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-workflow-driven-runs-design.md` (DR1–DR11; this plan argues from it) · `apps/workflow/docs/spec/07-headless.md` (the page contract this extends) · `apps/workflow/docs/spec/05-runs-and-persistence.md` §Resume · `apps/workflow/docs/spec/10-agent-embedding.md` (§"not served", D24) · `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` (the rejection that stands) · apps#598 (tracker), apps#554 (parent epic), apps#588 (the app-token session — the driver's credential).

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **`park` is page state, carried on `RunMeta`, never on a row.** `RunMeta.park?: boolean` (runSlice) is set from `?wait=park` by the kickoff page and by a `?resume=1&wait=park` adoption; the middleware reads it off the slice. A resumed run therefore parks again at its next undeclared step only if the *driver* asked (the person's tab never sets it), which is DR4.
2. **`parked` is a third `RunMode`.** `RunMode = 'live' | 'readonly' | 'parked'`. Everything that tests `mode === 'live'` keeps its meaning; the only site that tests `'readonly'` by name (`lifecycleActions.adopt`'s clobber guard) treats `parked` the same. The run page's `ResumeBanner` shows for both, so a person watching a parked tab sees Resume.
3. **Park detection is one predicate after the schedule pass.** A live headless run with `meta.park` parks when `nextActions` proposed nothing, the run is still `running`, no step is `queued`/`running`/`polling`, and at least one `waiting` step declares no `headless:` (`headlessMode(step) === undefined`). A run whose only waiting steps are `auto` is self-driving and does not park. Parking = stop the heartbeat, clear the lease with the same `run/update` patch `run.finished` uses, `loseLease` (abort controllers, dispose islands, disarm clocks), then `runParked`.
4. **A parked step gets no default budget.** `waitBudgetMs(step, headless)` is armed with `headless = state.headless && headlessMode(decl) !== undefined` — the 5-minute `HEADLESS_AUTO_DEFAULT_MS` exists for `auto` steps nobody watches; a parked step waits for a person. A declared `timeout-minutes` still applies. The island's `hostContext.bffless.headless` flag is unchanged: an island without `headless:` has no self-submit contract to trigger.
5. **A headless form never auto-submits unless it declared `auto`.** Today `runState.headless` alone triggers `autoSubmitForm`, because an undeclared form could never reach that line. With park it can, so the condition becomes `headlessMode(step) === 'auto' && (runState.headless || unattendedStep(scope))`.
6. **The pre-minted id is checked before the start, and refused by the rule as a backstop.** The kickoff page reads `GET /api/workflow/run?id=<runId>` and publishes `invalid` (`errors.runId`) when a row exists; the `runs/post` rule additionally answers `409 RUN_EXISTS` on a duplicate so a race becomes the persistence-pause banner rather than two rows. Ids must match `run_` + 26 Crockford-base32 chars.
7. **`drive` is one rule, called in-process by the tool rules.** `POST /api/workflow/run/drive { id, mode: 'run'|'resume', impl?, workflow?, inputs? }`. `workflow.start` → `mode: 'run'` with a run id the endpoint's `plan` step mints (`Math.random` ULID — an id, not a secret); `workflow.resume` and the post-write half of `workflow.submitStep` → `mode: 'resume'`. The tool rules reach it through the same `http()` step shape as `pipelinePost` (in-process, `forwardAuth`, `failOnError: false`), so the caller's credential and scope are what `drive` runs as.
8. **`drive`'s two functions are bundles, not hand-written.** `src/mcp/drivePlan.ts` (before the index fetch: the run row's or the body's `impl`, the index URL through `siblingBaseOf`) and `src/mcp/driveGate.ts` (after: every refusal, the `client_payload`) join `ENTRIES` in `scripts/build-mcp.mjs`, so `bundle.test.ts` sandboxes them like `route`/`plan`/`merge`/`reply`. The rule YAML itself is hand-written like `run/lease/post/rule.yaml`.
9. **A GitHub failure is CE's own error.** The `github_api` step has no `failOnError`; a non-204 or `GITHUB_NOT_CONFIGURED` fails the pipeline and the caller sees CE's step error as `DISPATCH_FAILED`. No third function step to relay it.
10. **`workflow.cancel` stays not served** (spec §The `drive` rule). `NOT_SERVED` shrinks to `{ 'workflow.cancel' }`.
11. **The catalog's words change, so `@bffless/workflow-agent-tools` releases.** `workflow.start` and `workflow.resume` descriptions say what the endpoint now does; the `mcp` walk's `toolParity` holds `tools/list` byte-equal to the catalog, so the endpoint rules regenerate in the same PR.
12. **Cross-repo work is a checklist task, not a story.** `bffless/publish-workflow` (an input `driver-repo`, default `github.repository`), `bffless/workflow-implementations` (`.github/workflows/workflow-drive.yml`, a `hello/driven` workflow with an undeclared form, the `WORKFLOW_APP_TOKEN` secret) and the CE GitHub integration on the `bffless/workflow` project are the person's (Task 16). The `driven` live walk is written here and gated on them; every unit and MSW proof lands without them.
13. **Branching.** An epic branch `epic/driven-runs` off `main` with a draft master PR; four story PRs stacked into it; the epic→main squash is the person's, with a release-notes override in the PR body (memory *release-please override lives in the PR body*).

## Deferred out of this plan, explicitly

- `on.schedule` / `on.webhook` (DR11: an Actions `schedule:` block / a second `repository_dispatch` type on `workflow-drive.yml`).
- Cancelling a parked run over the endpoint.
- A self-hosted `workflow-headless serve` loop.
- A driver-repo declaration that is not `github.repository` (an implementation whose driver runs elsewhere).
- `workflow.await` over the endpoint.

## Global Constraints

- **Worktrees only, under `.claude/worktrees/`** (memory *use worktrees in repos/apps*). Every story branches off `origin/epic/driven-runs`: `git worktree add .claude/worktrees/<name> -b <branch> origin/epic/driven-runs`, then `pnpm install --frozen-lockfile` and `pnpm workflow-lint:build && pnpm workflow-cli:build && pnpm workflow-agent-tools:build && pnpm workflow-headless:build && pnpm workflow-live:build` (a fresh worktree's `apps/workflow` suites fail with `Failed to resolve import "@bffless/workflow-lint/expressions"` until `workflow-lint` is built), then `pnpm --filter workflow stage` (hello-dist, needed by `test:stage`). Never switch the shared checkout `repos/apps`. Never bare `git stash`.
- **Branching:** PRs target `epic/driven-runs`, never `main`. Stacked: PR B bases on PR A's branch until A merges, then `git rebase --onto origin/epic/driven-runs <old-base-tip>` + `--force-with-lease` (CLAUDE.md squash-merge rule). Read the automated review comments on **every** push before merging.
- **PR titles are release commits** (`.claude/apps-pr-review-checklist.md` §3): `docs(workflow): the driven-runs plan — parked headless runs, resumed by a dispatched driver (#598)` · `feat(workflow): the page parks a headless run at a step that needs a person, and resumes on ?resume=1 (#598)` · `feat(workflow-headless): --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up (#598)` · `feat(workflow): the drive rule and index.json's driver — workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches (#598)` · `docs(workflow): ADR-0006 driven runs, the driven walk, workflow-drive.yml (#598)`. **Never edit a `CHANGELOG.md`.**
- **Verification chain per PR** (checklist §4–§7): `pnpm --filter @bffless/workflow-lint build && pnpm --filter @bffless/workflow-lint test:run` when lint changes; `pnpm --filter @bffless/workflow-agent-tools lint && … build && … test:run` when the catalog changes; `pnpm --filter @bffless/workflow lint && … build && … test:run` when the CLI changes; `pnpm --filter workflow mcp:build` then `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build` for the app (Vitest does not typecheck — `build` is part of the chain); `pnpm --filter @bffless/workflow-headless lint && … build && … test:run`; `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`; `pnpm apps:check`; real counts pasted in the PR body. `.github/workflows/workflow-app.yml` runs exactly these.
- **Live targets, ask-first.** `workflow` has no PR preview deploy; its rules and alias go live **on merge to main** (checklist §1; memory *workflow app rules land on merge only*). The new `run/drive` rule and the regenerated `mcp-tools/*` rules are therefore merge-time live writes on `bffless/workflow` (j5s). Walks run first against the scratch project `bffless/workflow-mcp` (`https://workflow-mcp.j5s.dev`, redeploy per `apps/workflow/bffless/README.md`, key in `~/.config/bffless/workflow-mcp.env`, act-and-report); **any deploy of `workflow.j5s.dev` or live change to `bffless/workflow` is ask-first.** `mcp` must stay 26/26, `oauth` 9/9. j5s only; no bffless.dev.
- **Sandbox-safety of the bundles:** every function the rules run is an esbuild IIFE that must pass `bundle.test.ts` (CE's `PROHIBITED_PATTERNS` scan; a `node:vm` run with no `URL`, `TextEncoder`, `Buffer`, `crypto`, `globalThis`). A ULID minted in a bundle uses `Math.random` and `Date.now` only.
- **Pipeline `condition`s are simple paths** (memory): every gate is a boolean the preceding function step computed.
- **The catalog owns every tool's words** (D19). **Text-only host rule:** every tool result's `text` stands alone.
- **`data-testid`s and `window.__workflow` are contracts** (spec 07): additive only.

## File structure

```
apps/workflow
  src/store/runSlice.ts                       RunMeta.park; RunMode 'parked'; runParked()                                (Task 1)
  src/store/runnerActions.ts                  StartRunArgs.park / .runId                                                  (Tasks 1, 2)
  src/store/runnerMiddleware.ts (+ .park.test.ts)   headlessDecision(scope, park); parkIfIdle; the form auto-submit and wait-clock conditions   (Task 1)
  src/lib/workflowGlobal.ts                   status 'parked' | 'busy'                                                     (Tasks 1, 3)
  src/pages/RunPage.tsx                       publishes parked/busy; ?resume=1 auto-adopt                                 (Tasks 1, 3)
  src/lib/autoStart.ts (+ .test.ts)           parseRunIdParam, RUN_ID_PATTERN                                             (Task 2)
  src/pages/KickoffPage.tsx                   ?wait=park, ?runId=, the exists check                                       (Tasks 1, 2)
  src/store/lifecycleActions.ts (+ .test.ts)  openRun/takeOver carry park; the clobber guard knows 'parked'               (Tasks 1, 3)
  src/mocks/handlers.ts (+ handlers.test.ts)  POST /api/workflow/runs → 409 RUN_EXISTS on a duplicate                     (Task 2)
  .bffless/proxy-rules/workflow/rules/api/workflow/runs/post/{rule.yaml,exists.fn.js}   the 409 backstop                   (Task 2)
  src/lib/coerce.ts (+ .test.ts)              Implementation.driver                                                       (Task 8)
  src/mcp/drivePlan.ts, driveGate.ts (+ drive.test.ts)   the drive rule's two bundles                                     (Task 10)
  .bffless/proxy-rules/workflow/rules/api/workflow/run/drive/post/rule.yaml   the drive rule                              (Task 10)
  src/mcp/ids.ts (+ .test.ts)                 mintRunId, runIdTime                                                        (Task 11)
  src/mcp/route.ts, plan.ts, reply.ts, mcpConfig.ts (+ tests)   start/resume served; submitStep dispatches; pending    (Task 11)
  scripts/build-mcp.mjs                       ENTRIES + drivePlan/driveGate; the `drive` step; TOOL_STEPS                 (Tasks 10, 11)
  .bffless/proxy-rules/workflow/{mcp-fn/*.fn.js, rules/api/workflow/mcp/any.rule.yaml, rules/api/workflow/mcp-tools/**}   regenerated   (Task 11)
  docs/adr/0006-driven-runs.md                new                                                                         (Task 15)
  docs/spec/{00-overview,01-workflow-yaml,05-runs-and-persistence,07-headless,10-agent-embedding}.md   amended          (Tasks 4, 12, 15)
  CONTEXT.md                                  "Driven run", "Park"                                                        (Task 15)
packages/workflow-agent-tools
  src/scopes.ts (+ test)                      RULE_SCOPES 'workflow/run/drive/post'                                       (Task 10)
  src/catalog.ts (+ test)                     start/resume descriptions                                                   (Task 11)
packages/workflow-lint
  src/index/index.ts (+ test/index.test.ts)   IndexJson.driver, BuildIndexArgs.driver                                     (Task 8)
packages/workflow-cli
  src/index-bundle.ts, src/cli.ts (+ test)    --driver-repo                                                               (Task 8)
  src/templates/drive.yml.tmpl, src/verbs/init.ts (+ test/init.test.ts)   .github/workflows/workflow-drive.yml            (Task 9)
packages/workflow-headless
  src/errors.ts, args.ts, observe.ts, run.ts, resume.ts, cli.ts, index.ts (+ test/*)   the driver half                    (Tasks 5, 6)
  README.md                                                                                                               (Task 7)
packages/workflow-live
  src/walks/driven.ts, walks/index.ts, args.ts, README.md   the driven walk                                              (Task 14)
docs/superpowers/plans/2026-09-05-workflow-driven-runs.md   this plan                                                     (Task 0)
```

## Traceability — spec → tasks

| spec section | tasks |
|---|---|
| DR2/DR3 park; page contract `wait=park`, `parked` | 1, 4 |
| page contract `runId=`; DR8 half (the page inserts under the id) | 2 |
| page contract `resume=1`, `busy`; DR4 | 3 |
| the driver (`--wait`, `--run-id`, `--grace`, `resume`, exit codes, artifacts); DR9 grace | 5, 6, 7 |
| DR7 `index.json` `driver`; `@bffless/workflow init` template | 8, 9 |
| DR6 the `drive` rule, its refusals, scope | 10 |
| DR5/DR8 the endpoint: `start`, `resume`, `submitStep` dispatch, `pending`; DR10 identity | 11, 12 |
| the Actions workflow in the implementation repo; the `driven` walk | 13, 14 |
| §Docs (ADR-0006, spec 00/01/05/07/10, READMEs) | 4, 7, 15 |
| §Failure modes, §Identity, cross-repo provisioning | 16 |

---

### Task 0: the plan PR, the epic branch and its master PR

**Files:**
- Create: `docs/superpowers/plans/2026-09-05-workflow-driven-runs.md` (this file)

- [ ] **Step 1: Create the epic branch off main and the draft master PR**

```bash
cd /home/rico/bffless/repos/apps
git fetch origin
git push origin origin/main:refs/heads/epic/driven-runs
gh pr create --draft --base main --head epic/driven-runs --label epic --title "feat(workflow): driven runs — parked headless runs, resumed by a dispatched driver (#598)" --body-file - <<'EOF'
Epic branch for apps#598. Story PRs stack into this branch; this PR merges to main when the last one lands.

Spec: docs/superpowers/specs/2026-09-05-workflow-driven-runs-design.md · Plan: docs/superpowers/plans/2026-09-05-workflow-driven-runs.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: a draft PR URL. (An empty diff is fine for a draft; GitHub allows it once the first story merges into the branch.)

- [ ] **Step 2: Rebase the spec worktree onto the epic and open the docs PR**

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/workflow-driven-runs-spec
git rebase origin/epic/driven-runs
git add docs/superpowers/plans/2026-09-05-workflow-driven-runs.md
git commit -m "docs(workflow): the driven-runs plan — parked headless runs, resumed by a dispatched driver (#598)"
git push -u origin worktree-workflow-driven-runs-spec
gh pr create --base epic/driven-runs --title "docs(workflow): the driven-runs plan — parked headless runs, resumed by a dispatched driver (#598)" --body-file - <<'EOF'
The design (spec) and the implementation plan for apps#598: no second engine — a headless run parks at a step that needs a person, and a server-side submit re-dispatches the Playwright driver through CE's github_api (repository_dispatch) to resume it from its rows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: a PR URL. Story branches base on the epic tip, not on this branch.

---

## Story A — the page contract (PR A, branch `feat/driven-page-contract`, worktree `.claude/worktrees/driven-page-contract`)

*Deliverable: with `?auto=1&wait=park`, an undeclared interactive step parks the run (row `waiting`, lease cleared, `status: 'parked'` on the global); `?runId=` pre-mints the row's id; `?resume=1` adopts without a click and publishes `busy` when the lease is held. Verified by the middleware's MSW-backed suites and the page tests.*

Setup once:

```bash
cd /home/rico/bffless/repos/apps
git fetch origin && git worktree add .claude/worktrees/driven-page-contract -b feat/driven-page-contract origin/epic/driven-runs
cd .claude/worktrees/driven-page-contract
pnpm install --frozen-lockfile
pnpm workflow-lint:build && pnpm workflow-cli:build && pnpm workflow-agent-tools:build && pnpm workflow-headless:build && pnpm workflow-live:build
pnpm --filter workflow stage
pnpm workflow:test        # baseline — paste the count into the PR body
```

### Task 1: `wait=park` — the run parks instead of failing `HEADLESS_REQUIRED`

**Files:**
- Modify: `apps/workflow/src/store/runSlice.ts` (`RunMeta`, `RunMode`, a `runParked` reducer)
- Modify: `apps/workflow/src/store/runnerActions.ts` (`StartRunArgs.park`)
- Modify: `apps/workflow/src/store/runnerMiddleware.ts` (`headlessDecision`, the form auto-submit condition at the `else if (step.uses === 'form')` branch, the `armWaitClock` call, a `parkIfIdle` after the schedule pass)
- Modify: `apps/workflow/src/store/lifecycleActions.ts` (`adopt`'s guard; `metaFrom` carries `park`)
- Modify: `apps/workflow/src/lib/workflowGlobal.ts`, `apps/workflow/src/pages/RunPage.tsx`, `apps/workflow/src/pages/KickoffPage.tsx`
- Test: `apps/workflow/src/store/runnerMiddleware.park.test.ts` (new), `apps/workflow/src/store/runSlice.test.ts`

**Interfaces:**
- Produces: `RunMeta.park?: boolean`; `RunMode = 'live' | 'readonly' | 'parked'`; `runParked()` action; `StartRunArgs.park?: boolean`; `WorkflowGlobal.status: RunStatus | 'invalid' | 'parked' | 'busy'`; `openRun`/`takeOver` accept `park?: boolean` (used by Task 3).

- [ ] **Step 1: Write the failing middleware test**

`apps/workflow/src/store/runnerMiddleware.park.test.ts`, modelled on `runnerMiddleware.headless.test.ts` (same `withSteps`/`form`/`island` helpers — copy them; they are module-local there):

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { db } from '../mocks/db'
import { newRunId } from '../lib/runner/ids'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import { flush, pumpUntil, resetHelloHarness, trackedHelloStore } from '../test/helloHarness'
import { runEvent, runOpened } from './runSlice'

afterEach(() => resetHelloHarness())

const REVIEW: StepKey = stepKey('confirm', 0, 'review')
const ECHO: StepKey = stepKey('confirm', 0, 'echo')

function withSteps(steps: Record<string, unknown>[]): Definition {
  return toDefinition({ name: 'Park', jobs: { confirm: { steps } } }) as Definition
}
const undeclaredForm = { id: 'review', uses: 'form', with: { title: 'Review', fields: { note: { type: 'string' } }, submit: 'Approve' } }
const autoForm = { ...undeclaredForm, headless: 'auto' }
const echo = { id: 'echo', uses: 'pipeline', with: { path: 'echo', text: 'hi' }, outputs: { text: { type: 'string' } } }

async function start(def: Definition, park: boolean) {
  const { store, advance } = trackedHelloStore()
  const runId = newRunId()
  store.dispatch(runOpened({ meta: { def, yaml: '# park\n', workflowName: 'Park', park } }))
  store.dispatch(runEvent({ type: 'run.started', runId, impl: 'hello', workflow: 'park', inputs: {}, headless: true, unattended: false, at: Date.now() }))
  await flush()
  return { store, advance, runId }
}

describe('wait=park (spec 07 additions; DR2/DR3)', () => {
  it('parks a headless run at an undeclared form: row waiting, lease cleared, mode parked', async () => {
    const { store, advance, runId } = await start(withSteps([undeclaredForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })
    const state = store.getState().run
    expect(state.state?.status).toBe('running')
    expect(state.state?.steps[REVIEW]?.status).toBe('waiting')
    expect(state.state?.steps[ECHO]).toBeUndefined()
    const row = db.runs.get(runId)!
    expect(row.status).toBe('running')
    expect(row.leaseOwner).toBeNull()
    expect(row.leaseUntil).toBeNull()
  })

  it('still fails fast without the flag', async () => {
    const { store, advance } = await start(withSteps([undeclaredForm, echo]), false)
    await pumpUntil(advance, () => store.getState().run.state?.status === 'failed', { maxSteps: 200 })
    expect(store.getState().run.state?.steps[REVIEW]?.error?.code).toBe('HEADLESS_REQUIRED')
    expect(store.getState().run.mode).toBe('live')
  })

  it('does not park on a headless:auto form — it auto-submits as today', async () => {
    const { store, advance } = await start(withSteps([autoForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running', { maxSteps: 400 })
    expect(store.getState().run.mode).not.toBe('parked')
    expect(store.getState().run.state?.steps[REVIEW]?.status).toBe('succeeded')
  })

  it('an undeclared form under park is not auto-submitted and gets no 5-minute budget', async () => {
    const { store, advance } = await start(withSteps([undeclaredForm, echo]), true)
    await pumpUntil(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })
    await advance(6 * 60_000)
    expect(store.getState().run.state?.steps[REVIEW]?.status).toBe('waiting')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter workflow exec vitest run src/store/runnerMiddleware.park.test.ts`
Expected: FAIL — `runOpened` refuses `park` (type error at build) and the first case times out with `mode === 'live'` and the step `failed`.

- [ ] **Step 3: The slice — `park` on the meta, `parked` as a mode, `runParked`**

`runSlice.ts`:

```ts
export interface RunMeta {
  def: Definition
  yaml: string
  workflowName: string
  workflowVersion?: string
  forkedFrom?: { runId: string; job: string }
  /**
   * The driver asked the page to park rather than fail at an interactive
   * step that declares no `headless:` (07 `wait=park`, ADR-0006). Page state:
   * never on a row, never on `RunState` — a person's tab never sets it.
   */
  park?: boolean
}

/** `readonly` = replayed rows; another tab holds the lease. `parked` = this tab parked the run and released the lease (07 `wait=park`). */
export type RunMode = 'live' | 'readonly' | 'parked'
```

Add the reducer next to `runModeChanged`:

```ts
    /** The run parked (07 `wait=park`): the lease is already cleared; nothing in this tab drives it any more. */
    runParked(state) {
      state.mode = 'parked'
    },
```

and export it: `export const { runOpened, runEvent, runReplaced, runModeChanged, runPaused, runParked, runClosed } = runSlice.actions`.

`runnerActions.ts`: add `park?: boolean` to `StartRunArgs` (doc: "`?wait=park` sets it; rides on `RunMeta`, not on `run.started`, because it is page state") and in `startRun` build `meta` with `...(a.park ? { park: true } : {})`.

- [ ] **Step 4: The middleware — decide `run` instead of `fail`, never auto-submit an undeclared form, no default budget, and park when idle**

In `runnerMiddleware.ts`:

(a) `headlessDecision(a: StepScope, park: boolean)`: in the `mode === undefined` branch,

```ts
  if (mode === undefined) {
    if (!a.state.headless) return { act: 'run' }
    // 07 `wait=park` (ADR-0006): the driver would rather wait for a person than
    // fail — the step runs as it would for a person, and `parkIfIdle` parks the
    // run once it is the only thing left waiting.
    if (park) return { act: 'run' }
    return { act: 'fail', error: { code: 'HEADLESS_REQUIRED', … }, annotate: true }
  }
```

At the one call site (`case 'start'`), pass the flag: `const park = getPark()` where `handleNextAction` gains a `getPark: () => boolean` parameter, supplied by the listener as `() => (listenerApi.getState() as HasRunSlice).run.meta?.park === true`.

(b) The form branch's auto-submit condition:

```ts
        if (headlessMode(step) === 'auto' && (runState.headless || unattendedStep(scope))) {
```

(c) The wait clock (the `armWaitClock({ … headless: state.headless … })` call): `headless: state.headless && headlessMode(decl) !== undefined,` with the comment from Decision 4.

(d) After the SCHEDULE pass in the `runEvent` listener (the place that calls `nextActions` and hands each action to `handleNextAction`), add:

```ts
/**
 * 07 `wait=park` (ADR-0006): a driven run with nothing left to do but wait on
 * a person parks — the lease is cleared with the same patch `run.finished`
 * writes (rows.ts), the tab stops driving, and the driver reads `parked` off
 * the global. A run whose only waiting steps declare `headless: auto` is
 * still driving itself (they submit on their own) and never parks.
 */
async function parkIfIdle(
  runId: string,
  def: Definition,
  state: RunState,
  proposed: NextAction[],
  deps: RunnerDeps,
  dispatch: (action: unknown) => unknown,
): Promise<void> {
  if (proposed.length > 0 || state.status !== 'running' || !state.headless) return
  const steps = Object.values(state.steps)
  if (steps.some((s) => s.status === 'queued' || s.status === 'running' || s.status === 'polling')) return
  const undeclared = steps.some((s) => {
    if (s.status !== 'waiting') return false
    const decl = stepOf(def, s.job, s.stepId)
    return decl !== undefined && headlessMode(decl) === undefined
  })
  if (!undeclared) return
  stopHeartbeat(runId)
  try {
    await deps.runStore.patchRun(runId, { leaseOwner: null, leaseUntil: null })
  } catch (err) {
    dispatch(runPaused(`the run could not be parked: ${messageOf(err)}`))
    return
  }
  loseLease(dispatch)
  dispatch(runParked())
}
```

Call it with `if (slice.meta?.park) void parkIfIdle(runState.runId, def, freshState, actions, deps, listenerApi.dispatch)` where `actions` is the array `nextActions` returned and `freshState` the state read after the actions were dispatched. Import `runParked`.

(e) `lifecycleActions.ts`: `adopt`'s guard `if (current.mode === 'live' && …)` is unaffected; `metaFrom(run, def, park?: boolean)` adds `...(park ? { park: true } : {})`; `openRun`/`takeOver` take `{ runId, run, steps, park? }` and pass it through.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter workflow exec vitest run src/store/runnerMiddleware.park.test.ts src/store/runnerMiddleware.headless.test.ts src/store/runnerMiddleware.unattended.test.ts src/store/runnerMiddleware.form.test.ts`
Expected: PASS, the three existing suites unchanged.

- [ ] **Step 6: The page half — `?wait=park` in, `parked` out**

`KickoffPage.tsx`: `const park = auto && searchParams.get('wait') === 'park'`; `start(values, headless, unattendedRun = false)` passes `park` into `startRun({ …, park })`.

`workflowGlobal.ts`: `status: RunStatus | 'invalid' | 'parked' | 'busy'` with the doc: "`parked` and `busy` are page states like `invalid`: no row ever carries them (07)". Add:

```ts
/** The run, with the page's own state on top of the record's (07: `parked`, `busy` are page states). */
export function withPageState(snapshot: WorkflowGlobal, pageState: 'parked' | 'busy' | null): WorkflowGlobal {
  return pageState === null ? snapshot : { ...snapshot, status: pageState }
}
```

`RunPage.tsx`, the publish effect:

```ts
  const pageState: 'parked' | 'busy' | null = sliceMode === 'parked' && sliceRunId === runId ? 'parked' : resumeOutcome === 'busy' ? 'busy' : null
  useEffect(() => {
    publishWorkflowGlobal(state ? withPageState(snapshotOf(state), pageState) : null)
    return () => publishWorkflowGlobal(null)
  }, [state, pageState])
```

(`resumeOutcome` is Task 3's; declare it here as `const resumeOutcome: 'busy' | null = null` so this task builds, and Task 3 replaces it.) The run header's status pill: `data-state={pageState ?? state.status}` on `run-status`.

`runSlice.test.ts`: one case — `runParked` sets `mode: 'parked'` and leaves `state`/`meta`.

- [ ] **Step 7: Chain and commit**

Run: `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`
Expected: green; the run count is the baseline + 5.

```bash
git add apps/workflow/src
git commit -m "feat(workflow): wait=park — a headless run parks at an undeclared interactive step instead of failing (#598)"
```

### Task 2: `runId=` — the page inserts the row under a pre-minted id

**Files:**
- Modify: `apps/workflow/src/lib/autoStart.ts`, `apps/workflow/src/lib/autoStart.test.ts`
- Modify: `apps/workflow/src/store/runnerActions.ts` (`StartRunArgs.runId`), `apps/workflow/src/pages/KickoffPage.tsx`
- Modify: `apps/workflow/src/mocks/handlers.ts`, `apps/workflow/src/mocks/handlers.test.ts`
- Create: `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/runs/post/exists.fn.js`; modify its `rule.yaml`

**Interfaces:**
- Produces: `parseRunIdParam(param: string | null): { ok: true; runId?: string } | { ok: false; error: string }`; `RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/`; `StartRunArgs.runId?: string`. The rule answers `409 { code: 'RUN_EXISTS' }`.

- [ ] **Step 1: Failing tests**

`autoStart.test.ts`:

```ts
describe('parseRunIdParam (07 `runId=`)', () => {
  it('accepts an absent parameter, a well-formed id, and refuses the rest', () => {
    expect(parseRunIdParam(null)).toEqual({ ok: true })
    expect(parseRunIdParam('run_01J8ZK3N4Q5R6S7T8V9WXYZABC')).toEqual({ ok: true, runId: 'run_01J8ZK3N4Q5R6S7T8V9WXYZABC' })
    expect(parseRunIdParam('run_lower')).toEqual({ ok: false, error: '`runId` must be run_ followed by 26 Crockford-base32 characters' })
    expect(parseRunIdParam('')).toEqual({ ok: false, error: '`runId` must be run_ followed by 26 Crockford-base32 characters' })
  })
})
```

`handlers.test.ts` (beside the existing create case): posting the same row twice answers `409` with `{ code: 'RUN_EXISTS' }` and leaves one row in `db.runs`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter workflow exec vitest run src/lib/autoStart.test.ts src/mocks/handlers.test.ts`
Expected: FAIL (`parseRunIdParam` undefined; the second POST answers 200).

- [ ] **Step 3: Implement**

`autoStart.ts`:

```ts
/** `run_` + a 26-char Crockford ULID — `lib/runner/ids.ts`'s own shape. */
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * The `runId` query parameter (07 `runId=`, ADR-0006): an id the caller minted
 * before the browser existed, so it could hand it out first. Absent means
 * "mint one"; present and malformed is a refusal, never a silent re-mint.
 */
export function parseRunIdParam(param: string | null): { ok: true; runId?: string } | { ok: false; error: string } {
  if (param === null) return { ok: true }
  if (!RUN_ID_PATTERN.test(param)) return { ok: false, error: '`runId` must be run_ followed by 26 Crockford-base32 characters' }
  return { ok: true, runId: param }
}
```

`runnerActions.ts`: `StartRunArgs.runId?: string`; `const runId = a.runId ?? newRunId()`.

`KickoffPage.tsx`: `const runIdParam = auto ? parseRunIdParam(searchParams.get('runId')) : { ok: true as const }`; fold a bad one into `autoStart` as `{ errors: { runId: runIdParam.error } }` before the inputs are decoded; `const existing = useGetRunQuery(auto && runIdParam.ok && runIdParam.runId ? runIdParam.runId : skipToken)`; in `blocked`, after the lint check: `if (existing.data?.run) return { runId: 'A run with this id already exists' }`, and hold the auto-start effect until `existing` has settled (`!existing.isLoading`). Pass `runId: runIdParam.runId` into `startRun`.

`mocks/handlers.ts` create handler: `if (db.runs.has(row.runId)) return HttpResponse.json({ code: 'RUN_EXISTS', error: 'a run with this id already exists' }, { status: 409 })`.

The rule — `runs/post/exists.fn.js`:

```js
function handler({ steps }) {
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const exists = rows(steps.find).length > 0
  return { exists, fresh: !exists }
}
```

`runs/post/rule.yaml`: prepend `find` (`data_query` on `workflow_runs`, `filters: { runId: { op: eq, value: request.body.runId } }`, `limit: 1`) and `exists` (`function_handler`, `code: ./exists.fn.js`); give `create` `condition: steps.exists.fresh`; add before `respond` a `duplicate` `response_handler` with `condition: steps.exists.exists`, `status: 409`, `body: '{"code":"RUN_EXISTS","error":"a run with this id already exists"}'`, `contentType: application/json`; give `respond` `condition: steps.exists.fresh`. Update the rule's `description`.

- [ ] **Step 4: Run to verify they pass, then the chain**

Run: `pnpm --filter workflow exec vitest run src/lib/autoStart.test.ts src/mocks/handlers.test.ts src/pages` then `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/workflow/src apps/workflow/.bffless
git commit -m "feat(workflow): ?runId= — the kickoff page inserts the row under a pre-minted id; the create rule refuses a duplicate (#598)"
```

### Task 3: `resume=1` — adopt without the click, `busy` when held

**Files:**
- Modify: `apps/workflow/src/pages/RunPage.tsx`, `apps/workflow/src/store/lifecycleActions.ts`
- Test: `apps/workflow/src/pages/RunPage.resume.test.tsx` (new; model on the existing `RunPage.*.test.tsx` that renders the page against the MSW db)

- [ ] **Step 1: Failing test**

Three cases against a `running` row seeded in `db.runs` with one `waiting` undeclared form row:
1. `?resume=1` with no lease → the page adopts (`store.getState().run.mode === 'live'`), the global's `runId` is the run and `status` is `running`, and no `run-resume` button click was needed.
2. `?resume=1` with `leaseOwner: 'tab_other', leaseUntil: Date.now() + 60_000` → `mode` stays `readonly`, the global's `status` is `busy`, `run-status[data-state="busy"]` is in the document.
3. `?resume=1` on a `succeeded` row → the global's `status` is `succeeded`; nothing adopted.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter workflow exec vitest run src/pages/RunPage.resume.test.tsx`
Expected: FAIL — case 1 stays `readonly` (Resume needs a click today); case 2 has no `busy`.

- [ ] **Step 3: Implement**

`RunPage.tsx`:

```ts
  // 07 `resume=1` (ADR-0006): the driver's resume — adopt without the confirm
  // once, and say `busy` on the global if someone else holds the lease.
  const autoResume = searchParams.get('resume') === '1'
  const resumePark = searchParams.get('wait') === 'park'
  const resumed = useRef(false)
  const [resumeOutcome, setResumeOutcome] = useState<'busy' | null>(null)
  useEffect(() => {
    if (!autoResume || resumed.current || isLive || !run || run.status !== 'running' || !runId) return
    resumed.current = true
    void dispatch(openRun({ runId, run, steps, park: resumePark })).then(() => {
      const adopted = store.getState().run
      if (!(adopted.mode === 'live' && adopted.state?.runId === runId)) setResumeOutcome('busy')
    })
  }, [autoResume, isLive, run, steps, runId, resumePark, dispatch])
```

(`store` is the app store the page already has access to through `useStore()`; the existing `ResumeBanner` reads the same outcome from the slice, so `busy` and the banner's "still held elsewhere" agree.) Replace Task 1's placeholder `resumeOutcome` with this state.

- [ ] **Step 4: Verify, chain, commit**

Run: `pnpm --filter workflow exec vitest run src/pages/RunPage.resume.test.tsx` then the chain.

```bash
git add apps/workflow/src
git commit -m "feat(workflow): ?resume=1 — the run page adopts the lease without the confirm and publishes busy when it is held (#598)"
```

### Task 4: spec 07 and 05 say so; PR A

**Files:**
- Modify: `apps/workflow/docs/spec/07-headless.md` (§Page contract: the three parameters; §Observe: the two page states; a new §"Driven runs — park and resume"), `apps/workflow/docs/spec/05-runs-and-persistence.md` (§Resume: the parked paragraph)

- [ ] **Step 1: Spec 07 §Page contract** — after the `inputs` bullets, add:

```markdown
- **`wait=park`** (with `auto=1`; ADR-0006). An `island`/`form` step that declares no `headless:`
  **parks** the run instead of failing `HEADLESS_REQUIRED`: the step is queued and mounted as it
  would be for a person, its row reaches `waiting`, and once nothing else is queued, running or
  polling the page clears the lease (the same `run/update` patch `run.finished` writes; the
  status stays `running`), stops driving, and publishes `status: 'parked'`. A `headless: auto`
  step still submits itself and a `skip` still stands its outputs in; a run whose only waiting
  steps are `auto` never parks. A parked step gets no `HEADLESS_AUTO_DEFAULT_MS` budget — a
  declared `timeout-minutes` still applies.
- **`runId=<run_ulid>`** (with `auto=1`). The row is inserted under this id instead of a minted
  one, so a caller can hand the id out before the browser exists. Malformed → `invalid`,
  `errors.runId`; already in use → `invalid`, `errors.runId` (and the create rule answers
  `409 RUN_EXISTS` as a backstop).
- **`resume=1`** (on a run page, optionally with `wait=park`). The page adopts the lease without
  the confirm and relaunches non-terminal steps through Resume (05). Held by someone else →
  `status: 'busy'`, nothing driven. A terminal run → its terminal status; nothing to do.
```

§Observe: `status: 'running'|'succeeded'|'failed'|'cancelled'|'invalid'|'parked'|'busy'` with "`parked` and `busy` are **page** states like `invalid`"; testids: `run-status[data-state=parked|busy]`.

New section before §Resume, "## Driven runs — park and resume (ADR-0006)": the lifecycle table from the spec's §Run lifecycle, the sentence "the browser owns what it claimed: a person who resumes on the harness page drives to the end in their tab; a server-side submit over the MCP endpoint re-dispatches the driver (10)".

§Resume: prepend "**Driven runs are the exception:** a run the driver parked is a `running` row with a `waiting` step and no lease; `workflow-headless resume <runId>` (or a person on the page) resumes it exactly as any abandoned run is resumed."

- [ ] **Step 2: Spec 05 §Resume** — after item 4: "A **parked** run (07 `wait=park`) is this same state on purpose: the driver cleared the lease itself. Its resume is the driver's `resume` verb or the page's `?resume=1`; nothing new goes on the row."

- [ ] **Step 3: Chain, commit, PR**

```bash
git add apps/workflow/docs
git commit -m "docs(workflow): spec 07/05 — wait=park, runId=, resume=1, the parked and busy page states (#598)"
git push -u origin feat/driven-page-contract
gh pr create --base epic/driven-runs --title "feat(workflow): the page parks a headless run at a step that needs a person, and resumes on ?resume=1 (#598)" --body-file - <<'EOF'
Story A of apps#598 (spec: docs/superpowers/specs/2026-09-05-workflow-driven-runs-design.md, DR2–DR4). Three additive page-contract parameters — `wait=park`, `runId=`, `resume=1` — and two page states, `parked` and `busy`. No row changes; `parked` is a `RunMode`, `park` rides on `RunMeta`. The `runs/post` rule gains a `409 RUN_EXISTS` backstop (a merge-time live write on `bffless/workflow`; inert until a caller sends a duplicate id).

Verification: <paste counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Story B — the driver (PR B, branch `feat/driven-driver`, worktree `.claude/worktrees/driven-driver`, based on `feat/driven-page-contract` until it merges)

*Deliverable: `workflow-headless run … --wait park --run-id <id> --grace 5m` exits 0 on a park and writes `parkedOn`; `workflow-headless resume <harness> <runId>` resumes a parked run and follows it; `busy` exits 5. Verified against the fake page.*

### Task 5: args and exit codes

**Files:**
- Modify: `packages/workflow-headless/src/errors.ts`, `src/args.ts`
- Test: `packages/workflow-headless/test/args.test.ts`

**Interfaces:**
- Produces: `EXIT.BUSY = 5`; `RunCommand.wait: 'fail' | 'park'`, `RunCommand.runId?: string`, `RunCommand.graceMs: number`; `ResumeCommand { command: 'resume'; harnessUrl; runId; out?; timeoutMs; graceMs; mocks; headed }`; `Command = RunCommand | RunsCommand | ResumeCommand`.

- [ ] **Step 1: Failing tests** (`args.test.ts`)

```ts
test('run: --wait park, --run-id and --grace', () => {
  const c = parseArgs(['run', 'https://h.test', 'hello/demo', '--inputs', 'i.json', '--wait', 'park', '--run-id', 'run_01J8ZK3N4Q5R6S7T8V9WXYZABC', '--grace', '2m'])
  expect(c).toMatchObject({ command: 'run', wait: 'park', runId: 'run_01J8ZK3N4Q5R6S7T8V9WXYZABC', graceMs: 120_000 })
  expect(parseArgs(['run', 'https://h.test', 'hello/demo', '--inputs', 'i.json'])).toMatchObject({ wait: 'fail', graceMs: 5 * 60_000 })
  expect(() => parseArgs(['run', 'https://h.test', 'hello/demo', '--inputs', 'i.json', '--wait', 'sometimes'])).toThrow(/--wait: expected fail or park/)
  expect(() => parseArgs(['run', 'https://h.test', 'hello/demo', '--inputs', 'i.json', '--run-id', 'nope'])).toThrow(/--run-id/)
})
test('resume: harness and run id, the shared options', () => {
  expect(parseArgs(['resume', 'https://h.test', 'run_01J8ZK3N4Q5R6S7T8V9WXYZABC', '--out', 'o', '--timeout', '10m'])).toEqual({
    command: 'resume', harnessUrl: 'https://h.test', runId: 'run_01J8ZK3N4Q5R6S7T8V9WXYZABC', out: 'o', timeoutMs: 600_000, graceMs: 300_000, mocks: false, headed: false,
  })
  expect(() => parseArgs(['resume', 'https://h.test'])).toThrow(/a run id is required/)
})
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @bffless/workflow-headless exec vitest run test/args.test.ts`.

- [ ] **Step 3: Implement**

`errors.ts`: `BUSY: 5,` with the doc "`resume` found a live lease: another tab or job drives the run; nothing was done". `args.ts`: `export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/`; the `run` loop gains `--wait` (`fail`|`park`), `--run-id` (validated), `--grace` (`parseDuration`); the `resume` verb parses `argv[1]` as the harness and `argv[2]` as the id (`RUN_ID_PATTERN`, else `UsageError('a run id is required (run_…)')`) and the options `--out`, `--timeout`, `--grace`, `--mocks`, `--headed`. Extend `USAGE` with the `resume` line, the three options, and the exit rows `0 … or parked (--wait park: the run waits on a person; run.json says where)` and `5 resume: another tab or job holds the lease`.

- [ ] **Step 4: Pass, commit**

```bash
git add packages/workflow-headless
git commit -m "feat(workflow-headless): --wait park, --run-id, --grace and the resume verb's argv (#598)"
```

### Task 6: follow a run to a park, wait out the grace window, resume

**Files:**
- Modify: `packages/workflow-headless/src/observe.ts`, `src/run.ts`, `src/cli.ts`, `src/index.ts`
- Create: `packages/workflow-headless/src/resume.ts`
- Test: `packages/workflow-headless/test/observe.test.ts`, `test/run.test.ts`, `test/resume.test.ts` (new), `test/cli.test.ts`

**Interfaces:**
- Consumes: Task 5's commands; the page's `parked`/`busy` statuses (Tasks 1, 3).
- Produces: `SETTLED: ReadonlySet<string>` (= `TERMINAL` ∪ `parked` ∪ `busy`); `waitForSettled(page, o)`; `RunReport.status` adds `'parked' | 'busy'`, `RunReport.parkedOn?: string[]`; `RunOptions.wait`, `.runId`, `.graceMs`; `resumeRun(o: ResumeOptions, deps: RunDeps): Promise<RunReport>`; `followRun(...)` shared by both.

- [ ] **Step 1: Failing tests**

`observe.test.ts`: `waitForSettled` returns on `status: 'parked'` (with `currentSteps: ['ask/0/answer']`) and on `busy`, and still returns on the three terminal statuses.

`run.test.ts`, new describe "runWorkflow — --wait park":
- globals `[{runId:'run_1', status:'running', …}, {runId:'run_1', status:'parked', currentSteps:['ask/0/answer']}]`, `graceMs: 0` → report `{ status: 'parked', parkedOn: ['ask/0/answer'] }`, `run.json` written with `run.status = 'running'`, the start URL contains `&wait=park`, and with `runId` in options contains `&runId=run_1`.
- grace: routes for `/api/workflow/run?id=run_1` answer `[{ steps waiting, leaseOwner: null }, { steps: [{key:'ask/0/answer', status:'succeeded'}], run: {status:'running', leaseOwner:null} }]`; globals after the park read: `[…, {runId:'run_1', status:'running'}, {runId:'run_1', status:'succeeded'}]` → the page was navigated to `/runs/run_1?resume=1&wait=park` (assert on `page.gotos`) and the report is `succeeded`.
- grace, lease taken: the record answers `leaseOwner: 'tab_x', leaseUntil: <future>` → report `parked`, no second `goto`.

`resume.test.ts`: routes give the record (`run: { runId, status:'running', impl:'hello', workflow:'demo' }`), globals `[{runId, status:'running'}, {runId, status:'succeeded'}]` → gotos include `/hello/demo/runs/run_1?resume=1&wait=park`, report `succeeded`; a `busy` global → report `busy`; a terminal record → no goto, report is the record's status.

`cli.test.ts`: `parked` → exit 0 and a `parked: run_1 (ask/0/answer)` line; `busy` → exit 5.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @bffless/workflow-headless test:run`.

- [ ] **Step 3: Implement**

`observe.ts`:

```ts
/** The statuses a driver stops following at: the run's own terminal three plus the two page states of a driven run (07 `wait=park`, `resume=1`). */
export const SETTLED: ReadonlySet<string> = new Set([...TERMINAL, 'parked', 'busy'])

export async function waitForSettled(page: PageLike, o: WatchOptions): Promise<Snapshot> {
  // Same loop as waitForTerminal (steps before the run's own line), done at SETTLED.
}
```

Refactor `waitForTerminal` to a shared `waitUntil(page, o, done)` with the transition logging; `waitForTerminal = waitUntil(…, s => TERMINAL.has(s.status))`, `waitForSettled = waitUntil(…, s => SETTLED.has(s.status))`.

`run.ts`: `RunOptions` gains `wait?: 'fail' | 'park'`, `runId?: string`, `graceMs?: number`; `startUrl` appends `&wait=park` and `&runId=<id>` when given; `RunReport.parkedOn?: string[]`. Extract the "follow to the end, seal, write artifacts" tail into

```ts
export interface FollowContext {
  page: PageLike; api: ApiLike; base: string; runId: string; runUrl: string
  out?: string; timeoutMs: number; graceMs: number; park: boolean
  log: (line: string) => void; warn: (line: string) => void
  sleep: (ms: number) => Promise<void>; now: () => number
  transitions: Transition[]; shot: (name: string) => Promise<void>
}

/**
 * Follow a run this driver is on the page of, through as many parks as the
 * grace window allows (spec DR9): a park releases the lease; while the window
 * is open the record is polled every 10 s, and if every parked step has been
 * answered and nobody took the lease the page is re-opened with `resume=1`
 * (07) and followed again in this same job. A live lease means a person's tab
 * (DR4) or another job has it — leave it to them.
 */
export async function followRun(ctx: FollowContext): Promise<{ status: string; outputs: Record<string, unknown>; parkedOn: string[] }> {
  for (;;) {
    const settled = await waitForSettled(ctx.page, { timeoutMs: ctx.timeoutMs, pollMs: 1000, onTransition: … })
    if (settled.status !== 'parked') return { status: settled.status, outputs: settled.outputs, parkedOn: [] }
    const parkedOn = settled.currentSteps
    ctx.log(`parked on ${parkedOn.join(', ')}`)
    await ctx.shot('03-parked')
    const deadline = ctx.now() + ctx.graceMs
    for (;;) {
      if (ctx.now() >= deadline) return { status: 'parked', outputs: {}, parkedOn }
      await ctx.sleep(Math.min(10_000, Math.max(0, deadline - ctx.now())))
      const record = await ctx.api.json(`/api/workflow/run?id=${encodeURIComponent(ctx.runId)}`)
      const verdict = graceVerdict(record.body, parkedOn, ctx.now())
      if (verdict === 'wait') continue
      if (verdict === 'held') { ctx.log('a page or another driver took the run'); return { status: 'parked', outputs: {}, parkedOn } }
      if (verdict === 'answered') { ctx.log('answered — resuming'); await ctx.page.goto(`${ctx.runUrl}?resume=1&wait=park`, { waitUntil: 'domcontentloaded' }); await waitForStart(ctx.page, { timeoutMs: 120_000, pollMs: 250 }); break }
      return { status: verdict, outputs: {}, parkedOn: [] } // the record went terminal under us
    }
  }
}

/** What the record says a parked driver should do. Exported for the test. */
export function graceVerdict(body: unknown, parkedOn: string[], now: number): 'wait' | 'held' | 'answered' | 'succeeded' | 'failed' | 'cancelled'
```

`graceVerdict`: read `run.status` (terminal → that status), `run.leaseOwner`/`leaseUntil` (live → `held`), then every `parkedOn` key's row status (all in `succeeded|failed|skipped|cancelled` → `answered`, else `wait`). The record's `steps[]` may be `{ fields }` envelopes — use the same `r.fields ?? r` read `park.ts` in workflow-live does.

`runWorkflow` calls `followRun` after `waitForStart`; on `parked`/`busy` it skips `waitForSealedRecord` (the record is not sealed) but still writes `run.json` (the freshest record) and the logs; `outputs/` only on a terminal run.

`resume.ts`:

```ts
export interface ResumeOptions { harnessUrl: string; runId: string; out?: string; timeoutMs: number; graceMs: number; mocks: boolean; token?: string; appToken?: string; credentials?: Credentials }

export async function resumeRun(o: ResumeOptions, deps: RunDeps): Promise<RunReport> {
  // login (or ?mocks=on), read /api/workflow/run?id= for impl/workflow/status;
  // terminal → report it, no navigation; else goto `${base}/${impl}/${workflow}/runs/${runId}?resume=1&wait=park`,
  // waitForStart (runId on the board), then followRun; write artifacts as runWorkflow does.
}
```

`cli.ts`: `doResume`; `exitFor`: `parked` → `EXIT.OK` (log `parked: <runId> (<keys>)`), `busy` → `EXIT.BUSY`. `index.ts` exports `resumeRun`, `followRun`, `graceVerdict`, `waitForSettled`, `SETTLED`, `type ResumeOptions`, `type ResumeCommand`.

- [ ] **Step 4: Pass, chain, commit**

Run: `pnpm --filter @bffless/workflow-headless lint && pnpm --filter @bffless/workflow-headless build && pnpm --filter @bffless/workflow-headless test:run`

```bash
git add packages/workflow-headless
git commit -m "feat(workflow-headless): follow a run to a park, wait out the grace window, and the resume verb (#598)"
```

### Task 7: README; PR B

- [ ] **Step 1: `packages/workflow-headless/README.md`** — §Use gains the `resume` line; §Options gains `--wait <fail|park>`, `--run-id <run_…>`, `--grace <5m>`; §Exit codes gains `0 … or parked` and `5 busy`; §Artifacts gains `parkedOn` in `run.json`'s driver note and `03-parked.png`; a short §"Driven runs" paragraph pointing at spec 07 §Driven runs and ADR-0006.

- [ ] **Step 2: Commit, PR**

```bash
git add packages/workflow-headless/README.md
git commit -m "docs(workflow-headless): the resume verb, --wait park, --grace, exit 5 (#598)"
git push -u origin feat/driven-driver
gh pr create --base feat/driven-page-contract --title "feat(workflow-headless): --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up (#598)" --body-file - <<'EOF'
Story B of apps#598 (spec §The driver, DR9). Stacked on PR A (the page contract it drives). Package-only; no live surface.

Verification: <paste counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

When PR A merges: `git rebase --onto origin/epic/driven-runs <old-A-tip>` and `git push --force-with-lease`, then retarget the PR to `epic/driven-runs`.

---

## Story C — `index.json`'s `driver`, the `drive` rule, the endpoint (PR C, branch `feat/driven-drive-rule`, based on `feat/driven-driver`)

*Deliverable: `workflow.start` over the endpoint mints an id, calls `drive`, and answers `pending`; `workflow.resume` calls `drive`; `workflow.submitStep` calls it after its write; `drive` refuses honestly and otherwise sends the `repository_dispatch`. Verified by the endpoint's unit suites, the bundle sandbox, and a scratch-host round trip.*

### Task 8: `index.json` declares its driver

**Files:**
- Modify: `packages/workflow-lint/src/index/index.ts`, `packages/workflow-lint/test/index.test.ts`
- Modify: `packages/workflow-cli/src/index-bundle.ts`, `src/cli.ts`, `test/cli.test.ts`
- Modify: `apps/workflow/src/lib/coerce.ts`, `apps/workflow/src/lib/coerce.test.ts`

**Interfaces:**
- Produces: `IndexJson.driver?: { repo: string }`; `BuildIndexArgs.driver?: { repo: string }`; CLI flag `--driver-repo <owner/name>` on `index` and `publish` (default: `GITHUB_REPOSITORY` when set); `Implementation.driver?: { repo: string }` (coerce).

- [ ] **Step 1: Failing tests** — lint: `buildIndex({ …, driver: { repo: 'acme/site' } })` puts `driver: { repo: 'acme/site' }` on the index and omits the key without it; cli: `parseIndexArgs(['--out', …, '--driver-repo', 'acme/site'])` carries it, and with `GITHUB_REPOSITORY=acme/site` in the env the default is the same; coerce: `toImplementation('hello', false, { …, driver: { repo: 'acme/site' } }).driver` equals it and a malformed `driver` (no string `repo`) is dropped.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** — `IndexJson.driver?: { repo: string }` with the doc "`ADR-0006`: the GitHub repo whose `workflow-drive.yml` a `repository_dispatch` reaches; filled by the publish step from `github.repository`"; `buildIndex` spreads `...(args.driver ? { driver: args.driver } : {})`. CLI: `INDEX_FLAGS` gains `'--driver-repo'`; `BundleArgs.driverRepo?: string`; default `process.env.GITHUB_REPOSITORY`; validate `^[^/\s]+/[^/\s]+$` else usage error; pass `driver: { repo }` into `buildIndex`; document it in the `index`/`publish` usage text. `coerce.ts`: read `raw.driver`.

- [ ] **Step 4: Pass, chain, commit**

Run: `pnpm --filter @bffless/workflow-lint build && pnpm --filter @bffless/workflow-lint test:run && pnpm --filter @bffless/workflow lint && pnpm --filter @bffless/workflow build && pnpm --filter @bffless/workflow test:run && pnpm --filter workflow exec vitest run src/lib/coerce.test.ts`

```bash
git add packages/workflow-lint packages/workflow-cli apps/workflow/src/lib
git commit -m "feat(workflow-lint,workflow-cli): index.json declares its driver repo (--driver-repo, default GITHUB_REPOSITORY) (#598)"
```

### Task 9: `@bffless/workflow init` writes `workflow-drive.yml`

**Files:**
- Create: `packages/workflow-cli/src/templates/drive.yml.tmpl`
- Modify: `packages/workflow-cli/src/verbs/init.ts` (`buildGeneratedFiles`), `test/init.test.ts`

- [ ] **Step 1: Failing test** — `runInit` writes `.github/workflows/workflow-drive.yml` (once per repo, not per alias), its text contains `repository_dispatch`, `types: [workflow-drive]`, `workflow-headless`, and `WORKFLOW_APP_TOKEN`; the dry run prints `generate .github/workflows/workflow-drive.yml`; an existing file is skipped like the other two.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: The template** (`drive.yml.tmpl`; no alias placeholders — one file per repo):

```yaml
name: Workflow drive

# The harness dispatches this (ADR-0006, spec 07 §Driven runs): a `repository_dispatch`
# with `client_payload: { mode: run|resume, run_id, harness_url, workflow?, inputs? }`
# sent by the harness's `POST /api/workflow/run/drive` rule through CE's github_api
# handler. `run` starts a workflow headless with --wait park; `resume` picks a parked
# run back up. Both exit 0 on a park — the run is waiting on a person, not failed.
on:
  repository_dispatch:
    types: [workflow-drive]

concurrency: { group: "drive-${{ github.event.client_payload.run_id }}", cancel-in-progress: false }

permissions: { contents: read }

jobs:
  drive:
    runs-on: ubuntu-latest
    timeout-minutes: 70
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g @bffless/workflow-headless@^1.2
      - run: npx --yes playwright@1.61 install chromium --with-deps
      # Through the environment, never interpolated into `run:` — a JSON body is shell source otherwise.
      - name: Write the kickoff inputs
        env:
          WORKFLOW_INPUTS: ${{ toJSON(github.event.client_payload.inputs) }}
        run: printf '%s' "$WORKFLOW_INPUTS" > inputs.json
      - name: Drive
        env:
          MODE: ${{ github.event.client_payload.mode }}
          RUN_ID: ${{ github.event.client_payload.run_id }}
          HARNESS_URL: ${{ github.event.client_payload.harness_url }}
          TARGET: ${{ github.event.client_payload.workflow }}
          # An app token (Settings → App Tokens on the harness's admin; spec 10 D23) — the member this job is.
          WORKFLOW_APP_TOKEN: ${{ secrets.WORKFLOW_APP_TOKEN }}
        run: |
          if [ "$MODE" = "run" ]; then
            workflow-headless run "$HARNESS_URL" "$TARGET" --inputs inputs.json --run-id "$RUN_ID" --wait park --out output --timeout 60m
          else
            workflow-headless resume "$HARNESS_URL" "$RUN_ID" --out output --timeout 60m
          fi
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: "workflow-drive-${{ github.event.client_payload.run_id }}", path: output/, if-no-files-found: warn }
```

`init.ts`: `const DRIVE_TMPL = readFileSync(join(TEMPLATES_DIR, 'drive.yml.tmpl'), 'utf8')`; `buildGeneratedFiles` appends `{ rel: '.github/workflows/workflow-drive.yml', tmpl: DRIVE_TMPL }` (it renders with no placeholders; `render` is a no-op on it). The README's init section lists the third file and the secret it needs.

- [ ] **Step 4: Pass, chain, commit**

```bash
git add packages/workflow-cli
git commit -m "feat(workflow-cli): init writes .github/workflows/workflow-drive.yml — the repository_dispatch the harness's drive rule sends (#598)"
```

### Task 10: the `drive` rule

**Files:**
- Create: `apps/workflow/src/mcp/drivePlan.ts`, `apps/workflow/src/mcp/driveGate.ts`, `apps/workflow/src/mcp/drive.test.ts`
- Create: `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/run/drive/post/rule.yaml`
- Modify: `apps/workflow/scripts/build-mcp.mjs` (`ENTRIES`), `packages/workflow-agent-tools/src/scopes.ts` (+ its test), `apps/workflow/src/rules.fence.test.ts` (only if it enumerates rules by name)

**Interfaces:**
- Consumes: `siblingBaseOf`, `header` from `route.ts` (export them), `rows`/`fieldsOf` from `rows.ts`, `Implementation.driver` shape (Task 8).
- Produces: request body `{ id, mode: 'run'|'resume', impl?, workflow?, inputs? }`; responses `202 { dispatched: true, runId, repo, eventType: 'workflow-drive' }` and `400 { code, message }` with `code ∈ RUN_NOT_FOUND | RUN_EXISTS | RUN_TERMINAL | LEASE_LIVE | NO_DRIVER | BAD_REQUEST`; `RULE_SCOPES['workflow/run/drive/post'] = 'workflow:run'`.

- [ ] **Step 1: Failing tests** (`drive.test.ts`, node environment, driving the two handlers the way `reply.test.ts` drives `route`/`plan`):

```ts
const req = (body: unknown): FnRequest => ({ body, headers: { host: 'h.example' }, method: 'POST', path: '/public/o/r/alias/workflow/dist/api/workflow/run/drive' })
const found = (row: Record<string, unknown>) => [{ id: 'rec', fields: row }]
const index = (body: unknown, status = 200) => ({ ok: status < 400, status, body })

it('plans the index fetch from the body (run) or the row (resume)', () => {
  const p = drivePlan({ request: req({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }), steps: { find: [] } })
  expect(p).toMatchObject({ hasIndex: true, indexPath: '/w/hello/.bffless/workflows/index.json', impl: 'hello' })
  const r = drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { find: found(runRow()) } })
  expect(r).toMatchObject({ hasIndex: true, impl: 'hello' })
  expect(drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { find: [] } })).toMatchObject({ hasIndex: false })
})

describe('the gate', () => {
  const gate = (body: unknown, find: unknown, idx: unknown) => driveGate({ request: req(body), steps: { find, plan: drivePlan({ request: req(body), steps: { find } }), index: idx } })
  it('refuses RUN_NOT_FOUND, RUN_EXISTS, RUN_TERMINAL, LEASE_LIVE, NO_DRIVER, BAD_REQUEST', () => {
    expect(gate({ id: RUN_ID, mode: 'resume' }, [], index(HELLO_INDEX)).code).toBe('RUN_NOT_FOUND')
    expect(gate({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }, found(runRow()), index(HELLO_INDEX)).code).toBe('RUN_EXISTS')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow({ status: 'succeeded' })), index(HELLO_INDEX)).code).toBe('RUN_TERMINAL')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow({ leaseOwner: 'tab_x', leaseUntil: Date.now() + 60_000 })), index(HELLO_INDEX)).code).toBe('LEASE_LIVE')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow()), index(HELLO_INDEX)).code).toBe('NO_DRIVER')
    expect(gate({ id: 'nope', mode: 'run' }, [], index(HELLO_INDEX)).code).toBe('BAD_REQUEST')
  })
  it('dispatches with the client_payload the Actions file reads', () => {
    const idx = index({ ...HELLO_INDEX, driver: { repo: 'bffless/workflow-implementations' } })
    const g = gate({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: { note: 'x' } }, [], idx)
    expect(g).toMatchObject({ dispatch: true, refused: false, owner: 'bffless', repo: 'workflow-implementations', eventType: 'workflow-drive',
      payload: { mode: 'run', run_id: RUN_ID, harness_url: 'https://h.example', workflow: 'hello/driven', inputs: { note: 'x' } } })
    expect(JSON.parse(g.response)).toEqual({ dispatched: true, runId: RUN_ID, repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' })
  })
})
```

Plus, in `bundle.test.ts`, nothing to add: `ENTRIES` drives it.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`drivePlan.ts` — output `{ hasIndex, indexUrl, indexPath, impl, siblingBase, host, appOrigin, mode, runId }`: `impl` from `request.body.impl` (mode `run`) or the found row's `impl` (mode `resume`); `hasIndex = impl !== '' && siblingBase !== ''`; the same `x-original-uri`/`x-forwarded-host` conventions as `route.ts` (export `siblingBaseOf` and `header` from `route.ts` and import them).

`driveGate.ts` — output `{ dispatch: boolean, refused: boolean, code, message, status, owner, repo, eventType: 'workflow-drive', payload, response }`; the refusal order is the spec's table (`BAD_REQUEST` first: `id` must match the ULID pattern, `mode` ∈ run|resume, `run` needs `impl`+`workflow` and a plain-object `inputs`); `NO_DRIVER` when `index.ok !== true` or `driver.repo` is not `owner/name`; `payload.workflow = \`${impl}/${workflow}\``; `harness_url = plan.appOrigin`; `response` is the JSON string a `response_handler` echoes.

`rule.yaml` (`run/drive/post`), `order: 16`:

```yaml
targetUrl: pipeline
order: 16
pipeline:
  name: Drive a run
  description: "POST { id, mode: run|resume, impl?, workflow?, inputs? } — dispatch the implementation's workflow-drive.yml (repository_dispatch, event workflow-drive) through the project's GitHub integration (ADR-0006). Refuses on a live lease, a terminal run, a missing driver."
  steps:
    - id: find
      name: find
      handler: data_query
      config: { schemaId: $schema:workflow_runs, limit: 1, filters: { runId: { op: eq, value: request.body.id } } }
    - id: plan
      name: plan
      handler: function_handler
      code: ../../../../../mcp-fn/drivePlan.fn.js
    - id: index
      name: index
      handler: http_request
      config: { condition: steps.plan.hasIndex, url: steps.plan.indexUrl, method: GET, headers: { x-original-uri: steps.plan.indexPath, x-forwarded-host: steps.plan.host }, forwardAuth: true, failOnError: false }
    - id: gate
      name: gate
      handler: function_handler
      code: ../../../../../mcp-fn/driveGate.fn.js
    - id: dispatch
      name: dispatch
      handler: github_api
      config:
        condition: steps.gate.dispatch
        action: dispatch
        owner: steps.gate.owner
        repo: steps.gate.repo
        eventType: steps.gate.eventType
        clientPayload: { mode: steps.gate.payload.mode, run_id: steps.gate.payload.run_id, harness_url: steps.gate.payload.harness_url, workflow: steps.gate.payload.workflow, inputs: steps.gate.payload.inputs }
    - id: refuse
      name: refuse
      handler: response_handler
      config: { condition: steps.gate.refused, body: "{{{steps.gate.response}}}", status: 400, headers: { Cache-Control: no-store }, contentType: application/json }
    - id: respond
      name: respond
      handler: response_handler
      config: { condition: steps.gate.dispatch, body: "{{{steps.gate.response}}}", status: 202, headers: { Cache-Control: no-store }, contentType: application/json }
  validators:
    - type: auth_required
      config: { allowApiKey: true, requiredScopes: [workflow:run] }
description: "Dispatch the driver for a run (ADR-0006). 202 dispatched · 400 { code } refused · the pipeline's own error when GitHub refuses (DISPATCH_FAILED)."
```

`build-mcp.mjs`: `ENTRIES = ['route', 'plan', 'merge', 'reply', 'wellKnown', 'drivePlan', 'driveGate']`. `scopes.ts`: `'workflow/run/drive/post': 'workflow:run'`. Run `pnpm --filter workflow mcp:build`.

- [ ] **Step 4: Pass, chain, commit**

Run: `pnpm --filter @bffless/workflow-agent-tools test:run && pnpm --filter workflow mcp:build && pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build` (the fence test holds `RULE_SCOPES` and the rule's `requiredScopes` equal; `bundle.test.ts` sandboxes the two new bundles).

```bash
git add apps/workflow packages/workflow-agent-tools
git commit -m "feat(workflow): the run/drive rule — repository_dispatch to the implementation's workflow-drive.yml through the project's GitHub integration (#598)"
```

### Task 11: the endpoint — `start` and `resume` served, `submitStep` re-dispatches, `pending`

**Files:**
- Modify: `apps/workflow/src/mcp/ids.ts` (+ `ids.test.ts`), `route.ts`, `plan.ts`, `reply.ts`, `mcpConfig.ts` (+ their tests), `apps/workflow/scripts/build-mcp.mjs` (the `drive` step)
- Modify: `packages/workflow-agent-tools/src/catalog.ts` (+ `catalog.test.ts`)
- Regenerate: `apps/workflow/.bffless/proxy-rules/workflow/**` via `pnpm --filter workflow mcp:build`

**Interfaces:**
- Consumes: Task 10's rule and body shape.
- Produces: `mintRunId(now, random)`, `runIdTime(runId): number | null` in `ids.ts`; `Route.isStart`, `.isResume`, `.driveUrl`, `.drivePath`; `Plan.isDrive`, `.driveBody`, `.driveError`, `.runId`; `PlanSteps.update`; `TOOL_STEPS` for `start` `['route','index','plan','drive','reply']`, `resume` `['route',...RUN_ROWS,'plan','drive','reply']`, `submitStep` `['route',...RUN_ROWS,'merge','update','plan','drive','reply']`; `NOT_SERVED = { 'workflow.cancel' }`; `PENDING_WINDOW_MS = 10 * 60_000`.

- [ ] **Step 1: Failing tests**

`ids.test.ts`: `mintRunId(1_756_800_000_000, () => 0)` matches `RUN_ID_PATTERN` and `runIdTime` of it is `1_756_800_000_000`; `runIdTime('nope')` is `null`.

`reply.test.ts`, new describes:
- **workflow.start**: with `index: http(HELLO_INDEX_WITH_DRIVER)` and `drive: http({ dispatched: true, runId: 'run_…', repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' }, 202)`: not an error, text starts with `Dispatched run run_` and contains `pending`, `structuredContent` has `runId`, `pending: true`, `status: 'pending'`, and `plan.driveBody` sent `{ mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }` with `id === structuredContent.runId`. Without `driver` in the index → `isError`, `errors.tool` names `NO_DRIVER` and the harness page. With an unknown workflow → `errors.workflow` = `REFUSALS.noWorkflow`. With `drive: http({ code: 'LEASE_LIVE', … }, 400)` → `errors.drive === 'LEASE_LIVE'`.
- **workflow.resume**: with run rows and `drive: 202` → text `Dispatched a driver to resume run_…`; with `drive: 400 LEASE_LIVE` → refused; with no run rows → `No such run`.
- **workflow.submitStep + drive**: the existing island submit case, plus `drive: 202` → text ends with `; a driver was dispatched to continue the run`; with `drive: 400 NO_DRIVER` → text ends with `; not dispatched (NO_DRIVER): resume it on the harness page`; the verdict's `isError` is unchanged either way.
- **workflow.status pending**: no run rows and `runId = mintRunId(Date.now() - 60_000, …)` → not an error, `status: 'pending'`, text mentions `not started yet`; the same with an id minted 11 minutes ago → `No such run`.
- **workflow.cancel** stays not served.

`mcpConfig.test.ts`: the three `TOOL_STEPS` rows above. `catalog.test.ts`: the two descriptions.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`ids.ts`:

```ts
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/

/** `lib/runner/ids.ts`'s ULID restated for the bundle (no `crypto` in CE's sandbox): 10 time chars + 16 random. An id, not a secret. */
export function mintRunId(now: number, random: () => number = Math.random): string {
  let time = '', t = now
  for (let i = 0; i < 10; i++) { const mod = t % 32; time = CROCKFORD[mod] + time; t = (t - mod) / 32 }
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(random() * 32)]
  return `run_${time}${rand}`
}

/** The ms timestamp a run id carries, or `null` for anything that is not one. */
export function runIdTime(runId: string): number | null {
  if (!RUN_ID_PATTERN.test(runId)) return null
  let t = 0
  for (const ch of runId.slice(4, 14)) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}
```

`route.ts`: `isStart = tool === 'workflow.start' && impl && workflow && siblingBase !== ''` (and `indexUrl`/`indexPath` set for it, like `isDescribe`); `isResume = tool === 'workflow.resume' && runId !== ''` (`needsRun = true`); `driveUrl = siblingBase === '' ? '' : \`${siblingBase}/api/workflow/run/drive\``, `drivePath = '/api/workflow/run/drive'`. Add `'workflow.resume'` to `RUN_SCOPED`.

`plan.ts` (`PlanSteps` gains `update?: unknown`; the `Plan` gains `isDrive`, `driveBody`, `driveError`, `runId`):
- `isStart`: the listing must exist in `steps.index` (else `driveError = REFUSALS.noWorkflow`), `driver.repo` must exist (else `driveError = 'NO_DRIVER: this implementation publishes no driver — start it on the harness page'`), `inputs` must be a plain object (else `driveError = '`inputs` must be an object'`); then `runId = mintRunId(Date.now())`, `isDrive = true`, `driveBody = { id: runId, mode: 'run', impl, workflow, inputs }`.
- `isResume`: the run row must exist and be `running` (else `driveError`), `driveBody = { id: route.runId, mode: 'resume' }`.
- `workflow.submitStep`: `isDrive = stepUpdated(steps.update)` (move `stepUpdated` from `reply.ts` into `rows.ts` and import it in both), `driveBody = { id: route.runId, mode: 'resume' }`.

`build-mcp.mjs`: `drive: http('drive', 'steps.plan.isDrive', 'steps.plan.driveUrl', 'steps.plan.drivePath', { method: 'POST', body: 'steps.plan.driveBody' })` — `driveUrl`/`drivePath` are copied from `route` onto `plan` so the step reads one source.

`reply.ts`:
- `NOT_SERVED = new Set(['workflow.cancel'])`.
- `start(route, steps)`: `plan.driveError` → `refuse(key, message)` (`workflow` for `noWorkflow`, `tool` for `NO_DRIVER`, `inputs` otherwise); then `driveOutcome(steps.drive)`: `202` → `textResult(\`Dispatched run ${runId} of ${impl}/${workflow} to its driver; pending — the row appears when the job starts (about a minute). Poll workflow.status; when it reports waiting, complete the step here with workflow.submitStep.\`, { runId, pending: true, ...pendingSnapshot(runId) })`; `400` → `refuse('drive', code)` with the body's `message` in the text; anything else → `refuse('drive', 'DISPATCH_FAILED')` with the status.
- `resume(route, steps)`: `resolveRun` then the same `driveOutcome`, text `Dispatched a driver to resume ${runId}; …`.
- `withDriveNote(verdict, plan, drive)`: appends the two sentences from the test to `content[0].text` and `dispatched: boolean` to `structuredContent`; applied in `callTool` to `workflow.submitStep`'s verdict only.
- `status`: when `resolveRun` finds no row and `runIdTime(route.runId)` is within `PENDING_WINDOW_MS` of now → `textResult(\`Run ${runId} is pending — dispatched, not started yet. Poll again.\`, pendingSnapshot(runId))`.
- `pendingSnapshot(runId)`: `{ runId, status: 'pending', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] }`.

`catalog.ts`:
- `workflow.start`: "Start a run of a workflow with the given inputs. Validated exactly as the kickoff form validates a person’s values; a refusal names each bad input. On the harness page it returns the run id and its first snapshot and moves the page to the run. Over the MCP endpoint it dispatches the implementation’s headless driver and answers `pending` with the run id; poll workflow.status until the row exists (about a minute), then complete its interactive steps here."
- `workflow.resume`: "Take over a `running` run whose driver went away (an expired lease). On the harness page this surface drives it from here. Over the MCP endpoint it dispatches the implementation’s headless driver to resume the run — how a run answered here continues without a person on the page."

`mcpConfig.ts`: the three `TOOL_STEPS` rows. Run `pnpm --filter workflow mcp:build`.

- [ ] **Step 4: Pass, chain, commit**

Run: `pnpm --filter @bffless/workflow-agent-tools lint && pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-agent-tools test:run && pnpm --filter workflow mcp:build && pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`

```bash
git add apps/workflow packages/workflow-agent-tools
git commit -m "feat(workflow): workflow.start and workflow.resume served over the MCP endpoint through the drive rule; submitStep re-dispatches; status answers pending (#598)"
```

### Task 12: spec 10, the scratch-host round trip, PR C

- [ ] **Step 1: Spec 10** — §"What an agent host is for" (the "not served" sentences at `10-agent-embedding.md:172-173`): "So over the endpoint `workflow.start` and `workflow.resume` are served **by dispatching the implementation's headless driver** (ADR-0006; `drive`, 07 §Driven runs) and answer `pending` until the row exists; `workflow.submitStep` re-dispatches after its write; `workflow.cancel` is listed (D19) but not served." §Later: replace the first bullet with "`on.schedule` / `on.webhook` — a `schedule:` block or a second `repository_dispatch` type on `workflow-drive.yml`, dispatching `mode: run` (ADR-0006 DR11)." Add a §"Driven runs over the endpoint" table: tool → what `drive` does → the refusal codes.

- [ ] **Step 2: Scratch-host round trip (act-and-report; the scratch project is public and authless)** — redeploy per `apps/workflow/bffless/README.md`, then with the MCP client (`packages/workflow-live/src/mcp-client.ts` from a node REPL, or `curl` JSON-RPC): `tools/call workflow.start { impl: 'hello', workflow: 'interactive', inputs: {} }` → expect an `isError` result naming `NO_DRIVER` (hello's published index has no `driver` yet — Task 16); `workflow.status` on a fresh `mintRunId` → `pending`; `workflow.cancel` → not served. Paste the three answers into the PR body. The `mcp` walk must stay 26/26 on the scratch host (`pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev`; its `spec10.notServedHonest` check reads `workflow.start`'s refusal — update the check to expect `NO_DRIVER` in the text, since the scratch host's hello declares no driver).

- [ ] **Step 3: Commit, PR**

```bash
git add apps/workflow/docs packages/workflow-live
git commit -m "docs(workflow): spec 10 — start/resume served by dispatching the driver; the mcp walk expects NO_DRIVER on a driverless hello (#598)"
git push -u origin feat/driven-drive-rule
gh pr create --base feat/driven-driver --title "feat(workflow): the drive rule and index.json's driver — workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches (#598)" --body-file - <<'EOF'
Story C of apps#598 (spec DR5–DR8, DR10). Stacked on PR B.

**Live writes on merge to main** (checklist §1): a new `run/drive` rule and the regenerated `mcp-tools/{start,resume,submitStep}` rules on `bffless/workflow`. Both are inert until (a) an implementation publishes `driver.repo` and (b) the project's GitHub integration is configured — Task 16's checklist; until then `start`/`resume` refuse with `NO_DRIVER`, which the `mcp` walk now asserts.

Scratch-host round trip: <paste>. `mcp` walk on the scratch host: 26/26.

Verification: <paste counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Story D — the walk, the docs, the closeout (PR D, branch `docs/driven-runs-closeout`, based on `feat/driven-drive-rule`)

### Task 13: the implementation repo's driver workflow and a workflow that parks (cross-repo PR text)

**Files:**
- Create in `bffless/workflow-implementations` (a PR the person opens or approves; text lives here): `.github/workflows/workflow-drive.yml` (Task 9's template verbatim), `workflows/hello/.bffless/workflows/driven.workflow.yaml`
- Modify there: `.github/workflows/deploy-hello.yml` (`bffless/publish-workflow@v1` with `driver-repo: ${{ github.repository }}` once Task 16's action input exists)

- [ ] **Step 1: The workflow that parks** (`driven.workflow.yaml`):

```yaml
name: Driven hello
description: One undeclared form between two pipelines — the run parks on it (ADR-0006).
on:
  manual:
    inputs:
      greeting: { type: string, default: Hello }
jobs:
  greet:
    steps:
      - id: echo
        uses: pipeline
        with: { path: echo, text: "${{ inputs.greeting }}" }
        outputs:
          text: { type: string, value: "${{ response.text }}" }
  ask:
    needs: [greet]
    steps:
      - id: answer
        uses: form
        with:
          title: A person answers
          fields:
            note: { type: string, required: true }
          submit: Continue
  finish:
    needs: [ask]
    steps:
      - id: echo
        uses: pipeline
        with: { path: echo, text: "${{ needs.greet.outputs.text }} — ${{ needs.ask.outputs.note }}" }
        outputs:
          text: { type: string, value: "${{ response.text }}" }
    outputs:
      text: "${{ steps.echo.outputs.text }}"
outputs:
  text: "${{ jobs.finish.outputs.text }}"
```

(`echo` is hello's existing pipeline; the form's `outputs` are its fields, 03.) Lint it locally with `pnpm --filter @bffless/workflow-lint exec workflow-lint <file>` — the `interactive-headless` notice is expected and is the point.

- [ ] **Step 2: Record the two files and the secret in `apps/workflow/docs/spec/07-headless.md` §In CI** as the third thing that exists: "`workflow-drive.yml` in the implementation repo (`@bffless/workflow init` writes it) — `repository_dispatch` `workflow-drive`, secret `WORKFLOW_APP_TOKEN`". Commit with Task 15.

### Task 14: the `driven` walk

**Files:**
- Create: `packages/workflow-live/src/walks/driven.ts`
- Modify: `packages/workflow-live/src/walks/index.ts`, `src/args.ts` (USAGE), `README.md` (the walks table)

**Interfaces:**
- Consumes: `openMcp`, `mintAppToken`, `openSession`, `credentials`/`appToken` (as `walks/mcp.ts`), the `hello/driven` workflow (Task 13), an implementation with `driver.repo` and the project's GitHub integration (Task 16).

- [ ] **Step 1: Write the walk**

```ts
/**
 * Driven (ADR-0006): a run started over the MCP endpoint is driven by the
 * implementation's dispatched headless job, parks on `hello/driven`'s
 * undeclared form, is answered over the endpoint, and is driven to the end by
 * a second job. Six checks; two Actions jobs; one hello run. Blocks — rather
 * than fails — when the harness's hello declares no driver.
 */
export const driven: Walk = async ({ args, env, report }) => {
  // token as in walks/mcp.ts (mint with all three scopes when none is given)
  const call = …
  const start = await call('workflow.start', { impl: 'hello', workflow: 'driven', inputs: { greeting: 'Hello' } })
  if (start.isError && /NO_DRIVER/.test(text(start))) return report.block('hello declares no driver on this harness (index.json driver.repo) — Task 16')
  const runId = String(structured(start).runId ?? '')
  report.expect('driven.startPending', !start.isError && structured(start).pending === true && runId !== '', brief(start))
  if (runId) report.run(runId)
  const parked = await pollStatus(call, runId, (s) => s.status === 'running' && s.waitingOn.some((w) => w.key === 'ask/0/answer'), 8 * 60_000)
  report.expect('driven.parksOnTheForm', parked !== null && parked.currentSteps.join(',') === 'ask/0/answer', parked)
  const row = await session.api.json(`/api/workflow/run?id=${encodeURIComponent(runId)}`)
  report.expect('driven.leaseCleared', (row.body as { run?: { leaseOwner?: unknown } }).run?.leaseOwner == null, brief(row))
  const answered = await call('workflow.submitStep', { runId, step: 'ask/0/answer', values: { note: 'from the endpoint' } })
  report.expect('driven.submitDispatches', !answered.isError && /a driver was dispatched/.test(text(answered)), brief(answered))
  const done = await pollStatus(call, runId, (s) => s.status !== 'running', 8 * 60_000)
  report.expect('driven.completes', done?.status === 'succeeded' && /from the endpoint/.test(String((done.outputs as { text?: string }).text ?? '')), done)
  report.expect('driven.startedByTheToken', … `startedBy` on the record equals the token's member id …)
}
```

`pollStatus(call, runId, until, timeoutMs)` calls `workflow.status` every 10 s and returns the `structuredContent` snapshot when `until` holds, `null` on timeout. Register it in `WALKS` (not in `ALL_ORDER`: it spends two Actions jobs), add it to `USAGE` and the README table with its checks and spend ("two Actions jobs in the implementation repo").

- [ ] **Step 2: Lint, build, test; commit**

Run: `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`

```bash
git add packages/workflow-live
git commit -m "feat(workflow-live): the driven walk — start over the endpoint, park, answer over the endpoint, a second job finishes (#598)"
```

### Task 15: ADR-0006 and the amendments

**Files:**
- Create: `apps/workflow/docs/adr/0006-driven-runs.md`
- Modify: `apps/workflow/docs/spec/00-overview.md` (D24; §What this is not; the decisions table gains D25), `01-workflow-yaml.md` (§Triggers), `05-runs-and-persistence.md` (done in Task 4), `07-headless.md` (§In CI; done partly in Task 4), `10-agent-embedding.md` (done in Task 12), `apps/workflow/CONTEXT.md`, `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` (a one-line pointer under the amendment)

- [ ] **Step 1: ADR-0006**

```markdown
---
status: accepted
date: 2026-09-05
---
# Driven runs: a parked headless run, resumed by a dispatched driver

`workflow.start` over the MCP endpoint had nothing to start a run with, and a step answered in
claude.ai left a run nobody was driving (apps#598). ADR-0005 rejected a server-side engine.

**Decision:** there is **no second engine**. D11 stands — the harness is always in a browser;
headless is Playwright — and the driver is `@bffless/workflow-headless` on GitHub Actions in
the implementation's repo. What changes: (1) a headless run started with `wait=park` **parks**
at an `island`/`form` that declares no `headless:` — row `waiting`, lease cleared, the job
exits 0 — instead of failing `HEADLESS_REQUIRED`; the rows are the checkpoint, and Resume is
the resume. (2) A harness rule, `POST /api/workflow/run/drive`, sends a `repository_dispatch`
(`workflow-drive`) to the repo the implementation's `index.json` names (`driver.repo`), through
CE's `github_api` handler and the project's GitHub integration. The endpoint's `workflow.start`
(a pre-minted id, `pending` until the row exists) and `workflow.resume` call it; `workflow.submitStep`
calls it after its write. (3) The browser owns what it claimed: a person who resumes on the
harness page drives to the end in their tab; only a server-side submit re-dispatches. (4) A grace
window after a park lets the same job pick up an answer given within minutes.

**Why:** one engine to keep honest (spec 09's purity fence, the same rows, the same history);
no owned service (the implementation repo already runs Actions for its deploy); nothing
app-aware in CE (D22 — `github_api` is generic, the rule is the app's); the run row already
held every fact a resume needs (05).

**Considered:** a controller inside CE's `function_handler` (rejected: the sandbox has no
`fetch` and no timers, and a `polling` step needs a controller that can poll — a browser
already is one); a Playwright sidecar next to CE (rejected: CE would know the app); a
self-hosted driver loop (deferred: the same binary polling for runs wanting a driver — the
`drive` contract is written so it can replace the dispatch); handing a page-resumed run back
to the server after its submit (rejected: a minute of cold start on a path that was free, and
the person's tab is already an engine); `workflow_dispatch` (not what CE's handler sends).

**Consequences:** three additive page-contract parameters and two page states (07); the driver
gains `resume` and exit 5; `index.json` gains `driver`; `@bffless/workflow init` writes
`workflow-drive.yml`; the catalog's `start`/`resume` words change; `on.schedule`/`on.webhook`
are now a `schedule:` block or a second dispatch type on that file (01 §Triggers); the GitHub
integration and the `WORKFLOW_APP_TOKEN` secret are provisioned per instance by a person.
```

- [ ] **Step 2: Spec 00** — D24: append "; **driven by a dispatched headless driver** when the implementation declares one (ADR-0006)" in place of "a server-side driver is the long-term direction"; D25: `| D25 | Driven runs: no second engine — a headless run parks at an undeclared interactive step (`wait=park`), and the harness's `drive` rule re-dispatches the implementation's Playwright job (`repository_dispatch`) to resume it; the browser owns what it claimed | 07, 10, ADR-0006 |`. §What this is not: "Not an engine outside a browser: `on.schedule`/`on.webhook` dispatch a headless browser (ADR-0006); no secrets in the browser (secrets live in pipelines)."

- [ ] **Step 3: Spec 01 §Triggers** — "`on.schedule` / `on.webhook` are later: a `schedule:` block or a second `repository_dispatch` type on the implementation's `workflow-drive.yml`, dispatching `mode: run` (ADR-0006)."; move them from "## Not in v1"'s list to "later (ADR-0006)".

- [ ] **Step 4: ADR-0005** — under the amendment: "**ADR-0006 (2026-09-05)** names the driver: the dispatched headless browser, not a server-side engine; this rejection stands."

- [ ] **Step 5: CONTEXT.md** — two glossary entries: **Driven run**: "A headless run the implementation's dispatched driver job drives; it parks at a step that needs a person and a fresh job resumes it after a server-side submit. _Avoid_: server-side run, background run." **Park**: "A driven run reaching an interactive step that declares no `headless:`: the row waits, the lease is cleared, the job ends. Not a failure. _Avoid_: pause, suspend."

- [ ] **Step 6: Commit**

```bash
git add apps/workflow/docs apps/workflow/CONTEXT.md
git commit -m "docs(workflow): ADR-0006 driven runs — D24/D25, spec 00/01/07 amended, the glossary (#598)"
```

### Task 16: the cross-repo checklist, the closeout, PR D

- [ ] **Step 1: File the three cross-repo items as issues (use the `file-issue` skill for each; they are person-owned or other-repo)** — (a) `bffless/publish-workflow`: input `driver-repo` (default `${{ github.repository }}`) passed as `--driver-repo` to the index step; (b) `bffless/workflow-implementations`: `.github/workflows/workflow-drive.yml` (Task 9's template), `workflows/hello/.bffless/workflows/driven.workflow.yaml` (Task 13), the `WORKFLOW_APP_TOKEN` repo secret (an app token for `workflow-ci@bffless.app` on the `bffless/workflow` project, scopes `workflow:read workflow:run workflow:files`), `deploy-hello.yml` passing `driver-repo`; (c) `bffless/workflow` on j5s: Project Settings → Integrations → GitHub, a fine-grained PAT with `contents: write` on `bffless/workflow-implementations` (**ask-first: a live change to the project**). Link all three from apps#598.

- [ ] **Step 2: Post the closeout on apps#598** — what shipped (the four PRs), what is gated (the three items above), and the gate: "`pnpm workflow-live:walk driven --harness https://workflow.j5s.dev` green (6/6) once (a)–(c) are done; `mcp` 26/26 and `oauth` 9/9 unchanged". Keep the issue open until the walk is green; close it then.

- [ ] **Step 3: PR D, then the epic**

```bash
git push -u origin docs/driven-runs-closeout
gh pr create --base feat/driven-drive-rule --title "docs(workflow): ADR-0006 driven runs, the driven walk, workflow-drive.yml (#598)" --body-file - <<'EOF'
Story D of apps#598: ADR-0006, the spec amendments, the `driven` live walk (gated on the cross-repo checklist in #598), the implementation repo's driver workflow text.

Verification: <paste counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

After PR D merges into the epic: the person marks the epic PR ready and squash-merges it into `main` with the release notes in the PR body (memory *release-please override lives in the PR body*). Then the merge-time live writes land (`run/drive`, the regenerated tool rules) — check `bffless rules` diff on `bffless/workflow` afterwards and run `mcp` (26/26) against `workflow.j5s.dev` (ask-first).

- [ ] **Step 4: Memory** — update `m5-phase4-handoff.md`'s "server-side driver" loose end to point at ADR-0006 and #598's gate; add a `driven-runs-handoff` memory naming the three gated items and where the walk lives.

---

## Self-review (writing-plans checklist, applied)

1. **Spec coverage.** DR1 (no second engine) — Tasks 1, 15. DR2/DR3 (park; rows are the checkpoint) — Task 1. DR4 (the browser owns what it claimed) — Tasks 1 (`park` only from the driver's URL), 3, 15. DR5 (submit re-dispatches) — Task 11. DR6 (the drive rule, its refusals, scope) — Task 10. DR7 (`driver` in `index.json`, generated) — Tasks 8, 16(a). DR8 (the endpoint mints the id; the page inserts under it) — Tasks 2, 11. DR9 (grace window; a collision costs a wasted minute) — Task 6, and the Actions concurrency group in Task 9. DR10 (identity) — Task 9 (the app token is the job's), Task 14 (`driven.startedByTheToken`). DR11 (schedules later) — Task 15 (spec 01, ADR). Page contract §: Tasks 1–4. Driver §: Tasks 5–7. `drive` rule §: Task 10. Endpoint (start/resume/submitStep/status pending, cancel not served): Task 11. Actions file: Tasks 9, 13. Identity/auth §: Tasks 9, 16. Failure modes: `pending` window (11), lease expiry (existing), `busy` (3, 6), two drives (9's concurrency + 10's `LEASE_LIVE`), submit-then-drive-fails (11's note), no driver (10, 11, 12). Docs §: Tasks 4, 7, 12, 15. Testing §: unit (1–3, 5–6, 8–11), driver fakes (6), live (14). Out of scope: honoured.
2. **Placeholders.** None: every code step carries the code or the exact edit; the two "paste counts" are PR-body fields filled at execution.
3. **Type consistency.** `RunMode 'parked'` (1) is what `RunPage` publishes (1) and `adopt` tolerates (1, 3); `park` flows `?wait=park` → `StartRunArgs.park` → `RunMeta.park` (1) and `openRun({ park })` → `metaFrom` (1, 3); `RUN_ID_PATTERN` is defined identically in `autoStart.ts` (2), `args.ts` (5) and `mcp/ids.ts` (11) — three copies on purpose, each side of a fence; `SETTLED`/`waitForSettled` (6) read the statuses Task 1 and 3 publish; `drive`'s body `{ id, mode, impl?, workflow?, inputs? }` is what `driveGate` validates (10) and `plan.driveBody` sends (11); `EXIT.BUSY = 5` (5) is what `doResume` maps `busy` to (6); the Actions payload keys `mode, run_id, harness_url, workflow, inputs` are the same in `driveGate.payload` (10) and `drive.yml.tmpl` (9).

## Execution handoff

Plan complete. Two execution options: **Subagent-Driven** (recommended: a fresh subagent per task with review between tasks — `superpowers:subagent-driven-development`) or **Inline** (`superpowers:executing-plans`). Story A first; B stacks on A, C on B, D on C.
