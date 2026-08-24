# Workflow M2 — Interactive Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Workflow harness (`apps/workflow`) from "pipelines and a plain form" (M1) to the M2 bar: `island` steps hosted as MCP Apps in a sandboxed iframe with `workflow.submit`/`workflow.annotate` host tools and pipelines-as-tools; `script` steps in a Worker with Blob file outputs; `render: island` and the four named renderers (`transcript`, `chart`, `images`, `code`); the mid-run `form` upgrades M1 deferred (`file` fields, tile-picker previews, markdown preview); run deletion with file-prefix GC; the >256 KB `{"$file"}` payload offload; graph data-flow hover; and the M1 live follow-ups (#362 `?download=1` contract, #363 scoped discovery) — mock-first (MSW), one Playwright smoke per phase, a live j5s verification at the end.

**Architecture:** Same shape as M1 (spec 09 / ADR-0003): the pure engine in `src/lib/runner/` grows two adapters (`adapters/island.ts`, `adapters/script.ts`) whose *pure* halves (tool-name resolution, submit validation, output/Blob coercion, event production) are unit-tested with fakes, while their *IO* halves — the `@modelcontextprotocol/ext-apps` `AppBridge` host around a `srcdoc` iframe, and a Blob-URL module Worker with a postMessage RPC relay — live in `src/islands/` and `src/scripts/` outside the purity fence and are driven by the one runner middleware. Every new transition is still one row write (05); Resume re-mounts a `waiting` island from its recorded `inputs` and re-runs a `running` script. Renderers stay one dispatch (`ValueView`). Deletion is one harness pipeline that removes rows and the run's storage prefix together (D18: the per-workflow `inputs/` area is exempt).

**Tech Stack:** Everything M1 pinned (TypeScript ~6.0.2, React ^19.2, RTK ^2.12, react-router ^7, `@bffless/workflow-lint` `workspace:*`, MSW ^2, vitest ^4, Playwright 1.61.1, eslint ^10) plus: `@modelcontextprotocol/ext-apps ^1.7.5` (host `AppBridge` + `PostMessageTransport`; peers `@modelcontextprotocol/sdk ^1.30.0`, `zod ^4.4.3`), `highlight.js ^11.12.0` (`lib/core` + a fixed language set) for `render: code`, `uplot ^1.6.32` for `render: chart`, `vite-plugin-singlefile` (dev, hello islands only). New workspace package `packages/workflow-script` (types only, zero runtime). Backend: the `workflow` rule set gains `POST /api/workflow/run/delete` (`data_query` → `function_handler` gate → `file_delete prefix` → `data_delete` ×3); the `hello` set gains `POST /api/hello/analyze`.

**Spec:** `apps/workflow/docs/spec/` — 00-overview.md (M2 bullet, D4–D7, D9, D18), 02-types-and-renderers.md (renderers table, File ref, `render: island`), 03-step-kinds.md (`island`, `form`, `script`), 04-islands.md (the MCP Apps contract — **amended by Decision 1 in Phase 1**), 05-runs-and-persistence.md (`{"$file"}`, retention & deletion, annotations), 06-discovery-publishing-files.md (files trio, `step.prefix`, access), 08-harness-ui.md (panes, `display: fullscreen`, header Delete, data-flow hover), 09-state-management.md (adapters behind interfaces, testing stance), ADR-0001/0002, `workflow.schema.json`, `examples/hello.workflow.yaml` (M1 — untouched) and the new `examples/interactive.workflow.yaml` (M2 test workflow, Decision 3). M1 plan: `docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md` (its Decisions 1, 10, 13 are what this plan pays down). Live state: `apps/workflow/bffless/README.md` (the walked checklist: `/api/uploads/workflows/*` serve route, `data_query` bare arrays, `upload-artifact ≥ 1.4.2` keeps `.bffless/`). Follow-ups folded in: apps#362 (`?download=1`, CE side ce#697), apps#363 (`?repository=`). Not in scope: apps#361 (done), apps#364 / ce#698 (`alias://`, M4).

## Decisions this plan makes (spec-ambiguous points, resolved here)

Locked D1–D18 and the M1 decisions are not re-litigated. The eight ⚑ items **were confirmed by the user on 2026-08-24** (answers recorded inline); the rest are reversible calls made by the planner and flagged.

1. **⚑ CONFIRMED — Tool names are dot-canonical, slash-tolerant.** Spec 04 names tools by pipeline path (`workflow/submit`, `video/slice`); MCP's tool-name guidance is `[A-Za-z0-9_.-]`. The host's canonical names are `workflow.submit`, `workflow.annotate`, and a pipeline's path with `/` replaced by `.` (`video.slice`); the host **also accepts** the slash form verbatim. Resolution rule (Task 3): a name containing `/` is used as the relative path as-is; otherwise every `.` becomes `/`. A pipeline whose path itself contains a `.` is therefore only reachable by the slash form (lint notice, Task 2). Spec 04, 03 (`island` example), ADR-0002 and `examples/studio.workflow.yaml` are edited in Phase 1 to say so.
2. **⚑ CONFIRMED — Scripts run in a Blob-URL module Worker with a postMessage relay; no COOP/COEP in M2.** The harness fetches the module text from `/w/<impl>/scripts/<x>.js` (same path islands use, MSW-mockable in vitest), spawns `new Worker(URL.createObjectURL(blob), { type: 'module' })` and injects the `ctx` contract (03) through a worker-side shim: `ctx.files.fetch`, `ctx.log`, `ctx.annotate` are RPC to the main thread, so the Worker itself never needs credentials (06: "every call goes through the harness"). Threads / `SharedArrayBuffer` / ffmpeg core-mt and the COOP/COEP response-header rules are decided at M3 with the Studio port (03's open item stays open, now dated).
3. **⚑ CONFIRMED — The M2 test workflow is a second workflow in hello: `interactive.workflow.yaml`.** `hello.workflow.yaml` and the M1 smoke stay byte-identical; the hello bundle ships two workflows (discovery lists a 2-workflow implementation). The new workflow lands **incrementally per phase** so every push-to-main deploy stays runnable live: Phase 1 = island step + `render: island` viewer; Phase 2 = script job; Phase 3 = form upgrades + named renderers. Hello gains one pipeline, `POST /api/hello/analyze` (words/counts/snippet from the greet lines), two islands and one script (Decision 12).
4. **⚑ CONFIRMED — Cancel-time semantics (PR #357's parked note) stay deferred to M3.** `cancelRun` keeps M1 behaviour (in-flight → `cancelled`, `run.finished` at once; `if: cancelled()`/`always()` cleanup steps never run). Recorded in "Deferred out of M2" below; decided at M3 against the Studio port's first real cleanup step.
5. **⚑ CONFIRMED — `{"$file"}` offload applies to `outputs` only, at 256 KB.** A step-output or run-output value whose JSON serialisation exceeds **256 KB** (the epic's number, not 05's 1 MB) is stored as `<name>.json` under `step.prefix` (run-level: `<run.prefix>/outputs/<name>.json`) and the **row** holds `{ "$file": <File ref> }`; the live `RunState` keeps the value inline (expressions are synchronous). Replay hydrates every `$file` before reducing (Task 13). `response` keeps M1's 256 KB trim + `truncated` flag — it is debug data.
6. **⚑ CONFIRMED — Renderer dependencies: `highlight.js` (core + fixed language set) for `code`, `uplot` for `chart`.** Languages bundled: `javascript, typescript, json, yaml, bash, python, xml, css, markdown`; an unknown `mapping.language` renders unhighlighted with the label. `chart` supports `mapping: { x, y, kind: bar | line }` over a `table` (`rows`) or a `json` array of objects.
7. **⚑ CONFIRMED — Run deletion: owner or admin, terminal runs only, header action only.** `POST /api/workflow/run/delete { id }`: the gate allows `run.startedBy === user.id` or a global role of `admin`/`owner`; a `running` run answers 409 (cancel first). It deletes, in this order, the run's storage prefix (`workflows/<impl>/<workflow>/runs/<id>/`), the `workflow_files` records under it, the step rows, then the run row — files first so a failed GC leaves a retryable record, not orphaned bytes. The Delete button lives in the run header behind a confirm; no per-row delete on Past runs; the `inputs/` area is never touched (D18 — 05's "also delete its uploaded inputs" tick is **not** built in M2).
8. **⚑ CONFIRMED — Discovery is scoped by a build-time `VITE_BFFLESS_PROJECT`.** `deploy-workflow.yml` builds with `VITE_BFFLESS_PROJECT=bffless/workflow`; the discovery query appends `?repository=<value>` when set and stays unscoped when unset (dev, mocks, tests) — the relay preserves the query string (README). Runtime self-discovery of the project is an M4 catalog-install concern (apps#363 stays open until then, re-titled to the M4 half).
9. **Island sandbox = exactly 04 v1.** One `<iframe sandbox="allow-scripts">` (opaque origin), HTML fetched by the harness (`fetch('/w/<impl>/islands/x.html', { credentials: 'same-origin' })`) and injected via `srcdoc`; `_meta.ui.permissions` → the iframe `allow` attribute via ext-apps' `buildAllowAttribute`; `PostMessageTransport(iframe.contentWindow, iframe.contentWindow)` on the host side (ext-apps posts with `targetOrigin "*"` and filters on `event.source`, so an opaque origin works). No double-iframe proxy, no per-island CSP (04 "Later").
10. **`tools/call` HTTP mapping.** Default `POST /api/<impl>/<path>` with `arguments` as the JSON body; a call may set `_meta: { bffless: { method: 'GET' } }` to send `arguments` as the query string (04 says "GET rules are called with arguments as query" but the host cannot know a rule's method — the island says). Result: `structuredContent` = the JSON body (or `{ text }` for a non-JSON 2xx), `content: [{ type: 'text', text: JSON.stringify(body) }]`; a non-2xx → `isError: true` with `content[0].text` = `code: message` and `_meta.bffless.status`. Absolute paths and names resolving outside `/api/<impl>/` are rejected as a tool error (04 own-implementation restriction).
11. **Island step lifecycle.** `queued → running` (`step.started`, `inputs` = evaluated `with` minus `src/title/display`, HTML fetched, bridge connected) `→ waiting` (after `ui/notifications/initialized`, `tool-input` sent) `→ succeeded` (a valid `workflow.submit`) / `failed` (`ISLAND_LOAD` when the HTML fetch is not 2xx or `ui/initialize` never arrives within 30 s; `TIMEOUT` per `timeout-minutes`). Cancel → `teardownResource({ reason: 'cancelled' })` then `step.cancelled`. Resume of a `waiting` island row re-mounts from the recorded `inputs` (no re-evaluation — the record is the truth, D16). Islands are not resumed as `running` (a row stuck in `running` is re-driven from `queued` semantics: the relaunch re-fetches and re-mounts, same as a `running` pipeline re-requests).
12. **Dynamic annotations/summaries are a persisted event.** `workflow.annotate` (islands) and `ctx.annotate` (scripts) emit a new engine event `step.annotated { key, annotations?, summary?, at }`, applied by the reducer (append annotations, replace summary) and persisted as one step-row upsert of `annotations`/`summary` (05 "appended to the same columns"). Replay: a non-terminal row that already carries annotations/summary yields one `step.annotated` after its status event. `ctx.log` lines are live-only (shown in the step card, never persisted).
13. **Script step lifecycle.** `queued → running` (`step.started` with `inputs` = evaluated `with` minus `src`) `→ succeeded` / `failed` (`error.code` = `err.code` string if present else `SCRIPT`; `SCRIPT_LOAD` when the module fetch/instantiation fails; `TIMEOUT` per `timeout-minutes`). Cancel → `worker.terminate()` → `step.cancelled`. Resume re-runs a `running` script row from scratch (scripts are re-runnable; an unregistered Blob is nothing). Returned `Blob`/`File` values where a `file` output is declared are uploaded by the main thread through the files trio under scope `runs/<runId>/<stepKey>` (a `File` keeps its name; a bare `Blob` is named `<output>.<ext>` with the extension derived from `blob.type`, `.bin` when unknown); a returned string where a `file` is declared is registered as in M1; anything else fails `OUTPUT_TYPE`.
14. **Form upgrades (M1 Decision 1 paid down).** `FormStepPane` passes an `upload` bound to scope `inputs` (D18: form uploads are kickoff-class, not run-scoped); `choice` options may be an expression (evaluated with the step's contexts, both for the kickoff form's static case and the mid-run form) and render as a **tile picker** when any option carries `preview` or when the options are File refs (the value is the ref's `path`, 02); `markdown` fields get a live preview toggle (`MarkdownView`). `headless: auto` auto-submit for forms/islands and `_meta.bffless.headless` semantics stay **M3** (the host already stamps `_meta.bffless.headless = run.headless`, always `false` in M2).
15. **`isSafeUrl` tightened; a separate same-origin check for media sinks.** `isSafeUrl` now rejects protocol-relative urls (`//host`, `/\host`, and any whitespace-stripped equivalent) everywhere. A new `isSameOriginUrl` (root-relative `/…` or an absolute `http(s)` url whose origin equals `location.origin`) gates `FileCard`, `images`, `transcript` seek targets and `render: island` `src` — the sinks that load bytes. Markdown link/image hrefs keep `isSafeUrl` (http/https/mailto allowed).
16. **`?download=1` contract unchanged (apps#362).** `FileCard` keeps `href = url + download=1` and the `download` attribute (same-origin, so the browser saves anyway); when ce#697 lands nothing in the harness changes. Task 24's checklist records the observed behaviour either way.
17. **Lint grows with the kinds (Task 2).** New rules in `@bffless/workflow-lint`: `island-src-ext` / `script-src-ext` (errors: `src` must end `.html` / `.js|.mjs`), `island-reserved-with` (error: `with.src|title|display` are not delivered as tool input, so an island output named like them is fine but a `with` key named `arguments` is not — reserved list `src,title,display`), `render-mapping` (warning: `chart` without `mapping.x`/`mapping.y`; `code` without `mapping.language`), `tool-name-dot` (notice: a pipeline path containing `.` is only callable from an island by its slash name, Decision 1). `index.json`'s `islands`/`scripts` arrays are generated from the staged files.
18. **Three PRs, phase order = risk order.** Phase 1 islands (the biggest unknown: a third-party host SDK inside a sandbox), Phase 2 scripts + offload (engine/persistence changes), Phase 3 renderers + forms + deletion + minors (UI-heavy, low risk). The live verification is the tail of Phase 3.

## Deferred out of M2, explicitly

- Cancel-time semantics (`if: cancelled()`/`always()` cleanup, cancelled-job result mapping) — M3 (Decision 4).
- COOP/COEP / cross-origin isolation for threaded scripts — M3 (Decision 2).
- Headless behaviour of interactive steps (`headless: auto` auto-submit, `HEADLESS_TIMEOUT`, `?auto=1`) — M3 (07).
- Double-iframe sandbox proxy, per-island CSP, `ui://` resources from a BFFless MCP server, WebMCP — 04 "Later".
- "Also delete its uploaded inputs" on run deletion, automatic retention (`keep:`) — 05 follow-ups.
- Runtime project self-discovery for `?repository=` (catalog installs) — M4 (Decision 8).
- `targetUrl: alias://` for the `/w/<impl>` forwarder — M4 / ce#698.
- `response` offload (only `outputs` are offloaded, Decision 5).
- Script `ctx.log` persistence (live-only, Decision 12).

## Global Constraints

- Monorepo: pnpm 10 workspace `bffless-apps`; Node `>=20`; ESM only; TypeScript `~6.0.2`.
- **Shared checkout is read-only.** All work in a worktree: `git worktree add .claude/worktrees/workflow-m2-<phase> -b <branch> origin/main` from `/home/rico/bffless/repos/apps`. Verify `git rev-parse --show-toplevel` ends in the worktree path before the first commit; run a hygiene check (`git -C /home/rico/bffless/repos/apps status --short`) before each PR — a subagent can stray-write the main checkout.
- **Three sequential PRs, one per phase**, squash-merged, conventional-commit titles with scope `workflow` (the title IS the release commit): Phase 1 `feat(workflow): island host and the island step`; Phase 2 `feat(workflow): script steps, file outputs and the payload offload`; Phase 3 `feat(workflow): named renderers, form upgrades and run deletion`. Push every commit before opening the PR; re-check merge state before pushing follow-ups (the user merges fast).
- **A merge is a live deploy.** `deploy-workflow.yml` runs on push to `main` under `apps/workflow/**` (rules pruned + both bundles). Every phase must leave `workflow.j5s.dev` runnable: hello's M1 workflow untouched, the M2 workflow only ever declaring steps the merged harness supports (Decision 3).
- One parser: all expression evaluation via `@bffless/workflow-lint/expressions`, definitions via `/definition`, lint via `/lint`. **No second parser, no `eval`.** Island HTML is injected verbatim into a sandboxed `srcdoc` — it is never parsed, sanitised or rewritten by the harness.
- `src/lib/runner/**` imports nothing from React, Redux, MSW, `src/islands/`, `src/scripts/` or `src/` outside `lib/` (eslint `no-restricted-imports` block from M1 Task 4 — extend its patterns to the two new IO directories).
- Persisted step keys `"<job>/<index>/<step>"`; statuses unchanged (`queued running polling waiting succeeded failed skipped cancelled`). New event `step.annotated` (Decision 12) is the only vocabulary addition; `job.expanded` stays derived.
- Lease numbers unchanged (heartbeat 15 s, lease 60 s). `response` trimmed at 256 KB; `outputs` offloaded above **256 KB** (Decision 5). Island init timeout **30 s** (`ISLAND_LOAD`); script/island `timeout-minutes` → `TIMEOUT`.
- All new `/api/workflow/*` rules carry `validators: [{ type: auth_required, config: { allowApiKey: true } }]`; the delete rule's ownership check is a `function_handler` gate (the validator has no per-record notion).
- UI contract (08/07): existing `data-testid`s unchanged; new ones this plan adds and that Task 24's driver relies on: `island-frame`, `island-display` (`data-mode="inline|fullscreen"`), `script-log`, `run-delete`, `form-step`, `renderer` (`data-render="transcript|chart|images|code|island"`), `step-annotated`. Renaming any is a Playwright-breaking change.
- `pnpm apps:check` (conventions) green at the end of every task: `bffless/README.md` keeps its two required headings and gains the M2 rows (delete rule, `VITE_BFFLESS_PROJECT`, hello's new pipeline).
- Commit after every task; before each commit run `pnpm --filter workflow lint && pnpm --filter workflow test:run` (plus `pnpm --filter @bffless/workflow-lint test:run` when Task 2 touches it). Before each phase PR: `pnpm --filter workflow build && pnpm --filter workflow test:e2e` (needs `node apps/workflow/scripts/stage-hello.mjs` first from Phase 1 on), `bffless rules validate apps/workflow/.bffless/proxy-rules/workflow` and `…/hello`.

## File structure

```
apps/workflow/
  package.json                      + ext-apps, sdk, zod, highlight.js, uplot; dev: vite-plugin-singlefile; "stage" script
  vite.config.ts                    + define VITE_BFFLESS_PROJECT passthrough (no change needed: import.meta.env)
  bffless/README.md                 + delete rule, VITE_BFFLESS_PROJECT, hello analyze, M2 checklist rows
  .bffless/proxy-rules/
    workflow/rules/api/workflow/run/delete/post/{rule.yaml,gate.fn.js}            Task 19
    workflow/rules/api/workflow/whoami/get/rule.yaml                              Task 19 (current user for the header + delete gate)
    hello/rules/api/hello/analyze/post/{rule.yaml,analyze.fn.js}                    Task 6
  hello/                            ← hello's M2 static sources (test scaffolding, M1 Decision 2 still applies)
    islands/pick-line/index.html + main.ts   (Vite single-file build → hello-dist/islands/pick-line.html)   Task 7
    islands/line-viewer/index.html + main.ts (render: island viewer)                                       Task 7
    scripts/poster-card.js                   (plain ES module, copied verbatim)                              Task 14
    vite.islands.config.ts
  scripts/stage-hello.mjs           + copies interactive.workflow.yaml, builds islands, copies scripts, fills index.json islands/scripts
  docs/spec/examples/interactive.workflow.yaml   the M2 test workflow (grows per phase: Tasks 7, 14, 21)
  docs/spec/04-islands.md, 03-step-kinds.md, adr/0002-…, examples/studio.workflow.yaml   Decision 1 edits (Task 1)
  e2e/interactive.spec.ts           the M2 smoke (grows per phase)
  src/
    lib/
      runner/
        types.ts                    + step.annotated event; ScriptOutputs / IslandSubmit types
        transitions.ts              unchanged (running→waiting, queued→running already legal)
        reducer.ts                  + step.annotated
        rows.ts / replay.ts         + step.annotated write + replay; $file-aware rowsToEvents (values already hydrated)
        payload.ts                  NEW — isFilePayload(), offloadOutputs(), hydrateValue() (pure; IO via injected fns)
        adapters/island.ts          NEW — pure: islandInputs(), resolveToolName(), toolCallRequest(), completeIslandStep()
        adapters/script.ts          NEW — pure: scriptInputs(), coerceScriptOutputs() (Blob → upload fn injected)
      url.ts                        isSafeUrl (no protocol-relative) + isSameOriginUrl
      upload.ts                     + uploadBlob() (File|Blob + name) sharing prepare→PUT→register
      discovery.ts                  NEW — projectRepository() (VITE_BFFLESS_PROJECT), aliasesUrl()
    islands/                        IO, outside the purity fence
      IslandHost.ts                 createIslandHost(): AppBridge + PostMessageTransport around an iframe
      IslandFrame.tsx               the iframe component (step mode + viewer mode), display mode, allow attr
      islandDisplaySlice? → no: uiSlice gains islandDisplay
    scripts/
      worker-shim.ts                the Worker-side bootstrap (imports the module, builds ctx, RPC)
      ScriptHost.ts                 createScriptHost(): fetch text → Blob URL Worker → run(ctx) → outputs
    store/
      runnerMiddleware.ts           + island/script launches (start + resume), step.annotated, offload before persist
      uiSlice.ts                    + islandDisplay ('inline'|'fullscreen'), hoveredValue
      lifecycleActions.ts           + deleteRun(); openRun hydrates $file before replay
      workflowApi.ts                + discovery ?repository=, deleteRun mutation, getRun hydrates $file
    components/
      run/IslandStepPane.tsx        waiting island = the pane (or fullscreen takeover)
      run/ScriptStepCard.tsx        live log lines for a running script (data-testid="script-log")
      run/StepPane.tsx              island/script delegation; Output tab passes seek context
      run/RunHeader.tsx             + Delete (confirm) when terminal && (owner || admin)
      values/ValueView.tsx          named-render dispatch replaces the M2 badge
      values/renderers/{TranscriptView,ChartView,ImagesView,CodeView,IslandView}.tsx
      values/MediaSeekContext.ts    transcript click → nearest video
      kickoff/FieldControl.tsx      tile picker, markdown preview, options expressions
      graph/GraphView.tsx, StepChip.tsx   data-flow hover-highlight
    mocks/handlers.ts               + /w/hello/islands/*, /w/hello/scripts/*, /api/hello/analyze, /api/workflow/run/delete, ?repository= echo
    mocks/db.ts                     + deleteRun(), files by prefix
packages/workflow-lint/src/checks/{srcs.ts,render.ts,toolnames.ts}  Task 2 rules + tests
packages/workflow-script/           NEW — package.json ("types": index.d.ts, no runtime), README
localdev-tools/workflow-live.mjs    + interactive walk (Task 24; outside the repo)
.github/workflows/deploy-workflow.yml   VITE_BFFLESS_PROJECT at build; stage step already present
.github/workflows/workflow-app.yml      stage-hello before the e2e job
docs/superpowers/plans/2026-08-24-workflow-m2-interactive-steps.md   (this plan)
```

## Traceability — M2 scope → tasks

| Epic #359 M2 checkbox / spec item | Spec | Tasks |
|---|---|---|
| Write the M2 plan | — | this document |
| Island host + `island` step kind (`AppBridge`, sandboxed srcdoc, `workflow.submit`/`workflow.annotate`, pipelines-as-tools naming) | 03, 04, D5, ADR-0002 | 1, 3, 4, 5, 7, 8 |
| `render: island` + named renderers `transcript`, `chart`, `images`, `code` (replace M1 badge) | 02, M1 Decision 10 | 5 (island viewer), 15, 16, 17 |
| `script` step kind + file outputs | 03, 06 | 9, 10, 11, 14 |
| Mid-run `form` upgrades (`file` fields, tile picker, markdown preview) | 02, 03, M1 Decision 1 | 18 |
| Run deletion — delete rule + file-prefix GC together; header Delete | 05, D18, M1 Decision 13 | 19, 20 |
| Graph data-flow hover-highlight | 08 | 22 |
| >256 KB `{"$file"}` offload | 05, Decision 5 | 12, 13 |
| `isSafeUrl` same-origin tightening + remaining M1 minors | M1 review | 23 |
| apps#362 `?download=1` (contract kept; ce#697) | 06 | 16 (FileCard unchanged), 24 (checklist) |
| apps#363 scoped discovery (`?repository=`) | 06, README | 23 |
| Lint keeps pace (src extensions, mapping, tool names) | 09 | 2 |
| Hello M2 fixture (`interactive.workflow.yaml`, islands, script, analyze rule) | Decision 3 | 6, 7, 14, 21 |
| Live j5s verification (member login, headless runner) | 06 phase 1 | 24 |

---

# Phase 1 — The island host and the `island` step

*Branch `feat/workflow-m2-islands`, worktree `.claude/worktrees/workflow-m2-islands`. Deliverable: an `island` step renders its MCP App in a sandboxed iframe, can call its own implementation's pipelines as tools, finishes the step through `workflow.submit`, adds annotations through `workflow.annotate`; `render: island` shows a read-only viewer; hello ships `interactive.workflow.yaml` with one island step and one island viewer; the smoke drives it. The engine's only vocabulary change is `step.annotated`.*

### Task 1: Spec amendments for tool naming (Decision 1) + dependency install

**Files:**
- Modify: `apps/workflow/docs/spec/04-islands.md` (mapping table rows for `workflow/submit`, `workflow/annotate`; "Tool naming" section; authoring example), `apps/workflow/docs/spec/03-step-kinds.md` (`island` bullets), `apps/workflow/docs/adr/0002-islands-are-mcp-apps.md` (Decision + Consequences), `apps/workflow/docs/spec/examples/studio.workflow.yaml` (comment header only — YAML has no tool names), `apps/workflow/package.json`
- Test: none (docs) — `pnpm install` must succeed and `pnpm --filter workflow build` stay green.

**Interfaces:**
- Produces: the naming rule every later task implements — canonical `workflow.submit` / `workflow.annotate` / `<path with / → .>`; slash forms accepted; dot-in-path pipelines only reachable by slash name; `_meta.bffless.method` for GET (Decision 10).

- [ ] **Step 1: Edit spec 04.** Replace the "Tool naming — pipelines as tools" section with:

```markdown
## Tool naming — pipelines as tools

Inside an island a pipeline is a tool named after its path **relative to the implementation's
API prefix**, with `/` written as `.` (MCP tool names are `[A-Za-z0-9_.-]`):
`tools/call { name: "video.slice", arguments: {...} }` → `POST /api/<alias>/video/slice` with
`arguments` as the JSON body. The host is **slash-tolerant**: `"video/slice"` is accepted and
means the same thing — and a pipeline whose path itself contains a `.` (`feed.xml`) is only
callable by its slash name (the linter notices). The two host tools are `workflow.submit` and
`workflow.annotate` (slash forms accepted). A call may carry
`_meta: { bffless: { method: "GET" } }` to send `arguments` as the query string; the default
is POST. The host restricts islands to **their own implementation's** rules plus the
`workflow.*` host tools: absolute paths and other aliases are a tool error. `poll` is not
available to islands — an island that enqueues a job polls it itself.
```

Update the mapping table (`workflow/submit` → `workflow.submit`, `workflow/annotate` → `workflow.annotate`, `render: island` row: "`workflow.submit` is rejected"), the authoring example (`name: "workflow.submit"`, `name: "refine-scene"` unchanged — no slash), and the "Sandbox" paragraph gets one sentence: "The island HTML is fetched by the harness with the member's session and injected verbatim; relative asset references inside it do not resolve (opaque origin) — inline everything, or read siblings through `resources/read` (`ui://bffless/<impl>/…`)."

- [ ] **Step 2: Edit spec 03 `island` bullets and ADR-0002** to the same names; ADR "Decision" paragraph: "completion is our single host tool `workflow.submit` (plus `workflow.annotate`); tool names are dot-canonical and slash-tolerant (M2 plan Decision 1)". Add to the studio example's header comment: `# Island tool names: workflow.submit / refine-scene (04, dot-canonical).`

- [ ] **Step 3: Add dependencies** to `apps/workflow/package.json`:

```json
"dependencies": {
  "@modelcontextprotocol/ext-apps": "^1.7.5",
  "@modelcontextprotocol/sdk": "^1.30.0",
  "zod": "^4.4.3"
},
"devDependencies": { "vite-plugin-singlefile": "^2.3.3" }
```

Run `pnpm install` (from the worktree root). `highlight.js`/`uplot` are Phase 3 (Task 16).

- [ ] **Step 4: Verify** `pnpm --filter workflow build && pnpm --filter workflow test:run` still green (nothing imports the new packages yet).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs(workflow): dot-canonical island tool names; add ext-apps host deps" && git push -u origin feat/workflow-m2-islands`

### Task 2: Lint rules for the interactive kinds

**Files:**
- Create: `packages/workflow-lint/src/checks/srcs.ts`, `packages/workflow-lint/src/checks/toolnames.ts`
- Modify: `packages/workflow-lint/src/checks/render.ts` (render-mapping), `packages/workflow-lint/src/checks/index.ts` (register), `packages/workflow-lint/README.md` (rules table)
- Test: `packages/workflow-lint/src/checks/srcs.test.ts`, `toolnames.test.ts`, extend `render.test.ts`

**Interfaces:**
- Consumes: `Definition`/`Step` (`model/definition.ts`), `Finding` (`findings.ts`).
- Produces rules (rule ids are contract — the harness file screen shows them): `island-src-ext` (error), `script-src-ext` (error), `island-reserved-with` (error: `with` key `arguments`), `render-mapping` (warning), `tool-name-dot` (notice).

```ts
export function checkSrcs(def: Definition): Finding[]        // island/script/render:island src extensions + reserved with keys
export function checkToolNames(def: Definition): Finding[]   // pipeline step paths containing '.' → notice (only when the workflow has ≥1 island step)
```

- [ ] **Step 1: Write the failing tests** (vitest, `lintSource` over inline YAML): island `src: islands/x.htm` → `island-src-ext`; script `src: scripts/x.ts` → `script-src-ext`; output `render: island, src: islands/v.html` passes, `src: v.js` fails; island `with: { src, arguments: 1 }` → `island-reserved-with`; `render: chart` without `mapping` → `render-mapping` warning, with `mapping: {x: a, y: b}` clean; `render: code` without `mapping.language` → warning; a workflow with an island step and a pipeline `path: feed.xml` → `tool-name-dot` notice, the same pipeline in a workflow with no island → no notice.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bffless/workflow-lint test:run`.
- [ ] **Step 3: Implement** the three files; register in `runChecks` after `checkRender`.
- [ ] **Step 4: Run green**; also `pnpm --filter workflow test:run` (the harness's file screen tests assert finding counts on hello — hello has no islands, so counts must not change).
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow-lint): src extension, reserved with, render mapping and tool-name rules"`

### Task 3: Pure island adapter — inputs, tool-name resolution, submit validation

**Files:**
- Create: `apps/workflow/src/lib/runner/adapters/island.ts`
- Modify: `apps/workflow/src/lib/runner/types.ts` (`step.annotated` event), `reducer.ts`, `rows.ts`, `replay.ts`, `apps/workflow/eslint.config.js` (fence: forbid `src/islands`, `src/scripts` inside `lib/runner`)
- Test: `apps/workflow/src/lib/runner/adapters/island.test.ts`, extend `reducer.test.ts`, `rows.test.ts` (or `replay.test.ts`)

**Interfaces:**
- Consumes: `buildContexts`, `evalDeep` (contexts.ts); `validateValue` (outputs.ts); `validateInputConstraints`; `evalSummary`/`evalAnnotations` (results.ts).
- Produces:

```ts
// types.ts — one new event
| { type: 'step.annotated'; key: StepKey; annotations?: Annotation[]; summary?: string; at: number }
// reducer: append annotations, replace summary when given; legal in running|polling|waiting only (IllegalTransition otherwise)
// rows.ts: upsert { annotations: s.annotations, summary: s.summary ?? null }
// replay.ts: a non-terminal row with annotations/summary → its status event, then one step.annotated

// adapters/island.ts (pure)
export const ISLAND_RESERVED = ['src', 'title', 'display'] as const
export interface IslandStepArgs { step: Step; key: StepKey; job: string; index: number; def: Definition; state: RunState }
/** Evaluated `with` minus the reserved keys = tool-input arguments AND the persisted `inputs`. */
export function islandInputs(a: IslandStepArgs): { src: string; title: string; display: 'inline' | 'fullscreen'; arguments: Record<string, unknown> }
/** `islands/x.html` → `/w/<impl>/islands/x.html`; absolute `/w/…` verbatim (01 Paths). */
export function resolveSrc(impl: string, src: string): string
export type ToolTarget =
  | { kind: 'host'; tool: 'submit' | 'annotate' }
  | { kind: 'pipeline'; path: string; method: 'GET' | 'POST'; url: string }   // url = /api/<impl>/<path>
  | { kind: 'rejected'; reason: string }
/** Decision 1 + 10. */
export function resolveToolName(impl: string, name: string, meta?: unknown): ToolTarget
export type IslandSubmitResult =
  | { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { ok: false; errors: Record<string, string> }
/** Validate `outputs` against the step's declared map (02); on success evaluate summary/annotations. Never throws. */
export function completeIslandStep(a: IslandStepArgs & { outputs: unknown }): IslandSubmitResult
export function annotateEvent(key: StepKey, args: unknown, at: number): Extract<RunEvent, { type: 'step.annotated' }> | { error: string }
```

Semantics: `resolveToolName('studio', 'workflow.submit')` and `'workflow/submit'` → host submit; `'video.slice'` → `{ path: 'video/slice', url: '/api/studio/video/slice', method: 'POST' }`; `'video/slice'` same; `'feed.xml'` → path `feed/xml` (documented lossy case); `'/api/other/x'`, `'../x'`, `''`, names with `..` segments → rejected; `meta?.bffless?.method === 'GET'` → GET. `completeIslandStep` rejects a non-object `outputs`, missing declared outputs (`'required'`), type mismatches via `validateValue`, and — when the declaration has a `schema` — leaves JSON-Schema validation to M3 (note in code: 02 says "one function over that schema"; M2 validates type/list shape, the `schema` key is accepted and ignored — **flagged deviation**, fold into the plan's Deferred list at review).

- [ ] **Step 1: Write the failing tests** — inputs: a step `with: { src: islands/a.html, title: T, display: fullscreen, clip: "${{ inputs.greeting }}" }` on a state with `inputs.greeting = 'hi'` → `arguments = { clip: 'hi' }`, `display 'fullscreen'`; missing display → `'inline'`. Tool names: the table above, each case. Submit: declared `{ pick: { type: string, required: true }, n: { type: number } }` — `{ pick: 'a' }` ok with `outputs { pick: 'a' }` (undeclared keys dropped), `{ n: 1 }` → error `pick: 'This field is required'`, `{ pick: 1 }` → type error; summary template evaluated with `steps.<id>.outputs`. Annotate: `{ annotations: [{ level: 'notice', message: 'm' }] }` → event; `{ level: 'bogus' }` → error. Reducer: `step.annotated` on a `waiting` step appends; on a `succeeded` step throws `IllegalTransition`. Rows: `step.annotated` → one upsert with both columns. Replay: a `waiting` row with `annotations: [a]` replays to state with `[a]`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (types → reducer → rows/replay → adapter → eslint fence patterns).
- [ ] **Step 4: Run green** — `pnpm --filter workflow test:run && pnpm --filter workflow lint`.
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): pure island adapter, step.annotated event"`

### Task 4: The island host — `AppBridge` around a sandboxed srcdoc iframe

**Files:**
- Create: `apps/workflow/src/islands/IslandHost.ts`, `apps/workflow/src/islands/IslandFrame.tsx`, `apps/workflow/src/islands/fakeIsland.ts` (test double: a fake iframe `Window` that speaks JSON-RPC over a `MessageChannel`)
- Modify: `apps/workflow/src/store/uiSlice.ts` (`islandDisplay`), `apps/workflow/src/index.css` (frame + fullscreen strip)
- Test: `apps/workflow/src/islands/IslandHost.test.ts` (jsdom + fake island), `IslandFrame.test.tsx`

**Interfaces:**
- Consumes: `AppBridge`, `PostMessageTransport`, `buildAllowAttribute` from `@modelcontextprotocol/ext-apps/app-bridge`; `resolveToolName`, `resolveSrc` (Task 3); `HttpJson` (lib/http).
- Produces:

```ts
// IslandHost.ts
export interface IslandHostDeps {
  http: HttpJson                                          // tools/call → pipelines
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>   // HTML + resources/read
  onSubmit: (outputs: unknown) => { ok: true } | { ok: false; errors: Record<string, string> }  // wired to completeIslandStep by the middleware
  onAnnotate: (args: unknown) => { ok: true } | { ok: false; error: string }
  onDisplayMode: (mode: 'inline' | 'fullscreen') => void
  onLog: (line: string) => void                           // ui/message → step card
  openLink: (url: string) => void                         // isSafeUrl-gated window.open(_blank, noopener)
  now: () => number
}
export interface IslandHost {
  /** Fetches the HTML, mounts the bridge on `iframe`, resolves after ui/notifications/initialized (or rejects ISLAND_LOAD after 30 s / non-2xx). */
  mount(iframe: HTMLIFrameElement, a: { impl: string; src: string; arguments: Record<string, unknown>; viewer?: boolean; headless: boolean; signal: AbortSignal }): Promise<void>
  /** teardownResource then disconnect; idempotent. */
  teardown(reason: 'cancelled' | 'completed' | 'unmounted'): Promise<void>
}
export function createIslandHost(deps: IslandHostDeps): IslandHost
// hostContext sent on initialize: { theme: 'light'|'dark' (matches prefers-color-scheme), displayMode, platform: 'web', containerDimensions }
// capabilities: tools/call, ui/message, ui/open-link, ui/request-display-mode (inline|fullscreen only), resources/read (ui://bffless/<impl>/… → /w/<impl>/…)
// tool-input: { arguments, _meta: { bffless: { headless } } } — viewer mode sends { arguments: { value }, ... } and rejects workflow.submit with a tool error
// ui/update-model-context: accepted, ignored. ui/notifications/size-changed → iframe height (inline mode only; max 80vh).

// IslandFrame.tsx
export function IslandFrame(props: {
  impl: string; src: string; arguments: Record<string, unknown>; viewer?: boolean; headless: boolean
  display: 'inline' | 'fullscreen'; permissions?: unknown   // _meta.ui.permissions from the island's initialize
  host: IslandHost; onLoadError: (err: { code: 'ISLAND_LOAD'; message: string }) => void
}): JSX.Element
// renders <iframe data-testid="island-frame" sandbox="allow-scripts" allow={buildAllowAttribute(...)} title=…> and drives host.mount/teardown on mount/unmount
```

- [ ] **Step 1: Write the failing tests** using `fakeIsland.ts` (implements the View side by hand — `ui/initialize` request, `ui/notifications/initialized`, then whatever the test scripts: a `tools/call`, a `workflow.submit`, a `ui/request-display-mode`): (a) mount resolves after `initialized`, `tool-input` arrives with the arguments; (b) `tools/call { name: 'echo' }` → `http` called with `POST /api/hello/echo` and the body; result `structuredContent` = the JSON; a 500 → `isError` with `_meta.bffless.status 500`; (c) `name: '/api/other/x'` → error result, `http` not called; (d) `workflow.submit` → `onSubmit` called; a rejected submit returns the errors as the tool error and does not resolve anything; (e) viewer mode: `workflow.submit` → error "read-only viewer"; (f) `resources/read ui://bffless/hello/islands/a.css` → `fetchText('/w/hello/islands/a.css')`; (g) non-2xx HTML fetch → rejects `ISLAND_LOAD`; no `initialize` within 30 s (fake timers) → rejects `ISLAND_LOAD`; (h) `teardown('cancelled')` sends `ui/resource-teardown` and disconnects.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `IslandHost.ts` (`new AppBridge(null, { name: 'bffless-workflow', version }, capabilities)`, `bridge.oncalltool`, `onreadresource`, `onopenlink`, `onmessage`, `onrequestdisplaymode`, `addEventListener('initialized')`, `sendToolInput`, `setHostContext`), `IslandFrame.tsx`, `uiSlice.islandDisplay`.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): island host (AppBridge over sandboxed srcdoc iframe)"`

### Task 5: Wiring — the middleware launches islands; the waiting pane is the island; `render: island` viewer

**Files:**
- Create: `apps/workflow/src/components/run/IslandStepPane.tsx`, `apps/workflow/src/components/values/renderers/IslandView.tsx`
- Modify: `apps/workflow/src/store/runnerMiddleware.ts` (start + resume for `island`; `step.annotated` passthrough), `src/components/run/StepPane.tsx` (island delegation, like form), `src/components/values/ValueView.tsx` (`render: island` → `IslandView`; other named renders keep the badge until Phase 3), `src/pages/RunPage.tsx` (fullscreen: graph collapses to a strip; `data-testid="island-display"`), `src/lib/outputDecls.ts` (`src` travels on `ValueDecl`)
- Test: `apps/workflow/src/store/runnerMiddleware.island.test.ts`, `src/components/run/IslandStepPane.test.tsx`, extend `ValueView.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–4; `runnerControllers`, `scopedDispatch`, `StepRuntime` pattern (M1 Task 17).
- Produces: in `handleNextAction` `start`, `step.uses === 'island'` → `step.started { inputs: islandInputs().arguments }` then the pane mounts (the *pane* owns the iframe; the middleware registers an `AbortController` keyed like a pipeline so cancel/abort reach `host.teardown`), and dispatches `step.waiting` when `host.mount` resolves; `ISLAND_LOAD` → `step.failed`. Resume (`runReplaced` live): a `waiting`/`running` island row → the pane re-mounts from `stepState.inputs` (no re-evaluation, Decision 11). `ValueDecl` gains `src?: string`; `IslandView({ decl, value, impl })` renders `IslandFrame` in viewer mode. A `waiting` island in a **read-only** view renders the ordinary tabs (same rule as the M1 form pane — no submit from a tab that does not drive the run).

The pane/middleware split: the middleware cannot create DOM; it creates the `IslandHost` (with `onSubmit` → `completeIslandStep` → `dispatch(runEvent(r.event))`, `onAnnotate` → `annotateEvent` → dispatch, `onDisplayMode` → `uiSlice`) and stores it in a module-level `islandHosts: Map<controllerKey, IslandHost>`; `IslandStepPane` looks its host up by run+key and hands it the iframe. `step.waiting` is dispatched by the middleware from the `mount` promise. Unmounting the pane (navigation) tears down with `'unmounted'`; the step stays `waiting` (the record is unchanged; Resume re-mounts).

- [ ] **Step 1: Write the failing tests** — middleware (fake `IslandHost` injected through `RunnerDeps.islandHost: (deps) => IslandHost`): a definition with one island step → events `queued → started(inputs) → waiting` once the fake resolves mount; fake `onSubmit({ pick: 'a' })` → `succeeded` with outputs, then the run finishes; fake load error → `failed ISLAND_LOAD`; `cancelRun` while waiting → `teardown('cancelled')` called, step `cancelled`. Pane: with a live slice at a waiting island step, `IslandStepPane` renders `island-frame` with the recorded title; `display: fullscreen` → `island-display[data-mode=fullscreen]` and the graph strip class on `RunPage`. ValueView: `decl { type: json, render: island, src: islands/v.html }` renders `IslandView` (frame present, viewer) instead of the badge; `render: transcript` still shows the M2 badge (until Task 15).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green** — full suite + lint.
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): island steps run in the pane; render: island viewer"`

### Task 6: Hello's `analyze` pipeline (real rule + mock)

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/hello/rules/api/hello/analyze/post/rule.yaml`, `analyze.fn.js`
- Modify: `apps/workflow/.bffless/proxy-rules/hello/ruleset.yaml` (description), `apps/workflow/src/mocks/handlers.ts` (`POST /api/hello/analyze`), `apps/workflow/src/rules.fence.test.ts` (whatever M1 fences over authored rules — keep green), `apps/workflow/bffless/README.md` (hello surface 5/5)
- Test: `apps/workflow/src/mocks/handlers.test.ts` (the mock answers the rule's shape)

**Interfaces:**
- Produces `POST /api/hello/analyze { lines: string[], code?: string }` → synchronous JSON:

```json
{ "words": [{ "text": "Hello,", "start": 0, "end": 0.4 }, …],            // one entry per word across all lines, 0.4 s apart → render: transcript
  "counts": { "columns": [{ "key": "line" }, { "key": "chars", "type": "number" }], "rows": [{ "line": "…", "chars": 13 }] },   // → render: chart (mapping x: line, y: chars)
  "snippet": "export const lines = [\"…\"]",                                // → render: code (language: javascript)
  "longest": "Hello, studio!" }
```

`analyze.fn.js` is a `function_handler` over `request.body`; `response_handler` returns `{{{steps.analyze}}}`. `validators: auth_required { allowApiKey: true }`. The mock mirrors it byte-for-byte in shape.

- [ ] **Step 1: Write the failing mock test** — POST with `lines: ['Hello, world!']` → `words.length === 2`, `counts.rows[0].chars === 13`, `snippet` contains `Hello, world!`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Author the rule + fn + mock**; `bffless rules validate apps/workflow/.bffless/proxy-rules/hello`.
- [ ] **Step 4: Run green** (`pnpm --filter workflow test:run`, `pnpm apps:check`).
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): hello analyze pipeline (rule + mock)"`

### Task 7: The M2 test workflow — Phase-1 slice — islands, staging, index.json

**Files:**
- Create: `apps/workflow/docs/spec/examples/interactive.workflow.yaml`, `apps/workflow/hello/islands/pick-line/{index.html,main.ts}`, `apps/workflow/hello/islands/line-viewer/{index.html,main.ts}`, `apps/workflow/hello/vite.islands.config.ts`
- Modify: `apps/workflow/scripts/stage-hello.mjs` (copy both YAMLs, build islands, copy `hello/scripts/*` if present, fill `islands`/`scripts`, `workflows[]` for both), `apps/workflow/src/mocks/handlers.ts` (`/w/hello/.bffless/workflows/interactive.workflow.yaml` from `?raw`; `/w/hello/islands/:name` served from `import.meta.glob('../../hello-dist/islands/*.html', { query: '?raw', import: 'default', eager: true })` — empty until staged; `HELLO_INDEX` lists both workflows + islands), `apps/workflow/.gitignore` (nothing new: `hello-dist/` already), `apps/workflow/package.json` (`"stage": "node scripts/stage-hello.mjs"`), `.github/workflows/workflow-app.yml` (run `pnpm --filter workflow stage` before the e2e step), `apps/workflow/src/hello-stage.test.ts` (asserts the staged `index.json` lists 2 workflows, `islands: ['islands/pick-line.html','islands/line-viewer.html']`)
- Test: `hello-stage.test.ts` (runs the stager into a temp dir — it already does for M1)

**Interfaces:**
- Produces the Phase-1 `interactive.workflow.yaml`:

```yaml
spec: 1
name: Interactive hello
description: Exercises every interactive feature of the harness (M2) — grows per phase.
on:
  manual:
    inputs:
      greeting: { type: string, default: "Hello", required: true }
      names:    { type: choice, options: [world, studio, reader], list: true, default: [world, studio] }
jobs:
  greet:
    strategy: { matrix: { who: "${{ inputs.names }}" } }
    steps:
      - id: say
        uses: pipeline
        with: { path: echo, body: { text: "${{ inputs.greeting }}, ${{ matrix.who }}!" } }
        outputs: { line: { type: string, value: "${{ response.text }}" } }
    outputs: { lines: "${{ steps.say.outputs.line }}" }
  analyze:
    needs: greet
    steps:
      - id: run
        uses: pipeline
        with: { path: analyze, body: { lines: "${{ needs.greet.outputs.lines }}" } }
        outputs:
          words:   { type: json, value: "${{ response.words }}" }            # render: transcript arrives in Phase 3 (Task 21)
          counts:  { type: table, value: "${{ response.counts }}", columns: [{key: line}, {key: chars, type: number}] }
          snippet: { type: string, value: "${{ response.snippet }}" }
          longest: { type: string, value: "${{ response.longest }}" }
    outputs: { words: "${{ steps.run.outputs.words }}", counts: "${{ steps.run.outputs.counts }}", snippet: "${{ steps.run.outputs.snippet }}" }
  pick:
    needs: [greet, analyze]
    steps:
      - id: choose
        uses: island
        with:
          src: islands/pick-line.html
          title: Pick the best line
          display: inline
          lines: ${{ needs.greet.outputs.lines }}
          longest: ${{ needs.analyze.outputs.words }}
        outputs:
          line:  { type: string, required: true }
          index: { type: number }
        headless: { mode: skip, outputs: { line: "${{ needs.greet.outputs.lines[0] }}", index: 0 } }
        summary: "Picked **${{ steps.choose.outputs.line }}** (#${{ steps.choose.outputs.index }})"
    outputs:
      line:  ${{ steps.choose.outputs.line }}
      view:  { type: json, value: "${{ steps.choose.outputs }}", render: island, src: islands/line-viewer.html }
outputs:
  line: ${{ jobs.pick.outputs.line }}
  view: ${{ jobs.pick.outputs.view }}
```

`pick-line` island (`main.ts`, built single-file by Vite): `new App({ name: 'pick-line', version: '1.0.0' })`; on `tool-input` renders one button per line; clicking calls `app.callTool({ name: 'echo', arguments: { text: line, upper: true } })` (proves pipelines-as-tools: shows the SHOUTED line), then `app.callTool({ name: 'workflow.annotate', arguments: { annotations: [{ level: 'notice', message: `Previewed ${line}` }] } })`, then `workflow.submit` with `{ line, index }`; a "submit nothing" button submits `{}` and shows the returned error (proves rejection keeps the step waiting). `line-viewer` island: renders `arguments.value` read-only. `vite.islands.config.ts`: `build.rollupOptions.input` = both `index.html`s, `vite-plugin-singlefile`, `outDir: hello-dist/islands`, output file names `<name>.html`.

- [ ] **Step 1: Write the failing test** (`hello-stage.test.ts` additions: two workflows, two islands, lint-clean for both YAMLs — Task 2 rules included).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Author** the YAML, the two islands, the Vite config, the stager changes, the mocks.
- [ ] **Step 4: Run** `pnpm --filter workflow stage && pnpm --filter workflow test:run` green; open `pnpm --filter workflow dev` with `?mocks=on` and run *Interactive hello* end-to-end by hand (or through the Task 8 smoke) — the island renders, the echo tool call shows the shouted line, submit finishes the run, `view` output renders the viewer island.
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): hello interactive workflow (islands), staged bundle + mocks"`

### Task 8: Phase-1 smoke + PR

**Files:**
- Create: `apps/workflow/e2e/interactive.spec.ts`
- Modify: `apps/workflow/bffless/README.md` (M2 rows: island contract summary, hello surface), `.github/workflows/workflow-app.yml` (Task 7 stage step verified)

- [ ] **Step 1: Write the smoke** — `/?mocks=on` → hello → *Interactive hello* → Start with defaults → wait `[data-testid="step"][data-key="pick/0/choose"][data-state="waiting"]` → `page.frameLocator('[data-testid="island-frame"]')` → click the first line button → expect the shouted text inside the frame → click Submit → `run-status[data-state=succeeded]` → `run-outputs` contains `line` and a second `island-frame` (the viewer) → `annotations` contains "Previewed".
- [ ] **Step 2: Run** `pnpm --filter workflow stage && pnpm --filter workflow test:e2e` — both specs green.
- [ ] **Step 3: Phase-1 gate + PR**

```bash
pnpm --filter workflow lint && pnpm --filter workflow build && pnpm --filter workflow test:run
pnpm --filter @bffless/workflow-lint test:run && pnpm apps:check && pnpm scripts:test
bffless rules validate apps/workflow/.bffless/proxy-rules/hello
git -C /home/rico/bffless/repos/apps status --short   # hygiene: main checkout untouched
git add -A && git commit -m "test(workflow): interactive smoke (islands)" && git push
gh pr create --title "feat(workflow): island host and the island step" --body-file - <<'PRBODY'
M2 Phase 1 of 3 (plan: docs/superpowers/plans/2026-08-24-workflow-m2-interactive-steps.md, epic #359).
MCP Apps host (`@modelcontextprotocol/ext-apps` AppBridge over a sandboxed srcdoc iframe), the
`island` step (pure adapter + host + pane, `workflow.submit`/`workflow.annotate`, pipelines-as-tools
dot-canonical/slash-tolerant per Decision 1), `render: island` viewer, `step.annotated` event, lint
rules for the interactive kinds, hello's `interactive.workflow.yaml` + two built islands + `analyze`
pipeline, and the interactive smoke. Spec 04/03/ADR-0002 amended for tool naming.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
```

**STOP — Phase 1 merges (and deploys) before Phase 2 begins.** After merge: optional live sanity — run *Interactive hello* on `workflow.j5s.dev` as the `workflow-ci` member; a failure here is a Phase-2-blocking finding, not a Task 24 item.

---

# Phase 2 — Script steps, file outputs and the payload offload

*Branch `feat/workflow-m2-scripts`, worktree `.claude/worktrees/workflow-m2-scripts` off the updated `origin/main`. Deliverable: `script` steps run in a Worker with the 03 `ctx` contract, return typed outputs incl. Blob files stored under `step.prefix`; outputs over 256 KB are persisted as `{"$file"}` and hydrated on replay; hello's interactive workflow gains a script job.*

### Task 9: `@bffless/workflow-script` types + pure script adapter

**Files:**
- Create: `packages/workflow-script/package.json` (`"name": "@bffless/workflow-script", "private": true, "types": "./index.d.ts", "files": ["index.d.ts"]`, no `main`), `packages/workflow-script/index.d.ts`, `packages/workflow-script/README.md`
- Create: `apps/workflow/src/lib/runner/adapters/script.ts`
- Modify: `apps/workflow/package.json` (devDependency `@bffless/workflow-script: workspace:*`), `apps/workflow/src/lib/upload.ts` (`uploadBlob`)
- Test: `apps/workflow/src/lib/runner/adapters/script.test.ts`, extend `upload.test.ts`

**Interfaces:**

```ts
// packages/workflow-script/index.d.ts — the 03 contract, verbatim
export interface FileRef { path: string; name: string; contentType: string; size: number; url: string }
export interface ScriptContext {
  inputs: Record<string, unknown>
  files: { fetch(ref: FileRef): Promise<Response> }
  log(msg: string): void
  annotate(a: { level: 'notice' | 'warning' | 'error'; message: string; title?: string } | { summary: string }): void
  signal: AbortSignal
}
export type ScriptModule = { default: (ctx: ScriptContext) => Promise<Record<string, unknown>> }

// adapters/script.ts (pure; Blob handling via injected fn)
export interface ScriptStepArgs { step: Step; key: StepKey; job: string; index: number; def: Definition; state: RunState }
export function scriptInputs(a: ScriptStepArgs): { src: string; inputs: Record<string, unknown> }   // `with` minus src, evaluated
export interface ScriptOutputDeps { uploadBlob: (blob: Blob, name: string) => Promise<FileRef>; registerFile: (path: string) => Promise<FileRef> }
/** Validate/coerce the module's return value against the declared outputs (02): Blob/File → upload → File ref (lists too); string for `file` → registerFile; else OUTPUT_TYPE. */
export async function coerceScriptOutputs(a: ScriptStepArgs, returned: unknown, deps: ScriptOutputDeps): Promise<Record<string, unknown>>   // throws OutputTypeError
export function blobFileName(output: string, blob: Blob): string   // File.name, else `${output}.${ext(blob.type)}`, `.bin` fallback

// lib/upload.ts
export async function uploadBlob(a: Omit<UploadFileArgs, 'file'> & { blob: Blob; name: string }): Promise<FileRef>   // same prepare → PUT → register; `uploadFile` becomes a one-liner over it
```

- [ ] **Step 1: Write the failing tests** — `scriptInputs` strips `src` and evaluates expressions; `coerceScriptOutputs` with declared `{ zip: { type: file }, n: { type: number } }`: `{ zip: new Blob(['x'], { type: 'application/zip' }), n: 1 }` → `uploadBlob` called with name `zip.zip`, output is the returned ref; a `File` keeps its name; `{ zip: 'workflows/…/x.zip' }` → `registerFile`; `{ zip: 42 }` → `OutputTypeError`; `file, list: true` with `[Blob, Blob]` → two uploads in order; missing declared output → `OutputTypeError`. `uploadBlob` drives the three calls against MSW with the `runs/<runId>/<key>` scope.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): workflow-script types, pure script adapter, uploadBlob"`

### Task 10: The script host — Blob-URL module Worker + RPC relay

**Files:**
- Create: `apps/workflow/src/scripts/worker-shim.ts` (built as a separate Vite worker entry: `new Worker(new URL('./worker-shim.ts', import.meta.url), { type: 'module' })` is **not** used — see below), `apps/workflow/src/scripts/ScriptHost.ts`, `apps/workflow/src/scripts/rpc.ts` (message types), `apps/workflow/src/scripts/fakeWorker.ts` (test double)
- Test: `apps/workflow/src/scripts/ScriptHost.test.ts` (jsdom + fake Worker), `rpc.test.ts`

**Interfaces:**

```ts
// rpc.ts — main ⇄ worker messages
export type ToWorker = { t: 'run'; inputs: Record<string, unknown>; moduleUrl: string } | { t: 'abort' } | { t: 'rpc:res'; id: number; ok: boolean; body?: ArrayBuffer; headers?: [string, string][]; status?: number; error?: string }
export type FromWorker = { t: 'log'; line: string } | { t: 'annotate'; args: unknown } | { t: 'rpc:req'; id: number; op: 'files.fetch'; ref: FileRef } | { t: 'done'; outputs: unknown } | { t: 'error'; code?: string; message: string }

// worker-shim.ts — the Worker's own bootstrap (shipped as a string: Vite `?raw` import of the compiled shim, prepended to the fetched module? NO — simpler and deterministic:)
// The shim is its own tiny ES module text (a template literal in ScriptHost.ts, plain JS, no imports) that does
//   const mod = await import(moduleUrl)   // the script's Blob URL (dynamic import inside a module worker)
// then builds ctx (files.fetch → postMessage rpc:req, awaits rpc:res, wraps into new Response(body, { status, headers })),
// runs mod.default(ctx), posts { t: 'done', outputs } (Blobs structured-clone across), or { t: 'error' }.
// ScriptHost creates TWO Blob URLs: the script module and the shim; the Worker is spawned from the shim's URL.

// ScriptHost.ts
export interface ScriptHostDeps {
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>
  fetchBytes: (url: string) => Promise<{ ok: boolean; status: number; body: ArrayBuffer; headers: [string, string][] }>   // files.fetch relay, same-origin, cookies
  onLog: (line: string) => void
  onAnnotate: (args: unknown) => void
  spawn?: (shimUrl: string) => WorkerLike     // default: new Worker(url, { type: 'module' }); tests inject fakeWorker
}
export interface ScriptRun { outputs: Promise<unknown>; abort(): void }
/** Fetch `/w/<impl>/<src>` → Blob URL; spawn; run(inputs). Rejects { code: 'SCRIPT_LOAD' | 'SCRIPT' | <err.code>, message }. `signal` aborts (terminate). */
export function createScriptHost(deps: ScriptHostDeps): { run(a: { impl: string; src: string; inputs: Record<string, unknown>; signal: AbortSignal }): ScriptRun }
```

`fetchBytes` is the only network the relay performs: `fetch(ref.url, { credentials: 'same-origin' })` — `isSameOriginUrl` (Task 23; until then, require a `/`-rooted url) gates it.

- [ ] **Step 1: Write the failing tests** — with `fakeWorker` (executes the posted `run` by *evaluating nothing*: the fake is scripted per test: on `run` it posts `log`, then `rpc:req files.fetch`, then `done` after the response arrives): (a) `run` resolves with the outputs; `onLog` got the line; `fetchBytes` was called with `ref.url` and the `rpc:res` carried the bytes; (b) `error { code: 'BOOM' }` → rejects with code `BOOM`; a message-less error → `SCRIPT`; (c) HTML/404 on the module fetch → `SCRIPT_LOAD`; (d) abort → `terminate()` called, promise rejects `AbortError`; (e) `rpc.test.ts`: the shim text is valid JS (`new Function` parse in a test — the one place the fence tolerates it, test-only) and contains no `import` other than the dynamic `import(moduleUrl)`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Real-browser check: in `pnpm dev` with `?mocks=on`, a scratch script logging and returning `{ n: 1 }` runs (verified again by Task 14's smoke).
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): script host (Blob-URL module Worker with RPC relay)"`

### Task 11: Wiring — the middleware runs scripts; the step card shows the log

**Files:**
- Create: `apps/workflow/src/components/run/ScriptStepCard.tsx` (`data-testid="script-log"`, last 50 lines from a module-level, live-only log store keyed by run+key — `src/scripts/logStore.ts`)
- Modify: `apps/workflow/src/store/runnerMiddleware.ts` (start + resume for `script`; `RunnerDeps.scriptHost`), `src/components/run/StepPane.tsx` (Details tab shows the log card for a running/finished script of the live run), `src/components/graph/StepChip.tsx` (kind icon already; nothing else)
- Test: `apps/workflow/src/store/runnerMiddleware.script.test.ts`, `ScriptStepCard.test.tsx`

**Interfaces:**
- `handleNextAction` `start` for `script`: `step.started { inputs }` → `scriptHost.run(...)` → `coerceScriptOutputs` (deps: `uploadBlob` bound to scope `runs/<runId>/<key>`, `registerFileForStep`) → `evalSummary`/`evalAnnotations` → `step.succeeded` (annotations = template ones + dynamic ones already applied via `step.annotated`); rejection → `step.failed { code, message }`; `timeout-minutes` budget → abort + `TIMEOUT`; `signal` abort by cancel → `step.cancelled`. Resume (`runReplaced` live): a `running` script row relaunches exactly like a `queued`/`running` pipeline (Decision 13).

- [ ] **Step 1: Write the failing tests** — fake script host: happy path events `queued → started → succeeded` with a Blob output turned into a File ref by the MSW files trio (`db.files` holds the bytes under `workflows/hello/interactive/runs/<id>/<key>/poster.svg`); `ctx.annotate` → `step.annotated` persisted (row `annotations` grows) before `succeeded`; rejection → `failed` with the code; cancel → `cancelled`; resume: a `running` script row → relaunched once (fake `run` called once). Card: log lines render, capped at 50.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): script steps run in the middleware; live log card"`

### Task 12: `{"$file"}` — pure payload module + offload on persist

**Files:**
- Create: `apps/workflow/src/lib/runner/payload.ts`
- Modify: `apps/workflow/src/store/runnerMiddleware.ts` (offload before `eventToWrites` for `step.succeeded` and `run.finished`), `src/lib/runner/rows.ts` (no change in shape — the *patch* carries the offloaded map)
- Test: `apps/workflow/src/lib/runner/payload.test.ts`, extend `runnerMiddleware.test.ts`

**Interfaces:**

```ts
export const PAYLOAD_BUDGET_BYTES = 256 * 1024
export interface FilePayload { $file: FileRef }
export function isFilePayload(v: unknown): v is FilePayload       // exactly one key `$file` holding a File ref
export function byteSize(v: unknown): number                      // UTF-8 length of JSON.stringify
/** For each output whose byteSize > budget: store `<name>.json` via `store` and substitute `{ $file }`. Returns a NEW map; the input is untouched (live state stays inline). */
export async function offloadOutputs(outputs: Record<string, unknown>, store: (name: string, json: string) => Promise<FileRef>): Promise<Record<string, unknown>>
/** Replace every `{ $file }` (top level of the map) with the fetched JSON. */
export async function hydrateOutputs(outputs: Record<string, unknown> | null | undefined, fetchJson: (ref: FileRef) => Promise<unknown>): Promise<Record<string, unknown> | null | undefined>
```

Middleware: `store` = `uploadBlob(new Blob([json], { type: 'application/json' }), `${name}.json`)` under scope `runs/<runId>/<key>` (step) or `runs/<runId>/outputs` (run-level; the prepare rule takes any scope string). The `PersistWrite` for `step.succeeded` gets `outputs: offloaded`; `run.finished` likewise. The reducer/state never sees `$file`.

- [ ] **Step 1: Write the failing tests** — a 300 KB string output is offloaded (store called once with `big.json`), a 10 KB one is not; both maps intact; `hydrateOutputs` restores; nested `$file` objects deeper than top level are left alone (documented: offload is per output). Middleware: a step with a 300 KB output → the upserted row's `outputs.big` is `{ $file }` while the slice state's is the string; the MSW `db.files` holds `big.json`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): offload >256 KB outputs to {\"$file\"} on persist"`

### Task 13: Hydration on read — replay, run page, resume, run outputs

**Files:**
- Modify: `apps/workflow/src/store/workflowApi.ts` (`getRun` `transformResponse` becomes an async `queryFn` that hydrates every step row's `outputs` and the run row's `outputs`), `src/store/lifecycleActions.ts` (`openRun`/`takeOver` receive already-hydrated rows — nothing to do once `getRun` hydrates; assert with a test), `src/lib/coerce.ts` (`toStepRow` keeps `$file` values as-is), `src/mocks/handlers.ts` (`GET /api/uploads/*` already serves bytes)
- Test: extend `workflowApi.test.ts`, `RunPage.test.tsx` (a seeded row with a `$file` output renders the hydrated value; the fetch failing renders a "payload unavailable" chip, not a crash), `lifecycleActions.test.ts` (resume of a run whose succeeded step had a `$file` output evaluates a downstream expression against the hydrated value)

- [ ] **Step 1: Write the failing tests** (seed `db` with a step row whose `outputs.big = { $file: ref }` and `db.files` with the JSON).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (`hydrateOutputs` with `fetchJson = (ref) => fetch(ref.url, { credentials: 'same-origin' }).then(r => r.json())`; a failed fetch leaves a sentinel `{ $file: ref, $error: message }` that `ValueView` renders as an "unavailable" chip with a Download link). **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): hydrate {\"$file\"} payloads on read (run page, resume)"`

### Task 14: Hello Phase-2 slice — the `poster-card` script + smoke + PR

**Files:**
- Create: `apps/workflow/hello/scripts/poster-card.js`
- Modify: `apps/workflow/docs/spec/examples/interactive.workflow.yaml` (add job `card`), `apps/workflow/scripts/stage-hello.mjs` (copies `hello/scripts/*.js`, fills `scripts`), `apps/workflow/src/mocks/handlers.ts` (`/w/hello/scripts/:name` via `import.meta.glob('../../hello/scripts/*.js', { query: '?raw', … })` — source, not staged: scripts need no build), `apps/workflow/e2e/interactive.spec.ts`, `apps/workflow/bffless/README.md`

```yaml
  card:
    needs: pick
    steps:
      - id: draw
        uses: script
        with:
          src: scripts/poster-card.js
          line: ${{ needs.pick.outputs.line }}
          counts: ${{ needs.analyze.outputs.counts }}
        outputs:
          poster: { type: file }              # an SVG Blob → File ref
          big:    { type: json }              # ~300 KB array → exercises {"$file"} (Task 12)
        summary: "Card **${{ steps.draw.outputs.poster.name }}** ({{ steps.draw.outputs.poster.size }} bytes)"
    outputs:
      poster: ${{ steps.draw.outputs.poster }}
outputs:
  line: ${{ jobs.pick.outputs.line }}
  view: ${{ jobs.pick.outputs.view }}
  poster: ${{ jobs.card.outputs.poster }}
```

`poster-card.js`: `export default async function run(ctx) { ctx.log('drawing'); const svg = …${ctx.inputs.line}…; ctx.annotate({ level: 'notice', message: 'card drawn' }); return { poster: new File([svg], 'poster.svg', { type: 'image/svg+xml' }), big: Array.from({ length: 20000 }, (_, i) => ({ i, line: ctx.inputs.line })) } }`.

- [ ] **Step 1: Extend the smoke** — after the island submit, wait `card/0/draw` `succeeded`; `run-outputs` shows `poster` as a file card with a Download link ending `poster.svg?download=1`; the Details tab of `draw` shows `script-log` containing "drawing"; the annotation "card drawn" is listed; reload the run page (replay path) → `big` still renders (hydrated) and `poster` still a file card.
- [ ] **Step 2: Run** `pnpm --filter workflow stage && pnpm --filter workflow test:e2e`.
- [ ] **Step 3: Phase-2 gate + PR**

```bash
pnpm --filter workflow lint && pnpm --filter workflow build && pnpm --filter workflow test:run
pnpm --filter @bffless/workflow-lint test:run && pnpm apps:check && pnpm scripts:test
git -C /home/rico/bffless/repos/apps status --short
git add -A && git commit -m "feat(workflow): hello poster-card script job + smoke" && git push
gh pr create --title "feat(workflow): script steps, file outputs and the payload offload" --body-file - <<'PRBODY'
M2 Phase 2 of 3 (plan: docs/superpowers/plans/2026-08-24-workflow-m2-interactive-steps.md, epic #359).
`script` steps: `@bffless/workflow-script` types, pure adapter (Blob/File outputs → files trio under
step.prefix), Blob-URL module Worker host with a postMessage relay for ctx.files/log/annotate
(Decision 2 — no COOP/COEP until M3), live log card; the >256 KB `{"$file"}` offload on persist and
hydration on every read path (Decision 5); hello's `card` script job and the extended smoke.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
```

**STOP — Phase 2 merges (and deploys) before Phase 3 begins.**

---

# Phase 3 — Named renderers, form upgrades, run deletion, the minors, the live checklist

*Branch `feat/workflow-m2-renderers`, worktree `.claude/worktrees/workflow-m2-renderers` off the updated `origin/main`. Deliverable: the M1 "renderer: <name> (M2)" badge is gone; mid-run forms upload files, pick tiles and preview markdown; runs can be deleted with their files; the graph highlights data flow on hover; `isSafeUrl`/same-origin, `?repository=`; the live checklist is walked on j5s.*

### Task 15: `transcript` and `images` renderers + media seek context

**Files:**
- Create: `apps/workflow/src/components/values/renderers/TranscriptView.tsx`, `ImagesView.tsx`, `apps/workflow/src/components/values/MediaSeekContext.ts`
- Modify: `src/components/values/ValueView.tsx` (dispatch on `decl.render`; remove the badge; unknown render → base viewer + `renderer: <name> (unknown)` badge), `src/components/values/FileCard.tsx` (a `video/*`/`audio/*` player registers itself with the seek context), `src/components/run/StepPane.tsx` + `RunOutputs.tsx` (wrap each step's/scope's values in a `MediaSeekProvider`)
- Test: `TranscriptView.test.tsx`, `ImagesView.test.tsx`, extend `ValueView.test.tsx`

**Interfaces:**

```ts
// MediaSeekContext.ts
export interface MediaSeek { register(el: HTMLMediaElement): () => void; seek(seconds: number): boolean }   // seeks the first registered element; false when none
export function MediaSeekProvider(props: { children: ReactNode }): JSX.Element
export function useMediaSeek(): MediaSeek
// TranscriptView: value shaped [{ text, start, end, speaker? }] (02); each segment a <button> "[m:ss] text"; click → seek(start). Malformed value → JsonTree fallback.
// ImagesView: value FileRef[] (list) or one ref; grid of <img src={ref.url}> gated by isSameOriginUrl (Task 23 — until then isSafeUrl) with the file card's Download below each; non-image refs → FileCard.
// data-testid="renderer" data-render="transcript|images" on the wrapper.
```

- [ ] **Step 1: Write the failing tests** — transcript renders 3 segments with `0:00` stamps; click calls the provider's seek (fake registered element's `currentTime` set); images: 2 refs → 2 `<img>`, an `image/png` and a `application/pdf` → 1 img + 1 file card; ValueView with `render: transcript` renders `TranscriptView`, `render: bogus` renders the base viewer + unknown badge, no `render` → no badge.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): transcript and images renderers, media seek context"`

### Task 16: `chart` (uPlot) and `code` (highlight.js) renderers

**Files:**
- Create: `apps/workflow/src/components/values/renderers/ChartView.tsx`, `CodeView.tsx`, `apps/workflow/src/lib/highlight.ts` (registers the fixed language set once)
- Modify: `apps/workflow/package.json` (`highlight.js ^11.12.0`, `uplot ^1.6.32`), `src/components/values/ValueView.tsx` (dispatch), `src/lib/valueDecl.ts` (`mapping?: unknown`), `src/lib/outputDecls.ts` (`typed()` carries `mapping` and `src`), `src/index.css` (import `uplot/dist/uPlot.min.css`, a small hljs theme with light/dark tokens)
- Test: `ChartView.test.tsx`, `CodeView.test.tsx`

**Interfaces:**
- `ChartView({ decl, value })`: `mapping { x, y, kind: 'bar' | 'line' }` (default `line`); rows = `value.rows` (table) or `value` (json array); x categorical → index axis with labels; y numeric; renders into a `<div data-testid="renderer" data-render="chart">` via `new uPlot(opts, data, el)` in an effect (bars via `uPlot.paths.bars()`); malformed → JsonTree fallback with a note. jsdom has no canvas: the test asserts the wrapper, the computed series (`chartSeries(value, mapping)` exported, pure) and that uPlot is constructed (mocked module).
- `CodeView({ value, mapping })`: `hljs.highlight(String(value), { language })` when the language is registered, else `hljs.highlightAuto` is **not** used — plain escaped text with the label; `<pre><code data-testid="renderer" data-render="code" data-language>` with line numbers via CSS counters.

- [ ] **Step 1: Write the failing tests** — `chartSeries` from a table with `mapping { x: line, y: chars }` → `[['a','b'], [13, 14]]`; a json array works the same; missing `y` → `null`; CodeView highlights `javascript` (contains `hljs-keyword` span), unknown language → no spans, label shows it.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green** (+ `pnpm --filter workflow build` — check the bundle only grows by hljs core + languages + uPlot).
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): chart (uPlot) and code (highlight.js) renderers"`

### Task 17: `render: island` in the outputs sections + renderer regression sweep

**Files:**
- Modify: `apps/workflow/src/components/run/RunOutputs.tsx` (island viewer needs `impl` — pass `state.impl`), `src/components/run/StepPane.tsx` (Output tab likewise), `src/components/values/ValueView.tsx` (`impl` prop threaded; viewer only when `decl.src` + `impl`)
- Test: extend `RunOutputs` tests (the M1 fixture run + a fixture with every `render` value renders without the badge), `src/mocks/fixtures/finishedRun.ts` (add a `rendered` fixture step with all five renders — keeps the M1 fixture's 6-row invariant intact by living in a **second** fixture `renderedRun.ts`)

- [ ] **Step 1: Write the failing test** — `renderedRun` fixture replays and `RunOutputs` shows five `[data-testid="renderer"]` wrappers with the five `data-render` values.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): named renderers everywhere outputs render; rendered-run fixture"`

### Task 18: Form upgrades — `file` fields, tile picker, markdown preview, options expressions

**Files:**
- Modify: `apps/workflow/src/components/kickoff/FieldControl.tsx` (tile picker branch for `choice`; markdown preview toggle; `options` already-evaluated array expected), `src/components/run/FormStepPane.tsx` (`upload` bound to scope `inputs`; evaluates `options` expressions per field through a new pure helper), `src/lib/runner/adapters/form.ts` (`formFieldDefs(a): Record<string, InputDef>` — the fields with `options` expressions evaluated against the step contexts; `completeFormStep` validates choice membership against the **evaluated** options), `src/components/kickoff/KickoffForm.tsx` (uses the same tile picker for static previews), `src/index.css`
- Test: extend `FieldControl` tests (new `FieldControl.test.tsx` if absent), `form.test.ts`, `FormStepPane.test.tsx`

**Interfaces:**
- Tile picker: rendered when `options` is a list of File refs (02 shorthand: `value = ref.path`, `label = ref.name`, `preview = ref`) or any option object has `preview` (a File ref or a same-origin url string); `list: true` → multi-select tiles; `data-testid="tile-picker"`. Image previews use `<img src>` gated by the same-origin check; other refs show the file card thumbnail.
- Markdown: `format`-less `markdown` field shows a "Preview" toggle rendering `MarkdownView` beside the textarea (`data-testid="markdown-preview"`).
- `file` field in a mid-run form uploads with `scope: 'inputs'`; the submitted value is the File ref (list for `list: true`); `completeFormStep` accepts File refs for `file` (via `validateValue('file')`).

- [ ] **Step 1: Write the failing tests** — `formFieldDefs` evaluates `options: "${{ steps.draw.outputs.options }}"` to the upstream File-ref list; `completeFormStep` accepts a path that is one of the evaluated options and rejects another; `FieldControl` with File-ref options renders `tile-picker` with 2 tiles, click selects (value = path); markdown preview toggle renders the markdown; `FormStepPane` with a `file` field renders a file input (no "not supported" notice) and, with a fake `upload`, submits the ref.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): mid-run form file fields, tile picker, markdown preview"`

### Task 19: The delete rule — rows + file-prefix GC together

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/run/delete/post/rule.yaml`, `gate.fn.js`, `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/whoami/get/rule.yaml`
- Modify: `apps/workflow/src/mocks/handlers.ts` (`POST /api/workflow/run/delete` with the same gate: 403 / 409 / 404 / 200 `{ ok: true, deleted: { files: n } }`), `src/mocks/db.ts` (`deleteRun(id)`, `filesUnder(prefix)`), `src/lib/runStore.ts` (`deleteRun(id)`), `apps/workflow/bffless/README.md`
- Test: `handlers.test.ts` (gate cases), `runStore.test.ts` if present else `http.test.ts` addition

**Interfaces:**

```yaml
# rule.yaml (order 16)
targetUrl: pipeline
pipeline:
  name: Delete workflow run
  description: "POST { id }: owner (startedBy == user.id) or admin; terminal runs only (409 while running). Deletes the run's storage prefix first (retryable), then workflow_files records under it, step rows, the run row. The per-workflow inputs/ area is never touched (D18)."
  steps:
    - { id: run,   name: run,   handler: data_query,      config: { schemaId: $schema:workflow_runs, pageSize: 1, filters: { runId: { op: eq, value: request.body.id } } } }
    - { id: gate,  name: gate,  handler: function_handler, code: ./gate.fn.js }           # { ok, status, error?, recordId, prefix, prefixLike } — never throws
    - { id: refuse, name: refuse, handler: response_handler, condition: steps.gate.refused, config: { body: '{"ok":false,"error":"{{steps.gate.error}}"}', status: steps.gate.status, contentType: application/json } }
    - { id: files, name: files, handler: file_delete,      condition: steps.gate.ok, config: { prefix: steps.gate.prefix } }
    - { id: recs,  name: recs,  handler: data_delete,      condition: steps.gate.ok, config: { schemaId: $schema:workflow_files, filters: { storagePath: { op: like, value: steps.gate.prefixLike } } } }
    - { id: steps, name: steps, handler: data_delete,      condition: steps.gate.ok, config: { schemaId: $schema:workflow_run_steps, filters: { runId: { op: eq, value: request.body.id } } } }
    - { id: row,   name: row,   handler: data_delete,      condition: steps.gate.ok, config: { schemaId: $schema:workflow_runs, recordId: steps.gate.recordId } }
    - { id: respond, name: respond, handler: response_handler, condition: steps.gate.ok, config: { body: '{"ok":true,"deleted":{"files":{{steps.files.deleted}}}}', status: 200, contentType: application/json } }
  validators: [{ type: auth_required, config: { allowApiKey: true } }]
```

`gate.fn.js` **never throws** (CE's `function_handler` turns any throw into a generic `FUNCTION_ERROR` failure, not a chosen status — verified in `function.handler.ts`): `rows = Array.isArray(steps.run) ? steps.run : []` (bare array, README); no row → `{ ok: false, refused: true, status: 404, error: 'run not found' }`; `row.status === 'running'` → 409 `'cancel the run first'`; `!['admin','owner'].includes(String(user.role).toLowerCase()) && row.startedBy !== user.id` → 403; otherwise `{ ok: true, refused: false, recordId: row.id, prefix: 'workflows/<impl>/<workflow>/runs/<id>/', prefixLike: '<same>%' }`. Same shape as M1's `lease/gate.fn.js` + `condition:` steps. Whether `response_handler` accepts an expression for `status` is checked at execution (M1's rules only use literals) — if not, three literal `refuse-404/409/403` steps with their own conditions. `file_delete`'s `prefix` is relative to the project's uploads root and `presigned_upload`'s `subDir: workflows/…` lands under that same root (README: a File ref `path` is uploads-relative), so `prefix` = the ref path's directory — the live checklist (Task 24) confirms with a throwaway run.

Alongside, one tiny read rule the header needs (Task 20) — `GET /api/workflow/whoami` (`rules/api/workflow/whoami/get/rule.yaml`, `response_handler` body `{"id":"{{user.id}}","email":"{{user.email}}","role":"{{user.role}}"}`, `Cache-Control: no-store`, `auth_required`), mocked as the `workflow-ci` member with `role: user`; a second mock identity (`?as=admin` on the mock only) for the gate tests.

- [ ] **Step 1: Write the failing mock tests** — as a non-owner member: 403; as the owner on a `running` run: 409; unknown id: 404; owner on a finished run: 200, the step rows, the run row and every `db.files` key under the prefix are gone while an `inputs/` key survives.
- [ ] **Step 2: Run to verify failure.** **Step 3: Author rule + fns + mocks + `runStore.deleteRun`**; `bffless rules validate apps/workflow/.bffless/proxy-rules/workflow`. **Step 4: Run green** (`pnpm apps:check` too).
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): run delete rule (rows + file-prefix GC) and mock"`

### Task 20: Delete in the run header

**Files:**
- Modify: `apps/workflow/src/components/run/RunHeader.tsx` (`onDelete?` → `data-testid="run-delete"` behind `window.confirm`; rendered only when `status !== 'running'` and `canDelete`), `src/pages/RunPage.tsx` (`canDelete = run.startedBy === me.id || ['admin','owner'].includes(me.role)` from the new `useWhoamiQuery` — M1 had no current-user endpoint; Task 19's `whoami` rule is it), `src/store/workflowApi.ts` (`whoami: builder.query<{ id: string; email?: string; role?: string }, void>`, `deleteRun` invalidation), `src/components/Shell.tsx` (08: the header shows the user — render `whoami.email` there too), `src/store/lifecycleActions.ts` (`deleteRun(id)`: `runStore.deleteRun` → invalidate `Runs` → navigate to `/<impl>/<workflow>/runs`)
- Test: `RunHeader` test (button absent while running, present when terminal), `RunPage` test (confirm → delete called → navigates; a 403 shows the error and stays)

- [ ] **Step 1: Write the failing tests.** **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): Delete run action in the run header"`

### Task 21: Hello Phase-3 slice — renderers + the upgraded form

**Files:**
- Modify: `apps/workflow/docs/spec/examples/interactive.workflow.yaml` (`render:` on the analyze outputs; a `review` form job), `apps/workflow/src/mocks/handlers.ts` (nothing new — the form uploads through the files trio), `apps/workflow/e2e/interactive.spec.ts`

```yaml
  analyze:   # outputs gain renderers
        outputs:
          words:   { type: json,   value: "${{ response.words }}",   render: transcript }
          counts:  { type: table,  value: "${{ response.counts }}",  render: chart, mapping: { x: line, y: chars, kind: bar }, columns: [{key: line}, {key: chars, type: number}] }
          snippet: { type: string, value: "${{ response.snippet }}", render: code, mapping: { language: javascript } }
  card:      # poster output rendered as images (list of one)
        outputs:
          poster: { type: file }
          posters: { type: file, list: true, render: images }      # poster-card.js returns [File] here too
  review:
    needs: card
    steps:
      - id: confirm
        uses: form
        with:
          title: Review the card
          fields:
            cover: { type: choice, options: "${{ needs.card.outputs.posters }}", required: true }   # tile picker over File refs → path
            notes: { type: markdown, default: "## Notes\n\n${{ needs.pick.outputs.line }}" }        # live preview
            extra: { type: file, accept: "image/*" }                                                # mid-run upload (inputs/ scope)
          submit: Approve
        headless: { mode: skip, outputs: { cover: "${{ needs.card.outputs.posters[0].path }}", notes: "", extra: null } }
    outputs:
      cover: { type: file, value: "${{ steps.confirm.outputs.cover }}" }
outputs:
  line: …, view: …, poster: …, cover: ${{ jobs.review.outputs.cover }}
```

- [ ] **Step 1: Extend the smoke** — `run-outputs` shows `renderer[data-render=transcript|chart|code|images]`; at the `review` form: `tile-picker` has one tile, click it; toggle the markdown preview and expect the rendered `<h2>`; set the file input with a fixture PNG (`page.setInputFiles`), wait for the ref name; Approve → `succeeded`; header `run-delete` visible → click (accept the confirm) → lands on Past runs without the run.
- [ ] **Step 2: Run** `pnpm --filter workflow stage && pnpm --filter workflow test:e2e` green.
- [ ] **Step 3: Commit** — `git commit -am "feat(workflow): hello interactive workflow completes (renderers, upgraded form, delete in smoke)"`

### Task 22: Graph data-flow hover-highlight

**Files:**
- Modify: `apps/workflow/src/lib/runner/graph.ts` (export `dataFlowEdges(def): Array<{ from: { job; step?; output }, to: { job; step } }>` built on `refsIn` — pure), `src/store/uiSlice.ts` (`hoveredValue: { job: string; step?: string; output?: string } | null`), `src/components/graph/GraphView.tsx` + `StepChip.tsx` (`data-flow="source|target"` classes from the hovered value), `src/components/values/ValueView.tsx` (`onHover` optional; `StepPane` passes the value's identity), `src/index.css`
- Test: `graph.test.ts` (edges for hello: `slow/start` reads `greet` job output → edge greet→slow/start; `confirm/review` default reads `slow`), `GraphView.test.tsx` (hover a chip → source/target attributes on the right cards)

- [ ] **Step 1: Write the failing tests.** **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "feat(workflow): data-flow hover-highlight on the graph"`

### Task 23: Minors — `isSafeUrl` / same-origin, scoped discovery, README

**Files:**
- Modify: `apps/workflow/src/lib/url.ts` (reject protocol-relative; add `isSameOriginUrl`), `src/components/values/FileCard.tsx`, `renderers/ImagesView.tsx`, `renderers/IslandView.tsx` + `islands/IslandHost.ts` (`openLink` gate), `scripts/ScriptHost.ts` (`fetchBytes` gate), `src/lib/discovery.ts` (new: `projectRepository()` reads `import.meta.env.VITE_BFFLESS_PROJECT`, `aliasesUrl()`), `src/store/workflowApi.ts` (`discover` uses `aliasesUrl()`), `src/mocks/handlers.ts` (`/api/workflow/aliases` filters by `?repository=` when present — the mock `ALIASES` gain `repository`), `.github/workflows/deploy-workflow.yml` (`env: { VITE_BFFLESS_PROJECT: bffless/workflow }` on the build step), `apps/workflow/bffless/README.md` (Manual setup: the env var; the delete rule; the M2 rows in the checklist), `.github/workflows/workflow-app.yml` (no env → unscoped in CI)
- Test: `url.test.ts` (`//evil.com`, `/\evil.com`, `/ /evil.com` (tab-stripped) → unsafe; `/api/uploads/x` safe + same-origin; `https://<location.origin>/x` same-origin; `https://other/x` safe but not same-origin), `workflowApi.test.ts` (with `VITE_BFFLESS_PROJECT` stubbed via `vi.stubEnv`, the request carries `?repository=`; without, it does not)

- [ ] **Step 1: Write the failing tests.** **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run green.**
- [ ] **Step 5: Commit** — `git commit -am "fix(workflow): reject protocol-relative urls, same-origin media sinks, scoped discovery"`

### Task 24: Phase-3 PR, then the live verification checklist on j5s

**Files:**
- Modify: `apps/workflow/bffless/README.md` (checklist results), `/home/rico/bffless/localdev-tools/workflow-live.mjs` (outside the repo: add an `--interactive` walk mirroring `e2e/interactive.spec.ts` with `frameLocator`, a fixture PNG upload, the delete at the end), epic #359 (tick the M2 boxes)

- [ ] **Step 1: Phase-3 gate + PR**

```bash
pnpm --filter workflow lint && pnpm --filter workflow build && pnpm --filter workflow test:run
pnpm --filter workflow stage && pnpm --filter workflow test:e2e
pnpm --filter @bffless/workflow-lint test:run && pnpm apps:check && pnpm scripts:test
bffless rules validate apps/workflow/.bffless/proxy-rules/workflow && bffless rules validate apps/workflow/.bffless/proxy-rules/hello
git -C /home/rico/bffless/repos/apps status --short
git add -A && git commit -m "docs(workflow): M2 README rows and deploy env" && git push
gh pr create --title "feat(workflow): named renderers, form upgrades and run deletion" --body-file - <<'PRBODY'
M2 Phase 3 of 3 (plan: docs/superpowers/plans/2026-08-24-workflow-m2-interactive-steps.md, epic #359).
Named renderers (transcript, chart/uPlot, images, code/highlight.js, island in every outputs section);
mid-run form upgrades (file fields to inputs/, tile picker over File refs, markdown preview, options
expressions); run deletion — delete rule with file-prefix GC + header Delete (owner/admin, terminal only);
graph data-flow hover; isSafeUrl rejects protocol-relative + same-origin media sinks; discovery scoped by
VITE_BFFLESS_PROJECT (#363); hello's interactive workflow completes and the smoke covers it all.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
```

- [ ] **Step 2: After merge, wait for `deploy-workflow.yml`** (`gh run list --workflow deploy-workflow.yml -L 1`), then walk the checklist as member `workflow-ci` (`source ~/.config/bffless/workflow-ci.env && node /home/rico/bffless/localdev-tools/workflow-live.mjs --interactive --out /tmp/claude-1000/…/live`). Each row is a Decision that assumed something; record PASS/FAIL + evidence in the README:
  - **Decision 9 (sandbox):** the island renders in the srcdoc iframe live; the echo tool call returns (`/api/hello/echo` from the host, member session); `workflow.annotate` lands on the row; a rejected submit keeps the step `waiting`.
  - **Decision 1:** the island's slash and dot names both resolve (the pick-line island uses `echo`; add one `workflow/annotate` call in the island to prove the slash form).
  - **Decision 2 (scripts):** the Worker runs live (`script-log` shows "drawing"); `poster.svg` serves from `/api/uploads/workflows/hello/interactive/runs/<id>/card/0/draw/poster.svg`; the `big` output is a `{"$file"}` row (inspect via `GET /api/workflow/run?id=`) and the run page hydrates it.
  - **Decision 5:** `big.json` exists under the step prefix (files trio `register` recorded it).
  - **Decision 7 (delete):** `dryRun` first is not possible from the UI — instead: on a throwaway run, read the record, delete, confirm `GET /api/workflow/run?id=` → `{ run: null }`, `GET /api/uploads/workflows/hello/interactive/runs/<id>/card/0/draw/poster.svg` → 404, and the kickoff upload under `inputs/` still serves. Non-owner (an admin session vs the ci member) → confirm the 403/allow matrix with a second account or note it untestable.
  - **Decision 8 (discovery):** the network log shows `/api/workflow/aliases?repository=bffless/workflow` and only that project's aliases are probed (no foreign 404s).
  - **Decision 14 (form):** the mid-run `extra` upload lands under `workflows/hello/interactive/inputs/…`; the tile picker value is the poster's path; the `cover` run output is a File ref built from it.
  - **apps#362:** `?download=1` behaviour observed (inline vs attachment) — update the issue with the date; if ce#697 shipped meanwhile, confirm `Content-Disposition`.
  - **Renderers:** transcript click seeks nothing (no video in hello — note as expected), chart draws, code is highlighted, images grid shows the SVG.
- [ ] **Step 3: Record** results in the README checklist (a `fix(workflow): …` PR if anything failed, same as M1's #365), close/re-title apps#363 (M4 half remains), tick the epic's M2 boxes, and write the memory note for M2 (what the live walk disproved).

---

## Self-review (writing-plans checklist, applied)

**Spec coverage.** Every #359 M2 checkbox maps to tasks (traceability table). 03 `island` → 3/4/5; 04's mapping table rows: tool-input → 4, tools/call → 3/4, submit/annotate → 3/4, hostContext/size/display → 4, teardown → 4/5, viewer → 5; 04 host capabilities (`ui/message`, `ui/open-link`, `ui/request-display-mode`, `resources/read`, `ui/update-model-context` ignored) → 4; 03 `script` contract → 9/10/11 (Blob → 9, `ctx` → 10, failure codes → 11); 02 renderers table → 15/16/17; 02 tile-picker shorthand → 18; 05 `{"$file"}` → 12/13; 05 retention & deletion → 19/20 (minus the inputs tick, Decision 7); 05 dynamic annotations → 3 (`step.annotated`); 08 "the pane is the island / fullscreen takes over" → 5; 08 header Delete → 20; 08 hover-highlight → 22; 06 `step.prefix` for script files → 9/11; README follow-ups #362/#363 → 23/24. Deliberate gaps are all in "Deferred out of M2".

**Placeholder scan.** No TBD/TODO. One execution-time check is named as such (Task 19: whether `response_handler.status` takes an expression) with the literal-steps fallback; the `function_handler` throw behaviour and the missing current-user endpoint were resolved during planning (gate returns `{ok,status}`; a `whoami` rule is added). Task 3 flags one deviation (JSON-`schema` validation of island outputs deferred).

**Type consistency.** `IslandHost.mount/teardown` (Task 4) are what Task 5's middleware and pane call; `completeIslandStep`/`annotateEvent` (Task 3) are the `onSubmit`/`onAnnotate` bodies in Task 5; `ScriptHostDeps.fetchBytes` (Task 10) is gated by `isSameOriginUrl` (Task 23) — Task 10 states the interim rule; `uploadBlob` (Task 9) is used by Tasks 11 and 12 with the scope strings 06 defines; `hydrateOutputs` (Task 12) is what Task 13 calls; `ValueDecl.src`/`mapping` (Tasks 5, 16) are what `outputDecls.typed()` carries; `step.annotated` (Task 3) is produced by Tasks 5 and 11 and replayed by Task 13's read path; `data-testid`s listed in Global Constraints appear in Tasks 4, 5, 11, 15, 16, 18, 20 and are consumed by Tasks 8, 14, 21, 24.

## Execution handoff

Plan complete. Execute per phase (Phase 1 → merge/deploy → Phase 2 → merge/deploy → Phase 3 → merge/deploy → Task 24 live walk), each in its own worktree/PR as specified in Global Constraints. Two execution options: **1. Subagent-Driven** (superpowers:subagent-driven-development — fresh subagent per task, review between tasks) or **2. Inline** (superpowers:executing-plans — batch with checkpoints). The eight ⚑ decisions were confirmed by the user on 2026-08-24; the remaining decisions are planner calls to be challenged in this plan's PR review. **Do not start Phase 1 in the planning session** (epic #359: one checkbox ≈ one session).
