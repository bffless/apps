# Workflow M5 Phase 2 — MCP Apps prototype Implementation Plan (apps#554, stories 5–6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second of spec 10's two adapters as a prototype: a stateless Streamable-HTTP MCP endpoint that is **one rule in the harness rule set** (`POST /api/workflow/mcp`, `function_handler` guts, D22) serving the catalog's eleven tools byte-identically to the page, executing the read tools against the sibling `/api/workflow/*` rows, serving islands unchanged as `ui://` resources, and — the point of the phase — rendering a hello island inside claude.ai and round-tripping `workflow.submit` through it, on a scratch **public** j5s project (auth ladder rung 1, D23). That is ADR-0002's "why", proven.

**Architecture:** One catalog, two adapters (D19, ADR-0005) — Phase 1 built the catalog and the page adapter; this phase binds the catalog to `/api/workflow/*`. The endpoint's `function_handler` steps are **esbuild bundles of TypeScript sources under `apps/workflow/src/mcp/`** that import the catalog package and the app's own pure adapters (`lib/runner/adapters/{island,declared}`, `lib/describe`, workflow-lint's `toDefinition`), so `tools/list` *is* `CATALOG`, the own-implementation fence *is* `resolveToolName`/`resolveSrc`, and a submit's validation *is* `validateDeclared` — nothing is re-declared, and drift is a build error. The rule is a static pipeline: a `route` function turns one JSON-RPC message into condition flags and derived URLs, condition-gated `data_query` / `http_request` / `signed_url` / `data_update` steps do the I/O a sandboxed function cannot, and a `reply` function assembles the JSON-RPC answer from their outputs. Islands mount in claude.ai under an engine-less **step view** (`ui://bffless/workflow/step.html`, a second single-file Vite entry hosting `IslandHost` in a nested srcdoc iframe — D24's mechanism minus the runner), because MCP Apps deliver the *tool call's* arguments as `tool-input`, not the step's (Decision 3).

**Tech Stack:** rules-as-code (`bffless rules push`, `deploy-proxy-rules@v1`); CE pipeline handlers `function_handler` (vm sandbox: no `fetch`, no `URL`, no `TextEncoder`; prohibited-pattern scan), `http_request`, `data_query`, `data_update`, `signed_url`, `response_handler`; esbuild 0.25 (`format: iife`, `inject` polyfills); `@bffless/workflow-agent-tools`; `@bffless/workflow-lint/definition` (`toDefinition`) + `yaml` (`parse`); `@modelcontextprotocol/ext-apps` 1.7.5 (`App` in the step view; `IslandHost` already an `AppBridge` host); `vite-plugin-singlefile` for `dist/step.html`; `@modelcontextprotocol/sdk` 1.30 `Client` + `StreamableHTTPClientTransport` for the live walk; the j5s MCP (`mcp__j5s-dev__*`) for provisioning.

**Spec:** `apps/workflow/docs/spec/10-agent-embedding.md` (§The MCP endpoint, §Islands and the run view, §Auth ladder rung 1; **D22–D23 govern this phase**, D19 holds) · `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` · `docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md` (§1 MCP Apps ground truth, §3 Layer 2, §4 stories 5–6 + the Phase-2 gate) · `docs/superpowers/plans/2026-09-02-workflow-m5-phase1-webmcp.md` (what Phase 1 built; its "as shipped" block) · `packages/workflow-agent-tools/README.md` (the catalog) · `apps/workflow/docs/spec/04-islands.md` (the sandbox contract, tool naming, `workflow.submit`/`annotate`/`sign` semantics) · `apps/workflow/docs/spec/06-discovery-publishing-files.md` (`/w/<impl>/…`, the forwarder, `index.json`, the files quartet) · `apps/workflow/docs/spec/05-runs-and-persistence.md` (rows, lease) · tracking issue **apps#554** (spike findings as a comment; check off stories 5–6 as they merge into `epic/agent-embedding`). Not in scope: CE changes of any kind (app tokens, `mcp_handler`, OAuth — Phase 3); the run view (`ui://bffless/workflow/run.html`, `workflow.http`) and `workflow.start`/`resume` linking it (Phase 4); per-workflow generated tools; bffless.dev.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **The rule's functions are built, not hand-written.** Spec 10 says the prototype "implements the protocol switch by hand"; the hard constraint is "never re-declare a tool" and D19's byte-identical descriptors. A hand-written `.fn.js` cannot import the catalog. So `apps/workflow/src/mcp/{route,plan,merge,reply}.ts` are TypeScript, and `scripts/build-mcp.mjs` (esbuild, `format: 'iife'`, `globalName: '__mcp'`, a trailing `function handler(data) { return __mcp.handler(data) }`) emits the four `*.fn.js` files **committed** beside `rule.yaml` (rules-as-code must be complete on disk for `deploy-proxy-rules` and the catalog bundle). `src/mcp/bundle.test.ts` rebuilds in memory and fails when a committed file is stale, scans every bundle against CE's `PROHIBITED_PATTERNS` (copied verbatim from `repos/ce/apps/backend/src/pipelines/function-runner.service.ts:72-95`), and runs each in a `node:vm` context shaped like CE's sandbox. Probed 2026-09-02: `describeWorkflow` + `toDefinition` + `parse` (yaml) + the island/declared adapters + the catalog bundle to 263 KB with zero prohibited hits and run in that sandbox; workflow-lint's `loadDefinition` does **not** (it pulls ajv, which uses `new Function`) — so the endpoint builds definitions with `toDefinition(parse(yaml))` (the published YAML was linted at publish, 06) and `toDefinition(run.definition)` (the row's `definition` column is `def.raw`, `store/lifecycleActions.ts:264`).
2. **The sandbox gets two polyfills, injected.** CE's vm context exposes `Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set, WeakMap, WeakSet, Promise, Symbol, BigInt, parseInt, parseFloat, isNaN, isFinite, (de|en)codeURI(Component), console` and nothing else non-intrinsic — no `URL` (`resolveSrc`/`resolveToolName`'s `inside()` needs `new URL(x, base).pathname`) and no `TextEncoder` (`annotateEvent`'s budgets). `src/mcp/polyfills.ts` exports a pathname-only `URL` and a byte-length-only `TextEncoder`, wired through esbuild `inject`, and `polyfills.test.ts` asserts the `URL` polyfill agrees with the real `URL` on a table of traversal spellings (the fence's whole job). The prohibited scan forbids `globalThis.`, which is why `inject` — not a global assignment — is the mechanism.
3. **The demo UI resource is an engine-less step view, and the island mounts inside it unchanged.** MCP Apps send the *model's* tool arguments as `ui/notifications/tool-input` (`workflow.submitStep { runId, step }`), while an island expects its evaluated `with` (`pick-line` reads `args.lines`; `hello/islands/pick-line/main.ts`). A `_meta.ui.resourceUri` is also static per tool in `tools/list`, so it cannot name a per-run island. Therefore `workflow.submitStep` links `ui://bffless/workflow/step.html`: a second single-file Vite entry (`step/index.html`, `src/step-view/main.ts`) that is an ext-apps `App` outward and an `IslandHost` inward — on `tool-input` it calls the app-only `workflow.stepView { runId, step }`, gets the island's HTML plus the step row's persisted `inputs` (which *are* the tool-input arguments verbatim, 04 Decision 11), and mounts the island in a nested `<iframe sandbox="allow-scripts" srcdoc>` under the same `IslandHost` the harness page uses. That is exactly how D24's run view will host islands ("nested srcdoc iframes under the same `IslandHost`, none the wiser"); Phase 4 grows this entry into the run view rather than starting over. The island file is still served unchanged as `ui://bffless/<impl>/islands/<name>.html` by `resources/read` — spec 10's resource contract holds — the step view just does not need the host to proxy `resources/read` for it.
4. **The step view's bridge calls are four listed app-only tools.** `workflow.submit { runId, step, outputs }`, `workflow.annotate { runId, step, annotations?, summary? }`, `workflow.pipeline { runId, step, name, arguments, method? }` and `workflow.stepView { runId, step }`, all `_meta.ui.visibility: ["app"]`, declared in `src/mcp/hostTools.ts`. An island's pipeline calls go through `workflow.pipeline` rather than as per-island tool names because a host may refuse `tools/call` for a name absent from `tools/list`; the fence still holds server-side: the run row's `impl` + `resolveToolName(impl, name, { bffless: { method } })` from `lib/runner/adapters/island.ts` decide the URL, and a `host`-kind or rejected name is a tool error. `workflow.sign` needs no app-only twin: the catalog's `workflow.sign { runId?, path }` is what the island calls, and the endpoint serves it for both audiences. The `run` `impl` is authoritative — a step view can only reach `/api/<its run's impl>/…`.
5. **Reads use the rows in-pipeline; only routes need HTTP.** `status`/`outputs`/`runs` are `data_query` steps over `workflow_runs`/`workflow_run_steps` (the same rows `run/get` and `runs/get` read; `runs`' `waitingOn` join mirrors `runs/get/shape.fn.js`). `list`/`describe`/`resources/*` need things only a route serves — CE's alias API, `/w/<alias>/.bffless/workflows/index.json`, the workflow YAML, an island file — and use `http_request` steps against the harness's own public host (`x-forwarded-host ?? host` from the request; `deployment.owner/repo` for the alias API), carrying the service identity below. The `list` fan-out is a **static** step list, so it is capped: `plan.ts` picks up to three implementation aliases (`LIST_FANOUT = 3`) when `impl` is absent; the cap is a recorded prototype limit that the generic `mcp_handler` (story 8) removes.
6. **The service identity is a project secret, and its absence makes the endpoint inert.** Authless callers cannot reach `auth_required` siblings, so every `http_request` to a sibling carries `x-api-key: secrets.WORKFLOW_MCP_KEY` — a key scoped to the scratch project, set with `set_secret`. A function cannot read secrets, so the pipeline's first step is `identity`: `GET /api/workflow/whoami` with that header, `failOnError: false`; when it is not `ok`, `reply` answers every method except `initialize` with JSON-RPC error `-32000 "MCP endpoint is not enabled on this install: no WORKFLOW_MCP_KEY service identity"`. That is instance-agnostic (no hostname or project baked in — memory `apps-derive-instance-hosts-never-hardcode`), and it is what keeps the authless rule inert on `bffless/workflow` should the epic ever deploy there before Phase 3. The identity's `id` is what `startedBy` would carry if the endpoint started runs; it does not in this phase (Decision 8).
7. **A server-side submit refuses a run with a live driver.** `workflow.submit`/`submitStep` write the step row the page's `completeIslandStep` would have produced (`status: succeeded`, `outputs`, `finishedAt`), through the same read-merge-write `run-step` uses — but only when `run.leaseOwner` is empty or `run.leaseUntil < now` (the lease gate's own predicate, `run/lease/post/gate.fn.js`). A parked run whose tab is still open is refused with `errors.lease`; a closed tab lapses in 60 s. The endpoint does **not** take the lease (it drives nothing) and does not seal the run: the harness page's Resume rebuilds from rows and continues (05) — the invariant spec 10 asks for. Not written: the step's `summary` (needs run contexts; a recorded gap, the row shows outputs), and `form` steps (the evaluated fields live in the page's state — refused with `errors.step`).
8. **Over the endpoint in this phase, `start`/`await`/`cancel`/`resume` are listed but not served.** `tools/list` is the whole catalog (D19: byte-identical), and a call to one of these answers an honest error result — `errors.tool: "workflow.<name> is not served by the MCP endpoint yet (Phase 4 adds the run view that drives runs)"` (`await`: "poll workflow.status") — exactly as Phase-1 Story 3 registered the mutations before Story 4 served them. `runId` is required for every run-scoped tool (spec 10: "the MCP server does not [have a current run], so there it is required"); `runs` requires `impl` and `workflow` for the same reason.
9. **`resources/read` derives `_meta.ui.csp` from the instance.** `connectDomains` = `[appOrigin, storageOrigin]`, `resourceDomains` = `[storageOrigin]` (`<img>`/`<video>` on presigned URLs), where `appOrigin` is the request's own host and `storageOrigin` is the origin of a `signed_url` step's answer for `<owner>/<repo>/uploads/workflows/.mcp-csp-probe` (presigning needs no object; the URL's origin is the storage backend's). `resources/list` lists `ui://bffless/workflow/step.html` plus `ui://bffless/<impl>/islands/<name>.html` for every `islands[]` entry of the discovered `index.json`s; `resources/read` of an island fetches `/w/<impl>/<src>` after `resolveSrc` (the same fence the page applies) and answers `text/html;profile=mcp-app`.
10. **`GET /api/workflow/mcp` is a second, two-line rule.** Rules are unique per (path, method) and an unmatched `GET` on the harness falls through to the SPA's `index.html` with 200, so the 405 the stateless profile requires needs its own manifest (`mcp/get/rule.yaml`, `response_handler` 405 with `Allow: POST`). "One rule" in the story means the endpoint; this is its transport companion. `DELETE` (a client ending a session) is left unmatched — stateless servers may 405 it, and nothing in the spike sends one.
11. **Notifications get a 202 with an empty body; everything else is a 200 JSON body.** `notifications/initialized` (no `id`) is answered by a conditional `response_handler` (status 202, body `''` — accepted: only `undefined`/`null` bodies are refused by `response.handler.ts:40`). Unknown methods → `-32601`; a body that is not an object or lacks `jsonrpc: "2.0"` → `-32600`; `ping` → `{}`; `initialize` → `{ protocolVersion: <client's if one of 2024-11-05|2025-03-26|2025-06-18, else 2025-06-18>, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'bffless-workflow', version: HOST_INFO.version } }`. Every `tools/call` answer is a catalog `CallToolResult` as the JSON-RPC `result` (an unknown tool is an `isError` result keyed `errors.tool`, not a protocol error).
12. **`snapshotText` moves into the catalog.** The page's prose for a snapshot (`agent/executors.ts:84`) is what the endpoint must say too ("Run X is running, waiting on pick/0/choose (island)"); a second copy would drift. It becomes `snapshotText(snapshot)` in `packages/workflow-agent-tools/src/snapshot.ts` (additive; the page imports it). The `list` prose and `structuredContent` shape (`executors.ts:130-170`) are mirrored line for line in `reply.ts` and asserted equal in a test that feeds both the same fixture.
13. **`IslandHost` deps may be async.** `IslandHostDeps.onSubmit`/`onAnnotate` (`islands/IslandHost.ts:114-116`) return sync results because the page's store answers synchronously; the step view's answers come from `callServerTool`. Both signatures widen to `… | Promise<…>` and `oncalltool` awaits them — a no-op for the page (awaiting a value), and the one edit the harness's host needs to serve an agent host. `resolveSrc`/`resolveToolName` and the sandbox contract are untouched: the island cannot tell which host it is in.
14. **The scratch project is `bffless/workflow-mcp`, public, at `workflow-mcp.j5s.dev`, and it stays until the phase ends.** Provisioned through the j5s MCP: `create_project` (public), a project-scoped key (`create_api_key repository: bffless/workflow-mcp`, doubling as the service identity secret), `create_domain` (subdomain, alias `workflow`, path `/dist`, SPA), deployments uploaded with `curl` to `/api/deployments/zip` (the fields `upload-artifact` sends, `repos/upload-artifact/src/upload.ts:141-192`), the harness rule set pushed with `bffless rules push --prune` from the branch, and `hello` published by hand the way `publish-workflow@v1` does it (06: build → deploy `dist/` to alias `hello` → push its set with `--path-prefix /api/hello` plus the generated forwarder → attach to both aliases). The sequence is written into `apps/workflow/bffless/README.md` so a re-deploy is a copy-paste, not archaeology. Teardown (`delete_project`) is irreversible and is **asked for**, not done; until then the project's description says what it is.
15. **The live proof is a walk; the claude.ai proof is a person.** `packages/workflow-live` gains an `mcp` walk (the official SDK's `StreamableHTTPClientTransport` against `--harness`): initialize, `tools/list` parity with `CATALOG` (names, descriptions, schemas, annotations JSON-equal; `submitStep` carries the resource URI; app-only tools carry `visibility: ["app"]`), the five reads, `resources/list`/`read` with the derived CSP, `GET` → 405; in Story 6 it also parks a `hello/interactive` run through the page tools, closes the browser, waits out the lease, and round-trips `workflow.stepView` → `workflow.submit` → `workflow.status` (step `succeeded`, run still `running`) and `workflow.sign`. What the walk cannot do is render claude.ai: story 6's gate step is a scripted-manual checklist (connector URL, prompts, what each screenshot must show) the user runs, with screenshots posted on the PR — as the design doc already says ("manual-with-screenshots and not reachable by the standard chain").

## Deferred out of this plan, explicitly

- The run view (`ui://bffless/workflow/run.html`), `workflow.http`, `workflow.start`/`resume` linking it, lease/take-over from an agent host → Phase 4 (stories 10–11). The step view is its seed, not a substitute.
- App tokens, per-rule `requiredScopes`, the visibility gate honouring Bearer, `.well-known` served-despite-visibility, OAuth 2.1, the generic `mcp_handler` → Phase 3 (CE; stories 7–9). The spike's findings feed story 8's shape.
- `workflow.await` over the endpoint (a stateless POST cannot wait; a `delay`-handler bounded wait is a later option), `form` steps over `workflow.submitStep`, a submitted step's `summary` → recorded on #554 as prototype gaps.
- Per-island tool names in `tools/list`, per-workflow generated tools → spec 10 Later.
- `list` beyond three implementations without `impl` → the `mcp_handler` story.
- The `workflow.runs` read-after-write lag from Phase 1 → filed as its own issue in the closeout (Task 14), not fixed here.

## Global Constraints

- **Worktrees only:** every story branch is `git worktree add .claude/worktrees/<name> -b <branch> origin/epic/agent-embedding`; the shared checkout is never switched (memory `use-worktrees-in-apps-repo`). Story 5: `feat/m5-mcp-endpoint` in `.claude/worktrees/m5-mcp-endpoint`; Story 6: `feat/m5-mcp-islands` in `.claude/worktrees/m5-mcp-islands` (based on the epic after Story 5 merged).
- **Branching:** all PRs target `epic/agent-embedding`, never `main`; the epic PR (#571, draft, label `epic`) is merged by a human. Story PRs merge into the epic on green; each merge checks its story off on #554.
- **PR titles are release commits** (`.claude/apps-pr-review-checklist.md` §3): `docs(workflow): the M5 Phase 2 plan — MCP Apps prototype on a scratch j5s project (#554)` · `feat(workflow): MCP endpoint prototype — POST /api/workflow/mcp as a harness rule (initialize, tools/list, read tools, resources/list)` · `feat(workflow): islands as ui:// resources — the step view, server-side workflow.submit/annotate/pipeline, submitStep's UI in claude.ai`. Never edit a `CHANGELOG.md`.
- **No CE changes** (Phase 3 owns them); **no `/_bffless/*`**, no CE endpoint, no use of CE's platform-admin MCP server (D22). The endpoint is app-level rules-as-code under `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp/`.
- **Dev instance only:** the endpoint is exercised on the scratch public project `bffless/workflow-mcp` (`workflow-mcp.j5s.dev`); never `bffless.dev`, never the members-only `bffless/workflow` harness (its visibility gate 302s anonymous callers before any rule runs — verified 2026-09-02). Scratch data only; the fixed service identity is the scratch key (Decision 6).
- **The rule is authless by design** (no `auth_required` validator) and inert without the `WORKFLOW_MCP_KEY` secret (Decision 6). The epic must not land on `main` with this rule until Phase 3 puts `auth_required` + scopes in front of it — recorded on #571.
- **Rule-set pruning:** the harness set is synced with `prune: true`; the existing 20 rules under `rules/api/` and 3 schemas must survive. This phase only **adds** (`mcp/post`, `mcp/get`). `$schema:` references resolve live — both schemas already exist on every target.
- **The catalog is read, never edited, by the endpoint:** `src/mcp/**` imports `@bffless/workflow-agent-tools`, `@bffless/workflow-lint/definition`, `yaml`, `../lib/describe`, `../lib/runner/adapters/{island,declared}`, `../lib/runner/types`, `../islands/IslandHost` (the `HOST_INFO` version only) and nothing else from the app — enforced by an eslint `no-restricted-imports` block shaped like the `src/agent` fence (`apps/workflow/eslint.config.js:51-62`). No React, no store, no DOM.
- **Every result is a `CallToolResult`** built with `textResult`/`errorResult`; refusals keyed as spec 07 keys them plus `runId`/`step`/`path`/`lease`/`tool`.
- **Verification chain per PR:** `pnpm --filter @bffless/workflow-agent-tools lint && build && test:run` when the package changes; `pnpm --filter workflow mcp:build` then `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build` (the build also emits `dist/step.html` from Story 6 on); `pnpm --filter @bffless/workflow-live lint && build && test:run` when the walk changes; `pnpm apps:check`; the `mcp` walk against the scratch harness with real counts pasted in the PR body (checklist §7). CI order stays stage → build → test; `workflow-app.yml` and `deploy-workflow.yml` already build `workflow-lint` and `workflow-agent-tools` first — no new workspace package is added by this phase, so neither workflow needs a new build step; `deploy-workflow.yml`'s `pnpm --filter workflow build` picks up `dist/step.html` through the app's `build` script.
- **Live surfaces:** nothing in these PRs deploys (`apps/workflow` deploys on merge to `main`). `workflow.j5s.dev` keeps serving the epic build until `main` next deploys; the scratch project is deployed by hand from the story branches.
- **Provisioning goes through the j5s MCP** (`mcp__j5s-dev__*`): project, key, domain, secret, alias attachments. API keys are per-project; AI provider tokens are admin-panel only (irrelevant here — `hello` uses none).

## File structure

```
bffless/apps
  docs/superpowers/plans/2026-09-02-workflow-m5-phase2-mcp-apps.md   this plan                          (Task 0)
  apps/workflow/
    package.json           + scripts mcp:build, build (adds the step entry); devDeps esbuild, vite-plugin-singlefile   (Tasks 1, 9)
    eslint.config.js       + the src/mcp fence                                                            (Task 1)
    scripts/build-mcp.mjs  esbuild: src/mcp/{route,plan,merge,reply}.ts → rules/api/workflow/mcp/post/*.fn.js (Task 1)
    src/mcp/polyfills.ts   URL (pathname only), TextEncoder (byte length) — esbuild inject (+ .test.ts)   (Task 1)
    src/mcp/jsonrpc.ts     parseMessage, okResponse, errorResponse, JSONRPC codes, PROTOCOL_VERSIONS (+ .test.ts) (Task 2)
    src/mcp/hostTools.ts   STEP_VIEW_URI, HOST_TOOLS (4 app-only descriptors), listedTools() (+ .test.ts)  (Task 2)
    src/mcp/csp.ts         uiMeta(appOrigin, storageOrigin), originOf(url) (+ .test.ts)                    (Task 2)
    src/mcp/route.ts       handler({request, deployment}) → Route (+ .test.ts)                             (Task 3)
    src/mcp/plan.ts        handler({steps}) → which index.json URLs to fetch (+ .test.ts)                  (Task 3)
    src/mcp/rows.ts        rows(), fieldsOf(), runsWithWaiting() — the data_query envelope readers (+ .test.ts) (Task 4)
    src/mcp/reply.ts       handler({request, steps, deployment}) → { json, status } (+ .test.ts)          (Tasks 4, 10, 11)
    src/mcp/merge.ts       handler({request, steps}) → the step-row write for submit/annotate (+ .test.ts) (Task 10)
    src/mcp/bundle.test.ts freshness + prohibited-pattern scan + vm smoke of the four committed bundles   (Task 1)
    .bffless/proxy-rules/workflow/rules/api/workflow/mcp/post/rule.yaml + route.fn.js, plan.fn.js, merge.fn.js, reply.fn.js (generated) (Tasks 1, 5, 10)
    .bffless/proxy-rules/workflow/rules/api/workflow/mcp/get/rule.yaml   405                              (Task 5)
    step/index.html, src/step-view/main.ts, src/step-view/deps.ts (+ .test.ts), vite.step.config.ts → dist/step.html (Task 9)
    src/islands/IslandHost.ts   onSubmit/onAnnotate may return a Promise (+ test)                         (Task 9)
    bffless/README.md      "Scratch: MCP Apps prototype (bffless/workflow-mcp)" — provisioning + redeploy sequence (Task 6)
    CONTEXT.md             glossary: "MCP endpoint", "Step view", "Service identity"                       (Task 5)
  packages/workflow-agent-tools/src/snapshot.ts   + snapshotText (+ test); apps/workflow/src/agent/executors.ts imports it (Task 4)
  packages/workflow-live/
    package.json           + @modelcontextprotocol/sdk                                                   (Task 7)
    src/mcp-client.ts      openMcp(base) → { client, close } over StreamableHTTPClientTransport             (Task 7)
    src/walks/mcp.ts       the walk (Story 5 reads; Story 6 park + submit round trip); walks/index.ts, args.ts USAGE, README (Tasks 7, 12)
  .claude/agents/apps-live-walk.md   walk list gains `mcp`                                                (Task 7)
```

## Traceability — spec 10 / design §4 / #554 → tasks

| Spec 10 / story item | Tasks |
|---|---|
| The endpoint is one rule in the harness set, `POST /api/workflow/mcp`, rules-as-code, never CE / `/_bffless` (D22) | 5 |
| Stateless Streamable HTTP: one POST → one JSON body, no SSE/session, `GET` → 405 | 2, 5, 7 |
| Answers `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read` | 2–5 (list/call/reads), 11 (resources/read) |
| `tools/list` = the catalog's 11, descriptions/schemas byte-identical to the page's (D19) | 2, 7 (`D19.toolsListParity`) |
| `tools/call` for the read tools against the sibling `/api/workflow/*` rows | 3, 4, 7 |
| Spike (a): can a `function_handler` execute sibling rules? | 8 |
| Spike (b): does `X-API-Key` alone pass the visibility gate? | 8 |
| Spike (c): does claude.ai's custom-connector flow accept the authless endpoint? | 8 (attempt), 13 (confirmed by the person) |
| Findings comment on #554 | 8 |
| Islands served as `ui://bffless/<impl>/islands/<name>.html` from `/w/<impl>/…`, unchanged, MIME `text/html;profile=mcp-app` | 11, 12 |
| `_meta.ui.csp.connectDomains` = app domain + storage origin, derived from the instance | 2 (`csp.ts`), 11, 12 (`spec10.cspDerived`) |
| One demo tool linked via `_meta.ui.resourceUri`; the lightweight path (a run waiting on one island) | 2 (`hostTools.ts`), 9, 11, 13 |
| Server-side `workflow.submit` / `workflow.sign` for the bridge, `visibility: ["app"]`; the fence holds server-side as `island.ts` holds it | 4 (sign), 10 (submit/annotate/pipeline), 12 |
| Auth rung 1: authless prototype on a scratch **public** j5s project, fixed service identity, scratch data | 6 |
| Manual claude.ai verification with screenshots on the story-6 PR — ADR-0002's "why", proven | 13 |
| Phase-2 gate + stories 5–6 checked off on #554; runs-lag follow-up filed | 14 |

---

## Phase 2 as shipped (2026-09-02; the claude.ai gate pending)

Landed on `epic/agent-embedding` as #577 (this plan), #578 (Story 5) and #579 (Story 6, draft until the screenshots are on it). Departures from the plan, all recorded on the PRs:

- **Alias discovery reads CE's API in-process** (`http://localhost:3000/api/aliases?repository=…`, the relay rule's own target) rather than the harness's `/api/workflow/aliases` relay: the relay forwards a *cookie* and the endpoint has none (Task 3/5). Every other sibling fetch goes through the harness host's own forwarders (`https://<host>/w/<impl>/…` — the hairpin from CE works on j5s).
- **The two response steps are both gated** (`accepted` on `isNotification`, `respond` on `isRequest`): CE runs every step whose condition holds, so an unconditional `respond` after a 202 answered 200 (Task 5).
- **`resources/list` runs the storage probe too** — the first walk caught a CSP without the storage origin on the listing (Task 7).
- **The endpoint gets its own `SERVER_VERSION`** rather than importing `HOST_INFO` from `IslandHost` (which would drag the ext-apps bridge into the sandbox); a test pins it to `HOST_INFO.version`.
- **The driver signs in on a public host**: `loginViaRelay` goes to `admin.<domain>/login?redirect=…` itself when the gate never bounces (a public deployment renders signed out and every `auth_required` rule 401s); `loginUrl` is exported. The j5s CI member also had to be granted `contributor` on the scratch project (CE's alias list is permission-filtered) — via CE's `POST /api/projects/:owner/:repo/permissions/users { userEmail, role }`, there being no MCP tool.
- **The rule-set fence test** learned `http_request` and the MCP rules' authless exception (it asserts the `identity` gate instead).
- **The walk waits for the `waiting` row before closing the browser**: the page's `workflow.await` answers from its store a beat ahead of the middleware's write; the endpoint reads rows and rightly refused a `queued` step (Task 12 — the same read-after-write shape as the Phase-1 follow-up).
- **Bucket CORS**: `https://workflow-mcp.j5s.dev` is not in the storage bucket's CORS, so the harness page's own `card` upload fails on the scratch host (`page-tools` there reads 11/17); a `gcloud` step for a person. The endpoint and the island round trip are unaffected.

**The claude.ai gate passed on 2026-09-02** (screenshots on #579): the connector listed the 11 tools (spike (c) settled — and claude.ai grouped them by `readOnlyHint` and put `workflow.submitStep` under "Interactive tools" because of its `_meta.ui.resourceUri`); `workflow.submitStep { values: {} }` rendered the step view, the `pick-line` island mounted inside it unchanged, a click relayed hello's `echo` through `workflow.pipeline` ("HELLO, WORLD!"), Submit round-tripped `workflow.submit`, and the row reads `succeeded { line: "Hello, studio!", index: 1 }` with the run still `running`. Four things stood between "connected" and that screen, none of them the endpoint's protocol: Cloudflare's AI-bot block (403 for Anthropic's user agents — a zone setting), the SPA's `index.html` answering OAuth discovery (a `/.well-known/*` 404 rule), the host being **text-only** (a model never sees `structuredContent`; the prose now carries declarations and the call to make; `submitStep { values: {} }` opens the panel), and the sibling-call hairpin through the edge (now in-process at the request's own `/public/…` base with `x-original-uri`/`x-forwarded-host`; 0.3–0.6 s per call). All recorded in `apps/workflow/bffless/README.md`.

Verified: `mcp` walk **24/24** on `https://workflow-mcp.j5s.dev` (Story 5's 13 + Story 6's 11), re-run green after the in-process routing; the spike's (a)/(b)/(c) on #554 with evidence. Scratch project kept, named, documented.

# Phase A — Story 5: the endpoint (Tasks 1–8)

*Deliverable: `POST /api/workflow/mcp` exists in the harness rule set as a built `function_handler` pipeline; on the scratch project it answers `initialize`, `tools/list` (catalog parity), `tools/call` for `list`/`describe`/`status`/`runs`/`outputs`/`sign`, `resources/list`; `GET` is 405; the `mcp` walk is green; the spike's three answers are on #554. Branch `feat/m5-mcp-endpoint`, worktree `.claude/worktrees/m5-mcp-endpoint`.*

### Task 0: the plan PR

- [ ] Worktree `m5-phase2-plan` off `origin/epic/agent-embedding`; commit this file as `docs(workflow): the M5 Phase 2 plan — MCP Apps prototype on a scratch j5s project (#554)`; PR into `epic/agent-embedding`; merge on green (docs only — CI is the path-filtered gates, none of which trigger). Comment on #554: "Phase 2 kicked off; plan merged (#<n>)."

### Task 1: the bundle toolchain — `scripts/build-mcp.mjs`, polyfills, the freshness test

**Files:** Create `apps/workflow/scripts/build-mcp.mjs`, `src/mcp/polyfills.ts`, `src/mcp/polyfills.test.ts`, `src/mcp/bundle.test.ts`, a placeholder `src/mcp/route.ts` (`export function handler() { return { ok: true } }` — Task 3 replaces it); modify `apps/workflow/package.json` (`"mcp:build": "node scripts/build-mcp.mjs"`, devDependencies `"esbuild": "^0.25.12"` — the version already in the lockfile), `apps/workflow/eslint.config.js` (the fence, after the `src/agent` block).

**Interfaces:**

```ts
// src/mcp/polyfills.ts — injected by esbuild into every bundle (Decision 2)
/** `new URL(input, base).pathname` and nothing else: dot-segments, `\` as `/`, percent-escapes decoded, query/fragment dropped. */
export class URL { readonly pathname: string; constructor(input: string, _base?: string) }
/** `.encode(s).length` only — UTF-8 byte length. */
export class TextEncoder { encode(s: string): { length: number } }
```

```js
// scripts/build-mcp.mjs — one entry per function step; run by `pnpm --filter workflow mcp:build`
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ENTRIES = ['route', 'plan', 'merge', 'reply']
export const OUT_DIR = join(app, '.bffless/proxy-rules/workflow/rules/api/workflow/mcp/post')
const HEADER = (name) =>
  `// GENERATED by scripts/build-mcp.mjs from src/mcp/${name}.ts — do not edit; run \`pnpm --filter workflow mcp:build\`.\n` +
  `// An esbuild IIFE of the app's pure adapters + @bffless/workflow-agent-tools, so this rule cannot drift from the page (spec 10, D19).\n`
const FOOTER = `\nfunction handler(data) { return __mcp.handler(data) }\n`

/** The bundle text for one entry (also what bundle.test.ts compares against the committed file). */
export async function bundle(name) {
  const result = await build({
    entryPoints: [join(app, 'src/mcp', `${name}.ts`)],
    bundle: true, write: false, format: 'iife', globalName: '__mcp', platform: 'neutral', target: 'es2022',
    treeShaking: true, minify: false, legalComments: 'none', logLevel: 'silent',
    inject: [join(app, 'src/mcp/polyfills.ts')],
    absWorkingDir: app,
  })
  return HEADER(name) + result.outputFiles[0].text + FOOTER
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const name of ENTRIES) {
    const text = await bundle(name)
    const out = join(OUT_DIR, `${name}.fn.js`)
    const same = (() => { try { return readFileSync(out, 'utf8') === text } catch { return false } })()
    if (!same) writeFileSync(out, text)
    console.log(`${same ? 'unchanged' : 'wrote'} ${out} (${text.length} bytes)`)
  }
}
```

`bundle.test.ts` (Vitest, node environment via `// @vitest-environment node`): for each `ENTRIES` name — (1) `await bundle(name)` equals `readFileSync(<OUT_DIR>/<name>.fn.js)` with the message "stale: run pnpm --filter workflow mcp:build"; (2) none of CE's prohibited patterns match (the 13 regexes from `function-runner.service.ts:72-95`, copied with a comment naming the source); (3) `vm.createContext` with exactly CE's sandbox globals, `runInContext` the file's text followed by `__result__ = handler(data)` with `data = { request: { body: {}, headers: {}, method: 'POST', path: '/api/workflow/mcp' }, steps: {}, deployment: { owner: 'o', repo: 'r' } }` → no throw, an object result. `polyfills.test.ts`: `for (const x of ['islands/x.html', '../x', 'a/./b/../c', 'a%2e%2e/b', 'a\\..\\b', '/w/hello/islands/x.html?q#f', '//evil/x', 'https://evil/x'])` expect `new URL(x, 'https://harness.invalid').pathname` (polyfill) `===` the global `URL`'s; `new TextEncoder().encode('mé€😀').length === 10`.

- [ ] **Step 1: failing tests** — write both test files; `pnpm --filter workflow test:run -- src/mcp` fails (no polyfills module, no bundles).
- [ ] **Step 2: implement** polyfills + the script + the placeholder route; `pnpm --filter workflow mcp:build` writes four files (plan/merge/reply entries are placeholders too until their tasks — each `export function handler() { return {} }`); tests green.
- [ ] **Step 3: the fence** — eslint block for `files: ['src/mcp/**/*.ts']`, `ignores: ['src/mcp/**/*.test.ts']`, patterns `['react', 'react-*', '@reduxjs/*', 'react-redux', 'msw*', '../store/*', '../store/**', '../components/**', '../pages/**', '../mocks/**', '../scripts/**', '../agent/**', '../islands/*', '!../islands/IslandHost', '../lib/*', '!../lib/describe', '../lib/runner/*', '!../lib/runner/adapters', '!../lib/runner/types', '../lib/runner/adapters/*', '!../lib/runner/adapters/island', '!../lib/runner/adapters/declared']` with the message `src/mcp is bundled into a CE function_handler (spec 10, D22): only the catalog package, workflow-lint/definition, yaml, lib/describe, lib/runner/{adapters/island,adapters/declared,types} and islands/IslandHost (HOST_INFO) may be imported.` `pnpm workflow:lint` green.
- [ ] **Step 4: commit** `feat(workflow): esbuild toolchain for the MCP endpoint's function_handler bundles (polyfills, freshness test)`.

### Task 2: protocol helpers — `jsonrpc.ts`, `hostTools.ts`, `csp.ts`

**Files:** Create `src/mcp/jsonrpc.ts`, `src/mcp/hostTools.ts`, `src/mcp/csp.ts` and their `.test.ts`.

**Interfaces:**

```ts
// src/mcp/jsonrpc.ts
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]
export const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, NOT_ENABLED: -32000 } as const
export type Id = string | number | null
export type Message =
  | { kind: 'request'; id: Id; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'invalid'; id: Id; message: string }
/** One JSON-RPC 2.0 message from a request body. A batch is `invalid` (the stateless profile answers one message per POST). */
export function parseMessage(body: unknown): Message
export function okResponse(id: Id, result: unknown): { jsonrpc: '2.0'; id: Id; result: unknown }
export function errorResponse(id: Id, code: number, message: string, data?: unknown): { jsonrpc: '2.0'; id: Id; error: { code: number; message: string; data?: unknown } }
/** The version to answer `initialize` with: the client's when we speak it, else ours. */
export function negotiateVersion(requested: unknown): string

// src/mcp/hostTools.ts
export const STEP_VIEW_URI = 'ui://bffless/workflow/step.html'
export const RESOURCE_MIME = 'text/html;profile=mcp-app'
/** The four app-only tools the step view calls (Decision 4). Shaped like the catalog's ToolDef minus scope, plus `_meta`. */
export interface HostToolDef { name: 'workflow.submit' | 'workflow.annotate' | 'workflow.pipeline' | 'workflow.stepView'; description: string; inputSchema: JsonSchema; _meta: { ui: { visibility: ['app'] } } }
export const HOST_TOOLS: readonly HostToolDef[]
/** What `tools/list` answers: CATALOG (each `{ name, description, inputSchema, annotations }`, `workflow.submitStep` additionally `_meta: { ui: { resourceUri: STEP_VIEW_URI } }`) followed by HOST_TOOLS. */
export function listedTools(): Array<Record<string, unknown>>
export function isHostTool(name: string): name is HostToolDef['name']

// src/mcp/csp.ts
export interface UiMeta { ui: { csp: { connectDomains: string[]; resourceDomains: string[] }; prefersBorder: true } }
/** `_meta` for every ui:// resource (Decision 9). Origins only — never a path. */
export function uiMeta(appOrigin: string, storageOrigin: string): UiMeta
/** `https://storage.googleapis.com` from a presigned URL; `''` when unparsable. A regex (`/^(https?:\/\/[^/?#]+)/`), because the sandbox's URL polyfill knows pathnames only. */
export function originOf(url: string): string
```

`HOST_TOOLS` schemas: `workflow.submit` `{ runId: string, step: string, outputs: object }` all required, description "Complete the waiting island step of a run with its declared outputs — the island's own `workflow.submit`, answered server-side (spec 04). Refused while a harness tab still drives the run."; `workflow.annotate` `{ runId, step, annotations?: array, summary?: string }` (runId, step required); `workflow.pipeline` `{ runId, step, name: string, arguments?: object, method?: 'GET'|'POST' }` (runId, step, name required) "Call one of the run's own implementation's pipelines on the island's behalf — fenced to `/api/<impl>/` exactly as on the harness page."; `workflow.stepView` `{ runId, step }` "What the step view needs to mount a waiting island: the island HTML, the step's persisted inputs, its declared outputs."

- [ ] **Step 1: failing tests** — `jsonrpc.test.ts`: `parseMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })` → request with `params: {}`; a body without `id` → notification; `[]`, `'x'`, `{ jsonrpc: '1.0' }`, `{ jsonrpc: '2.0', id: 1 }` (no method) → invalid with `id` preserved when present; `negotiateVersion('2025-03-26') === '2025-03-26'`, `negotiateVersion('1999-01-01') === '2025-06-18'`, `negotiateVersion(undefined) === '2025-06-18'`. `hostTools.test.ts`: `listedTools().length === CATALOG.length + 4`; the first 11 entries' `{ name, description, inputSchema, annotations }` deep-equal `CATALOG`'s (and carry **no** `scope` key — scope is the consent screen's, not the wire's); only `workflow.submitStep` has `_meta.ui.resourceUri === STEP_VIEW_URI`; every host tool has `_meta.ui.visibility` `['app']` and `inputSchema.required` starting `['runId', 'step']`. `csp.test.ts`: `uiMeta('https://workflow-mcp.j5s.dev', 'https://storage.googleapis.com')` deep-equals the literal; `originOf('https://storage.googleapis.com/j5s-dev/x?X-Goog=1') === 'https://storage.googleapis.com'`, `originOf('/api/storage/presigned/local?key=') === ''`.
- [ ] **Steps 2–3:** implement; `pnpm --filter workflow test:run -- src/mcp` + `pnpm workflow:lint` green; commit `feat(workflow): MCP endpoint protocol helpers — JSON-RPC envelope, listed tools (catalog + 4 app-only), ui:// CSP meta`.

### Task 3: `route.ts` + `plan.ts` — one message → condition flags and URLs

**Files:** Create `src/mcp/route.ts`, `src/mcp/route.test.ts`, `src/mcp/plan.ts`, `src/mcp/plan.test.ts`.

**Interfaces:**

```ts
// src/mcp/route.ts — the pipeline's first function step (`steps.route`)
export const LIST_FANOUT = 3
export interface FnRequest { body: unknown; headers: Record<string, string | string[] | undefined>; method: string; path: string }
export interface FnDeployment { owner?: string; repo?: string; alias?: string }
export interface Route {
  /** Echoed for `reply`: the parsed message and the tool it names. */
  kind: 'initialize' | 'ping' | 'toolsList' | 'toolsCall' | 'resourcesList' | 'resourcesRead' | 'notification' | 'unknown' | 'invalid'
  id: string | number | null
  method: string
  message: string            // `invalid`: why
  tool: string               // canonicalToolName(params.name) for toolsCall, else ''
  args: Record<string, unknown>
  uri: string                // resourcesRead
  // --- one boolean per gated pipeline step (conditions are simple paths — never compound) ---
  isNotification: boolean
  needsRun: boolean          // status | outputs | submitStep | submit | annotate | pipeline | stepView | sign (runId present)
  isRuns: boolean            // runs with impl+workflow
  isList: boolean            // list, resourcesList, resourcesRead(island) → aliases + plan + index1..3
  isDescribe: boolean        // describe → index + yaml
  isIsland: boolean          // resourcesRead of an island | stepView → fetch /w/<impl>/<src> (Story 6 fills the URL from the run row via `plan`)
  isStepView: boolean        // resourcesRead of STEP_VIEW_URI → fetch /step.html
  isCsp: boolean             // any resourcesRead → the storage probe
  isSign: boolean
  isPipelinePost: boolean    // Story 6
  isPipelineGet: boolean
  isWrite: boolean           // submit | submitStep with values | annotate  (Story 6)
  // --- derived values the gated steps read as expression paths ---
  runId: string; key: string; impl: string; workflow: string
  appOrigin: string          // `https://` + (x-forwarded-host ?? host); `''` when neither
  whoamiUrl: string          // `${appOrigin}/api/workflow/whoami` — the `identity` probe (Decision 6)
  aliasesUrl: string         // `${appOrigin}/api/workflow/aliases?repository=${owner}/${repo}` — the harness's own relay (06), so the service key is honoured the same way everywhere
  indexUrl: string           // describe / list with impl: `${appOrigin}/w/${impl}/.bffless/workflows/index.json`
  stepViewUrl: string        // `${appOrigin}/step.html`
  signPath: string           // confine.fn.js's rule applied: '' when refused
  signStoragePath: string    // `${owner}/${repo}/uploads/${signPath}`
  probePath: string          // `${owner}/${repo}/uploads/workflows/.mcp-csp-probe`
}
export function handler(data: { request: FnRequest; deployment?: FnDeployment }): Route

// src/mcp/plan.ts — the second function step (`steps.plan`), after `aliases`, `index`, `run` and `steps`: the URLs only an earlier step's answer can supply
export interface Plan {
  // list / resourcesList: up to LIST_FANOUT index.json URLs
  has1: boolean; has2: boolean; has3: boolean; url1: string; url2: string; url3: string; aliases: string[]; skipped: string[]
  // describe: the YAML named by the index's `workflows[].file` for `route.workflow` (`interactive.workflow.yaml`, not a guessed `<workflow>.yaml`)
  hasYaml: boolean; yamlUrl: string
  // Story 6 (Task 11): the island file for stepView / resourcesRead, and the fenced pipeline call
  hasIsland: boolean; islandUrl: string; islandError: string
  isPipelinePost: boolean; isPipelineGet: boolean; pipelineUrl: string; pipelineBody: Record<string, unknown>; pipelineError: string
}
/** `impl` given → exactly one index URL; else the first LIST_FANOUT aliases from `steps.aliases.body.data[]` other than the harness alias (`deployment.alias`) — previews included, 06 lists them with a badge — and anything past the cap goes to `skipped`. */
export function handler(data: { steps: { aliases?: { ok?: boolean; body?: unknown }; index?: { ok?: boolean; body?: unknown }; run?: unknown; steps?: unknown; route: Route }; request: FnRequest; deployment?: FnDeployment }): Plan
```

A pipeline step cannot build a URL from a *later* step's answer, so the pipeline order is `route → identity → run → steps → runs → waiting → aliases → index → plan → index1..3 → yaml → …` (Task 5): `route` derives what the request alone determines, `plan` derives what needs a row or a fetched index.

- [ ] **Step 1: failing tests** — `route.test.ts` with a `req(body, headers?)` helper: `tools/call { name: 'workflow/status', arguments: { runId: 'run_1' } }` → `kind: 'toolsCall'`, `tool: 'workflow.status'`, `needsRun: true`, `runId: 'run_1'`; `workflow.status` without `runId` → `needsRun: false` (reply refuses); `workflow.runs { impl: 'hello', workflow: 'interactive' }` → `isRuns`; `workflow.list` → `isList`, `aliasesUrl === 'https://h.example/api/workflow/aliases?repository=o/r'` with headers `{ 'x-forwarded-host': 'h.example', host: 'localhost:3000' }`; `workflow.describe { impl: 'hello', workflow: 'interactive' }` → `isDescribe`, `indexUrl`; `workflow.sign { runId: 'r', path: 'workflows/a/b.svg' }` → `isSign`, `signStoragePath === 'o/r/uploads/workflows/a/b.svg'`; `path: '../x'` → `signPath === ''`, `isSign: false`; `resources/read { uri: STEP_VIEW_URI }` → `isStepView`, `isCsp`; `resources/read { uri: 'ui://bffless/hello/islands/pick-line.html' }` → `isIsland`, `impl: 'hello'`, `isCsp`; `resources/list` → `isList`; a notification → `isNotification`, every other flag false; `initialize` → `kind: 'initialize'`; an unknown method → `kind: 'unknown'`; a batch → `kind: 'invalid'`. `plan.test.ts`: aliases `[{alias:'workflow'},{alias:'hello'},{alias:'a'},{alias:'b'},{alias:'c'}]` with `deployment.alias: 'workflow'` → `url1..3` for hello/a/b, `skipped: ['c']`; `impl: 'hello'` → one URL, `has2/has3` false; a failed aliases step (`ok: false`) → no URLs, `aliases: []`; describe with an index whose `workflows[]` has `file: 'interactive.workflow.yaml'` → `yamlUrl` ends `/w/hello/.bffless/workflows/interactive.workflow.yaml`, `hasYaml: true`; `workflow` not in the index → `hasYaml: false`.
- [ ] **Steps 2–3:** implement (pure; `canonicalToolName` from the catalog; the `signPath` confinement copied from `files/sign/post/confine.fn.js` with a comment naming it); tests + lint green; `pnpm --filter workflow mcp:build`; commit `feat(workflow): MCP endpoint route + plan functions — one JSON-RPC message to condition flags and derived URLs`.

### Task 4: `reply.ts` — the read tools, `initialize`, `tools/list`, `resources/list`; `snapshotText` into the catalog

**Files:** Create `src/mcp/rows.ts` (+ test), `src/mcp/reply.ts`, `src/mcp/reply.test.ts`; modify `packages/workflow-agent-tools/src/snapshot.ts` (+ `test/snapshot.test.ts`, `src/index.ts`, `README.md`), `apps/workflow/src/agent/executors.ts` (import `snapshotText` from the package; delete the local copy and `describeWaiting` if it moves with it).

**Interfaces:**

```ts
// packages/workflow-agent-tools/src/snapshot.ts (Decision 12) — verbatim the page's text
/** "Run <id> is <status>[, waiting on <key> (<kind>)[, …]]"; 'No run was started' for `invalid`. */
export function snapshotText(snapshot: RunSnapshot): string

// src/mcp/rows.ts — the same envelope tolerance every harness fn.js carries
export function rows(r: unknown): Record<string, unknown>[]                 // array | {records|data|rows}
export function fieldsOf(r: Record<string, unknown>): Record<string, unknown> // flattened or under `fields`
/** runs/get/shape.fn.js's join, typed: each run row + `waitingOn: string[]` (sorted keys of its waiting step rows). */
export function runsWithWaiting(runRows: unknown, waitingRows: unknown): Array<Record<string, unknown> & { waitingOn: string[] }>

// src/mcp/reply.ts — the pipeline's last function step (`steps.reply`)
export interface Reply { json: string; status: number }
export interface StepOutputs {
  route: Route; plan?: Plan
  identity?: { ok?: boolean; status?: number; body?: unknown }
  run?: unknown; steps?: unknown; runs?: unknown; waiting?: unknown
  aliases?: { ok?: boolean; body?: unknown }
  index?: { ok?: boolean; body?: unknown }; index1?: …; index2?: …; index3?: …
  yaml?: { ok?: boolean; body?: unknown }
  island?: { ok?: boolean; status?: number; body?: unknown }; stepView?: { ok?: boolean; body?: unknown }
  probe?: { url?: string }; signed?: { url?: string }
  merge?: MergeResult; update?: unknown
  pipelinePost?: …; pipelineGet?: …
}
export function handler(data: { request: FnRequest; steps: StepOutputs; deployment?: FnDeployment }): Reply
```

Behaviour (`handler`): `route.kind` `invalid` → `errorResponse(id, INVALID_REQUEST, message)`; `notification` → `{ json: '', status: 202 }` (the 202 response step reads `route.isNotification`; this is belt and braces); `initialize` → Decision 11's result; `ping` → `{}`; not-enabled (Decision 6: `steps.identity.ok !== true`) for every other kind → `errorResponse(id, NOT_ENABLED, …)`; `toolsList` → `{ tools: listedTools() }`; `resourcesList` → `{ resources: [stepView, …islands from index1..3's islands[] as ui://bffless/<impl>/<path>] }` each `{ uri, name, mimeType: RESOURCE_MIME, _meta: uiMeta(appOrigin, originOf(probe.url)) }`; `unknown` → `METHOD_NOT_FOUND`; `toolsCall` → `okResponse(id, callTool(route, steps))` where `callTool` switches on `route.tool`:
- `workflow.list`: `aliases.ok` false → `errorResult('The implementations could not be listed', { errors: { discovery: … } })` (the page's string); else implementations from `index1..3` (`ok` + JSON body with `spec`/`impl`/`workflows` → an implementation; a 404 → skipped silently; a 200 that is not valid JSON → listed with `error`), shaped exactly as `executors.ts:139-154` (`alias, name, version?, preview, error?, workflows: [{ id, file, name, description?, headlessSafe }]`, `id = workflowId(file)` = the file name minus `.workflow.yaml`/`.yaml`), prose identical to `executors.ts:159-170`; `impl` given and nothing found → the page's `errors.impl` refusal; `plan.skipped` non-empty → append `\n(+N more implementations not listed by the prototype endpoint)` to the text and `skipped` to `structuredContent`.
- `workflow.describe`: `index.ok` false → `errorResult(START_REFUSALS.noWorkflow…)` — no: the page's `loadWorkflowDefinition` refusals are `discovery` / `workflow` keyed strings from `lib/autoStart` `START_REFUSALS`; `src/mcp` may not import `lib/autoStart` (fence) — so copy the four strings into `src/mcp/refusals.ts` **with a parity test** that imports `START_REFUSALS` and asserts equality (the fence keeps React-adjacent modules out of the bundle; the test keeps the strings honest). `yaml.ok` false → `fileUnreadable`; `toDefinition(parse(yaml.body))` throwing → `doesNotLint`; else `textResult(text, describeWorkflow({ def, listing, impl, workflow }))` with the same text the page builds (`executors.ts` `describe` — lift its `describeText` into `reply.ts` verbatim, and add it to the parity test with a fixture).
- `workflow.status` / `workflow.outputs`: no `runId` → `errorResult('… runId …', { errors: { runId: 'Pass runId — the MCP endpoint has no current run' } })`; run row missing → `No such run: <id>` (page's string); else `snapshotFromRows(fieldsOf(run), steps.map(fieldsOf))` → `status`: `textResult(snapshotText(s), { ...s })`; `outputs`: the page's `outputs` text and `{ runId, status, outputs }`.
- `workflow.runs`: `impl`/`workflow` missing → `errors.workflow: 'Pass impl and workflow — the MCP endpoint has no current run'`; else `runsWithWaiting(steps.runs, steps.waiting)` filtered by `status?`, sorted `startedAt` desc, capped `limit ?? 50`, shaped and worded as `executors.ts` `runs` (lift the row → `{ runId, status, startedAt, finishedAt, waitingOn }` mapping and the text).
- `workflow.sign`: `route.isSign` false → `errorResult(NOT_CONFINED, { errors: { path: NOT_CONFINED } })` (the sign rule's 400 string, `hostDeps.ts:29`); `signed.url` missing → `errors.path: 'the sign rule returned no url'`; else the page's `Signed <path> for <expiresIn> s` + `{ path, url, expiresIn: 3600 }`.
- `workflow.start|await|cancel|resume`, and (until Task 10) `submitStep`/host tools: Decision 8's error result.
- anything else: `errorResult('No such tool: <name>', { errors: { tool: 'No such tool' } })`.

- [ ] **Step 1: failing tests** — package: `snapshotText` on a running-waiting snapshot and an `invalid` one (strings copied from `executors.ts:84-87` before deleting them there). `rows.test.ts`: the three envelopes; nested `fields`; `runsWithWaiting` joins and sorts keys. `reply.test.ts` with a `steps()` fixture builder: every branch above — at least: initialize version negotiation; not-enabled error when `identity.ok` is false for `tools/list` but not for `initialize`; `tools/list` returns `listedTools()`; `list` with two indexes (one 404) → two/one implementations and the exact page text; `describe` on the `interactive.workflow.yaml` fixture (copy `docs/spec/examples/…` or vendor hello's YAML into `src/mcp/fixtures/`) → `structuredContent.jobs.map(id)` = `['greet','analyze','pick','card','review']`; `status` on a fixture run row + a waiting island row → `waitingOn[0].src === 'islands/pick-line.html'` and the snapshot text; `runs` filter/sort/limit; `sign` confined/refused; `start` → `errors.tool`; unknown tool; unknown method → -32601; notification → 202/''.
- [ ] **Steps 2–4:** implement; package `lint && build && test:run`; app `mcp:build`, `workflow:lint && workflow:test` (the `agent/*` suites still green with the import swap); commit `feat(workflow): MCP endpoint reply — initialize, tools/list, resources/list, and the read tools over the run rows; snapshotText joins the catalog`.

### Task 5: the rules — `mcp/post/rule.yaml`, `mcp/get/rule.yaml`

**Files:** Create `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/mcp/post/rule.yaml`, `…/mcp/get/rule.yaml`; the four `*.fn.js` are already generated beside `rule.yaml` (Task 1/3/4); modify `apps/workflow/CONTEXT.md` (glossary).

```yaml
# rules/api/workflow/mcp/post/rule.yaml
targetUrl: pipeline
order: 30
pipeline:
  name: MCP endpoint
  description: "POST /api/workflow/mcp — the harness's MCP server as ONE rule (spec 10, D22): stateless Streamable HTTP, one JSON-RPC message in, one JSON body out. The function steps are esbuild bundles of src/mcp/*.ts (the catalog + the app's pure adapters), so tools/list IS the catalog and the fence IS island.ts. Authless prototype (D23 rung 1): inert unless the WORKFLOW_MCP_KEY project secret holds a service identity."
  steps:
    - id: route
      name: route
      handler: function_handler
      code: ./route.fn.js
    # Decision 6: the service identity, probed through the harness's own whoami. Not ok ⇒ every method but initialize answers -32000.
    - id: identity
      name: identity
      handler: http_request
      config:
        url: steps.route.whoamiUrl
        method: GET
        headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }
        failOnError: false
        timeout: 10000
    # --- run-scoped reads (status / outputs / sign / and Story 6's writes): the same rows run/get reads
    - id: run
      name: run
      handler: data_query
      config:
        condition: steps.route.needsRun
        schemaId: $schema:workflow_runs
        limit: 1
        filters:
          runId: { op: eq, value: steps.route.runId }
    - id: steps
      name: steps
      handler: data_query
      config:
        condition: steps.route.needsRun
        schemaId: $schema:workflow_run_steps
        limit: 1000
        filters:
          runId: { op: eq, value: steps.route.runId }
    # --- runs: the same two queries runs/get runs
    - id: runs
      name: runs
      handler: data_query
      config:
        condition: steps.route.isRuns
        schemaId: $schema:workflow_runs
        limit: 50
        filters:
          impl: { op: eq, value: steps.route.impl }
          workflow: { op: eq, value: steps.route.workflow }
    - id: waiting
      name: waiting
      handler: data_query
      config:
        condition: steps.route.isRuns
        schemaId: $schema:workflow_run_steps
        limit: 1000
        filters:
          status: { op: eq, value: waiting }
    # --- discovery (list / describe / resources): only a route serves these
    - id: aliases
      name: aliases
      handler: http_request
      config:
        condition: steps.route.isList
        url: steps.route.aliasesUrl
        method: GET
        headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }
        failOnError: false
    - id: index
      name: index
      handler: http_request
      config:
        condition: steps.route.isDescribe
        url: steps.route.indexUrl
        method: GET
        headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }
        failOnError: false
    - id: plan
      name: plan
      handler: function_handler
      code: ./plan.fn.js
    - id: index1
      name: index1
      handler: http_request
      config: { condition: steps.plan.has1, url: steps.plan.url1, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    - id: index2
      name: index2
      handler: http_request
      config: { condition: steps.plan.has2, url: steps.plan.url2, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    - id: index3
      name: index3
      handler: http_request
      config: { condition: steps.plan.has3, url: steps.plan.url3, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    - id: yaml
      name: yaml
      handler: http_request
      config: { condition: steps.plan.hasYaml, url: steps.plan.yamlUrl, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    # --- files: the same signed_url the files/sign rule mints (Decision 6 of 04); the probe answers only "where is storage" (Decision 9 here)
    - id: signed
      name: signed
      handler: signed_url
      config:
        condition: steps.route.isSign
        path: steps.route.signStoragePath
        expiresIn: 3600
    - id: probe
      name: probe
      handler: signed_url
      config:
        condition: steps.route.isCsp
        path: steps.route.probePath
        expiresIn: 60
    # --- Story 6 adds: island (http_request /w/<impl>/<src>), stepView (http_request /step.html), pipelinePost/pipelineGet, merge (function) + update (data_update)
    - id: merge
      name: merge
      handler: function_handler
      code: ./merge.fn.js
    - id: reply
      name: reply
      handler: function_handler
      code: ./reply.fn.js
    - id: accepted
      name: accepted
      handler: response_handler
      config:
        condition: steps.route.isNotification
        body: ''
        status: 202
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: "{{{steps.reply.json}}}"
        status: 200
        headers: { Cache-Control: no-store }
        contentType: application/json
description: "The MCP endpoint (spec 10, D22): stateless Streamable HTTP over one rule. No auth validator on purpose — auth ladder rung 1 (D23) is an authless prototype on a scratch public project; Phase 3 puts app tokens + requiredScopes in front. no-store: every answer is per-message."
```

```yaml
# rules/api/workflow/mcp/get/rule.yaml
targetUrl: pipeline
order: 31
pipeline:
  name: MCP endpoint (GET)
  description: "The stateless Streamable-HTTP profile: GET carries no SSE stream here, so it is 405 with Allow: POST (spec 10). Without this rule an unmatched GET falls through to the SPA's index.html."
  steps:
    - id: respond
      name: respond
      handler: response_handler
      config:
        body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Method Not Allowed: this MCP endpoint is stateless — POST one JSON-RPC message"}}'
        status: 405
        headers: { Allow: POST, Cache-Control: no-store }
        contentType: application/json
description: "405 for GET on the MCP endpoint (stateless profile, no SSE)."
```

`merge`'s placeholder handler returns `{ update: false }` until Task 10.

- [ ] **Step 1:** write both manifests; `pnpm --filter workflow mcp:build` (no-op if fresh); run the rule-set compiler dry: `node /home/rico/bffless/repos/ce/packages/cli/dist/index.js rules build --path apps/workflow/.bffless/proxy-rules/workflow --out /tmp/…` (or `rules validate`) → the set compiles with 22 rules; `pnpm apps:check` green.
- [ ] **Step 2: CONTEXT.md** glossary — *MCP endpoint*: "`POST /api/workflow/mcp`, the harness's MCP server as one rule (spec 10, D22); its functions are built from `src/mcp/`." *Service identity*: "the `WORKFLOW_MCP_KEY` project secret the endpoint's sibling calls carry (auth rung 1); absent ⇒ the endpoint answers not-enabled." *Step view*: "`ui://bffless/workflow/step.html` — the engine-less host page that mounts a waiting island inside an agent host (Decision 3 of the Phase 2 plan)."
- [ ] **Step 3: commit** `feat(workflow): the MCP endpoint rule — POST /api/workflow/mcp as a function_handler pipeline, GET → 405`.

### Task 6: the scratch project — provision, deploy, document

**Files:** Modify `apps/workflow/bffless/README.md` (new section "Scratch: MCP Apps prototype (`bffless/workflow-mcp`)"). No source changes. Credentials never enter the repo; the scratch key lives in `~/.config/bffless/workflow-mcp.env` (`BFFLESS_API_KEY=…`, mode 600) beside `workflow-ci.env`.

Sequence (each step is a real call; record ids in the README):

1. `mcp__j5s-dev__create_project { owner: 'bffless', name: 'workflow-mcp', displayName: 'Workflow — MCP Apps scratch (apps#554 Phase 2)', description: 'SCRATCH. Authless MCP endpoint prototype for the Workflow harness (spec 10, D23 rung 1). Public on purpose. Safe to delete after Phase 2.', isPublic: true }` → `projectId`.
2. `mcp__j5s-dev__create_api_key { name: 'workflow-mcp scratch (service identity + deploys)', repository: 'bffless/workflow-mcp' }` → the raw key → `~/.config/bffless/workflow-mcp.env`; `mcp__j5s-dev__set_secret { projectId, name: 'WORKFLOW_MCP_KEY', value: <key> }`.
3. Harness rule set: from the story worktree, `set -a; source ~/.config/bffless/workflow-mcp.env; set +a; node /home/rico/bffless/repos/ce/packages/cli/dist/index.js rules push --path apps/workflow/.bffless/proxy-rules/workflow --project bffless/workflow-mcp --api-url https://admin.j5s.dev --prune` → creates set `workflow` (22 rules, 3 schemas); note `missingSecrets` is empty because step 2 ran first.
4. Harness build + deploy: `pnpm --filter workflow stage && pnpm --filter workflow build` (`VITE_BFFLESS_PROJECT` unset — runtime discovery reads the serving project, apps#363); `cd apps/workflow && rm -f /tmp/wf.zip && zip -qr /tmp/wf.zip dist`; `curl -sS -X POST https://admin.j5s.dev/api/deployments/zip -H "X-API-Key: $BFFLESS_API_KEY" -F file=@/tmp/wf.zip -F repository=bffless/workflow-mcp -F commitSha=$(git rev-parse HEAD) -F branch=$(git branch --show-current) -F isPublic=true -F alias=workflow -F proxyRuleSetNames=workflow` → `deploymentId`.
5. Domain (admin): `mcp__j5s-dev__create_domain { domain: 'workflow-mcp.j5s.dev', domainType: 'subdomain', projectId, alias: 'workflow', path: '/dist' }` then, if the tool exposes it, `update_domain { isSpa: true }` — the harness is a SPA (`bffless-app.json` `isSpa: true`); the `workflow.j5s.dev` mapping (`7276258f…`) is the model.
6. `hello` (the way `publish-workflow@v1` does it, 06): hello's `dist/` is `apps/workflow/hello-dist` after `stage`; `mkdir -p /tmp/hello && rm -rf /tmp/hello/dist && cp -r apps/workflow/hello-dist /tmp/hello/dist && (cd /tmp/hello && zip -qr /tmp/hello.zip dist)` (the same `dist/` root the harness zip has, so both aliases serve from `/dist`) then `curl … -F repository=bffless/workflow-mcp -F alias=hello -F isPublic=true -F commitSha=$(cat ../hello.ref) -F branch=main`. Rule set: copy `hello-src/workflows/hello/.bffless/proxy-rules/hello` to a temp dir, add `rules/_custom/forward/get.rule.yaml` with `pathPattern: /w/hello/*`, `targetUrl: http://localhost:3000/public/bffless/workflow-mcp/alias/hello/dist`, `stripPrefix: true`, `forwardCookies: true`, `order: 5`, then `rules push --path <tmp> --project bffless/workflow-mcp --path-prefix /api/hello --prune`. Attach: `mcp__j5s-dev__list_proxy_rule_sets { projectId }` → ids; `mcp__j5s-dev__update_alias { repository: 'bffless/workflow-mcp', alias: 'workflow', proxyRuleSetIds: [<workflow>, <hello>] }` and `{ alias: 'hello', proxyRuleSetIds: [<hello>] }`.
7. Response-header rule (the islands one `bffless/workflow` carries, `07a1ce16…`): `mcp__j5s-dev__create_response_header_rule { projectId, pathPattern: '**/islands/*.html', customHeaders: { 'Cache-Control': 'no-transform, no-cache' }, name: 'Islands: no Cloudflare script injection' }`.
8. Smoke: `curl -s https://workflow-mcp.j5s.dev/api/workflow/project` → `{"repository":"bffless/workflow-mcp"}` (public: no auth needed? — the rule is `auth_required allowApiKey` → 401 anonymous; with `-H "X-API-Key: $BFFLESS_API_KEY"` → 200); `curl -s https://workflow-mcp.j5s.dev/w/hello/.bffless/workflows/index.json | jq .impl` → `"hello"`; `curl -s -X POST https://workflow-mcp.j5s.dev/api/workflow/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'` → the initialize result; `… -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools | length'` → 15; `curl -si https://workflow-mcp.j5s.dev/api/workflow/mcp | head -1` → 405.
9. Sign in once through the browser path so the harness has a member: the `mcp` walk's park step (Task 12) does this with `WORKFLOW_CI_EMAIL/PASSWORD` — the j5s member; verify now with `pnpm workflow-live:walk page-tools --harness https://workflow-mcp.j5s.dev` (expect green: it is the epic build).

- [ ] **Step 1:** run 1–8, pasting each answer's id into the README section as you go (project id, key id — never the key —, domain id, rule-set ids, deployment ids). If step 8's `initialize` answers `-32000` not-enabled, debug `identity` with `mcp__j5s-dev__enable_pipeline_debug` + `get_pipeline_log` (the spike's first data point for Task 8: which URL form the backend can reach — `https://<host>` hairpin, or `http://localhost:3000` + `x-forwarded-host` — and what `request.headers` carries). If the hairpin fails, `route.ts` switches `whoamiUrl`/`aliasesUrl`/… to `http://localhost:3000` with `headers: { x-forwarded-host: steps.route.host }` on every sibling `http_request`; record which form shipped.
- [ ] **Step 2:** README section with the sequence above, the ids, the redeploy one-liners (rules: step 3; harness: step 4; hello: step 6), and the teardown note ("`delete_project <id>` — irreversible, ask first").
- [ ] **Step 3: commit** `docs(workflow): the bffless/workflow-mcp scratch project — provisioning and redeploy sequence for the Phase 2 prototype`.

### Task 7: the `mcp` walk (reads)

**Files:** Create `packages/workflow-live/src/mcp-client.ts`, `src/walks/mcp.ts`; modify `src/walks/index.ts` (`WALKS.mcp`), `src/args.ts` (USAGE list), `package.json` (`"@modelcontextprotocol/sdk": "^1.30.0"`), `README.md` (walk table + example), `.claude/agents/apps-live-walk.md` (walk list + a spec-10 pointer for `mcp`), `src/walks/mcp.test.ts` (the pure helpers: `toolParity`, `cspOf`).

**Interfaces:**

```ts
// src/mcp-client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
export async function openMcp(base: string): Promise<{ client: Client; url: string; close(): Promise<void> }>
  // url = `${base}/api/workflow/mcp`; new Client({ name: 'workflow-live', version: '0' }); transport = new StreamableHTTPClientTransport(new URL(url)); await client.connect(transport)

// src/walks/mcp.ts (checks — names cite what they prove; keep stable once shipped)
//  D22.getIs405            fetch(url) → status 405, Allow: POST
//  D22.initialize          client.getServerVersion().name === 'bffless-workflow'; protocolVersion negotiated
//  D19.toolsListParity     the first 11 of tools/list deep-equal CATALOG's { name, description, inputSchema, annotations } (JSON.stringify both, sorted keys)
//  spec10.appOnlyHidden    exactly 4 tools carry _meta.ui.visibility ['app']; workflow.submitStep carries _meta.ui.resourceUri 'ui://bffless/workflow/step.html'
//  D19.listsHello          workflow.list → hello/interactive with headlessSafe boolean (same assertion as page-tools)
//  D20.describeInteractive workflow.describe → jobs greet/analyze/pick/card/review; choose is island headless auto (same as page-tools)
//  spec10.runsRequiresImpl workflow.runs {} → isError with errors.workflow; workflow.runs { impl:'hello', workflow:'interactive' } → ok, array
//  spec10.statusRequiresRunId  workflow.status {} → errors.runId; workflow.status { runId: <newest from runs, or --run> } → snapshot with steps map
//  spec10.outputsOfRun     workflow.outputs { runId } → { runId, status, outputs }
//  D6.signIsPresigned      workflow.sign { runId, path: 'workflows/hello/interactive/runs/<runId>/x.svg' } → url with an https origin, expiresIn 3600; path '../x' → errors.path
//  spec10.notServedHonest  workflow.start → isError errors.tool naming Phase 4
//  spec10.resourcesList    resources/list → includes ui://bffless/workflow/step.html and ui://bffless/hello/islands/pick-line.html, each mimeType text/html;profile=mcp-app with _meta.ui.csp.connectDomains = [harness origin, <storage origin>] (two https origins, the first === --harness)
//  D22.unknownMethod       raw POST { method: 'prompts/list' } → error.code -32601 (the SDK throws; use fetch)
```
Thirteen checks.

- [ ] **Step 1: failing tests** — `mcp.test.ts`: `toolParity(listed, CATALOG)` returns `[]` for identical and names the first differing field otherwise; `cspOf(resource)` extracts the two arrays. Run → fails.
- [ ] **Step 2:** implement client + walk (`report.expect` per check, evidence = the `brief()` of each result as `page-tools` does; `--run` optional for a known run id, else the newest from `runs`); `pnpm --filter @bffless/workflow-live lint && build && test:run`.
- [ ] **Step 3: live** — `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp` → exit 0, 13/13. Paste `report.md` into the PR.
- [ ] **Step 4: commit** `feat(workflow-live): the mcp walk — Streamable HTTP against the endpoint (parity, reads, resources/list, 405)`.

### Task 8: the spike's three answers → #554; the Story 5 PR

- [ ] **(a) Can a `function_handler` execute sibling rules?** Answer from source + the live probe: **no, not the function** — CE's sandbox (`function-runner.service.ts:240-300`) has no `fetch`, and `data` is frozen; **yes, the pipeline** — `http_request` steps (`http-request.handler.ts`) call sibling rules at a URL a function derived (`url: steps.route.…`, headers from `secrets.*`), so a function *plans* and the pipeline *executes*, with the static step list as the limit (fan-out cap 3, one branch per verb; no loops) — the shape story 8's generic `mcp_handler` replaces. Evidence: the `identity` step's log (`get_pipeline_log`) and `D19.listsHello` green; note which URL form worked (hairpin vs localhost + `x-forwarded-host`).
- [ ] **(b) Does `X-API-Key` alone pass the deployment visibility gate?** Probe the **private** harness: `curl -si -H "X-API-Key: $WORKFLOW_DEPLOY_KEY" https://workflow.j5s.dev/api/workflow/whoami` (the `bffless/workflow` deploy key from `~/.config/bffless/workflow-ci.env`'s neighbour — if no key for that project is on disk, mint one with `create_api_key { repository: 'bffless/workflow' }`, use it once, `delete_api_key`). From source the expectation is: `OptionalAuthGuard` *does* authenticate `x-api-key` (`optional-auth.guard.ts:52-57`), then `public.controller.ts:234-262` asks `getUserProjectRole(user.id, project.id)` — a project-scoped key's `user` is the key's owner, so a member's key should pass with 200, and a key whose user is not a member 403s. Record the observed status and body. Also record the anonymous control (`302` to login, as on 2026-09-02).
- [ ] **(c) Does claude.ai's custom-connector flow accept the authless endpoint?** What this session can do: the official SDK client completes `initialize` + `tools/list` (Task 7) — the same transport claude.ai uses. What only a person can do: *Settings → Connectors → Add custom connector → URL `https://workflow-mcp.j5s.dev/api/workflow/mcp`, no auth* → the connector lists 11 tools. Post the request on #554 and in the PR body as the one manual step; the answer is confirmed in Task 13 (screenshots). Do not claim (c) is settled until then.
- [ ] Comment on #554 under the heading **"Story 5 — spike findings (2026-09-0x)"** with (a)/(b)/(c), the scratch project block (name, host, ids, teardown note), the prototype's recorded narrowings (Decisions 5, 7, 8: fan-out cap; `await`/`start`/`cancel`/`resume` not served; forms and `summary` not written), and the walk report.
- [ ] **PR** `feat(workflow): MCP endpoint prototype — POST /api/workflow/mcp as a harness rule (initialize, tools/list, read tools, resources/list)` into `epic/agent-embedding`. Body: checklist §1 note (workflow: lint/test gates only; the two new rules go live on `bffless/workflow` only when the epic lands on main, and are inert there without the secret — Decision 6); §6 blast radius: `workflow-agent-tools` gains `snapshotText` (consumers: `apps/workflow` — built in-repo); real counts from every verify command; the walk report. Merge on green; tick story 5 on #554.

# Phase B — Story 6: islands in claude.ai (Tasks 9–13)

*Deliverable: `resources/read` serves islands and the step view with derived CSP; `workflow.submitStep` opens the step view in claude.ai, the hello `pick-line` island renders inside it unchanged, a click round-trips `workflow.submit` to the endpoint and the step row reads `succeeded`; the walk proves the server half, screenshots on the PR prove the host half. Branch `feat/m5-mcp-islands`, worktree `.claude/worktrees/m5-mcp-islands`, based on the epic after Story 5 merged.*

### Task 9: the step view — a second single-file entry hosting `IslandHost`

**Files:** Create `apps/workflow/step/index.html`, `src/step-view/main.ts`, `src/step-view/deps.ts`, `src/step-view/deps.test.ts`, `vite.step.config.ts`; modify `apps/workflow/package.json` (`"build": "tsc -b && vite build && vite build -c vite.step.config.ts"`, devDependency `"vite-plugin-singlefile": "^2.3.3"`), `src/islands/IslandHost.ts` (Decision 13; + `IslandHost.test.ts` case), `tsconfig` includes if `step/` needs it.

**Interfaces:**

```ts
// src/islands/IslandHost.ts — widened (Decision 13); oncalltool `await`s both
onSubmit: (outputs: unknown) => SubmitAnswer | Promise<SubmitAnswer>      // SubmitAnswer = { ok: true } | { ok: false; errors: Record<string, string> }
onAnnotate: (args: unknown) => AnnotateAnswer | Promise<AnnotateAnswer>   // { ok: true } | { ok: false; error: string }

// src/step-view/deps.ts — pure: the outer bridge → IslandHostDeps
import type { App } from '@modelcontextprotocol/ext-apps'
export interface StepViewData { runId: string; step: string; impl: string; workflow: string; kind: string; status: string; src: string; arguments: Record<string, unknown>; outputs?: Record<string, unknown>; html: string }
export type ServerCall = App['callServerTool']   // (params: { name, arguments }) => Promise<CallToolResult>
/** The stepView result (Task 11) validated into StepViewData; throws with the result's text on isError. */
export function readStepView(result: CallToolResult): StepViewData
/** IslandHostDeps for one waiting step: every capability rides `call` (Decision 4). `http` maps `/api/<impl>/<path>` → workflow.pipeline { runId, step, name: path, arguments, method }; `fetchText` answers `resolveSrc(impl, src)` with `view.html` and anything else with `{ ok: false, status: 404 }`; `onSubmit` → workflow.submit → `{ ok }` / `{ ok: false, errors: structuredContent.errors }`; `onAnnotate` → workflow.annotate; `sign` → workflow.sign { runId, path }. */
export function stepViewDeps(call: ServerCall, view: StepViewData, hooks: { onLog(line: string): void; onSubmitted(): void }): IslandHostDeps
```

`main.ts`: `const app = new App({ name: 'bffless-workflow-step', version: HOST_INFO.version })`; render a header (`<h1 data-testid="title">`), a status line (`data-testid="status"`), the `<iframe data-testid="island" sandbox="allow-scripts">`, a banner (`data-testid="submitted"`, hidden). `app.ontoolinput = async ({ arguments: a })` → `readStepView(await app.callServerTool({ name: 'workflow.stepView', arguments: { runId: a.runId, step: a.step } }))` → `createIslandHost(stepViewDeps(app.callServerTool.bind(app), view, hooks)).mount(iframe, { impl, src, arguments: view.arguments, headless: false, signal })`; a `ResizeObserver` on `document.body` → `app.sendSizeChanged({ height })`; errors → the status line. `onSubmitted` → banner "Submitted <step>. Open the run on the harness and Resume to continue." `app.ontoolresult` ignored (the result is for the model). Register handlers before `await app.connect()`.

`vite.step.config.ts`: `root: 'step'`, `plugins: [viteSingleFile(), rename index.html → step.html]`, `build: { outDir: '../dist', emptyOutDir: false, target: 'es2022', modulePreload: false }` — the pattern from hello's `vite.islands.config.ts` (one entry per config because singlefile forbids multiple inputs).

- [ ] **Step 1: failing tests** — `IslandHost.test.ts`: an `onSubmit` returning a Promise resolves the island's `workflow.submit` call with `content[0].text === 'ok'` (existing sync case still green). `deps.test.ts` with a recording fake `call`: `http('/api/hello/echo', { method: 'POST', body: { text: 'x' } })` → one `workflow.pipeline` call `{ runId, step, name: 'echo', arguments: { text: 'x' }, method: 'POST' }` and the result's `structuredContent` becomes `res.body`; an `isError` pipeline answer becomes `{ ok: false, status: _meta.bffless.status ?? 500, body }`; `fetchText('/w/hello/islands/pick-line.html')` → `{ ok: true, text: view.html }`; `fetchText('/w/hello/other.html')` → `{ ok: false, status: 404 }`; `onSubmit({ line: 'x' })` → `workflow.submit { runId, step, outputs }` → `{ ok: true }` and `onSubmitted` fired; an error result → `{ ok: false, errors }`; `sign('workflows/a')` → `workflow.sign { runId, path }` → `{ url, expiresIn }`; `readStepView` throws on `isError`.
- [ ] **Step 2:** implement; `pnpm --filter workflow build` emits `dist/step.html` (single file, `<script>` inline, no `src=` — assert with `grep -c 'src="' dist/step.html` → 0 besides the iframe); `workflow:lint && workflow:test` green.
- [ ] **Step 3: commit** `feat(workflow): the step view — a single-file ui:// host page that mounts a waiting island under IslandHost inside an agent host`.

### Task 10: `merge.ts` — server-side `workflow.submit` / `submitStep` / `annotate`

**Files:** Create `src/mcp/merge.ts`, `src/mcp/merge.test.ts`; modify `src/mcp/route.ts` (+tests: `isWrite`, `key`, `args.outputs|values`), `src/mcp/reply.ts` (+tests), `rule.yaml` (the `update` step).

**Interfaces:**

```ts
// src/mcp/merge.ts — after `run`/`steps`, before `reply` (`steps.merge`)
export interface MergeResult {
  update: boolean                        // condition for the data_update step
  recordId: string | null
  fields?: Record<string, unknown>       // the full row column set (run-step's list), merged
  result: CallToolResult                 // what reply answers for submit/annotate — the refusal, or the ok
  key: string
}
export function handler(data: { request: FnRequest; steps: { route: Route; run?: unknown; steps?: unknown } }): MergeResult
```

Rules, in order, each a keyed refusal (`update: false`): no run row → `errors.runId: 'No such run: <id>'`; `run.status !== 'running'` → `errors.runId: 'Run <id> is <status>; only a running run takes a submit'`; lease held (`leaseOwner` non-empty and `leaseUntil > Date.now()`) → `errors.lease: 'A harness tab still drives this run (lease until <iso>) — close it or wait for the lease to lapse'`; no step row for `key` → `errors.step: 'No such step: <key>'`; `kind === 'form'` → `errors.step: 'form steps are not served over the MCP endpoint yet — complete it on the harness'`; `status !== 'waiting'` → `errors.step: '<key> is <status>, not waiting'`. Then for **submit** (`workflow.submit`, or `workflow.submitStep` whose `values` is present): `def = toDefinition(run.definition)`; `step = def.jobs[row.job].steps.find(s => s.id === row.step)`; `{ outputs, errors } = validateDeclared(outputDecls(step), args.outputs ?? args.values, { defaultType: 'json' })` (the page's `completeIslandStep` path, `adapters/island.ts`); errors → `errorResult(JSON.stringify(errors) /* IslandHost's wording */, { errors })`; ok → `fields = { ...rowFields, status: 'succeeded', outputs, finishedAt: Date.now() }`, `result = textResult('Submitted <key>; <snapshotText(snapshot after the write)>', { runId, step: key, snapshot })` — the snapshot recomputed from the rows with this row patched. For **annotate**: `annotateEvent(key, args, Date.now(), existing = row.annotations ?? [])` → `{ error }` → `errorResult(error, { errors: { annotations: error } })`; else `fields.annotations = [...existing, ...event.annotations]`, `fields.summary = event.summary ?? row.summary`, `result = textResult('ok')` (the page answers islands `ok`). For `workflow.submitStep` with **no** values on a waiting island: `update: false`, `result = textResult('<snapshotText>; pick in the panel below to complete <key>', { ...snapshot, step: key })` — the host renders the step view; on a waiting **form** the Decision-7 refusal.

`rule.yaml` gains, after `merge`:

```yaml
    - id: update
      name: update
      handler: data_update
      config:
        condition: steps.merge.update
        schemaId: $schema:workflow_run_steps
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
          log: steps.merge.fields.log
          logId: steps.merge.fields.logId
          startedAt: steps.merge.fields.startedAt
          finishedAt: steps.merge.fields.finishedAt
          heartbeatAt: steps.merge.fields.heartbeatAt
```

`reply.ts`: `workflow.submit` / `workflow.annotate` / `workflow.submitStep` → `steps.merge.result` (and if `merge.update` was true but `steps.update` is missing/errored, `errorResult('The step row could not be written', { errors: { step: … } })`).

- [ ] **Step 1: failing tests** — `merge.test.ts` with fixtures (a running run row with `definition` = hello's raw interactive YAML data via `parse(fixture)`, a waiting island row `pick/0/choose` with `inputs: { lines: [...] }`): every refusal above; a good submit → `update: true`, `fields.status === 'succeeded'`, `fields.outputs` deep-equals `{ line: 'Hello, world!', index: 0 }`, `fields.finishedAt` a number, and the result text starts `Submitted pick/0/choose; Run run_x is running`; a bad submit (`{}`) → `errors.line === 'This field is required'`, `update: false`; annotate over budget → refusal; annotate ok → `fields.annotations.length === existing + 1`; `submitStep` without values on the island → `update: false` and a non-error result whose text mentions the panel.
- [ ] **Steps 2–3:** implement; `mcp:build`; tests + lint; redeploy the rule set to scratch (README step 3); `curl` a `workflow.submit` against a run parked by hand (`page-tools` walk leaves none parked — use Task 12's park step early, or the harness page in headless Chromium with the relay login) → the row flips; commit `feat(workflow): server-side workflow.submit / annotate / submitStep over the MCP endpoint — the page's validators, the run-step write, a lease guard`.

### Task 11: `resources/read`, `workflow.stepView`, `workflow.pipeline`

**Files:** Modify `src/mcp/route.ts` (+tests: `isIsland`, `isStepView`, `islandUrl` from the run row is not knowable in `route` — see below), `src/mcp/plan.ts` (+tests: `islandUrl`, `hasIsland`, `pipelineUrl`, `pipelineBody`, `isPipelinePost/Get`), `src/mcp/reply.ts` (+tests), `rule.yaml` (steps `island`, `stepView`, `pipelinePost`, `pipelineGet`).

`plan.ts` runs after `run`/`steps`, so it is the function that can see the run row: for `workflow.stepView { runId, step }` it finds the waiting row, reads the step's `with.src` from `run.definition` (`declaredStep` as `snapshotFromRows` does), fences it with `resolveSrc(run.impl, src)` (throws → `hasIsland: false`, `islandError`), and emits `islandUrl = appOrigin + url`. For `resources/read ui://bffless/<impl>/<rest>`, `route` already has `impl`/`rest`; `plan` applies `resolveSrc(impl, rest)` the same way (`IslandHost.ts` `onreadresource` is the model). For `workflow.pipeline { runId, step, name, arguments, method }`: `resolveToolName(run.impl, name, { bffless: { method } })` → `pipeline` kind → `pipelineUrl = appOrigin + target.url`, `isPipelinePost`/`isPipelineGet`, `pipelineBody = arguments` (POST) / `pipelineQuery` (GET: `route` builds the query string onto the URL — `http_request` has no query config); `host`/`rejected` → `pipelineError` (reply → tool error with the reason, exactly `IslandHost`'s `toolError(target.reason)`).

`rule.yaml` additions (after `plan`):

```yaml
    - id: island
      name: island
      handler: http_request
      config: { condition: steps.plan.hasIsland, url: steps.plan.islandUrl, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    - id: stepView
      name: stepView
      handler: http_request
      config: { condition: steps.route.isStepView, url: steps.route.stepViewUrl, method: GET, failOnError: false }
    - id: pipelinePost
      name: pipelinePost
      handler: http_request
      config: { condition: steps.plan.isPipelinePost, url: steps.plan.pipelineUrl, method: POST, body: steps.plan.pipelineBody, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
    - id: pipelineGet
      name: pipelineGet
      handler: http_request
      config: { condition: steps.plan.isPipelineGet, url: steps.plan.pipelineUrl, method: GET, headers: { x-api-key: secrets.WORKFLOW_MCP_KEY }, failOnError: false }
```

`reply.ts`: `resourcesRead` → `{ contents: [{ uri, mimeType: RESOURCE_MIME, text: (island|stepView).body, _meta: uiMeta(appOrigin, originOf(probe.url)) }] }`, or JSON-RPC error `-32002 'Resource not found: <uri>'` when the fetch was not ok / the uri is outside `ui://bffless/`; `workflow.stepView` → `textResult('<key> (island) is waiting — <n> arguments', { runId, step, impl, workflow, kind, status, src, arguments: row.inputs, outputs: declared, html })` or the same refusals as `merge`; `workflow.pipeline` → the body → `{ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: structured(body) }` and non-2xx → `IslandHost`'s `httpToolError` shape (`<code>: <message>`, `_meta.bffless.status`) — lift `structured()`/`httpToolError()`'s logic verbatim into `src/mcp/toolResults.ts` with a parity test against a fixture (they are private in `IslandHost.ts`; do not export them — the fence forbids importing the host beyond `HOST_INFO`).

- [ ] **Step 1: failing tests** — `plan.test.ts`: stepView on the fixture run → `islandUrl` ends `/w/hello/islands/pick-line.html`; a definition with `src: '../x.html'` → `hasIsland: false`; `resources/read ui://bffless/hello/islands/pick-line.html` → the same URL; `ui://bffless/other/x.html` on a run of `hello` → still resolved by `impl` from the uri (resources are not run-scoped) — but `workflow.pipeline` with `name: '../workflow/run'` → `pipelineError` "resolves outside /api/hello/"; `name: 'echo'` → POST URL `https://h/api/hello/echo`; `_meta`-less `method: 'GET'` → GET URL with the query string. `reply.test.ts`: `resources/read` of both kinds → `mimeType`, `_meta.ui.csp.connectDomains` `['https://h', 'https://storage.googleapis.com']` given a probe url; a failed island fetch → -32002; `workflow.pipeline` 200/JSON, 200/text (`{ text }`), 500 → `HTTP_500: …` with `_meta.bffless.status`.
- [ ] **Steps 2–3:** implement; `mcp:build`; tests + lint; redeploy scratch (rules + harness, since `dist/step.html` is new); `curl` `resources/read` for the island → the HTML and CSP; commit `feat(workflow): ui:// resources — islands and the step view over resources/read with a derived CSP; workflow.stepView and the fenced workflow.pipeline`.

### Task 12: the walk, round trip

**Files:** Modify `packages/workflow-live/src/walks/mcp.ts` (+ README row, `apps-live-walk.md`), `src/walks/mcp.test.ts` if a helper grows.

Added checks (after Task 7's thirteen; `--run <id>` skips the park and uses that run; `--park-only` parks, prints the run id, and exits 0 before any submit — the way Task 13 hands a fresh run to the person; both flags in `args.ts` + USAGE):
```
spec10.parkIsland      page-tools style: openSession (relay login), waitForPageTools, workflow.start hello/interactive { greeting: 'Hello', names: ['world','studio'] }, workflow.await { until: 'waiting' } → waitingOn[0].key 'pick/0/choose'; record runId; s.close() (the driver goes away)
spec10.leaseLapses     poll workflow.status via MCP until a workflow.submit probe with {} is refused by errors.line (not errors.lease) — i.e. the lease lapsed (≤ 75 s); evidence: the seconds waited
spec10.resourcesReadIsland   resources/read ui://bffless/hello/islands/pick-line.html → text contains 'pick-line' and '<script', mimeType text/html;profile=mcp-app
spec10.cspDerived      its _meta.ui.csp.connectDomains[0] === new URL(args.harness).origin and [1] is the origin of the workflow.sign URL from D6.signIsPresigned
spec10.stepViewMounts  workflow.stepView { runId, step } → html contains 'bffless-workflow-step', arguments.lines is a 2-item array, outputs has line/index
spec10.pipelineFenced  workflow.pipeline { runId, step, name: 'echo', arguments: { text: 'hi', upper: true } } → structuredContent.text 'HI'; name '../workflow/run' → isError 'resolves outside'
spec10.annotateWrites  workflow.annotate { runId, step, annotations: [{ level: 'notice', message: 'from the mcp walk' }] } → 'ok'
spec10.submitRefusesBad   workflow.submit { runId, step, outputs: {} } → isError errors.line 'This field is required'
spec10.submitWrites    workflow.submit { runId, step, outputs: { line: 'Hello, world!', index: 0 } } → text starts 'Submitted pick/0/choose'
record.stepSucceeded   GET /api/workflow/run?id=<runId> (pageApi with the walk's session, or X-API-Key from ADMIN_API_KEY) → the pick/0/choose row: status 'succeeded', outputs.line 'Hello, world!', annotations includes the walk's; run.status still 'running' (no driver sealed it — Decision 7)
spec10.submitTwiceRefused  the same submit again → isError errors.step "pick/0/choose is succeeded, not waiting"
```

- [ ] **Step 1:** implement; `lint && build && test:run`; live: `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp-6` → 24/24. The parked run is left `running` on scratch as history (like every walk's); note its id in the PR.
- [ ] **Step 2: commit** `feat(workflow-live): the mcp walk round-trips an island — park, lease lapse, stepView, pipeline, annotate, submit, record`.

### Task 13: claude.ai — the manual gate, with screenshots

The person's checklist (post it in the PR body and on #554; the session cannot open claude.ai):

1. Park a fresh run for the demo (this session does it and posts the id): `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --park-only --out /tmp/park` → prints the run id. The run id is what the person quotes to Claude. Wait a minute after it exits (the lease lapses).
2. claude.ai → Settings → Connectors → **Add custom connector** → name `Workflow (scratch)`, URL `https://workflow-mcp.j5s.dev/api/workflow/mcp`, no OAuth. **Screenshot 1:** the connector's tool list (11 tools; the app-only four absent). This settles spike (c).
3. New chat, connector enabled. Prompt: *"List the workflows on my Workflow connector."* **Screenshot 2:** hello/interactive listed.
4. Prompt: *"What is run `<runId>` waiting on?"* → `workflow.status` → waiting on `pick/0/choose` (island).
5. Prompt: *"Let me complete that step."* → Claude calls `workflow.submitStep { runId, step: 'pick/0/choose' }` (no values) → the step view mounts → the pick-line island renders its two lines. **Screenshot 3:** the island inside the chat (the buttons, the "2 lines · N words" line).
6. Click a line (the island calls `echo` through `workflow.pipeline` — the shouted text appears — and `workflow.annotate`), then **Submit**. **Screenshot 4:** the view's "Submitted pick/0/choose" banner.
7. Prompt: *"What is the run's status now?"* → `pick/0/choose` `succeeded`, run `running`. **Screenshot 5.**
8. Open `https://workflow-mcp.j5s.dev/hello/interactive/runs/<runId>` on the harness → Resume → the run continues from the submitted step to the review form. **Screenshot 6:** the harness run page showing the island step done with the line Claude's user picked.

- [ ] Post the checklist; when the screenshots arrive, attach them to the PR (drag into the PR body or a comment) and quote the connector's tool count for (c) on #554.
- [ ] **PR** `feat(workflow): islands as ui:// resources — the step view, server-side workflow.submit/annotate/pipeline, submitStep's UI in claude.ai` into `epic/agent-embedding`; body: §1 note as Story 5's; the six screenshots; the walk report (24/24); real counts. Merge on green **after** the screenshots are on the PR (the gate is the screenshots, not CI); tick story 6 on #554.

### Task 14: Phase-2 closeout

- [ ] **File the Phase-1 follow-up** with the `file-issue` skill: *"workflow.runs lists a run as `running` a beat after the sealing run/update landed — the list endpoint's data_query read lags the write"* (evidence: the Phase-1 gate report on #554, observed-on-green note 1; the `page-tools` walk asserts membership only; ask for a `status` assertion with a short retry in the walk and a look at whether `runs/get` reads stale; app `workflow`).
- [ ] **#554:** check off stories 5 and 6; comment **"Phase 2 gate — PASS"** with the walk report, the six screenshots' links, the three spike answers restated in one line each, the prototype narrowings (Decisions 5, 7, 8) as the list Phase 3/4 inherits, and the scratch project's status (kept, named, documented — or deleted if the user said so).
- [ ] **This plan:** add a "Phase 2 as shipped" block under the traceability table (PR numbers, departures, which URL form the sibling calls use, the walk's counts), the way Phase 1's plan did; PR `docs(workflow): M5 Phase 2 as shipped — plan notes` into the epic.
- [ ] **Memory:** a project note that `bffless/workflow-mcp` (`workflow-mcp.j5s.dev`) is the Phase-2 scratch project, public and authless by design, redeployed by the README sequence, and that the endpoint's functions are esbuild bundles (`pnpm --filter workflow mcp:build`) with a freshness test.
- [ ] **Ask the user** whether to `delete_project` the scratch project now or keep it for Phase 3's OAuth work (it is the natural target for story 9's claude.ai DCR test too).
