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

(Full plan continues in /home/rico/bffless/plans/2026-08-19-workflow-m1-harness-core.md)
