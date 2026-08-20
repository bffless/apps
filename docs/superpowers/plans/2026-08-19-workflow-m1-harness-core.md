# Workflow M1 — Harness Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Workflow harness app (`apps/workflow`) to the M1 bar: discovery, parse/validate via `@bffless/workflow-lint`, the workflow graph view, the kickoff form, `pipeline` steps with `poll`/`retry`, event-sourced run persistence + Resume with lease, the run page with Input/Output panes, summaries/annotations, and the `workflow-hello` test implementation (echo, slow job + poll, fail-on-purpose) — mock-first with MSW, one Playwright smoke.

**Architecture:** React 19 + Vite SPA with Redux Toolkit + RTK Query (spec 09 / ADR-0003). The run engine is a pure, framework-free module `src/lib/runner/` (definition, contexts, graph, transitions, reducer, next, replay, rows, adapters) reusing `@bffless/workflow-lint/expressions` and `/definition` — one parser, no second implementation. Side effects live in exactly one RTK listener middleware; every engine event is persisted as one row write to the harness's own `/api/workflow/*` rule set (BFFless Data Tables) before the engine proceeds; Resume is `rows → events → reduce`, the same reducer as the live run.

**Tech Stack:** TypeScript ~6.0.2, React ^19.2, react-router-dom ^7, @reduxjs/toolkit ^2.12, react-redux ^9, `@bffless/workflow-lint` `workspace:*`, `marked` (summaries), MSW ^2 (mock-first), vitest ^4 + @testing-library/react, @playwright/test 1.61.1 (one smoke), eslint ^10 flat config. Backend: authored proxy-rule sets (`workflow`, `hello`) using `data_query`/`data_create`/`data_update`/`presigned_upload`/`register_upload`/`file_serve_handler`/`function_handler`/`response_handler` + `postSteps`.

**Spec:** `apps/workflow/docs/spec/` — 00-overview.md (M1 bullet), 01-workflow-yaml.md (grammar, contexts, control flow), 02-types-and-renderers.md (type vocabulary, File ref), 03-step-kinds.md (`pipeline` rules, `form` contract), 05-runs-and-persistence.md (tables, write path, Resume, summaries), 06-discovery-publishing-files.md (discovery, files trio, access, names), 08-harness-ui.md (routes, graph, panes, testids), 09-state-management.md (lib/runner layout, testing stance), ADR-0001/0003/0004, `workflow.schema.json`, `examples/hello.workflow.yaml`. Vocabulary: `apps/workflow/CONTEXT.md`. Conventions: `docs/app-pipelines-convention.md`, `scripts/check-app-conventions.mjs`.

## Decisions this plan makes (spec-ambiguous points, resolved here)

Locked D1–D18 are not re-litigated. The following are the gaps M1 forces; each is decided below. The three ⚑ items **were confirmed by the user on 2026-08-20** (answers recorded inline); the rest were accepted as a bundle the same day.

1. **⚑ CONFIRMED — The `form` step ships in M1 (minimal).** 00 lists `form` under M2, but `hello.workflow.yaml` — the M1 test implementation — ends in a `form` step (`confirm/review`), and M1's run-completion path (`jobs.confirm.outputs.*` feed the top-level outputs) cannot be exercised without it. Spec 03 says a `form` step is "the same renderer as the kickoff form", and the kickoff form **is** M1 scope — so the marginal cost is one adapter + reusing the field controls. M1 `form` scope: field types `string` (+`format: textarea`), `number`, `boolean`, `choice`, `markdown` (plain textarea editor); expression `default`s; submit → field values become outputs. **Deferred to M2:** `file` fields in mid-run forms, `choice` tile-picker previews, markdown live preview, `headless: auto` auto-submit (M1 never runs headless).
2. **⚑ CONFIRMED — `workflow-hello` lives in-monorepo for M1, as test scaffolding only.** The user's confirmation came with an explicit condition: **this is a development/testing convenience, NOT the long-term architecture** — implementations live in separate repos (D1/D15), and nothing in M1 may blur that boundary. Concretely: the harness never imports from hello's files; hello reaches the harness only through the real contract (its own alias, its own rule set attached to both aliases, discovery via `index.json` probing), exactly as a separate repo would. Rationale for the temporary co-location: D15 says separate `workflow-<impl>` repos, but M1's Playwright smoke is mock-backed (09) and `publish-workflow` (the thing that makes a separate repo workable) is M3. M1 ships hello as: (a) MSW mocks of `/api/hello/*` + the discovery probes (the smoke's backend), serving the YAML by raw-importing `apps/workflow/docs/spec/examples/hello.workflow.yaml` (single source of truth, no copy); (b) a **real, deployable** authored rule set at `apps/workflow/.bffless/proxy-rules/hello/` (paths pre-prefixed `/api/hello/…` since the `--path-prefix` CLI rewrite is M3) plus `scripts/stage-hello.mjs` that builds the hello static bundle (`.bffless/workflows/` + generated `index.json`). Extraction to `bffless/workflow-hello` happens at M3 with `publish-workflow`; nothing here blocks it (the rule set moves, paths lose their baked prefix).
3. **No `resume:` hint in M1** (05's explicit "open: decide at M1"). Resume re-issues the initial request for `queued`/`running` pipeline steps; `polling` steps resume polling with their recorded `response.initial`. Hello's `slow` enqueue is safe to re-enqueue (a duplicate job row is orphaned, not harmful). Revisit at M3 with the Studio port.
4. **Discovery aliases: assume CE's alias API is reachable on the harness host** (`GET /api/aliases`), exactly the assumption 06 says to verify at M1. Mock-first: MSW mocks it; the live check happens at the deploy task (Task 22). The fallback (`GET /api/workflow/aliases` harness rule wrapping the CE API) is designed in Task 1's notes but not built.
5. **Mutation endpoints use POST, not PATCH/PUT.** 05 says its paths "are examples". Authored rule files in this repo demonstrably support `get`/`post`/`delete`/`any` methods; `patch`/`put` are unproven. Final API: `POST /api/workflow/runs` (create), `GET /api/workflow/runs?impl=&workflow=` (list), `GET /api/workflow/run?id=`, `POST /api/workflow/run/update` `{id, patch}`, `POST /api/workflow/run-step` `{runId, key, patch}` (upsert), `POST /api/workflow/run/lease` `{id, owner, takeover?}`. Cancel is a client-side `run/update` (status + annotation) + per-step writes, not a dedicated rule.
6. **Run list is scoped and simple in M1:** `GET /api/workflow/runs` requires `impl`+`workflow` (every 08 screen that lists runs is per-workflow), returns the latest 50; `status` filtering and sorting happen client-side. Cursor pagination (`before`) is deferred.
7. **Three schemas, not two.** `workflow_runs`, `workflow_run_steps`, plus `workflow_files` — `register_upload` requires a `schemaId` to write its upload record. 06's "two schemas, ~10 rules" was an estimate; noted as a benign deviation.
8. **File-serve URL shape:** `path` is the full storage key (`workflows/<impl>/<workflow>/…`); the minted `url` is `/api/workflow/files/<path minus the leading "workflows/">` because the serve rule's `file_serve_handler` is configured `subDir: workflows` (mirrors studio-blog's serve rule). The spec's example url embeds `workflows/` once more; the URL shape is harness-minted and opaque to everyone else, so this is ours to choose. Per-input `accept`/`maxSize` are enforced client-side in M1 (the `presigned_upload` config is static YAML; a 100 MB static cap applies server-side).
9. **No release-please component for `apps/workflow` in M1.** The app ships no `bffless-app.json` (catalog packaging is M4), and `checkReleaseComponents` in `scripts/check-app-conventions.mjs` **errors** when a component exists for an app without a manifest. `apps/workflow/package.json` stays `"private": true, "version": "0.0.0"`.
10. **Renderers in M1 = the default viewers only** (string/number/boolean chips, file cards with Download + content-type players, table, rendered markdown, JSON tree). Named renders (`transcript`, `chart`, `images`, `code`, `island`) render as their base type with a small "renderer: <name> (M2)" badge. Hello uses none of them.
11. **⚑ CONFIRMED — Live deploy (Task 22) is INCLUDED in M1, `workflow_dispatch`-only.** Gated on provisioning: the `bffless/workflow` project on j5s.dev, its `workflow` + `hello` aliases/domains, and a `BFFLESS_WORKFLOW_API_KEY` Actions secret. Execution note: project/alias/domain/API-key creation is likely doable via the session's j5s MCP tools and `gh secret set` (gh is authed) — attempt that first and only ask the user to authenticate if something actually requires it (they asked to be told if auth is needed).
12. **Engine internals not in 05's persisted-event list** (`job.expanded`) are *derived* events: emitted live and re-derived on replay from the recorded inputs/outputs (matrix expansion is deterministic), never persisted — keeping "job-level state is derived" (05) intact.
13. **Deferred out of M1, explicitly:** `island`/`script` step kinds and `render: island` (M2); `headless` execution incl. `?auto=1` (M3 — but `data-testid`/`data-state` contracts ship now per 08); the >1 MB `{"$file": …}` payload offload (05) — M1 trims `response` at 256 KB with a `truncated` flag, and hello's payloads are tiny; run deletion is deferred **entirely** — the delete rule and the file-prefix GC ship together in M2, so the 08 header's Delete action does not appear in M1; data-flow edge hover-highlighting on the graph (M1 draws structural `needs` edges + "from/goes to" chip labels in the panes, not the animated cross-highlight).

## Global Constraints

- Monorepo: pnpm 10 workspace `bffless-apps`; Node `>=20`; ESM only; TypeScript `~6.0.2`.
- **Shared checkout is read-only.** All work in a worktree: `git worktree add .claude/worktrees/workflow-m1-<phase> -b <branch> origin/main` from `/home/rico/bffless/repos/apps`. Never commit on the main checkout; verify `git rev-parse --show-toplevel` ends in the worktree path before the first commit.
- **Three sequential PRs, one per phase**, each squash-merged (the PR title IS the release-please commit — conventional, scope `workflow`): Phase 1 `feat(workflow): harness scaffold, rule set and pure run engine`; Phase 2 `feat(workflow): discovery, browsing and read-only runs`; Phase 3 `feat(workflow): live runner, resume and the hello smoke`. Push every commit before opening each PR; re-check merge state before pushing follow-ups (the user merges fast).
- One parser: all expression evaluation via `@bffless/workflow-lint/expressions`; all definition typing via `/definition`; validation/lint via the new `/lint` entry (Task 3). **No second parser, no `eval`.**
- `src/lib/runner/**` imports nothing from React, Redux, MSW, or `src/` outside `lib/` — enforced by an eslint `no-restricted-imports` block (Task 4).
- Persisted step keys are `"<job>/<index>/<step>"`, index `0` for non-matrix jobs (05). Step statuses: `queued running polling waiting succeeded failed skipped cancelled`; run statuses: `running succeeded failed cancelled`.
- Lease numbers (05): heartbeat every **15 s**, `lease_until = now + 60 s`.
- `response` rows trimmed to **256 KB** (JSON-serialized) with `truncated: true`.
- Durations grammar: `^[0-9]+(ms|s|m|h)$`.
- All `/api/workflow/*` rules carry `validators: [{ type: auth_required, config: { allowApiKey: true } }]` except the `/api/auth/[...path]` relay (D14).
- UI contract (08/07): `data-testid`s `implementations`, `workflow-list`, `kickoff-form`, `kickoff-start`, `run-status`, `step`, `run-outputs`; state via `data-state`. Renaming any is a Playwright-breaking change.
- Conventions check must pass from the first commit that adds `apps/workflow/package.json`: the authored rule set + `apps/workflow/bffless/README.md` (with "Manual setup (admin panel)" and "First-success checkpoint" headings) land in Task 1, the package.json in Task 2. `pnpm apps:check` green at the end of every task from Task 2 on.
- Summaries are markdown, HTML never interpreted (05): `renderMarkdown()` escapes raw HTML tokens.
- Commit after every task; run `pnpm --filter workflow lint && pnpm --filter workflow test:run` before each commit (plus `pnpm --filter @bffless/workflow-lint test:run` when Task 3 touches it).

## File structure

```
apps/workflow/
  package.json  vite.config.ts  tsconfig.json  tsconfig.node.json  eslint.config.js  index.html
  bffless/README.md                          ← conventions: Manual setup + First-success checkpoint
  .bffless/proxy-rules/
    workflow/                                ← the harness rule set (spec 05/06)
      ruleset.yaml
      schemas/workflow_runs.schema.yaml
      schemas/workflow_run_steps.schema.yaml
      schemas/workflow_files.schema.yaml
      rules/api/workflow/runs/post/rule.yaml           create run
      rules/api/workflow/runs/get/rule.yaml            list runs (impl+workflow)
      rules/api/workflow/run/get/{rule.yaml,shape.fn.js}   run + step rows
      rules/api/workflow/run/update/post/{rule.yaml,merge.fn.js}
      rules/api/workflow/run-step/post/{rule.yaml,merge.fn.js}   upsert by (runId,key)
      rules/api/workflow/run/lease/post/{rule.yaml,gate.fn.js}
      rules/api/workflow/files/prepare/post/rule.yaml
      rules/api/workflow/files/register/post/{rule.yaml,shape.fn.js}
      rules/api/workflow/files/[...path]/get.rule.yaml
      rules/api/auth/[...path]/any.rule.yaml           SuperTokens relay (D14)
    hello/                                   ← the M1 test implementation's backend (Task 19)
      ruleset.yaml
      schemas/hello_jobs.schema.yaml
      rules/api/hello/echo/post/{rule.yaml,echo.fn.js}
      rules/api/hello/slow/post/{rule.yaml,work.fn.js}
      rules/api/hello/job/get/{rule.yaml,shape.fn.js}
      rules/api/hello/fail/post/rule.yaml
      rules/w/hello/[...path]/get.rule.yaml            forwarding rule (live only)
  scripts/stage-hello.mjs                    ← builds hello-dist/ (.bffless/workflows + index.json)
  e2e/hello.spec.ts  playwright.config.ts
  src/
    main.tsx  App.tsx  index.css
    lib/
      runner/                                ← PURE (no React/Redux/network) — spec 09
        types.ts        RunState/StepState/RunEvent/FileRef/StepError/Annotation/…
        ids.ts          newRunId() (run_<ulid>), newOwnerId()
        durations.ts    parseDuration()
        definition.ts   loadWorkflow() over @bffless/workflow-lint/lint
        contexts.ts     buildContexts(), statusFns(), evalDeep(), evalIf(), evalString()
        graph.ts        topoLayers(), expandMatrix(), jobResult(), dataFlowEdges()
        transitions.ts  STEP_TRANSITIONS, assertTransition()
        reducer.ts      initialRunState(), runReducer()
        next.ts         nextActions()
        outputs.ts      coerceOutputs(), OUTPUT_TYPE validation
        results.ts      evalSummary(), evalAnnotations()
        rows.ts         RunRow/StepRow, eventToWrites(), rowsToEvents()
        replay.ts       replayRun()
        adapters/pipeline.ts   runPipelineStep() (fetch+poll+retry+cancel)
        adapters/form.ts       completeFormStep()
      coerce.ts         toIndexJson()/toRunRow()/toStepRow()/toFileRef()/toAliasList()
      markdown.ts       renderMarkdown() (HTML-escaping)
      http.ts           httpJson(): HttpJson over fetch (same-origin, cookies)
      runStore.ts       RunStore over /api/workflow/* (imperative writes)
      upload.ts         uploadFile(): prepare → PUT → register
    store/
      index.ts  hooks.ts
      workflowApi.ts    RTK Query (reads + discovery)
      runSlice.ts       the live RunState + event action
      uiSlice.ts        selected step, filters, theme
      runnerMiddleware.ts   THE one listener middleware (persist → schedule → adapters)
    mocks/
      config.ts  browser.ts  server.ts (node, for vitest)
      handlers.ts  db.ts  fixtures/finishedRun.ts
    components/
      Shell.tsx  EmptyState.tsx  StatusPill.tsx  AnnotationList.tsx
      graph/GraphView.tsx  graph/JobCard.tsx  graph/StepChip.tsx
      values/ValueView.tsx  values/FileCard.tsx  values/JsonTree.tsx  values/TableView.tsx  values/MarkdownView.tsx
      kickoff/KickoffForm.tsx  kickoff/FieldControl.tsx
      run/StepPane.tsx  run/RunHeader.tsx  run/RunOutputs.tsx  run/RunSummary.tsx  run/FormStepPane.tsx
    pages/
      ImplementationsPage.tsx  WorkflowsPage.tsx  WorkflowPage.tsx  KickoffPage.tsx
      RunsPage.tsx  RunPage.tsx  FilePage.tsx
    test/setup.ts
packages/workflow-lint/          (Task 3 only)
  src/lint.ts                    lintSource + loadDefinition, fs-free
  src/index.ts                   re-exports + lintFile (node)
  package.json                   + "./lint" export
.github/workflows/workflow-app.yml     build + lint + unit + e2e smoke
.github/workflows/deploy-workflow.yml  (Task 22, dispatch-only)
docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md   (this plan, committed in Phase 1)
```

## Traceability — M1 scope → tasks

| M1 scope item (00-overview) | Spec | Tasks |
|---|---|---|
| Discovery (alias probing + index.json) | 06, ADR-0004 | 11, 12 |
| Parse/validate via workflow-lint | 09 | 3, 4, 14 |
| Workflow graph view (definition mode) | 08 | 7 (layout), 14 |
| Kickoff form (+ file uploads on select) | 02, 06, 08 | 16 |
| `pipeline` steps with `poll`/`retry` | 03 | 10, 17 |
| Run persistence (event-sourced rows) | 05 | 1, 9, 17 |
| Resume with lease (+ take-over, read-only live view) | 05 | 1 (lease rule), 9 (replay), 19 |
| Run page (Input/Output panes, run mode graph) | 08 | 13, 15, 18 |
| Summaries / annotations | 05, 01 | 8, 15, 17 |
| Test implementation workflow-hello | 00, examples/hello | 11 (mocks), 20 (real rules), 21 (smoke) |
| Conventions (rule set + bffless README) | apps#85 | 1, 2 |
| One Playwright smoke | 09 | 21 |
| Live deploy (severable) | 06 phase 1 | 22 |

---

# Phase 1 — Backend contract + the pure engine

*Branch `feat/workflow-m1-engine`. Deliverable: the authored `workflow` rule set, a buildable app shell passing `pnpm apps:check`, a browser-safe workflow-lint entry, and the fully unit-tested `lib/runner` (reducer, transitions, next, replay, adapters) — no UI beyond a placeholder.*

### Task 1: The harness rule set (`workflow`) + conventions README

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/workflow/ruleset.yaml`
- Create: `apps/workflow/.bffless/proxy-rules/workflow/schemas/workflow_runs.schema.yaml`, `…/workflow_run_steps.schema.yaml`, `…/workflow_files.schema.yaml`
- Create: the 10 rule files listed in *File structure* under `workflow/rules/`
- Create: `apps/workflow/bffless/README.md`
- Create: `docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md` (this plan)

**Interfaces:**
- Consumes: spec 05 (tables, write path), 06 (files trio, access), studio/handoff authored-rule precedents.
- Produces: the HTTP API of Decision 5/8 that `RunStore` (Task 17), `upload.ts` (Task 16) and the MSW mocks (Task 11) implement against. No tests run yet (the dir is still spec-only to `apps:check`); Task 2's fence test covers these files.

- [ ] **Step 1: Worktree**

```bash
cd /home/rico/bffless/repos/apps
git fetch origin
git worktree add .claude/worktrees/workflow-m1 -b feat/workflow-m1-engine origin/main
cd .claude/worktrees/workflow-m1 && git rev-parse --show-toplevel   # must end /workflow-m1
```

- [ ] **Step 2: Schemas**

`apps/workflow/.bffless/proxy-rules/workflow/ruleset.yaml`:

```yaml
name: workflow
description: Workflow harness backend — run records (event-sourced rows), lease, and the files trio (prepare/register/serve). Spec: apps/workflow/docs/spec/05 + 06.
```

`schemas/workflow_runs.schema.yaml`:

```yaml
name: workflow_runs
fields:
  - { name: runId, type: string, required: true }
  - { name: impl, type: string, required: true }
  - { name: workflow, type: string, required: true }
  - { name: workflowName, type: string, required: true }
  - { name: workflowVersion, type: string, required: false }
  - { name: definition, type: json, required: true }
  - { name: yaml, type: text, required: true }
  - { name: inputs, type: json, required: false }
  - { name: status, type: string, required: true }
  - { name: headless, type: boolean, required: false }
  - { name: startedBy, type: string, required: false }
  - { name: startedAt, type: number, required: true }
  - { name: finishedAt, type: number, required: false }
  - { name: leaseOwner, type: string, required: false }
  - { name: leaseUntil, type: number, required: false }
  - { name: outputs, type: json, required: false }
  - { name: annotations, type: json, required: false }
```

`schemas/workflow_run_steps.schema.yaml`:

```yaml
name: workflow_run_steps
fields:
  - { name: runId, type: string, required: true }
  - { name: key, type: string, required: true }
  - { name: job, type: string, required: true }
  - { name: index, type: number, required: true }
  - { name: step, type: string, required: true }
  - { name: kind, type: string, required: true }
  - { name: status, type: string, required: true }
  - { name: attempt, type: number, required: false }
  - { name: inputs, type: json, required: false }
  - { name: response, type: json, required: false }
  - { name: outputs, type: json, required: false }
  - { name: error, type: json, required: false }
  - { name: summary, type: text, required: false }
  - { name: annotations, type: json, required: false }
  - { name: startedAt, type: number, required: false }
  - { name: finishedAt, type: number, required: false }
  - { name: heartbeatAt, type: number, required: false }
```

`schemas/workflow_files.schema.yaml` (the `register_upload` record table):

```yaml
name: workflow_files
fields:
  - { name: fileName, type: string, required: false }
  - { name: storagePath, type: string, required: false }
  - { name: contentType, type: string, required: false }
  - { name: size, type: number, required: false }
```

- [ ] **Step 3: Run-record rules**

`rules/api/workflow/runs/post/rule.yaml` (create — one `data_create`, all columns from the body):

```yaml
targetUrl: pipeline
order: 10
pipeline:
  name: Create workflow run
  description: "Insert the workflow_runs row at run start (event run.started, spec 05). The client sends the full row: runId, definition snapshot, yaml text, inputs (File refs), lease fields."
  steps:
    - id: create
      name: create
      handler: data_create
      config:
        schemaId: $schema:workflow_runs
        fields:
          runId: request.body.runId
          impl: request.body.impl
          workflow: request.body.workflow
          workflowName: request.body.workflowName
          workflowVersion: request.body.workflowVersion
          definition: request.body.definition
          yaml: request.body.yaml
          inputs: request.body.inputs
          status: request.body.status
          headless: request.body.headless
          startedBy: user.id
          startedAt: request.body.startedAt
          leaseOwner: request.body.leaseOwner
          leaseUntil: request.body.leaseUntil
          annotations: request.body.annotations
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.create}}}"
        status: 200
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Create a workflow run row (run.started). auth_required; startedBy from the session."
```

`rules/api/workflow/runs/get/rule.yaml` (list, Decision 6):

```yaml
targetUrl: pipeline
order: 11
pipeline:
  name: List workflow runs
  description: "Latest 50 workflow_runs rows for one (impl, workflow). Status filtering and sorting are client-side in M1 (Decision 6)."
  steps:
    - id: query
      name: query
      handler: data_query
      config:
        schemaId: $schema:workflow_runs
        pageSize: 50
        filters:
          impl: { op: eq, value: request.query.impl }
          workflow: { op: eq, value: request.query.workflow }
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.query}}}"
        status: 200
        headers: { Cache-Control: no-store }
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "List runs of one workflow (members see all runs, D14). no-store: run lists must never be stale."
```

`rules/api/workflow/run/get/rule.yaml` (run + all step rows):

```yaml
targetUrl: pipeline
order: 12
pipeline:
  name: Get workflow run record
  description: "One run row + every step row — what the run page, Resume and read-only views rebuild state from (spec 05)."
  steps:
    - id: run
      name: run
      handler: data_query
      config:
        schemaId: $schema:workflow_runs
        pageSize: 1
        filters:
          runId: { op: eq, value: request.query.id }
    - id: steps
      name: steps
      handler: data_query
      config:
        schemaId: $schema:workflow_run_steps
        pageSize: 1000
        filters:
          runId: { op: eq, value: request.query.id }
    - id: shape
      name: shape
      handler: function_handler
      code: ./shape.fn.js
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.shape}}}"
        status: 200
        headers: { Cache-Control: no-store }
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Run record: { run, steps } or { run: null, steps: [] } when the id is unknown."
```

`rules/api/workflow/run/get/shape.fn.js`:

```js
// Merge the two queries into { run, steps }. Tolerate both result envelopes
// (records vs data) the data_query handler has used across CE versions.
const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const runRows = rows(steps.run)
const stepRows = rows(steps.steps)
return { run: runRows[0] || null, steps: stepRows }
```

`rules/api/workflow/run/update/post/rule.yaml` (Decision 5 — read, merge, write all columns):

```yaml
targetUrl: pipeline
order: 13
pipeline:
  name: Update workflow run
  description: "POST { id, patch } — read-merge-write the workflow_runs row. Writing the full merged column set keeps data_update deterministic (no partial-field semantics to rely on)."
  steps:
    - id: find
      name: find
      handler: data_query
      config:
        schemaId: $schema:workflow_runs
        pageSize: 1
        filters:
          runId: { op: eq, value: request.body.id }
    - id: merge
      name: merge
      handler: function_handler
      code: ./merge.fn.js
    - id: update
      name: update
      handler: data_update
      config:
        schemaId: $schema:workflow_runs
        recordId: steps.merge.recordId
        condition: steps.merge.found
        fields:
          status: steps.merge.fields.status
          finishedAt: steps.merge.fields.finishedAt
          leaseOwner: steps.merge.fields.leaseOwner
          leaseUntil: steps.merge.fields.leaseUntil
          outputs: steps.merge.fields.outputs
          annotations: steps.merge.fields.annotations
    - id: notFound
      name: notFound
      handler: response_handler
      config:
        condition: steps.merge.missing
        body: '{"error":"run not found","code":"NOT_FOUND"}'
        status: 404
        contentType: application/json
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: '{"ok":true}'
        status: 200
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Patch a run row (status, finishedAt, lease, outputs, annotations). Two terminal response branches — fine in rules-as-code (the admin UI bug ce#502 does not apply)."
```

`rules/api/workflow/run/update/post/merge.fn.js`:

```js
const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const row = rows(steps.find)[0] || null
const patch = request.body.patch || {}
// Only these columns are patchable post-create; everything else is immutable (D16 snapshot).
const KEYS = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations']
const fields = {}
for (const k of KEYS) {
  fields[k] = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : (row ? row[k] : null)
}
return { found: !!row, missing: !row, recordId: row ? row.id : null, fields }
```

`rules/api/workflow/run-step/post/rule.yaml` (upsert by `(runId, key)`):

```yaml
targetUrl: pipeline
order: 14
pipeline:
  name: Upsert workflow run step
  description: "POST { runId, key, patch } — one row per (job, matrix index, step); spec 05 write path. Query by (runId,key), then create or read-merge-write."
  steps:
    - id: find
      name: find
      handler: data_query
      config:
        schemaId: $schema:workflow_run_steps
        pageSize: 1
        filters:
          runId: { op: eq, value: request.body.runId }
          key: { op: eq, value: request.body.key }
    - id: merge
      name: merge
      handler: function_handler
      code: ./merge.fn.js
    - id: create
      name: create
      handler: data_create
      config:
        schemaId: $schema:workflow_run_steps
        condition: steps.merge.create
        fields:
          runId: steps.merge.fields.runId
          key: steps.merge.fields.key
          job: steps.merge.fields.job
          index: steps.merge.fields.index
          step: steps.merge.fields.step
          kind: steps.merge.fields.kind
          status: steps.merge.fields.status
          attempt: steps.merge.fields.attempt
          inputs: steps.merge.fields.inputs
          response: steps.merge.fields.response
          outputs: steps.merge.fields.outputs
          error: steps.merge.fields.error
          summary: steps.merge.fields.summary
          annotations: steps.merge.fields.annotations
          startedAt: steps.merge.fields.startedAt
          finishedAt: steps.merge.fields.finishedAt
          heartbeatAt: steps.merge.fields.heartbeatAt
    - id: update
      name: update
      handler: data_update
      config:
        schemaId: $schema:workflow_run_steps
        condition: steps.merge.update
        recordId: steps.merge.recordId
        fields:
          status: steps.merge.fields.status
          attempt: steps.merge.fields.attempt
          inputs: steps.merge.fields.inputs
          response: steps.merge.fields.response
          outputs: steps.merge.fields.outputs
          error: steps.merge.fields.error
          summary: steps.merge.fields.summary
          annotations: steps.merge.fields.annotations
          startedAt: steps.merge.fields.startedAt
          finishedAt: steps.merge.fields.finishedAt
          heartbeatAt: steps.merge.fields.heartbeatAt
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: '{"ok":true}'
        status: 200
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Upsert one step row keyed <job>/<index>/<step>. The lease serializes writers, so query-then-write is race-safe in practice."
```

`rules/api/workflow/run-step/post/merge.fn.js`:

```js
const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const row = rows(steps.find)[0] || null
const patch = request.body.patch || {}
const base = row || {
  runId: request.body.runId, key: request.body.key,
  job: null, index: 0, step: null, kind: null,
  status: 'queued', attempt: 1, inputs: null, response: null, outputs: null,
  error: null, summary: null, annotations: null,
  startedAt: null, finishedAt: null, heartbeatAt: null,
}
const fields = { ...base }
delete fields.id
for (const k of Object.keys(patch)) fields[k] = patch[k]
fields.runId = request.body.runId
fields.key = request.body.key
return { create: !row, update: !!row, recordId: row ? row.id : null, fields }
```

`rules/api/workflow/run/lease/post/rule.yaml`:

```yaml
targetUrl: pipeline
order: 15
pipeline:
  name: Acquire or renew run lease
  description: "POST { id, owner, takeover? }. Grants when unheld, expired, already ours, or takeover — sets lease_until = now + 60s (spec 05 Resume)."
  steps:
    - id: find
      name: find
      handler: data_query
      config:
        schemaId: $schema:workflow_runs
        pageSize: 1
        filters:
          runId: { op: eq, value: request.body.id }
    - id: gate
      name: gate
      handler: function_handler
      code: ./gate.fn.js
    - id: grant
      name: grant
      handler: data_update
      config:
        schemaId: $schema:workflow_runs
        condition: steps.gate.ok
        recordId: steps.gate.recordId
        fields:
          leaseOwner: steps.gate.owner
          leaseUntil: steps.gate.leaseUntil
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.gate.result}}}"
        status: 200
        headers: { Cache-Control: no-store }
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Lease acquire/heartbeat/release-by-expiry. Response { ok, leaseUntil, heldBy }."
```

`rules/api/workflow/run/lease/post/gate.fn.js`:

```js
const rows = (r) => (r && (r.records || r.data || r.rows)) || []
const row = rows(steps.find)[0] || null
const now = Date.now()
const owner = String(request.body.owner || '')
const takeover = request.body.takeover === true
if (!row) return { ok: false, recordId: null, owner, leaseUntil: 0, result: { ok: false, error: 'run not found' } }
const held = row.leaseOwner && typeof row.leaseUntil === 'number' && row.leaseUntil > now
const ok = takeover || !held || row.leaseOwner === owner
const leaseUntil = now + 60000
return {
  ok, recordId: row.id, owner, leaseUntil,
  result: ok ? { ok: true, leaseUntil } : { ok: false, heldBy: row.leaseOwner, leaseUntil: row.leaseUntil },
}
```

- [ ] **Step 4: Files trio + auth relay**

`rules/api/workflow/files/prepare/post/rule.yaml` (06 — presigned PUT into the harness-owned prefix; `scope` is `"inputs"` or `"runs/<runId>/<stepKey>"`, normalized by the client):

```yaml
targetUrl: pipeline
order: 20
pipeline:
  name: Prepare workflow file upload
  description: "Mint a presigned PUT under workflows/<impl>/<workflow>/<scope>/ (D7/D18). Per-input accept/maxSize are enforced client-side in M1; the static 100 MB cap is the server backstop."
  steps:
    - id: prepare
      name: prepare
      handler: presigned_upload
      config:
        subDir: workflows/{{request.body.impl}}/{{request.body.workflow}}/{{request.body.scope}}
        filename: request.body.filename
        expiresIn: 3600
        maxFileSize: 104857600
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.prepare}}}"
        status: 200
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Files trio 1/3: presigned PUT for kickoff/form uploads and registered pipeline outputs."
```

`rules/api/workflow/files/register/post/rule.yaml`:

```yaml
targetUrl: pipeline
order: 21
pipeline:
  name: Register workflow file
  description: "Verify the uploaded object and return the File ref { path, name, contentType, size, url } (spec 02). The record row lands in workflow_files."
  steps:
    - id: register
      name: register
      handler: register_upload
      config:
        subDir: workflows/{{request.body.impl}}/{{request.body.workflow}}/{{request.body.scope}}
        schemaId: $schema:workflow_files
        storageKey: request.body.storageKey
        originalName: request.body.originalName
        maxFileSize: 104857600
    - id: shape
      name: shape
      handler: function_handler
      code: ./shape.fn.js
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.shape}}}"
        status: 200
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Files trio 2/3: finalize a direct-to-bucket upload into a File ref."
```

`rules/api/workflow/files/register/post/shape.fn.js`:

```js
// Normalize the register_upload result to the spec-02 File ref.
const r = steps.register || {}
const path = r.storagePath || r.path || r.storageKey || ''
const name = r.fileName || r.originalName || path.split('/').pop() || 'file'
const url = '/api/workflow/files/' + path.replace(/^workflows\//, '')
return { path, name, contentType: r.contentType || 'application/octet-stream', size: r.size || 0, url }
```

`rules/api/workflow/files/[...path]/get.rule.yaml`:

```yaml
targetUrl: pipeline
order: 22
pipeline:
  name: Serve workflow files
  description: "Files trio 3/3: Range-aware serve of the workflows/ prefix (video seeking); Content-Disposition attachment on ?download=1."
  steps:
    - id: serve
      name: serve
      handler: file_serve_handler
      config:
        subDir: workflows
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "auth_required file serving from the harness-owned run storage."
```

`rules/api/auth/[...path]/any.rule.yaml` (verbatim studio pattern, D14):

```yaml
targetUrl: http://localhost:3000/api/auth
order: 23
forwardCookies: true
description: 'Reverse-proxy SuperTokens auth endpoints to the CE backend so this subdomain app can refresh the sAccessToken session. forwardCookies carries the path-scoped sRefreshToken and relays the rotated Set-Cookie back (same rule Studio/Recall ship).'
```

> **Fallback design (Decision 4, build only if the discovery assumption fails at Task 22):** `rules/api/workflow/aliases/get/rule.yaml` — a forwarding rule `targetUrl: http://localhost:3000/api/aliases`, `forwardCookies: true`, `auth_required` — the same localhost-backend relay shape as the auth rule.

- [ ] **Step 5: `apps/workflow/bffless/README.md`** (the two headings are matched by `scripts/check-app-conventions.mjs` — keep the exact wording):

```markdown
# Workflow harness backend — BFFless proxy rule sets

Two authored sets: `workflow` (run records, lease, files trio — spec 05/06) and, from M1
Phase 3, `hello` (the workflow-hello test implementation: echo, slow+poll, fail).

## Manual setup (admin panel)

- **Project**: the harness expects its own BFFless project (phase 1: `bffless/workflow` on
  j5s.dev) — discovery lists *this project's* aliases, so co-tenanting with unrelated apps
  only adds harmless 404 probes.
- **Aliases + domains**: alias `workflow` (the harness SPA) on `workflow.<domain>`, alias
  `hello` (the test implementation bundle) on `hello.<domain>`. Attach rule set `workflow`
  to alias `workflow`; attach rule set `hello` to BOTH aliases (ADR-0001 single origin).
- **Storage**: a default storage backend must be configured (bucket or local ≥ CE 0.3.15) —
  the files trio (presigned PUT → register → serve) is the upload path.
- **External connections / AI tokens**: none. **Secrets**: none.
- **Response-header rules**: none in M1 (COOP/COEP only becomes relevant with M2 scripts).
- The `/w/hello/[...path]` forwarding rule bakes `targetUrl: https://hello.j5s.dev` — edit it
  for a different install domain (CE follow-up `targetUrl: alias://hello` removes this).

## First-success checkpoint

Open `workflow.<domain>`, sign in as a project member: the Implementations screen lists
**hello**. Open *Hello workflow* → Start a run with the defaults → the run page shows
`greet` fan out, `slow` poll to done, `flaky` fail-then-recover, submit the confirm form →
run status **succeeded** with `report`, `poster`, `lines` under Outputs.
```

- [ ] **Step 6: Copy this plan into the repo** at `docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md`.

- [ ] **Step 7: Verify + commit**

```bash
# YAML sanity for every authored file (the vitest fence arrives with the package in Task 2):
node --input-type=module -e "
import { globSync, readFileSync } from 'node:fs'
const { parse } = await import('yaml')   // hoisted from the pnpm store; else: npx yaml not needed — any workspace has it
const files = globSync('apps/workflow/.bffless/proxy-rules/workflow/**/*.yaml')
for (const f of files) parse(readFileSync(f, 'utf8'))
console.log(files.length, 'yaml files parse cleanly')
"
pnpm apps:check       # workflow still listed as spec-only (no package.json yet) — that is expected
git add apps/workflow docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md
git commit -m "feat(workflow): harness rule set (runs, lease, files trio) + conventions README"
git push -u origin feat/workflow-m1-engine
```

### Task 2: App scaffold — package.json binds the conventions check

**Files:**
- Create: `apps/workflow/package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `eslint.config.js`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `src/test/setup.ts`
- Create: `apps/workflow/src/rules.fence.test.ts`
- Modify: root `package.json` (workflow:* scripts)
- Create: `.github/workflows/workflow-app.yml`

**Interfaces:**
- Consumes: Task 1's rule files (the fence test parses them).
- Produces: `pnpm --filter workflow dev|build|lint|test:run|test:e2e` targets every later task uses; `pnpm apps:check` green with `workflow` as a real app.

- [ ] **Step 1: Write the failing test** — `apps/workflow/src/rules.fence.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const SET = join(__dirname, '..', '.bffless', 'proxy-rules', 'workflow')
const KNOWN = new Set(['data_query', 'data_create', 'data_update', 'function_handler',
  'response_handler', 'presigned_upload', 'register_upload', 'file_serve_handler'])

function ruleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return ruleFiles(p)
    return /rule\.yaml$/.test(n) ? [p] : []
  })
}

describe('workflow rule set fence', () => {
  const files = ruleFiles(join(SET, 'rules'))
  it('ships the full API surface', () => {
    const rel = files.map((f) => f.slice(SET.length))
    expect(rel.some((p) => p.includes('/runs/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/runs/get/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/get/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/update/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run-step/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/lease/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/prepare/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/register/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/[...path]/'))).toBe(true)
    expect(rel.some((p) => p.includes('/api/auth/'))).toBe(true)
  })
  it.each(files)('%s parses, uses known handlers, and gates auth', (file) => {
    const doc = parse(readFileSync(file, 'utf8'))
    expect(doc.targetUrl).toBeDefined()
    if (doc.targetUrl !== 'pipeline') return // forwarding rules (auth relay) are exempt
    for (const s of [...(doc.pipeline.steps ?? []), ...(doc.pipeline.postSteps ?? [])]) {
      expect(KNOWN.has(s.handler), `${file}: ${s.handler}`).toBe(true)
    }
    const validators = doc.pipeline.validators ?? []
    expect(validators.some((v: { type: string }) => v.type === 'auth_required'),
      `${file} must be auth_required (D14)`).toBe(true)
  })
  it('ships the three schemas', () => {
    for (const s of ['workflow_runs', 'workflow_run_steps', 'workflow_files']) {
      const doc = parse(readFileSync(join(SET, 'schemas', `${s}.schema.yaml`), 'utf8'))
      expect(doc.name).toBe(s)
    }
  })
})
```

- [ ] **Step 2: Scaffold.** `apps/workflow/package.json`:

```json
{
  "name": "workflow",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest",
    "test:run": "vitest run",
    "test:e2e": "playwright test"
  },
  "msw": { "workerDirectory": ["public"] },
  "dependencies": {
    "@bffless/workflow-lint": "workspace:*",
    "@reduxjs/toolkit": "^2.12.0",
    "marked": "^16.4.2",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "react-redux": "^9.3.0",
    "react-router-dom": "^7.9.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@playwright/test": "1.61.1",
    "@testing-library/dom": "^10.4.1",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@types/node": "^24.12.3",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "eslint": "^10.3.0",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.2",
    "globals": "^17.6.0",
    "jsdom": "^29.1.1",
    "msw": "^2.14.6",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.59.2",
    "vite": "^8.0.12",
    "vitest": "^4.1.7",
    "yaml": "^2.8.0"
  }
}
```

`apps/workflow/vite.config.ts` (studio's proxy pattern, workflow host):

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import https from 'node:https'

const upstreamAgent = new https.Agent({ keepAlive: false })
const proxy = {
  '/api': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
  '/w': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
  '/_bffless': { target: 'https://workflow.j5s.dev', changeOrigin: true, secure: true, agent: upstreamAgent },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
```

`index.html` (title **Workflow**, `<div id="root">`, module script `/src/main.tsx`), `src/index.css` (reset + theme tokens; plain CSS, no Tailwind), `src/test/setup.ts` (`import '@testing-library/jest-dom'`), `tsconfig.json`/`tsconfig.node.json` and `eslint.config.js` copied from `apps/studio` (drop the ffmpeg-specific bits; eslint adds the Task 4 purity fence later). `src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`src/App.tsx` (placeholder until Task 11):

```tsx
export default function App() {
  return <main data-testid="implementations">Workflow harness — under construction (M1)</main>
}
```

Root `package.json` — add to `scripts`:

```json
"workflow:dev": "pnpm --filter workflow dev",
"workflow:build": "pnpm --filter workflow build",
"workflow:lint": "pnpm --filter workflow lint",
"workflow:test": "pnpm --filter workflow test:run"
```

`.github/workflows/workflow-app.yml`:

```yaml
name: workflow-app
on:
  pull_request:
    paths: ['apps/workflow/**', 'packages/workflow-lint/**', '.github/workflows/workflow-app.yml']
  workflow_dispatch:
permissions: { contents: read }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @bffless/workflow-lint build
      - run: pnpm --filter workflow lint
      - run: pnpm --filter workflow test:run
      - run: pnpm --filter workflow build
      # e2e steps added in Task 21
```

- [ ] **Step 3: Install and run the fence test**

```bash
pnpm install
pnpm --filter workflow test:run   # fence test PASSES against Task 1's files
pnpm apps:check                   # ✓ workflow (rule set + README from Task 1)
pnpm --filter workflow build && pnpm --filter workflow lint
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(workflow): app scaffold, CI workflow, rule-set fence test" && git push
```

### Task 3: Browser-safe workflow-lint entry + `loadDefinition`

**Files:**
- Create: `packages/workflow-lint/src/lint.ts`
- Modify: `packages/workflow-lint/src/index.ts`, `packages/workflow-lint/package.json` (exports)
- Test: `packages/workflow-lint/test/load-definition.test.ts`

**Interfaces:**
- Consumes: existing `lintSource` internals (`loadYaml`, `validateDefinition`, `toDefinition`, `collectSites`, `runChecks`).
- Produces: `import { lintSource, loadDefinition, type LoadResult } from '@bffless/workflow-lint/lint'` — fs-free, importable by Vite browser builds. `loadDefinition(source: string, opts?: { file?: string }): LoadResult` where `LoadResult = { def: Definition | null; findings: Finding[]; counts: Counts }` (`def` is `null` iff any `yaml-parse` or `schema` finding exists). Root export unchanged for node consumers (`lintFile` keeps `node:fs`).

- [ ] **Step 1: Write the failing test** — `packages/workflow-lint/test/load-definition.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDefinition } from '../src/lint.js'

const hello = readFileSync(new URL('../../../apps/workflow/docs/spec/examples/hello.workflow.yaml', import.meta.url), 'utf8')

describe('loadDefinition', () => {
  it('returns the typed definition for a valid workflow', () => {
    const { def, findings } = loadDefinition(hello, { file: 'hello.workflow.yaml' })
    expect(def).not.toBeNull()
    expect(Object.keys(def!.jobs)).toEqual(['greet', 'slow', 'flaky', 'confirm'])
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })
  it('returns def null on schema failure, with findings', () => {
    const { def, findings } = loadDefinition('name: x\njobs: {}\n')
    expect(def).toBeNull()
    expect(findings.some((f) => f.rule === 'schema')).toBe(true)
  })
  it('the /lint module never imports node:fs', () => {
    const src = readFileSync(new URL('../src/lint.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/node:fs/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @bffless/workflow-lint test:run` → FAIL (`src/lint.ts` missing).

- [ ] **Step 3: Implement.** Move the body of `lintSource` from `src/index.ts` into `src/lint.ts` unchanged (with its imports of `loadYaml`, `validateDefinition`, `toDefinition`, `collectSites`, `runChecks`, `findings.js` — none touch `node:fs`), and add:

```ts
export interface LoadResult {
  def: Definition | null
  findings: Finding[]
  counts: Counts
}

/** lintSource + the typed Definition when the document is structurally valid (M1 harness entry). */
export function loadDefinition(source: string, opts: { file?: string } = {}): LoadResult {
  const res = lintSource(source, opts)
  const fatal = res.findings.some((f) => f.rule === 'yaml-parse' || f.rule === 'schema')
  const def = fatal ? null : toDefinition(loadYaml(source).data)
  return { def, findings: res.findings, counts: res.counts }
}
```

`src/index.ts` becomes re-export + node half:

```ts
import { readFileSync } from 'node:fs'
import { lintSource, type LintResult } from './lint.js'

export { lintSource, loadDefinition, type LintResult, type LoadResult } from './lint.js'
export type { Finding, Severity, Counts } from './findings.js'
export { toDefinition, type Definition, type Job, type Step } from './model/definition.js'

export function lintFile(path: string): LintResult {
  return lintSource(readFileSync(path, 'utf8'), { file: path })
}
```

`package.json` exports gains `"./lint": "./dist/lint.js"`.

- [ ] **Step 4: Run to verify** — `pnpm --filter @bffless/workflow-lint build && pnpm --filter @bffless/workflow-lint test:run` → all green (including the untouched M0 suite).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow-lint): browser-safe /lint entry with loadDefinition for the M1 harness" && git push`

### Task 4: `lib/runner` foundation — types, ids, durations, definition loading, purity fence

**Files:**
- Create: `apps/workflow/src/lib/runner/types.ts`, `ids.ts`, `durations.ts`, `definition.ts`
- Modify: `apps/workflow/eslint.config.js` (purity fence)
- Test: `apps/workflow/src/lib/runner/definition.test.ts`, `durations.test.ts`, `ids.test.ts`

**Interfaces:**
- Consumes: `@bffless/workflow-lint/lint` (`loadDefinition`), `/definition` (`Definition`, `Job`, `Step`, `StepKind`).
- Produces — the shared vocabulary every later task imports from `./types`:

```ts
// types.ts (complete)
import type { StepKind } from '@bffless/workflow-lint/definition'
export type { Definition, Job, Step, StepKind } from '@bffless/workflow-lint/definition'

export type StepStatus =
  | 'queued' | 'running' | 'polling' | 'waiting'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type StepKey = string // `<job>/<index>/<step>`

export interface FileRef { path: string; name: string; contentType: string; size: number; url: string }
export interface StepError { code: string; message: string; status?: number }
export interface Annotation { level: 'notice' | 'warning' | 'error'; title?: string; message: string; stepKey?: StepKey }

export interface StepState {
  key: StepKey; job: string; index: number; stepId: string; kind: StepKind
  status: StepStatus; attempt: number
  inputs?: Record<string, unknown>
  response?: { initial?: unknown; last?: unknown; truncated?: boolean }
  outputs?: Record<string, unknown>
  error?: StepError
  summary?: string
  annotations: Annotation[]
  startedAt?: number; finishedAt?: number
}

export interface RunState {
  runId: string; impl: string; workflow: string
  status: RunStatus; headless: boolean
  inputs: Record<string, unknown>
  steps: Record<StepKey, StepState>
  /** matrix expansion per job: total items + the per-index variable bindings (derived, Decision 12) */
  expansions: Record<string, { total: number; items: Record<string, unknown>[] }>
  outputs?: Record<string, unknown>
  annotations: Annotation[]
  startedAt: number; finishedAt?: number
}

export type RunEvent =
  | { type: 'run.started'; runId: string; impl: string; workflow: string; inputs: Record<string, unknown>; headless: boolean; at: number }
  | { type: 'job.expanded'; job: string; total: number; items: Record<string, unknown>[] } // derived — never persisted
  | { type: 'step.queued'; key: StepKey; job: string; index: number; stepId: string; kind: StepKind; at: number }
  | { type: 'step.started'; key: StepKey; inputs: Record<string, unknown>; at: number }
  | { type: 'step.polling'; key: StepKey; initial: unknown; at: number }
  | { type: 'step.waiting'; key: StepKey; at: number }
  | { type: 'step.succeeded'; key: StepKey; outputs: Record<string, unknown>; response?: { initial?: unknown; last?: unknown; truncated?: boolean }; summary?: string; annotations?: Annotation[]; at: number }
  | { type: 'step.failed'; key: StepKey; error: StepError; annotations?: Annotation[]; at: number }
  | { type: 'step.skipped'; key: StepKey; job: string; index: number; stepId: string; kind: StepKind; at: number }
  | { type: 'step.retrying'; key: StepKey; error: StepError; at: number }
  | { type: 'step.cancelled'; key: StepKey; at: number }
  | { type: 'run.annotation'; annotation: Annotation; at: number }
  | { type: 'run.finished'; status: Exclude<RunStatus, 'running'>; outputs?: Record<string, unknown>; at: number }

export const stepKey = (job: string, index: number, stepId: string): StepKey => `${job}/${index}/${stepId}`
```

- `ids.ts`: `newRunId(): string` returning `run_<26-char ULID>` (compact Crockford-base32 ULID over `crypto.getRandomValues` + `Date.now()`); `newOwnerId(): string` (`tab_<ulid>`).
- `durations.ts`: `parseDuration(s: string): number` (ms; throws `RangeError` on anything not matching `^[0-9]+(ms|s|m|h)$`).
- `definition.ts`:

```ts
import { loadDefinition } from '@bffless/workflow-lint/lint'
import type { Finding } from '@bffless/workflow-lint/lint'
import type { Definition } from './types'

export interface LoadedWorkflow { def: Definition | null; findings: Finding[]; ok: boolean; yaml: string }
export function loadWorkflow(yamlText: string, file: string): LoadedWorkflow {
  const { def, findings } = loadDefinition(yamlText, { file })
  const ok = def !== null && !findings.some((f) => f.severity === 'error')
  return { def, findings, ok, yaml: yamlText }
}
```

- [ ] **Step 1: Write the failing tests** — `definition.test.ts` (hello loads: 4 jobs, `greet` has matrix, `ok === true`; a workflow with an unknown context errors → `ok === false` but `def !== null`); `durations.test.ts` (`'500ms'→500`, `'3s'→3000`, `'10m'→600000`, `'1h'→3600000`, `'5'`/`'3 s'`/`'s'` throw); `ids.test.ts` (shape `^run_[0-9A-HJKMNP-TV-Z]{26}$`, 1000 ids unique, lexicographically increasing across two `Date.now()` ticks). Import hello via `import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'`.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter workflow test:run` → FAIL (modules missing).

- [ ] **Step 3: Implement** the four modules per the Produces block (ULID: 10 time chars + 16 random chars, Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`).

- [ ] **Step 4: Add the purity fence** to `eslint.config.js` — for `src/lib/runner/**`:

```js
{
  files: ['src/lib/runner/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['react', 'react-*', '@reduxjs/*', 'react-redux', 'msw*', '../../store/*', '../../components/*', '../../pages/*', '../../mocks/*'],
          message: 'lib/runner is pure (spec 09): no React, Redux, MSW, or app modules.' },
      ],
    }],
  },
}
```

- [ ] **Step 5: Run tests + lint, verify green, commit**

```bash
pnpm --filter workflow test:run && pnpm --filter workflow lint
git add -A && git commit -m "feat(workflow): runner types, ids, durations, definition loading + purity fence" && git push
```

### Task 5: Contexts — `buildContexts`, `evalDeep`, `evalIf`, status functions

**Files:**
- Create: `apps/workflow/src/lib/runner/contexts.ts`
- Test: `apps/workflow/src/lib/runner/contexts.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `renderTemplate`, `isSingleExpression`, `parseExpression`, `parseIfExpression`, `truthy`, type `EvalOptions` from `@bffless/workflow-lint/expressions`; `RunState`, `Definition`, `StepError` from Task 4.
- Produces (exact signatures):

```ts
export interface CtxScope {
  job: string; index: number; stepId?: string; attempt?: number
  /** step-local overlays for pipeline slots (01 contexts table) */
  response?: unknown; error?: StepError
  /** own outputs, readable in the step's own summary/annotations */
  selfOutputs?: Record<string, unknown>
}
/** The 01 contexts table for one evaluation site. */
export function buildContexts(def: Definition, state: RunState, scope: CtxScope): Record<string, unknown>
/** Contexts for job-level slots (job if, matrix expr, job outputs). */
export function buildJobContexts(def: Definition, state: RunState, job: string, index?: number): Record<string, unknown>
/** Contexts for top-level outputs (adds `jobs`). */
export function buildRunContexts(def: Definition, state: RunState): Record<string, unknown>
/** success()/failure()/always()/cancelled() for a job-if or step-if site. */
export function statusFns(def: Definition, state: RunState, scope: { job: string; index?: number; beforeStep?: string }): NonNullable<EvalOptions['status']>
/** Deep-evaluate every string scalar in a JSON value; single-expression scalars keep their type (01). */
export function evalDeep(value: unknown, contexts: Record<string, unknown>): unknown
/** Evaluate a string that may be a template; single expression keeps type. */
export function evalValue(raw: string, contexts: Record<string, unknown>, status?: EvalOptions['status']): unknown
/** GitHub if semantics: undefined → success(); bare string parsed whole (parseIfExpression). */
export function evalIf(expr: string | undefined, contexts: Record<string, unknown>, status: NonNullable<EvalOptions['status']>): boolean
```

Context contents (from 01): `inputs` = `state.inputs`; `needs.<job>` = `{ outputs, result }` for each job in the target's `needs` (outputs from job-output evaluation — provided by the caller via state: job outputs are stored on `state` per job? **No** — job outputs are evaluated lazily here: `needsFor(def, state, job)` computes each needed job's outputs by evaluating its `outputs` declarations against that job's own contexts, collecting matrix lists in index order; a skipped/failed job's outputs are `null`); `steps.<id>` = `{ outputs, outcome, conclusion, error, response }` for steps of the same (job,index) with index earlier than the site (plus self when `selfOutputs` given); `matrix` = `state.expansions[job].items[index]`; `strategy` = `{ 'job-index': index, 'job-total': total }`; `response`/`error` overlays from scope; `step` = `{ key, prefix: run.prefix + '/' + key, attempt }`; `run` = `{ id, prefix: 'workflows/<impl>/<workflow>/runs/<runId>', started_by, started_at, headless }`; `impl` = `{ alias: state.impl, base: '/w/<impl>', api: '/api/<impl>' }`; `jobs` only via `buildRunContexts`.

`outcome` vs `conclusion` (01): `outcome` = raw terminal status; `conclusion` = `'success'` when a failure was tolerated by `continue-on-error`, else = outcome.

Status semantics: `success()` = no untolerated failure among the scope's dependencies (for a step: no earlier step of the same job item with `conclusion === 'failure'`, and the job's needs all succeeded; for a job: every needed job's result is success); `failure()` = at least one such failure; `always()` = true; `cancelled()` = `state.status === 'cancelled'`.

- [ ] **Step 1: Write the failing tests** — drive with a tiny inline definition (two jobs `a`→`b`, `a` has steps `s1`,`s2`) plus hello; cases: (1) `inputs.greeting` resolves; (2) `steps.s1.outputs.x` visible in `s2`'s contexts, invisible in `s1`'s (unless `selfOutputs`); (3) `needs.a.outputs.y` collected as a list when `a` is a matrix job (seed `state.expansions` + two succeeded step states); (4) `evalIf(undefined, …)` = `success()`; (5) `continue-on-error` failure → `conclusion 'success'`, `outcome 'failure'`, later `success()` still true (01); (6) `evalDeep({ body: { text: '${{ inputs.greeting }}, ${{ matrix.who }}!' } })` interpolates; single-expression `'${{ inputs.names }}'` keeps the array type; (7) `matrix.who`/`strategy['job-index']` present; (8) `step.prefix` = `workflows/hello/hello/runs/<runId>/greet/0/say`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Evaluation goes through `evaluate(expr, { contexts, status })` from the lint package; `evalValue` uses `isSingleExpression` → `evaluate(parseExpression(inner))`, else `renderTemplate`. `evalDeep` recurses arrays/objects, applies `evalValue` to strings. Job outputs evaluation handles both `OutputDecl` forms (bare string / `{ type?, value }`). Matrix collection: for job with `state.expansions[job].total = n`, output value = `[for i in 0..n-1: evaluate against (job,i) contexts]`; missing/failed item → `null` element.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): runner contexts + status functions over the shared expression engine" && git push`

### Task 6: Transitions table + reducer

**Files:**
- Create: `apps/workflow/src/lib/runner/transitions.ts`, `reducer.ts`
- Test: `apps/workflow/src/lib/runner/reducer.test.ts`

**Interfaces:**
- Consumes: Task 4 types.
- Produces:

```ts
// transitions.ts
export const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  queued:    ['running', 'waiting' /* form steps */, 'skipped', 'cancelled'],
  running:   ['polling', 'waiting', 'succeeded', 'failed', 'queued' /* retry */, 'cancelled'],
  polling:   ['succeeded', 'failed', 'queued' /* retry */, 'cancelled'],
  waiting:   ['succeeded', 'failed', 'skipped', 'cancelled'],
  succeeded: [], failed: [], skipped: [], cancelled: [],
}
export class IllegalTransition extends Error {}
// from === to is always permitted as a payload-refresh no-op — Resume re-emits the current
// status (e.g. polling → polling with the recorded initial) without violating the table.
export function assertTransition(from: StepStatus, to: StepStatus, key: string): void

// reducer.ts
export function initialRunState(a: { runId: string; impl: string; workflow: string; inputs: Record<string, unknown>; headless: boolean; startedAt: number }): RunState
export function runReducer(state: RunState, event: RunEvent): RunState  // pure, structural sharing
```

Reducer rules: `run.started` builds `initialRunState`; `job.expanded` fills `expansions[job]`; `step.queued`/`step.skipped` create the StepState (skipped is terminal, `annotations: []`, attempt 1); `step.started` sets `status running`, `inputs`, `startedAt` (asserting transition); `step.polling` sets `status polling`, `response.initial`; `step.waiting` sets `waiting`; `step.retrying` sets `status queued`, `attempt + 1`, keeps `error` for the pane; `step.succeeded` sets outputs/response/summary/annotations/finishedAt; `step.failed` sets error/annotations/finishedAt; `step.cancelled` terminal; `run.annotation` appends to `state.annotations`; `run.finished` sets run status/outputs/finishedAt. Illegal transitions **throw** `IllegalTransition` (09: bugs throw in tests).

- [ ] **Step 1: Write the failing tests.** Full lifecycle for a happy pipeline step (`queued → running → polling → succeeded` with payload assertions at each hop); retry cycle (`running → failed?` **no** — retry is `running/polling → queued` via `step.retrying`, attempt increments, then `queued → running` again); `queued → waiting → succeeded` (form); a same-status re-emission (`polling → polling`) is accepted and refreshes the payload; `succeeded → running` throws `IllegalTransition`; `step.started` on an unknown key throws; `run.finished` stamps outputs; immutability (input state object unchanged by reference checks).

- [ ] **Step 2: Run to verify failure.** — `pnpm --filter workflow test:run`

- [ ] **Step 3: Implement** both modules exactly per the Produces block.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): transition table + event-sourced run reducer" && git push`

### Task 7: Graph + scheduler — `topoLayers`, `expandMatrix`, `jobResult`, `nextActions`

**Files:**
- Create: `apps/workflow/src/lib/runner/graph.ts`, `next.ts`
- Test: `apps/workflow/src/lib/runner/graph.test.ts`, `next.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6 (`buildJobContexts`, `evalIf`, `statusFns`, `evalDeep`, reducer types).
- Produces:

```ts
// graph.ts
export function topoLayers(def: Definition): string[][]          // left→right columns for the UI + deterministic scheduling order
export type JobResult = 'pending' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled'
export function jobResult(def: Definition, state: RunState, job: string): JobResult
export function expandMatrix(job: Job, contexts: Record<string, unknown>): { total: number; items: Record<string, unknown>[] }
export interface FlowEdge { fromJob: string; toJob: string; kind: 'needs' }
export function needsEdges(def: Definition): FlowEdge[]

// next.ts
export type NextAction =
  | { kind: 'expand'; job: string; total: number; items: Record<string, unknown>[] }
  | { kind: 'skip'; steps: Array<{ key: StepKey; job: string; index: number; stepId: string; stepKind: StepKind }> }
  | { kind: 'start'; key: StepKey; job: string; index: number; stepId: string }
  | { kind: 'finish'; status: 'succeeded' | 'failed' }
export function nextActions(def: Definition, state: RunState): NextAction[]
```

Scheduling semantics (01/05): a job is *ready* when every `needs` job has result `success` (or its `if` uses `always()`/`failure()` and the needs are terminal); ready + un-expanded matrix job → `expand` (evaluate `strategy.matrix` via job contexts; non-matrix jobs expand to `{ total: 1, items: [{}] }`); ready + expanded + job-`if` false → `skip` all its steps (rows for the record, 05); per item: if no step state exists for item, first step → `start` (respecting `max-parallel` — count items of this job with a non-terminal step); within an item, when the last-touched step is terminal, the next step starts — unless the item is *failed* (a step with `conclusion 'failure'`, i.e. failed without `continue-on-error`), in which case remaining steps with default `if` are skipped and only `always()`/`failure()` steps start; step-`if` false → `skip` that step; `fail-fast: true` (default) on a failed matrix item → remaining un-started items of that job are skipped; when every job is terminal (`success/failure/skipped/cancelled`) → `finish` with `failed` iff any job failed. `nextActions` on a `cancelled`/finished run returns `[]`. Deterministic ordering: topo layer order, then job id, then index.

- [ ] **Step 1: Write the failing tests** — the 09 battery, one scenario per test, each built by folding events through `runReducer` and asserting `nextActions`:
  - **diamond DAG** `a → b,c → d`: after `run.started`, actions = expand `a`; …; after `b` and `c` succeed, `d` starts once (not twice).
  - **matrix fan-in**: `greet` over 3 names with `max-parallel: 2` → exactly 2 `start`s initially; third starts as one finishes; after all succeed, dependent job's `needs.greet.outputs.lines` (via Task 5 contexts) is a 3-list in matrix order.
  - **fail-fast**: item 1 of 3 fails → remaining un-started items skipped, job result `failure`.
  - **continue-on-error** (hello's `boom`): step fails with `continue-on-error: true` → item continues, next step's default-`if` still starts, job result `success`.
  - **skipped-by-if**: job `if: ${{ false }}` → every step gets a `skip` action; `jobResult` = `skipped`; downstream job treating it as satisfied? — **No**: a skipped need does **not** satisfy `needs` (GitHub: dependent is skipped too) → dependent job is skipped; its outputs `null`.
  - **failure() path** (hello's `after`): `boom` tolerated-failed → `after` with `if: ${{ steps.boom.outcome == 'failure' }}` starts.
  - **finish**: all terminal, one failure → `{ kind: 'finish', status: 'failed' }`; all success/skipped → `succeeded`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `graph.ts` (Kahn layering; cycle → throw, lint already blocks it) then `next.ts` per the semantics above.

- [ ] **Step 4: Run the full battery, verify green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): DAG scheduler — topo layers, matrix expansion, nextActions" && git push`

### Task 8: Outputs coercion + summaries/annotations evaluation

**Files:**
- Create: `apps/workflow/src/lib/runner/outputs.ts`, `results.ts`
- Test: `apps/workflow/src/lib/runner/outputs.test.ts`, `results.test.ts`

**Interfaces:**
- Consumes: Task 5 (`evalValue`, `evalDeep`), types.
- Produces:

```ts
// outputs.ts
export class OutputTypeError extends Error { constructor(public output: string, public expected: string, public got: unknown) { super(`output ${output}: expected ${expected}`) } }
export type RegisterFile = (path: string) => Promise<FileRef>
/** Evaluate a pipeline step's declared outputs against `response` contexts; validate against the closed vocabulary (02).
 *  Bare string where `file` is declared → registerFile(path) → File ref. Omitted map → { response } (03). */
export async function coerceOutputs(
  decls: Record<string, OutputDecl> | undefined,
  contexts: Record<string, unknown>,
  registerFile: RegisterFile,
): Promise<Record<string, unknown>>
/** Validate an already-produced value map (form submits) against declared field types. */
export function validateValue(type: string, list: boolean | undefined, value: unknown): boolean

// results.ts
export function evalSummary(step: Step, contexts: Record<string, unknown>): string | undefined
export function evalAnnotations(step: Step, contexts: Record<string, unknown>): Annotation[]  // applies each entry's `if`
export function trimResponse(response: { initial?: unknown; last?: unknown }): { initial?: unknown; last?: unknown; truncated?: boolean } // 256 KB cap
```

Type validation per 02: `string`→string, `number`→number, `boolean`→boolean, `choice`→string, `file`→File-ref shape (or bare string path pre-registration), `table`→`{columns, rows}`, `markdown`→string, `json`→anything; `list: true` wraps each; `null` passes for any non-`required` slot (skipped/failed upstream, 01). A mismatch throws `OutputTypeError` (`error.code 'OUTPUT_TYPE'` at the adapter).

- [ ] **Step 1: Write the failing tests** — hello-derived: `say`'s `line` coerces `response.text` to string; `start`'s `poster` gets a bare `posterPath` string → `registerFile` called, ref inserted; `poster` null (no photo) passes; declared `number` receiving a string throws `OutputTypeError`; omitted decls → `{ response }`; `evalSummary` renders `"Said **Hello, world!**"` given self-outputs in contexts; `evalAnnotations` applies `if` (`level: warning` entry with false `if` dropped); `trimResponse` flags and truncates a 300 KB `last` (assert `truncated === true` and serialized size < 262144).

- [ ] **Step 2: Run to verify failure.**  — `pnpm --filter workflow test:run`

- [ ] **Step 3: Implement** per Produces (trim: `JSON.stringify` the response halves; if over budget, replace `last`, then `initial`, with `{ note: 'truncated', size }` stubs and set the flag).

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): typed output coercion + summary/annotation evaluation" && git push`

### Task 9: Rows + replay — `eventToWrites`, `rowsToEvents`, `replayRun`

**Files:**
- Create: `apps/workflow/src/lib/runner/rows.ts`, `replay.ts`
- Test: `apps/workflow/src/lib/runner/replay.test.ts`

**Interfaces:**
- Consumes: reducer, contexts, graph (`expandMatrix`), types.
- Produces:

```ts
// rows.ts — the 05 tables, camelCase columns (the rule set of Task 1)
export interface RunRow {
  runId: string; impl: string; workflow: string; workflowName: string; workflowVersion?: string
  definition: unknown; yaml: string; inputs: Record<string, unknown>
  status: RunStatus; headless: boolean; startedBy?: string
  startedAt: number; finishedAt?: number | null
  leaseOwner?: string | null; leaseUntil?: number | null
  outputs?: Record<string, unknown> | null; annotations?: Annotation[] | null
}
export interface StepRow {
  runId: string; key: StepKey; job: string; index: number; step: string; kind: StepKind
  status: StepStatus; attempt: number
  inputs?: unknown; response?: unknown; outputs?: unknown; error?: StepError | null
  summary?: string | null; annotations?: Annotation[] | null
  startedAt?: number | null; finishedAt?: number | null; heartbeatAt?: number | null
}
export type PersistWrite =
  | { table: 'runs'; op: 'create'; row: RunRow }
  | { table: 'runs'; op: 'patch'; id: string; patch: Partial<RunRow> }
  | { table: 'steps'; op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }
/** The 05 write-path table: one write per persisted event; [] for derived events (job.expanded). */
export function eventToWrites(event: RunEvent, ctx: { state: RunState; runRow?: () => RunRow }): PersistWrite[]

// replay.ts
export function rowsToEvents(run: RunRow, steps: StepRow[], def: Definition): RunEvent[]
export function replayRun(run: RunRow, steps: StepRow[], def: Definition): RunState
```

`eventToWrites` mapping (05): `run.started` → runs create (via `ctx.runRow()`); `step.queued/started/polling/waiting` → steps upsert of status (+ `inputs`,`startedAt` on started; `attempt` on queued); `step.retrying` → upsert `{ status: 'queued', attempt, error }`; `step.succeeded` → upsert `{ status, outputs, response, summary, annotations, finishedAt }`; `step.failed/skipped/cancelled` → upsert `{ status, error?, finishedAt, …identity fields on skipped }`; `run.annotation` → runs patch `{ annotations: state.annotations }`; `run.finished` → runs patch `{ status, outputs, finishedAt, leaseOwner: null, leaseUntil: null }`; `job.expanded` → `[]`.

`rowsToEvents`: emit `run.started` from the run row; walk jobs in `topoLayers` order; for each job with rows (or whose needs are satisfied in the rebuilt state), re-derive `job.expanded` by calling `expandMatrix` against contexts built from the state-so-far (falling back to `1 + max(row.index)` if evaluation of an in-flight upstream is impossible); then per row in (index, step-order): emit the event(s) its status implies — terminal rows emit `step.queued` + `step.started` (when `startedAt` present) + the terminal event carrying the row's payloads; a `polling` row emits queued/started/polling with `response.initial`; `queued`/`running`/`waiting` rows emit up to their status. Attempts > 1 emit one `step.retrying` per extra attempt (payload error from the row). Finished runs emit `run.finished` from the run row.

- [ ] **Step 1: Write the failing tests** — round-trip property: drive a synthetic 3-job run (matrix + retry + skip) live through `runReducer`, persisting via `eventToWrites` into an in-memory `{runs, steps}` store (apply patches in order); then `replayRun(storedRun, storedSteps, def)` and assert deep-equality with the live final `RunState` on: every step's `status/attempt/outputs/error/summary`, `expansions` totals, run `status/outputs`. Second test: replay of an **in-flight** run (rows up to a `polling` step) yields state where `nextActions` proposes nothing new for terminal steps and the polling step is `polling` with its recorded `initial`. Third: `eventToWrites` returns `[]` for `job.expanded`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `rows.ts` then `replay.ts` per the mapping.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): event↔row mapping and replay (Resume core)" && git push`

### Task 10: Adapters — `runPipelineStep` (fetch + poll + retry + cancel) and `completeFormStep`

**Files:**
- Create: `apps/workflow/src/lib/runner/adapters/pipeline.ts`, `adapters/form.ts`
- Test: `apps/workflow/src/lib/runner/adapters/pipeline.test.ts`, `adapters/form.test.ts`

**Interfaces:**
- Consumes: contexts (Task 5), outputs/results (Task 8), durations, types.
- Produces:

```ts
// shared runtime the middleware injects (Task 17); tests pass fakes
export interface HttpJson {
  (path: string, init: { method: string; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }):
    Promise<{ status: number; ok: boolean; body: unknown }>
}
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface StepRuntime {
  emit(e: RunEvent): void
  http: HttpJson
  clock: Clock
  signal: AbortSignal
  registerFile: (path: string) => Promise<FileRef>
}

// pipeline.ts
export interface PipelineStepArgs {
  step: Step; key: StepKey; job: string; index: number
  def: Definition; state: RunState   // snapshot at start; step-local contexts built inside
}
/** Full lifecycle of one pipeline step incl. poll/retry; emits started/polling/retrying/succeeded/failed/cancelled. Never throws. */
export async function runPipelineStep(a: PipelineStepArgs, rt: StepRuntime): Promise<void>

// form.ts
/** Validate submitted field values against the form's field defs; evaluate summary/annotations. */
export function completeFormStep(
  a: { step: Step; key: StepKey; job: string; index: number; def: Definition; state: RunState; values: Record<string, unknown> },
): { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> } | { ok: false; errors: Record<string, string> }
/** Evaluated initial field values (expression defaults) for the form UI. */
export function formInitialValues(a: { step: Step; def: Definition; state: RunState; job: string; index: number }): Record<string, unknown>
```

Pipeline semantics (03, encoded exactly):
- Resolve path: relative → `/api/${state.impl}/${path}`; absolute (`/api/…`) verbatim.
- `emit step.started` with `inputs` = `evalDeep(with, contexts)` (minus nothing; the whole evaluated `with` is the Input pane).
- Request: method default POST; GET sends `query` only. Success = 2xx; non-2xx → `StepError` `{ status, code: body.code ?? body.error ?? 'HTTP_<status>', message }`; thrown fetch → `code 'NETWORK'`; non-JSON 2xx → response is the raw text string.
- `poll`: after a successful initial response, `emit step.polling { initial }`; loop: build poll contexts with `response` = latest tick response (initial on the first evaluation of `query`/`body`); evaluate `fail` then `until`; wait `parseDuration(every)` between ticks via `rt.clock.sleep`; `parseDuration(timeout)` budget → `code 'POLL_TIMEOUT'`.
- `retry`: on any failure, while `retry.if` holds (evaluated with `error` context; default any failure) and extra attempts < `max`: `emit step.retrying`, sleep `delay`, re-run the whole step (request + poll). Attempt counter rides the events.
- Terminal success: `coerceOutputs` (final response contexts) → `evalSummary`/`evalAnnotations` with `selfOutputs` → `emit step.succeeded` with `trimResponse({ initial, last })`.
- `timeout-minutes` on the step → overall budget → `code 'TIMEOUT'`. Cancel: `rt.signal` aborted → `emit step.cancelled` (not failed).
- `OutputTypeError` → `step.failed` with `code 'OUTPUT_TYPE'`.

- [ ] **Step 1: Write the failing tests** with a scripted fake `HttpJson` (queue of canned responses, records calls) and a virtual `Clock` (`sleep` resolves immediately, records requested ms):
  - happy sync call (hello `say`): POST `/api/hello/echo`, body interpolated, outputs `{ line: 'Hello, world!' }`, summary rendered, events `started → succeeded`.
  - poll (hello `slow`): initial `{ jobId: 'j1' }` → polling with initial; two pending ticks then `status 'done'` → outputs from final response; `steps.<id>.response.initial` preserved; sleep called with 2000.
  - poll fail expression → failed with the tick's error mapped.
  - retry on `BUSY`: first attempt 503 `{ code: 'BUSY' }` → `step.retrying` (attempt 2), sleep 3000, second attempt succeeds; a 503 `{ code: 'OTHER' }` with `retry.if` on BUSY → no retry, failed.
  - `max` exhausted → failed with last error.
  - abort mid-poll → `step.cancelled`.
  - form: `completeFormStep` accepts hello's `review` submit `{ approved: true, report: '# r' }`, rejects `{ approved: 'yes' }` with a field error; `formInitialValues` resolves `default: ${{ needs.slow.outputs.report }}`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** both adapters per the semantics block.

- [ ] **Step 4: Run tests, verify green** — `pnpm --filter workflow test:run` (whole Phase-1 suite).

- [ ] **Step 5: Phase-1 gate + PR**

```bash
pnpm --filter workflow lint && pnpm --filter workflow build
pnpm --filter @bffless/workflow-lint test:run
pnpm apps:check && pnpm scripts:test
git add -A && git commit -m "feat(workflow): pipeline adapter (fetch/poll/retry/cancel) + form completion"
git push
gh pr create --title "feat(workflow): harness scaffold, rule set and pure run engine" --body-file - <<'PRBODY'
M1 Phase 1 of 3 (plan: docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md).
Authored `workflow` rule set (runs/lease/files trio) + conventions README; app scaffold;
browser-safe workflow-lint `/lint` entry; pure lib/runner (contexts, reducer, transitions,
scheduler, outputs, rows/replay, pipeline+form adapters) fully unit-tested. No UI yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AxAwFXrMvmWTTN6zKzyv4k
PRBODY
```

**STOP — Phase 1 merges before Phase 2 begins** (new worktree branch `feat/workflow-m1-readonly` off the updated `origin/main`).

---

# Phase 2 — Read-only harness (discovery, browsing, past runs)

*Branch `feat/workflow-m1-readonly` (new worktree off updated `origin/main` after Phase 1 merges). Deliverable: the harness browses implementations and workflows (mock-backed and live alike), renders the definition-mode graph, shows lint results on the workflow file screen, and renders **finished/in-flight runs read-only** via replay. Nothing executes yet.*

### Task 11: Data layer — store, `workflowApi`, coercers, MSW infrastructure

**Files:**
- Create: `apps/workflow/src/lib/http.ts`, `src/lib/coerce.ts`
- Create: `apps/workflow/src/store/index.ts`, `store/hooks.ts`, `store/workflowApi.ts`, `store/runSlice.ts`, `store/uiSlice.ts`
- Create: `apps/workflow/src/mocks/config.ts`, `mocks/browser.ts`, `mocks/server.ts`, `mocks/handlers.ts`, `mocks/db.ts`, `mocks/fixtures/finishedRun.ts`
- Modify: `apps/workflow/src/main.tsx` (mock bootstrap + `<Provider>`), `src/test/setup.ts` (MSW node server lifecycle)
- Test: `apps/workflow/src/store/workflowApi.test.ts`, `src/lib/coerce.test.ts`

**Interfaces:**
- Consumes: `HttpJson` type (Task 10), `RunRow`/`StepRow` (Task 9), `loadWorkflow` (Task 4), hello YAML via `import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'`.
- Produces:

```ts
// lib/http.ts
export const httpJson: HttpJson   // fetch, credentials 'same-origin', JSON in/out, query-string builder; non-JSON body returned as text

// lib/coerce.ts — ONE coercer per server shape; real and mock go through these (09)
export interface WorkflowListing { file: string; name: string; description?: string; inputs: number; jobs: number; headlessSafe: boolean }
export interface Implementation {
  alias: string; name: string; description?: string; version?: string; commit?: string
  preview: boolean; workflows: WorkflowListing[]; error?: string   // error: reachable but invalid index.json (08 empty states)
}
export function toAliasList(raw: unknown): Array<{ name: string; isAutoPreview: boolean }>  // tolerates array | {aliases} | {data}
export function toImplementation(alias: string, preview: boolean, raw: unknown): Implementation
export function toRunRow(raw: unknown): RunRow      // tolerates row fields flat or under .fields; keeps server record id at ._id
export function toStepRow(raw: unknown): StepRow
export function toFileRef(raw: unknown): FileRef

// store/workflowApi.ts (RTK Query, baseQuery = fetchBaseQuery({ baseUrl: '/' }) wrapped with one-shot
// 401 → POST /api/auth/session/refresh → retry, the studio reauth pattern)
export const workflowApi = createApi({
  reducerPath: 'workflowApi',
  tagTypes: ['Runs', 'Run'],
  endpoints: (b) => ({
    discover: b.query<Implementation[], void>(/* queryFn: GET /api/aliases → probe /w/<alias>/.bffless/workflows/index.json in parallel; 404 → not an implementation (ADR-0004); invalid JSON → Implementation with error */),
    getWorkflowYaml: b.query<string, { impl: string; file: string }>(/* GET /w/<impl>/.bffless/workflows/<file>, text */),
    listRuns: b.query<RunRow[], { impl: string; workflow: string }>(/* GET /api/workflow/runs → toRunRow[], sorted startedAt desc; providesTags Runs */),
    getRun: b.query<{ run: RunRow | null; steps: StepRow[] }, string>(/* GET /api/workflow/run?id= ; providesTags Run:id */),
  }),
})
export const { useDiscoverQuery, useGetWorkflowYamlQuery, useListRunsQuery, useGetRunQuery } = workflowApi

// store/runSlice.ts — the live/adopted run (09 table row 2)
export interface RunSliceState {
  meta: { def: Definition; yaml: string; workflowName: string; workflowVersion?: string } | null
  state: RunState | null
  mode: 'live' | 'readonly' | null   // readonly = replayed, another tab holds the lease
  paused?: string                     // persistence-failure banner (05 write path)
}
export const runSlice = createSlice(/* reducers: */)
export const { runOpened, runEvent, runReplaced, runClosed, runPaused, runModeChanged } = runSlice.actions
// runOpened({ meta })            — set meta before the first event
// runEvent(RunEvent)             — 'run.started' → initialRunState(...), else runReducer(state, event)
// runReplaced({ state, mode })   — adopt a replayed RunState (Resume / read-only)
// store/uiSlice.ts: { selectedStep: StepKey | null; runsStatusFilter: RunStatus | 'all' }
// store/index.ts: configureStore({ reducer: { workflowApi, run, ui }, middleware: getDefault().concat(workflowApi.middleware) })
export type RootState / AppDispatch / useAppDispatch / useAppSelector (hooks.ts)
export type AppThunk<R> = (dispatch: AppDispatch, getState: () => RootState) => R   // used by startRun (Task 16) and the lifecycle thunks (Task 19)
```

- MSW (`mocks/`): `config.ts` = studio's master-switch verbatim (`?mocks=on|off`, localStorage, `VITE_MOCKS`, default on in dev). `db.ts` = in-memory `Map`s `runs`, `steps` (keyed `runId` / `runId+'|'+key`), `files`, `helloJobs`, plus `resetDb()`, `seedFinishedRun()`. `handlers.ts` covers **everything** the app touches:
  - `GET /api/aliases` → `[{ name: 'workflow', isAutoPreview: false }, { name: 'hello', isAutoPreview: false }]`
  - `GET /w/hello/.bffless/workflows/index.json` → built at module load with `loadDefinition(helloYaml)`: `{ spec: 1, impl: 'hello', name: 'Hello', version: '0.0.0', commit: 'mock', generatedAt, workflows: [{ file: 'hello.workflow.yaml', name: def.name, inputs: 4, jobs: 4, headlessSafe: true }], islands: [], scripts: [] }`
  - `GET /w/workflow/.bffless/workflows/index.json` → 404 (the harness is not an implementation)
  - `GET /w/hello/.bffless/workflows/hello.workflow.yaml` → `helloYaml` (text)
  - the full `/api/workflow/*` surface from Task 1, implemented over `db` with the same request/response shapes (create, list, get `{run, steps}`, update `{id, patch}`, run-step upsert, lease gate incl. expiry/takeover logic mirroring `gate.fn.js`)
  - files: `POST /api/workflow/files/prepare` → `{ uploadUrl: '/mock-upload/<key>', storageKey: '<key>' }`; `PUT /mock-upload/*` → 200 storing byte length; `POST /api/workflow/files/register` → File ref via `toFileRef` shape; `GET /api/workflow/files/*` → stored bytes
  - hello pipelines: `POST /api/hello/echo` → `{ text: upper ? text.toUpperCase() : text }`; `POST /api/hello/slow` → **first call per run body returns 503 `{ code: 'BUSY' }`** (exercises `retry`), then creates a `helloJobs` row that reaches `done` on the **second** `GET /api/hello/job?id=` poll with `result: { markdown, posterPath: body.photo ?? null, ms: 1234 }`; `POST /api/hello/fail` → 418 `{ code: body.code, error: 'fails on purpose' }`
  - `fixtures/finishedRun.ts`: literal `RunRow` + 8 `StepRow`s of one completed hello run (greet×2 matrix items succeeded with summaries, slow succeeded with `report`+`poster` outputs + notice annotation, boom failed-tolerated, after succeeded with warning annotation, review succeeded) — `seedFinishedRun()` loads it.
- `main.tsx` adopts studio's `enableMocks()` bootstrap (unregister stale worker when off) and wraps `<App/>` in `<Provider store>` + `<BrowserRouter>`. `test/setup.ts` starts `mocks/server.ts` (`setupServer(...handlers)`) `beforeAll`/`resetHandlers + resetDb` `afterEach`/`close` `afterAll`.

- [ ] **Step 1: Write the failing tests** — `workflowApi.test.ts` (store + MSW node server): `discover` resolves to exactly one implementation `hello` with 1 workflow listing (`jobs: 4`, `headlessSafe: true`); `getRun` of the seeded fixture returns 8 step rows; `listRuns` returns the seeded run first; a 404 alias (`workflow`) is absent. `coerce.test.ts`: `toAliasList` accepts the three envelopes; `toRunRow` reads flat and `.fields` shapes; `toFileRef` fills defaults.

- [ ] **Step 2: Run to verify failure** — `pnpm --filter workflow test:run` → FAIL (modules missing).

- [ ] **Step 3: Implement** per the Produces block (MSW `http.get/post/put`, `HttpResponse.json`).

- [ ] **Step 4: Run tests, verify green.** Also `pnpm --filter workflow dev` and eyeball `/?mocks=on` (worker registers, no console errors).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): RTK store, workflowApi, coercers and full MSW mock backend" && git push`

### Task 12: Shell, routes, Implementations + Workflows screens

**Files:**
- Create: `apps/workflow/src/components/Shell.tsx`, `components/EmptyState.tsx`, `components/StatusPill.tsx`
- Create: `apps/workflow/src/pages/ImplementationsPage.tsx`, `pages/WorkflowsPage.tsx`
- Modify: `apps/workflow/src/App.tsx` (real routes)
- Test: `apps/workflow/src/pages/ImplementationsPage.test.tsx`

**Interfaces:**
- Consumes: `useDiscoverQuery`, `Implementation` (Task 11).
- Produces: the route table (08) every later page task plugs into:

```tsx
// App.tsx
<Routes>
  <Route element={<Shell />}>                         {/* left rail: impl → workflow tree; header */}
    <Route index element={<ImplementationsPage />} />
    <Route path=":impl" element={<WorkflowsPage />} />
    <Route path=":impl/:workflow" element={<WorkflowPage />} />        {/* Task 14 */}
    <Route path=":impl/:workflow/run" element={<KickoffPage />} />     {/* Task 16 */}
    <Route path=":impl/:workflow/runs" element={<RunsPage />} />       {/* Task 15 */}
    <Route path=":impl/:workflow/runs/:runId" element={<RunPage />} /> {/* Task 15 */}
    <Route path=":impl/:workflow/file" element={<FilePage />} />       {/* Task 14 */}
  </Route>
</Routes>
```

- `ImplementationsPage`: `data-testid="implementations"`; card per implementation — name, alias, version, workflow count, *preview* badge (`preview: true`), last-run pill (from `useListRunsQuery` per workflow, lazily; omit when none); an `error` implementation renders the card with the error text and no links; empty state → "No implementations found — publish one" linking spec 06 (external doc link).
- `WorkflowsPage`: `data-testid="workflow-list"`; row per `WorkflowListing` — name, description, inputs/jobs counts, headless-safe badge, last run status; links to `/:impl/:workflow`.
- Until Task 14/15/16 land, `WorkflowPage`/`KickoffPage`/`RunsPage`/`RunPage`/`FilePage` are thin stubs created **in this task** rendering the page title from route params (real components replace them in their own tasks — the stubs exist so the router compiles and the nav is clickable, and each carries its final `data-testid`).

- [ ] **Step 1: Write the failing test** — render `<App/>` at `/` inside `MemoryRouter` + real store (MSW seeded): finds `implementations` testid, the text `hello` and `1 workflow`; with `server.use(http.get('/api/aliases', () => HttpResponse.json([])))` the empty state appears; clicking `hello` navigates to the workflow list showing `Hello workflow`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** Shell (rail from `useDiscoverQuery`, `<Outlet/>`), the two pages, the stubs, the routes.

- [ ] **Step 4: Run tests + lint, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): shell, routing, implementations and workflows screens" && git push`

### Task 13: Value renderers — `ValueView` + markdown

**Files:**
- Create: `apps/workflow/src/lib/markdown.ts`
- Create: `apps/workflow/src/components/values/ValueView.tsx`, `values/FileCard.tsx`, `values/JsonTree.tsx`, `values/TableView.tsx`, `values/MarkdownView.tsx`
- Test: `apps/workflow/src/components/values/ValueView.test.tsx`, `src/lib/markdown.test.ts`

**Interfaces:**
- Consumes: `FileRef` (Task 4), `OutputDecl` shape (`@bffless/workflow-lint/definition`).
- Produces:

```ts
// lib/markdown.ts — 05: "Summaries are markdown; HTML is not interpreted"
export function renderMarkdown(md: string): string   // marked, with html/inline-html tokens escaped to text

// values/ValueView.tsx
export interface ValueDecl { type: string; list?: boolean; render?: string; columns?: unknown }
export function ValueView(props: { decl: ValueDecl; value: unknown; label?: string; origin?: string }): JSX.Element
// dispatch: null → "—"; list → stacked items; file → <FileCard refValue/> ; table → <TableView/>;
// markdown → <MarkdownView/>; json → <JsonTree/>; string/number/boolean/choice → chip.
// A named decl.render shows a small badge `renderer: <name> (M2)` above the base-type viewer (Decision 10).
export function FileCard(props: { refValue: FileRef }): JSX.Element
// player by contentType (video/audio/img/pdf/object, else download card); ALWAYS a Download
// link href = refValue.url + (url.includes('?') ? '&' : '?') + 'download=1' (02)
```

- [ ] **Step 1: Write the failing tests** — `renderMarkdown('**hi** <script>alert(1)</script>')` contains `<strong>hi</strong>` and `&lt;script&gt;`, never a `<script>` tag; `ValueView` renders: a `file` decl with a video ref → `<video>` + Download link with `download=1`; a `table` value → column headers from `columns`; `{type:'string', list:true}` with 3 values → 3 chips; `render:'transcript'` → badge text `renderer: transcript (M2)`; `null` → `—`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** `renderMarkdown`: `marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } })` + a `walkTokens` guard for inline html; output injected via `dangerouslySetInnerHTML` **only** through this function.

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): typed value renderers and HTML-safe markdown" && git push`

### Task 14: Definition-mode graph + workflow file screen

**Files:**
- Create: `apps/workflow/src/components/graph/GraphView.tsx`, `graph/JobCard.tsx`, `graph/StepChip.tsx`
- Create: `apps/workflow/src/pages/WorkflowPage.tsx` (replaces stub), `pages/FilePage.tsx` (replaces stub)
- Modify: `apps/workflow/src/lib/runner/graph.ts` (add `refsIn`)
- Test: `apps/workflow/src/components/graph/GraphView.test.tsx`, `src/pages/FilePage.test.tsx`

**Interfaces:**
- Consumes: `topoLayers`, `needsEdges` (Task 7), `loadWorkflow` (Task 4), `lintSource` from `@bffless/workflow-lint/lint`, `useGetWorkflowYamlQuery`.
- Produces:

```ts
// graph.ts addition — powers the panes' "from …" labels (08) without the M2 hover-highlight
export function refsIn(raw: unknown): Array<{ context: 'steps' | 'needs' | 'inputs'; name: string; output?: string }>
// scans every string scalar in a step's `with` / an output's `value` with scanTemplates + the parsed
// Expr, collecting steps.<id>.outputs.<o>, needs.<job>.outputs.<o>, inputs.<name> roots

// graph/GraphView.tsx — one component, two modes (08)
export function GraphView(props: {
  def: Definition
  mode: 'definition' | 'run'
  state?: RunState                      // required when mode 'run'
  selectedKey?: StepKey | null
  onSelect?: (key: StepKey) => void
}): JSX.Element
// Layout: topoLayers → CSS grid columns, left→right. JobCard per job: name, matrix note
// ("For each <var> · max N at once" from strategy), steps stacked as StepChip (kind icon, id,
// declared output names+types in definition mode; status + duration + attempt in run mode;
// matrix jobs show an item selector + "k of n" fraction in run mode). Edges: one SVG overlay,
// a line per needsEdges() entry between column anchors (data-edge="<from>→<to>" for tests).
// Every StepChip carries data-testid="step" data-key="<job>/<index>/<step>" data-state="<status|declared>" (07/08 contract).
```

- `WorkflowPage`: loads yaml (`useGetWorkflowYamlQuery`) → `loadWorkflow`; invalid → the 08 error state (lint findings listed, **no Start button**); valid → `GraphView mode="definition"` + "Start a run" link (`/run`) + recent runs (5 latest via `useListRunsQuery`) + "View workflow file" link. Clicking a chip opens a side panel with the step's declaration (`<pre>{JSON.stringify(step.raw, null, 2)}</pre>`).
- `FilePage`: the yaml in a `<pre>` + `lintSource` findings grouped by severity with line/col; a run link may pass `?yaml=snapshot` — when navigated from a run page (Task 15) the page renders the **snapshot** text passed via location state instead of fetching (D16).

- [ ] **Step 1: Write the failing tests** — `GraphView` with hello def (definition mode): 4 JobCards; grid columns are `[greet]`, `[slow, flaky]`, `[confirm]` (assert via `data-col` attributes); 3 edges (`greet→slow`, `greet→flaky`, `slow+flaky→confirm` = 3 entries); chip for `say` has `data-state="declared"`, shows `line` output. `FilePage` (MSW): hello yaml renders with `1 notice` and `0 errors` (hello's `boom` omits `outputs` — the M0 severity fixture); a broken yaml override (`server.use`) renders the schema error and the page still mounts.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (layout math stays in `topoLayers`; GraphView measures nothing — anchors are CSS-grid cell corners computed from column/row indices).

- [ ] **Step 4: Run tests + lint, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): workflow graph (definition mode) and lint-backed file screen" && git push`

### Task 15: Past runs + the read-only run page (replay)

**Files:**
- Create: `apps/workflow/src/pages/RunsPage.tsx` (replaces stub), `pages/RunPage.tsx` (replaces stub)
- Create: `apps/workflow/src/components/run/RunHeader.tsx`, `run/StepPane.tsx`, `run/RunOutputs.tsx`, `run/RunSummary.tsx`, `components/AnnotationList.tsx`
- Test: `apps/workflow/src/pages/RunPage.test.tsx`, `pages/RunsPage.test.tsx`

**Interfaces:**
- Consumes: `useGetRunQuery`/`useListRunsQuery`, `replayRun` (Task 9), `toDefinition` (`/definition`), `GraphView` run mode (Task 14), `ValueView` (Task 13), `refsIn`, `uiSlice.selectedStep`.
- Produces:

```tsx
// RunPage composition (08 sections, read-only path — Phase 3 adds live/Resume):
// 1. <RunHeader run={runRow} state={runState} />  — name, id, status pill (data-testid="run-status"
//    data-state={status}), started by/at, elapsed/duration, annotation badge counts, actions
//    (View workflow file → /file with snapshot state; Re-run → /run?from=<id>; Cancel/Resume appear in Phase 3)
// 2. <GraphView mode="run" state={state} selectedKey onSelect />  +  <StepPane .../>
// 3. <RunOutputs data-testid="run-outputs" def state />   — top-level outputs first (run.outputs),
//    then per job in topo order, each ValueView + Download for files
// 4. <RunSummary state def />   — step summaries concatenated in job order (rendered markdown)
// 5. <AnnotationList annotations={collectAnnotations(state)} onJump={selectStep} />

export function StepPane(props: { def: Definition; state: RunState; stepKey: StepKey }): JSX.Element
// tabs Input | Output | Details (08): Input = step.inputs entries via ValueView with origin labels
// from refsIn(step.raw.with); Output = declared outputs via ValueView (or the `response` json when
// the map was omitted); Details = status timeline (queued→…→terminal from row timestamps), attempt,
// pipeline path, error {code,message} with raw response behind <details>, rendered summary, annotations.
```

- `RunPage` data flow (this phase): `useGetRunQuery(runId)` → `run === null` → not-found state; else `def = toDefinition(run.definition)` (fallback: `loadWorkflow(run.yaml)`; both absent → the 08 "read-only record" degraded state) → `state = replayRun(run, steps, def)` (memoized) → render. A `status: 'running'` run renders a "held by another tab / resumable" notice **without** actions (Phase 3 wires them) and polls `getRun` every 5 s (`pollingInterval`).
- `RunsPage`: table (status pill, started by, started at, duration, outputs count + first file name, annotations count), client-side status filter (`uiSlice.runsStatusFilter`), row click → run page, Re-run link per row.

- [ ] **Step 1: Write the failing tests** — with the seeded fixture: `RunPage` shows `run-status` with `data-state="succeeded"`; 8 `step` testids; selecting `slow/0/start` shows Output tab with the markdown report and the poster FileCard; Details shows the notice annotation; `run-outputs` lists `report`, `poster`, `lines` (top-level) before job outputs; RunSummary contains "Said **Hello, world!**" before the slow job's summary. `RunsPage`: fixture row renders; filtering by `failed` empties the table.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the whole suite + lint + build, verify green.**

- [ ] **Step 5: Phase-2 gate + PR**

```bash
pnpm --filter workflow test:run && pnpm --filter workflow lint && pnpm --filter workflow build
pnpm apps:check
git add -A && git commit -m "feat(workflow): past runs and read-only run page via replay"
git push
gh pr create --title "feat(workflow): discovery, browsing and read-only runs" --body-file - <<'PRBODY'
M1 Phase 2 of 3 (plan: docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md).
RTK Query data layer + full MSW mock backend; shell/routes; implementations + workflows
screens; definition-mode graph; lint-backed file screen; past runs; read-only run page
rebuilt from rows by the Phase-1 replay engine. Nothing executes yet — that is Phase 3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AxAwFXrMvmWTTN6zKzyv4k
PRBODY
```

**STOP — Phase 2 merges before Phase 3 begins** (new worktree branch `feat/workflow-m1-runner`).

---

# Phase 3 — The live runner, hello, the smoke, the deploy

*Branch `feat/workflow-m1-runner`. Deliverable: kickoff starts real runs (mock- and live-backed), the listener middleware drives pipeline + form steps with write-ahead persistence and a heartbeat lease, Resume/Take-over/Cancel/Re-run work, the hello implementation exists as a real rule set + staged bundle, one Playwright smoke drives the whole thing, and a dispatch-only deploy workflow is ready for the day the `bffless/workflow` project exists.*

### Task 16: Kickoff form + uploads + `startRun`

**Files:**
- Create: `apps/workflow/src/lib/upload.ts`
- Create: `apps/workflow/src/components/kickoff/KickoffForm.tsx`, `kickoff/FieldControl.tsx`
- Create: `apps/workflow/src/pages/KickoffPage.tsx` (replaces stub)
- Create: `apps/workflow/src/store/runnerActions.ts` (`startRun` thunk; the middleware lands in Task 17 — this task asserts state + the created row only)
- Test: `apps/workflow/src/components/kickoff/KickoffForm.test.tsx`, `src/store/runnerActions.test.ts`

**Interfaces:**
- Consumes: `httpJson`, `toFileRef` (Task 11), `newRunId`/`newOwnerId` (Task 4), `runOpened`/`runEvent` (Task 11), `InputDef` (`/definition`), MSW files handlers.
- Produces:

```ts
// lib/upload.ts — the 06 prepare → PUT → register flow, one function
export async function uploadFile(a: {
  impl: string; workflow: string
  scope: string                       // 'inputs' (kickoff/form) or `runs/${runId}/${stepKey}` (step files)
  file: File
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}): Promise<FileRef>
// POST /api/workflow/files/prepare { impl, workflow, scope, filename, contentType, size }
//   → { uploadUrl, storageKey } (coercer tolerates url/uploadUrl, key/storageKey)
// PUT uploadUrl (XMLHttpRequest for progress) → POST /api/workflow/files/register
//   { impl, workflow, scope, storageKey, originalName } → toFileRef

// kickoff/FieldControl.tsx — shared by kickoff AND the form step (Decision 1)
export function FieldControl(props: {
  name: string
  def: InputDef                                    // string(+format textarea)/number/boolean/choice(+list)/markdown/file(+list)
  value: unknown
  onChange: (v: unknown) => void
  upload?: (file: File, onProgress: (f: number) => void) => Promise<FileRef>  // present only where file fields are allowed
  error?: string
}): JSX.Element
// file control: picker → upload() on select with a progress bar; value becomes the FileRef (list: FileRef[]);
// accept/maxSize enforced here (Decision 8) with inline errors. No `upload` prop → file fields render
// an unsupported notice (mid-run forms, M2).

// kickoff/KickoffForm.tsx
export function KickoffForm(props: {
  inputs: Record<string, InputDef>
  initial?: Record<string, unknown>                // Re-run prefill (08): file refs reused, no re-upload
  uploading: (file: File, onProgress: (f: number) => void) => Promise<FileRef>
  onStart: (values: Record<string, unknown>) => void
}): JSX.Element
// data-testid="kickoff-form"; Start button data-testid="kickoff-start", disabled while required
// fields are empty or any upload is in flight (08: "the form is valid only when uploads are registered").
// Validation: required, number min/max, string pattern/minLength/maxLength, choice membership — via
// validateValue (Task 8) + the input-specific keys.

// store/runnerActions.ts
export function startRun(a: {
  impl: string; workflow: string                   // workflow = file base name ('hello')
  def: Definition; yaml: string
  workflowName: string; workflowVersion?: string
  values: Record<string, unknown>
}): AppThunk<string>                               // returns the new runId
// runId = newRunId(); dispatch(runOpened({ meta })); dispatch(runEvent({ type: 'run.started', runId,
// impl, workflow, inputs: values, headless: false, at: Date.now() })). Persistence + scheduling are the
// middleware's job (Task 17) — this thunk only opens the run and fires the first event.
```

- `KickoffPage`: discovery + yaml → `loadWorkflow`; invalid → same no-Start error state as Task 14; `?from=<runId>` → `useGetRunQuery(from)` prefills `initial` from the old run's `inputs`; `onStart` = `dispatch(startRun(...))` then `navigate(../runs/${runId})`.
- Owner id: `getOwnerId()` in `runnerActions.ts` — module-level `newOwnerId()` memoized per tab (sessionStorage).

- [ ] **Step 1: Write the failing tests** — `KickoffForm` with hello's inputs: renders 4 controls with defaults (`greeting: 'Hello'`, `names: ['world']`, `shout: false`); Start disabled when `greeting` cleared (required); selecting a file calls `uploading`, disables Start until it resolves, then the value is the FileRef; submit yields the values map. `runnerActions.test.ts`: `startRun` on a real store (no middleware yet) sets `run.meta.def`, `run.state.status === 'running'`, `run.state.runId` matching `^run_`, inputs stored.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per Produces.

- [ ] **Step 4: Run tests + lint, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): kickoff form, presigned uploads, startRun" && git push`

### Task 17: The runner middleware — persistence, scheduling, adapters, lease heartbeat

**Files:**
- Create: `apps/workflow/src/lib/runStore.ts`
- Create: `apps/workflow/src/store/runnerMiddleware.ts`
- Modify: `apps/workflow/src/store/index.ts` (prepend the listener middleware, inject real deps)
- Test: `apps/workflow/src/store/runnerMiddleware.test.ts`

**Interfaces:**
- Consumes: `eventToWrites` (Task 9), `nextActions` (Task 7), `runPipelineStep`/`StepRuntime`/`HttpJson`/`Clock` (Task 10), `buildRunContexts`/`evalValue` (Task 5), `uploadFile` + `toFileRef` (files), `runSlice` actions (Task 11).
- Produces:

```ts
// lib/runStore.ts — imperative write half of the API (reads stay in RTK Query)
export interface RunStore {
  createRun(row: RunRow): Promise<void>                                  // POST /api/workflow/runs
  patchRun(id: string, patch: Partial<RunRow>): Promise<void>            // POST /api/workflow/run/update
  upsertStep(runId: string, key: StepKey, patch: Partial<StepRow>): Promise<void>  // POST /api/workflow/run-step
  lease(id: string, owner: string, takeover?: boolean): Promise<{ ok: boolean; leaseUntil?: number; heldBy?: string }>
}
export function createRunStore(http: HttpJson): RunStore

// store/runnerMiddleware.ts
export interface RunnerDeps {
  http: HttpJson
  clock: Clock                            // real: { now: Date.now, sleep: setTimeout+abort }
  runStore: RunStore
  registerFile: (state: RunState, key: StepKey, path: string) => Promise<FileRef>  // register a bare pipeline path (02) under the run scope
}
export function createRunnerMiddleware(deps: RunnerDeps): ListenerMiddleware<RootState>
// One listener on runSlice.actions.runEvent (09: "side effects live in one RTK listener middleware"):
//  1. PERSIST (write-ahead, 05): for each eventToWrites(event, { state, runRow: () => rowFromSlice(getState()) }):
//     execute against runStore; on rejection retry once; on second rejection dispatch(runPaused(msg)),
//     abort all in-flight controllers, and return — the run continues nowhere unrecorded.
//     Persist runs strictly in dispatch order (a per-run promise chain — the write queue).
//  2. SCHEDULE: if slice.mode === 'live' && state.status === 'running':
//     for (const a of nextActions(meta.def, state)) switch (a.kind):
//       'expand' → dispatch(runEvent({ type: 'job.expanded', ... }))
//       'skip'   → for each step: dispatch(runEvent({ type: 'step.skipped', ..., at: clock.now() }))
//       'start'  → if (!inflight.has(a.key)):
//                    dispatch(runEvent({ type: 'step.queued', ... }));
//                    kind 'pipeline' → launch runPipelineStep(args, rt) (fire-and-forget; rt.emit = e => dispatch(runEvent(e)))
//                    kind 'form'     → dispatch(runEvent({ type: 'step.waiting', key, at }))   // the pane completes it (Task 18)
//                    kind 'island' | 'script' → dispatch(runEvent({ type: 'step.failed', key,
//                        error: { code: 'UNSUPPORTED_KIND_M1', message: `\${kind} steps arrive in M2` }, at }))
//       'finish' → evaluate top-level outputs (buildRunContexts + evalValue per OutputDecl; errors → null
//                  + run annotation) then dispatch(runEvent({ type: 'run.finished', status, outputs, at }))
//  3. HEARTBEAT: started on run.started / resume adoption, every 15 s via clock:
//     lease(runId, owner) — ok → also upsertStep(heartbeatAt) for non-terminal steps;
//     !ok → dispatch(runModeChanged('readonly')) + abort in-flight (someone took over).
//     Stopped on run.finished / runClosed / runPaused.
// Controllers: Map<StepKey, AbortController>; exposed via cancelAll(runId) for Task 18/19.
export const runnerControllers: { abort(key: StepKey): void; abortAll(): void; has(key: StepKey): boolean }
```

Store wiring (`store/index.ts`): `createRunnerMiddleware({ http: httpJson, clock: realClock, runStore: createRunStore(httpJson), registerFile })` prepended; `registerFile` implementation: `POST /api/workflow/files/register` with `{ impl, workflow, scope: 'runs/<runId>/<stepKey>', storageKey: path }` — a bare path returned by a pipeline is registered in place (02); if the path lies outside the run prefix, still register but dispatch a `run.annotation` warning (06: "a run-time annotation, not a failure").

- [ ] **Step 1: Write the failing tests** — a real `configureStore` with the middleware and **fake deps** (scripted `HttpJson` from Task 10's tests reused; virtual clock; recording `RunStore` fake; stub `registerFile`):
  - drive `startRun` for an inline 2-job def (pipeline `a/0/one` → form `b/0/ask`): assert the recorded write sequence starts `runs.create` → `steps.upsert one queued` → `one running (inputs)` → `one succeeded (outputs, summary)` → `ask queued` → `ask waiting`, in order.
  - hello via MSW instead of fakes (node server): `startRun` with defaults reaches `waiting` on `confirm/0/review` with `greet` fanned out (2 items for `['world']`? — seed `names: ['world','studio']` to assert 2 matrix items), `slow` retried once (BUSY) then succeeded, `boom` failed-tolerated, `after` succeeded.
  - write-ahead failure: `RunStore.upsertStep` rejects twice → `run.paused` set, no further `nextActions` executed, controllers aborted.
  - heartbeat: advance the virtual clock 15 s → `lease` called; lease answer `{ ok: false }` → mode flips `readonly`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `runStore.ts` then the middleware per the Produces block.

- [ ] **Step 4: Run tests, verify green** (whole suite — Phases 1–2 must stay green).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): runner middleware — write-ahead persistence, scheduling, heartbeat lease" && git push`

### Task 18: The waiting form pane + live run page

**Files:**
- Create: `apps/workflow/src/components/run/FormStepPane.tsx`
- Modify: `apps/workflow/src/pages/RunPage.tsx` (live mode), `src/components/run/StepPane.tsx` (waiting → form), `run/RunHeader.tsx` (elapsed ticker, progress, Cancel slot)
- Test: `apps/workflow/src/components/run/FormStepPane.test.tsx`, `src/pages/RunPage.live.test.tsx`

**Interfaces:**
- Consumes: `completeFormStep`/`formInitialValues` (Task 10), `FieldControl` (Task 16), `runEvent` (Task 11), live slice state (Task 17 middleware persists + schedules on the submit event).
- Produces:

```tsx
export function FormStepPane(props: { def: Definition; state: RunState; stepKey: StepKey }): JSX.Element
// Renders the form step's with.title/description/fields via FieldControl (NO upload prop — Decision 1:
// file fields in mid-run forms are M2 and render the unsupported notice), initial values from
// formInitialValues, submit button label = with.submit ?? 'Submit'. On submit:
//   const r = completeFormStep({ step, key, job, index, def, state, values })
//   r.ok ? dispatch(runEvent(r.event)) : set field errors
// The middleware persists the succeeded event and schedules onward — the pane itself never persists.
```

- `RunPage` live path: when `slice.state?.runId === route runId && slice.mode === 'live'`, render from the slice (no polling); the graph updates as events reduce; a `waiting` step is auto-selected (first by topo order) and its `StepPane` **is** the `FormStepPane` (08: "the pane is the form"); `RunHeader` gains a 1 s elapsed ticker, "k of n done" (terminal steps / total known steps), the annotation badge counts live, and a Cancel button slot wired in Task 19.
- Read-only and not-found paths from Task 15 unchanged.

- [ ] **Step 1: Write the failing tests** — with the Task 17 test harness mid-run at `confirm/0/review` waiting: `FormStepPane` shows `approved` toggle (default true) and `report` markdown field prefilled from `needs.slow.outputs.report`; submit → slice state's step `succeeded`, run reaches `succeeded`, `run-status` flips `data-state="succeeded"`; submitting `approved: 'yes'` (forced via a broken control stub) surfaces the field error and dispatches nothing.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): live run page and the built-in form step pane" && git push`

### Task 19: Cancel, Resume, Take-over, Re-run

**Files:**
- Create: `apps/workflow/src/store/lifecycleActions.ts`
- Modify: `apps/workflow/src/pages/RunPage.tsx` (Resume/Take-over banners), `src/components/run/RunHeader.tsx` (Cancel), `src/lib/runner/adapters/pipeline.ts` + its test (resume mode — see Interfaces)
- Test: `apps/workflow/src/store/lifecycleActions.test.ts`

**Interfaces:**
- Consumes: everything above; `replayRun` (Task 9); `runnerControllers` + heartbeat (Task 17); lease endpoint.
- Produces:

```ts
// adapters/pipeline.ts — signature extension (kept backward-compatible):
export interface PipelineStepArgs {
  step: Step; key: StepKey; job: string; index: number
  def: Definition; state: RunState
  resume?: { mode: 'poll-only'; initial: unknown }   // Resume of a `polling` row: skip the initial
  // request, re-enter the poll loop with the recorded initial response (05 Resume item 3).
}

// store/lifecycleActions.ts
export function cancelRun(): AppThunk<Promise<void>>
// abort all controllers; for each non-terminal step dispatch step.cancelled; dispatch
// run.annotation({ level: 'notice', message: 'Run cancelled — server-side pipeline jobs already
// enqueued keep running.' }) when any pipeline step was in flight (01 Cancel); dispatch
// run.finished({ status: 'cancelled' }). The middleware persists each (write path rows: cancelled).

export function openRun(a: { runId: string; run: RunRow; steps: StepRow[] }): AppThunk<Promise<void>>
// The RunPage entry point for a `running` row this tab does not hold:
//   def = toDefinition(run.definition); state = replayRun(run, steps, def)
//   const l = await runStore.lease(runId, owner)
//   l.ok  → adopt live: dispatch(runOpened({ meta })); dispatch(runReplaced({ state, mode: 'live' }));
//           resume steps: for each StepState — 'polling' → launch runPipelineStep with
//           resume: { mode: 'poll-only', initial: s.response.initial }; 'queued'/'running' → relaunch
//           full (re-request; Decision 3 — no `resume:` hint in M1); 'waiting' → nothing (the pane
//           re-mounts from state); middleware heartbeat restarts.
//   !l.ok → dispatch(runReplaced({ state, mode: 'readonly' })) — RunPage shows the live read-only
//           view (5 s polling) with a confirm-gated Take over button.
export function takeOver(a: { runId: string; run: RunRow; steps: StepRow[] }): AppThunk<Promise<void>>
// lease(runId, owner, takeover: true) then the adopt-live path of openRun.
```

Transition note: resume re-emissions are self-transitions (`running → running`, `polling → polling`) — `assertTransition` permits `from === to` as a payload-refresh no-op (see the Task 6 table note).

- [ ] **Step 1: Write the failing tests** — (a) cancel mid-poll: hello run driven to `slow` polling → `cancelRun()` → step `cancelled`, run `cancelled`, the notice annotation present, recorded writes end with the run patch `{ status: 'cancelled' }`; (b) resume-poll: build rows for a run whose `slow/0/start` row is `polling` with `response.initial = { jobId }` (MSW db seeded so the next poll answers `done`) → `openRun` → fake http records **no** POST `/api/hello/slow`, one GET `/api/hello/job`, run completes after the form; (c) lease held (MSW db row `leaseUntil: Date.now() + 60_000`, other owner) → `openRun` → mode `readonly`; `takeOver` flips to live and the db row's `leaseOwner` is ours.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (pipeline resume mode included; RunPage banners: Resume button when lease expired, Take over behind `window.confirm`).

- [ ] **Step 4: Run tests, verify green.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): cancel, resume with lease, take-over, re-run" && git push`

### Task 20: The hello implementation — rule set + staged bundle

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/hello/ruleset.yaml`, `schemas/hello_jobs.schema.yaml`
- Create: `apps/workflow/.bffless/proxy-rules/hello/rules/api/hello/echo/post/{rule.yaml,echo.fn.js}`, `…/slow/post/{rule.yaml,work.fn.js}`, `…/job/get/{rule.yaml,shape.fn.js}`, `…/fail/post/rule.yaml`, `…/rules/w/hello/[...path]/get.rule.yaml`
- Create: `apps/workflow/scripts/stage-hello.mjs`
- Modify: `apps/workflow/src/rules.fence.test.ts` (cover both sets)
- Test: `apps/workflow/src/hello-stage.test.ts`

**Interfaces:**
- Consumes: spec 06 (implementation shape), the MSW hello contract (Task 11 — the real rules must match it).
- Produces: the deployable backend + bundle Task 22 ships; `node apps/workflow/scripts/stage-hello.mjs [--out <dir>]` → `<dir or apps/workflow/hello-dist>/.bffless/workflows/{hello.workflow.yaml,index.json}`.

Rule content (mirrors the mocks exactly):

`ruleset.yaml`: `name: hello` + description. `schemas/hello_jobs.schema.yaml`:

```yaml
name: hello_jobs
fields:
  - { name: status, type: string, required: true }
  - { name: request, type: json, required: false }
  - { name: result, type: json, required: false }
  - { name: error, type: string, required: false }
  - { name: startedMs, type: number, required: false }
```

`echo/post/rule.yaml` — `function_handler` (`./echo.fn.js`) + `response_handler` `{{{steps.echo}}}`, `auth_required`. `echo.fn.js`:

```js
const text = String(request.body.text ?? '')
const upper = request.body.upper === true || request.body.upper === 'true'
return { text: upper ? text.toUpperCase() : text }
```

`slow/post/rule.yaml` — the studio enqueue+postSteps pattern: steps = `createJob` (`data_create` into `hello_jobs`: `status: "'pending'"`, `request: request.body`, `startedMs: <fn 'now' step>`), `respond` (`{"jobId":"{{steps.createJob.id}}","status":"pending"}`); postSteps = `setRunning` (`data_update` → `'running'`), `work` (`function_handler ./work.fn.js`), `finish` (`data_update` → `status: "'done'"`, `result: steps.work`), `auth_required`. `work.fn.js`:

```js
// Compose the report from the greet lines; poster = the uploaded photo's path (or null).
const req = (steps.createJob && steps.createJob.request) || request.body || {}
const lines = Array.isArray(req.lines) ? req.lines : []
const markdown = ['## Hello report', '', ...lines.map((l) => `- ${l}`)].join('\n')
const ms = Date.now() - (steps.createJob.startedMs || Date.now())
return { markdown, posterPath: req.photo || null, ms }
```

`job/get/rule.yaml` — `data_query` (`recordId: request.query.id`, `$schema:hello_jobs`) + `shape.fn.js` (`return { id: steps.query.id, status: steps.query.status, result: steps.query.result || null, error: steps.query.error || null }`) + respond `Cache-Control: no-store`, `auth_required`. `fail/post/rule.yaml` — one `response_handler`: status 418, body `'{"code":"{{request.body.code}}","error":"fails on purpose"}'`, `auth_required`. `rules/w/hello/[...path]/get.rule.yaml` — the D2 forwarding rule (no validators — deployment visibility governs):

```yaml
targetUrl: https://hello.j5s.dev
order: 5
description: 'Single-origin forwarding (ADR-0001): /w/hello/[...path] on the harness host → the hello alias. targetUrl is per-install until CE grows targetUrl: alias://hello.'
```

> Live `retry` note: the real `slow` never answers 503 BUSY — the retry path is exercised by the mock backend and unit tests only (deterministic live BUSY would need server state for no user value). `retry.if` simply never fires live.

`scripts/stage-hello.mjs` (node, imports the **built** `@bffless/workflow-lint` — CI builds it first):

```js
#!/usr/bin/env node
// Stage the workflow-hello bundle: .bffless/workflows/hello.workflow.yaml + generated index.json (06).
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { lintSource, loadDefinition } from '@bffless/workflow-lint'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(appDir, 'docs/spec/examples/hello.workflow.yaml')
const outIdx = process.argv.indexOf('--out')
const out = outIdx > -1 ? process.argv[outIdx + 1] : join(appDir, 'hello-dist')
const yaml = readFileSync(src, 'utf8')

const { findings } = lintSource(yaml, { file: 'hello.workflow.yaml' })
if (findings.some((f) => f.severity === 'error' || f.severity === 'warning')) {
  console.error('hello.workflow.yaml fails lint — a failing lint fails the publish (06):', findings)
  process.exit(1)
}
const { def } = loadDefinition(yaml)
const headlessSafe = !findings.some((f) => f.rule === 'interactive-headless')
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? execSync('git rev-parse --short HEAD').toString().trim()

const dir = join(out, '.bffless', 'workflows')
mkdirSync(dir, { recursive: true })
copyFileSync(src, join(dir, 'hello.workflow.yaml'))
writeFileSync(join(dir, 'index.json'), JSON.stringify({
  spec: 1, impl: 'hello', name: 'Hello',
  description: 'M1 test implementation: echo, slow job + poll, fail-on-purpose.',
  version, commit, generatedAt: new Date().toISOString(),
  workflows: [{
    file: 'hello.workflow.yaml', name: def.name,
    description: def.raw.description ?? '',
    inputs: Object.keys(def.inputs).length, jobs: Object.keys(def.jobs).length, headlessSafe,
  }],
  islands: [], scripts: [],
}, null, 2))
console.log('staged', join(dir, 'index.json'))
```

Fence-test update: parameterize over both set dirs (`['workflow', 'hello']`); forwarding rules (`targetUrl !== 'pipeline'`) stay exempt from the `auth_required` assertion; add `hello_jobs` to the schema check for the hello set.

- [ ] **Step 1: Write the failing tests** — `hello-stage.test.ts`: `execFileSync('node', [script, '--out', tmp])` (after `pnpm --filter @bffless/workflow-lint build`); parse the staged `index.json`: `workflows[0]` has `jobs: 4`, `inputs: 4`, `headlessSafe: true`, `impl: 'hello'`; the staged yaml is byte-identical to the spec example. **Parity test:** the staged `index.json`'s `workflows[0]` counts equal the MSW handler's mock index counts (import both).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** rules + script; update the fence.

- [ ] **Step 4: Run tests, verify green** (`pnpm --filter workflow test:run` — fence now covers 15 rule files).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(workflow): hello implementation — rule set and staged bundle" && git push`

### Task 21: The Playwright smoke

**Files:**
- Create: `apps/workflow/playwright.config.ts`, `apps/workflow/e2e/hello.spec.ts`
- Modify: `.github/workflows/workflow-app.yml` (e2e job steps), `apps/workflow/.gitignore` (`hello-dist/`, `playwright-report/`, `test-results/`)

**Interfaces:**
- Consumes: the whole harness against the MSW backend (dev server, mocks default-on); the 08/07 testid contract.
- Produces: `pnpm --filter workflow test:e2e` — the ONE smoke (09).

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:4680' },
  webServer: {
    command: 'pnpm dev --port 4680 --strictPort',
    url: 'http://localhost:4680',
    reuseExistingServer: !process.env.CI,
  },
})
```

`e2e/hello.spec.ts` (one spec, the full loop):

```ts
import { test, expect } from '@playwright/test'

test('hello workflow runs end to end against the mock backend', async ({ page }) => {
  await page.goto('/?mocks=on')
  await expect(page.getByTestId('implementations')).toContainText('hello')
  await page.getByRole('link', { name: /hello/i }).first().click()
  await expect(page.getByTestId('workflow-list')).toContainText('Hello workflow')
  await page.getByRole('link', { name: 'Hello workflow' }).click()
  await expect(page.getByTestId('step').first()).toBeVisible()          // definition graph

  await page.getByRole('link', { name: /start a run/i }).click()
  await expect(page.getByTestId('kickoff-form')).toBeVisible()
  await page.getByTestId('kickoff-start').click()                        // defaults: Hello / [world]

  const status = page.getByTestId('run-status')
  await expect(status).toHaveAttribute('data-state', 'running')
  // greet succeeds, slow retries (mock BUSY) then polls to done, flaky fails-then-recovers,
  // confirm waits on the form:
  const review = page.locator('[data-testid="step"][data-key="confirm/0/review"]')
  await expect(review).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Finish' }).click()             // the form step's submit label

  await expect(status).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 })
  const outputs = page.getByTestId('run-outputs')
  await expect(outputs).toContainText('report')
  await expect(outputs).toContainText('lines')
  await expect(outputs).toContainText('Hello, world!')                   // collected greet line
  // the flaky job's warning annotation surfaced:
  await expect(page.getByText(/boom failed with TEAPOT/)).toBeVisible()
  // and the run appears under Past runs:
  await page.getByRole('link', { name: /past runs|runs/i }).first().click()
  await expect(page.getByRole('row').nth(1)).toContainText('succeeded')
})
```

CI additions to `workflow-app.yml` after the build step:

```yaml
      - name: Install Playwright Chromium
        run: pnpm --filter workflow exec playwright install chromium --with-deps
      - name: Playwright smoke
        run: pnpm --filter workflow test:e2e
```

- [ ] **Step 1: Write the spec** (above) and run it — expect it to pass against the finished Phase 3 app; where it fails, fix the app (testids/data-states are the contract), not the spec's assertions, unless the assertion contradicts the specs.

- [ ] **Step 2: Run** `pnpm --filter workflow test:e2e` locally (headless Chromium from `~/.cache/ms-playwright`) → 1 passed.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "test(workflow): playwright smoke — hello end to end on the mock backend" && git push`

### Task 22: Deploy workflow (severable — gated on user-created infrastructure)

**Files:**
- Create: `.github/workflows/deploy-workflow.yml`
- Modify: `apps/workflow/bffless/README.md` (fill the live-verification checklist)

**Interfaces:**
- Consumes: `bffless/deploy-proxy-rules@v1`, `bffless/upload-artifact@v1`, `scripts/stage-hello.mjs`.
- Produces: a `workflow_dispatch`-only deploy (flip to `push: branches: [main], paths: ['apps/workflow/**']` once the first manual dispatch succeeds).

**Manual prerequisites (user, admin panel / MCP — cannot be done from this repo):**
1. Create project `bffless/workflow` on j5s.dev; 2. aliases `workflow` + `hello` with domains `workflow.j5s.dev` / `hello.j5s.dev`; 3. an API key with deploy rights stored as repo secret `BFFLESS_WORKFLOW_API_KEY`; 4. a default storage backend on the instance.

```yaml
name: Deploy Workflow harness to BFFless
on:
  workflow_dispatch: {}
concurrency: { group: deploy-workflow, cancel-in-progress: false }
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @bffless/workflow-lint build
      - run: pnpm --filter workflow build
      - run: pnpm --filter workflow test:run
      - name: Stage the hello implementation bundle
        run: node apps/workflow/scripts/stage-hello.mjs
      - name: Sync proxy rules (workflow + hello)
        uses: bffless/deploy-proxy-rules@v1
        with:
          path: |
            apps/workflow/.bffless/proxy-rules/workflow
            apps/workflow/.bffless/proxy-rules/hello
          api-url: ${{ vars.BFFLESS_URL }}
          api-key: ${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
          project: bffless/workflow
          summary-title: Workflow Proxy Rules
      - name: Deploy the harness
        uses: bffless/upload-artifact@v1
        with:
          path: apps/workflow/dist
          api-url: ${{ vars.BFFLESS_URL }}
          api-key: ${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
          project: bffless/workflow
          alias: workflow
          proxy-rule-set-names: workflow,hello
      - name: Deploy the hello implementation
        uses: bffless/upload-artifact@v1
        with:
          path: apps/workflow/hello-dist
          api-url: ${{ vars.BFFLESS_URL }}
          api-key: ${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
          project: bffless/workflow
          alias: hello
          proxy-rule-set-names: hello
```

**Live verification checklist** (append to `bffless/README.md` under Manual setup; run once after the first dispatch, each item is a Decision that assumed something):
- Decision 4: `GET https://workflow.j5s.dev/api/aliases` returns the alias list under a member session (else: build the designed `/api/workflow/aliases` relay rule from Task 1's note).
- Decision 8: upload a kickoff photo → the returned ref's `url` serves the bytes (files-trio `subDir` mapping) — else adjust the serve rule's `subDir`/url minting together.
- `project:` input names: confirm both actions accept `project:` for a non-default project (memory: the two deploy actions have different project fallbacks) — else set repo var scoping.
- Do **not** add these sets to `.bffless/config.json`'s `ruleSets` globs — that file drives the nightly drift check against project `bffless/apps`; the workflow sets live in `bffless/workflow` (note this in the README).

- [ ] **Step 1: Author both files** per the blocks above.
- [ ] **Step 2: Verify** `node apps/workflow/scripts/stage-hello.mjs` locally produces `hello-dist/` and `pnpm apps:check` stays green.
- [ ] **Step 3: Commit + Phase-3 PR**

```bash
git add -A && git commit -m "ci(workflow): dispatch-only deploy for harness + hello (needs bffless/workflow project)" && git push
gh pr create --title "feat(workflow): live runner, resume and the hello smoke" --body-file - <<'PRBODY'
M1 Phase 3 of 3 (plan: docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md).
Kickoff + presigned uploads; the runner listener middleware (write-ahead persistence,
scheduling, heartbeat lease); built-in form step; cancel/resume/take-over/re-run; the hello
implementation as a real rule set + staged bundle; the Playwright smoke; a dispatch-only
deploy workflow gated on the bffless/workflow project being created.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AxAwFXrMvmWTTN6zKzyv4k
PRBODY
```

---

## Self-review (writing-plans checklist, applied)

**Spec coverage.** Every 00-overview M1 bullet maps to tasks (see the corrected traceability table above): discovery → 11/12; parse/validate → 3/4/14; graph → 7/14; kickoff → 16; pipeline+poll/retry → 10/17; persistence → 1/9/17; Resume+lease → 1/9/19; run page → 13/14/15/18; summaries/annotations → 8/15/17/18; hello → 11 (mock) / 20 (real) / 21 (smoke). 05's write-path table is encoded in `eventToWrites` (Task 9); 05's Resume steps 1–4 are `openRun` (Task 19); 06's files trio is Task 1 + `uploadFile` (Task 16); 08's routes are Task 12, panes Task 15, empty states Tasks 12/14/15, testid contract Tasks 14/15/16/21. Known intentional gaps are all in **Decisions 1, 10, 13** (M2/M3 items + Delete deferred).

**Placeholder scan.** No TBDs. Two deliberate summary-form code blocks remain (Task 11's `workflowApi` endpoint bodies are specified by their comment contracts; Task 12's stub pages) — each states its complete observable behavior and its tests; acceptable at plan altitude because the consuming signatures are exact.

**Type consistency (fixed inline during this pass):**
- `STEP_TRANSITIONS.queued` includes `'waiting'` (form steps go queued → waiting), and `assertTransition` permits `from === to` as a no-op payload refresh (Resume re-emissions) — reflected in Task 6.
- `PipelineStepArgs.resume` added in Task 19 as a compatible extension of Task 10's signature.
- `nextActions(def, state)` argument order is (def, state) everywhere; `eventToWrites(event, { state, runRow })`; `replayRun(run, steps, def)`; `buildContexts(def, state, scope)` — verified consistent across Tasks 5–19.
- The traceability table at the top was renumbered to match the final 22-task layout.
- Decision 13 gains "Delete run deferred entirely (rule + storage GC together, M2)" — the 08 header's Delete action does not ship in M1.

## Execution handoff

Plan complete. Execute per phase (Phase 1 → merge → Phase 2 → merge → Phase 3), each in its own worktree/PR as specified in Global Constraints. Two execution options: **1. Subagent-Driven** (superpowers:subagent-driven-development — fresh subagent per task, review between tasks) or **2. Inline** (superpowers:executing-plans — batch with checkpoints). The ⚑ decisions (form-in-M1, hello placement, deploy gating) and the deviations bundle were all confirmed by the user on 2026-08-20 — Phase 1 is cleared to start.
