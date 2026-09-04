# Workflow M5 Phase 4 — the step view completes forms; the run view is not built Implementation Plan (apps#554, stories 10–12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Apps-only: no CE change is needed (Decision 1).

**Goal:** Close M5 on the split the brainstorm ratified 2026-09-04 (Decision 1): an MCP app inside an agent host **reports back and takes one input** — it never carries the run engine. The one real gap on that surface is that a waiting **form** step is refused over the endpoint ("form steps are not served — complete it on the harness"), so a workflow with a form can only be half-completed in claude.ai. This phase (a) makes the existing step view render and submit a form step exactly as it mounts an island — the endpoint answers the form's evaluated fields off the step row, the view draws them with the harness's own `FieldControl`s, the submit rides the bridge into the same server-side `workflow.submitStep`/`validateFormOutputs` the page uses; (b) lands apps#587 (build-hashed `ui://` URIs, so every deploy is a cache miss in a host that caches per URI) and apps#586 (an emulated-host `mcp-app` walk, so a broken widget mount is caught without a person); (c) amends D24 and the docs to say the run view is **not** built and that driving belongs to a browser on the harness page — a person, or an agent through WebMCP (D21) — and, long-term, a server-side driver; (d) closes the epic: the claude.ai gate, "Phase 4 as shipped", stories 10–12 ticked on #554, the epic→main merge (#571) handed to the person.

**Architecture:** Nothing new runs anywhere. Server side, two pure functions in the shared MCP bundles gain a `form` branch: `reply.stepView` answers `{ kind: 'form', fields, initial, title, submit }` from the row's recorded `inputs` (the harness writes a form's *evaluated* `with` — title, fields with `default`/`options` resolved, submit label — on `step.waiting`, `lib/runner/adapters/form.ts` `formInputs`); `merge` validates a form submit with `validateFormOutputs(fields, values)`, the very function `completeFormStep` runs on the page, and writes the same full step row. Client side, `step/index.html` (the Phase-2 single-file entry, `ui://bffless/workflow/step-view.<rev>.html`) gains a React root that renders `StepForm` — the kickoff form's `FieldControl`s over the answered fields — and submits through `app.callServerTool('workflow.submitStep', { runId, step, values })`; the island path is untouched. `build-mcp.mjs` hashes `src/**` into the resource URI; the walks read the URI from `tools/list`. `packages/workflow-live` gains `host-emu.ts` (the MCP Apps host side of the bridge — a sandboxed frame, `document.write`, `ui/initialize` answered, `tools/call` proxied to the live endpoint with an app token) and the `mcp-app` walk that mounts the served step view, completes an island **and** a form through it, and resumes the run on the harness page.

**Tech Stack:** TypeScript · React 19 (`@vitejs/plugin-react` added to the step build) · `@modelcontextprotocol/ext-apps` 1.7.5 (`App`) · Vite 8 + `vite-plugin-singlefile` · esbuild IIFE bundles for CE's `function_handler` (`scripts/build-mcp.mjs`, `bundle.test.ts` sandbox) · CE ≥ v0.4.48 on j5s (`mcp_handler`, app tokens, OAuth) · Playwright 1.61 (`workflow-live`) · Vitest.

**Spec:** `apps/workflow/docs/spec/10-agent-embedding.md` (§Islands and the run view — **amended by Task 12 to "Islands and forms inside an agent host"**; §The MCP endpoint; D19, D22–D24) · `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` (amended, Task 12) · `docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md` (§3 Layer 2b, §4 Phase 4 — both amended, Task 12) · `docs/superpowers/plans/2026-09-02-workflow-m5-phase2-mcp-apps.md` Decisions 3–4, 7 (the step view, the four app-only tools, the lease guard) and its "Phase 2 as shipped" (the text-only host) · `docs/superpowers/plans/2026-09-03-workflow-m5-phase3-ce-auth.md` "Phase 3 as shipped" (departures, walk counts, the private host) · apps#554 (gate reworded by Task 0), apps#586, apps#587 · memories *in-process external siblings honour rule header controls* (the hello forwarder), *m5-phase3-handoff*. **Brainstorm evidence (2026-09-04):** the sandbox probe mounted in claude.ai from the scratch host — origin is a per-widget hashed `*.claudemcpcontent.com` subdomain; CSP `worker-src 'self' blob:` (no `data:`), `frame-src 'self' blob: data:`; storage CORS refuses the sandbox origin (and can never allow-list it); timers unthrottled; a 1.9 MB resource mounts; `sessionStorage` works; `requestDisplayMode` honoured. Not in scope (Decision 1): the run view (`ui://bffless/workflow/run.html`), `workflow.http`, lease/take-over from a widget, uploads via the bridge (`data:` URLs into `file_upload_handler`), blob-Worker script steps in a widget, `workflow.start`/`resume`/`cancel` served over the endpoint, a server-side driver, bffless.dev.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **D24 is amended: the run view is not built.** Ratified with the person on 2026-09-04 after the brainstorm: "webmcp apps should be small and lightweight … kick something off or report back, but not entire workflow engine"; "the agent on my app in my domain running it" is what WebMCP (Phase 1, D21) is for; driving from outside a browser is the server-side driver, later. So in an agent host the surface is **reports + one input at a time**: the read tools, and the step view for a waiting island **or form**. `workflow.start`/`resume`/`cancel` stay *not served* over the endpoint; their refusal is reworded to point at the page (Task 2). No CE change is needed anywhere in this phase.
2. **A form's fields come off the row, not from re-evaluation.** `formInputs` (`lib/runner/adapters/form.ts`) records the form's `with` **evaluated against the run** — `title`, `description`, `submit`, and `fields` with every `default`/`options` expression resolved (the poster tiles of hello's `review` form are File refs *in the row*) — as the step's `inputs` on `step.waiting`. The endpoint therefore has everything: `stepView` answers `inputs.fields` and per-field `default`s as `initial`; `merge` validates with `validateFormOutputs(inputs.fields, values)`, which normalises a File-ref option's `path` back to the ref (`withFileRefs`) exactly as a page submit does. A row whose `inputs.fields` is missing (a form that reached `waiting` under a harness older than this contract) is refused with "the form's evaluated fields were not recorded — complete it on the harness page". No run contexts are rebuilt server-side; nothing is re-evaluated.
3. **`workflow.submitStep` is the form's submit; `workflow.submit` stays island-only.** The catalog already says `submitStep { values }` completes "a `form` or `island` step"; the step view calls it directly (it is a model-visible tool the host proxies, like `workflow.sign` today). `workflow.submit { outputs }` is the island's own bridge verb (spec 04) and refuses a form step by name. `workflow.annotate` stays island-only (a form has no bridge caller). The no-values panel branch (`submitStep { values: {} }`) works for both kinds and its text names the kind.
4. **File fields do not upload from inside an agent host.** The sandbox origin cannot reach the bucket (brainstorm evidence), and bytes-over-the-bridge is out of scope (Decision 1). `StepForm` hands `FieldControl` an `upload` that rejects with "Files cannot be attached from inside an agent host — attach this one on the harness page"; `FieldControl`'s own `onError` shows it under the field. A **required** file field therefore cannot be satisfied in the view, and the form's Submit stays disabled by the same `missingRequired` rule the kickoff form uses — the person finishes that form on the harness page; hello's `extra` is optional, so its form completes in Claude.
5. **Validation happens once, server-side.** `StepForm` runs no `validateInputs` of its own (the kickoff form's loop is for *inputs*; a form step's authority is `validateFormOutputs`): it only disables Submit while a required field is blank, sends the values, and shows the endpoint's per-field `errors` under the fields — the island path's shape (`deps.ts` `onSubmit`). One validator, one wording (D12/D19).
6. **The step view grows a React root, and only for forms.** `src/step-view/main.ts` becomes `main.tsx`: the island branch (vanilla `IslandHost` + the `<iframe data-testid="island">`) is unchanged; a `form` answer renders `<StepForm>` into `<div data-testid="form">` with `createRoot`. `vite.step.config.ts` adds `@vitejs/plugin-react` (JSX) and `main.tsx` imports `../index.css` so the form uses the harness's own field/tile styles (inlined by the singlefile plugin; +~70 KB — the probe proved a 1.9 MB resource mounts). The step view's own header/status styles stay in `step/index.html`.
7. **Resource URIs carry a source revision (apps#587): `ui://bffless/workflow/step-view.<rev>.html`,** `rev` = the first 8 hex of a SHA-256 over every non-test file under `apps/workflow/src/**` (excluding `src/mocks/**`, `src/test/**`, `*.test.*`) plus `package.json`, computed by `scripts/build-mcp.mjs` at render time and passed into `mcpHandlerConfig({ rev })`. Any source change re-keys the URI; `bundle.test.ts` keeps the committed rule fresh, so `pnpm --filter workflow mcp:build` is already in the verify chain. The rule *paths* (`/api/workflow/mcp-resources/step-view`) do not change. Walks and CONTEXT read the URI from `tools/list` (`_meta.ui.resourceUri`) and assert the pattern `^ui://bffless/workflow/step-view\.[0-9a-f]{8}\.html$`, never a literal. The island template `ui://bffless/{impl}/{path+}` is left alone: an island is served from the implementation's own deployment, and hosts fetched it fresh at the Phase-3 gate.
8. **The emulated host is the `mcp-app` walk's own module (apps#586), not a shared package.** `packages/workflow-live/src/host-emu.ts` reproduces what claude.ai does that the walks never did: a `sandbox="allow-scripts allow-same-origin"` frame whose document is `document.write`n from the resource text, a hand-rolled JSON-RPC host over `postMessage` (`ui/initialize` answered with `hostCapabilities: { serverTools: {}, serverResources: {} }` and an `inline` display mode, `ui/notifications/tool-input` sent on `initialized`, `tools/call` proxied to the live endpoint with the walk's Bearer token, `ui/notifications/size-changed` recorded, `ui/request-display-mode` echoed). ~80 lines; `@modelcontextprotocol/ext-apps/app-bridge` is not bundled for the page. The walk drives the nested island frame and the form with Playwright locators the interactive/page-tools walks already use (`getByTestId('line')`, `getByTestId('submit')`, `getByTestId('tile')`, `getByTestId('form-step-submit')`).
9. **Parking is shared.** The `mcp` walk's inline "park a `hello/interactive` run on its island through the page tools, wait for the row, close the browser" block moves to `packages/workflow-live/src/park.ts` as `parkHelloRun(session, until, say)` with `until: 'island' | 'form'` (`'form'` submits the island through the page tools — `{ line: 'Hello, world!', index: 0 }` — and awaits the next `waiting`, which is `review/0/confirm` after the page runs the `card` script). The `mcp` walk's 26 checks and their evidence are unchanged; the `mcp-app` walk parks twice (island, then form). No check is renamed.
10. **The gate is reworded, and the claude.ai half stays a person's.** Phase 4 gate (Task 0 posts it on #554): *a `hello/interactive` run parked on its island is completed in claude.ai, and one parked on its `review` form is completed in claude.ai — the same step view, the same server-side submit — with screenshots on the story-10 PR; `mcp-app` green on the scratch host and on `workflow.j5s.dev`; `mcp` 26/26 and `oauth` 9/9 unchanged.* The scripted-manual checklist is Task 13; the person parks the runs with `pnpm workflow-live:walk mcp-app --harness … --park-only` (Task 9 gives `mcp-app` the same flag as `mcp`, parking on the **form**) and `pnpm workflow-live:walk mcp --harness … --park-only` (island).
11. **Story mapping.** Story 10 "run-view bundle" → **the step view completes forms** (PR A). Story 11 "server wiring" → **build-hashed URIs + the `mcp-app` walk** (PRs B and C). Story 12 unchanged (PR D). PR titles are release commits (Global Constraints). Stacked PRs into `epic/agent-embedding`, base = the previous PR's branch until it merges, then `git rebase --onto origin/epic/agent-embedding <old-base-tip>` + `--force-with-lease`.

## Deferred out of this plan, explicitly

- **A server-side run driver** — the person's stated long-term direction ("driving the entire workflow serverside would be a long term direction"): the thing that would make `workflow.start` over the endpoint start a run. Recorded in spec 10 §Later first (Task 12) and filed as an idea issue at closeout (Task 14). Until then, driving is the harness page: a person, or an agent through WebMCP.
- **Uploads through the bridge** (`workflow.upload { contentBase64 }` → a `data:` URL into CE's `file_upload_handler.sourceUrl`, ~7 MB cap under CE's 10 MB body limit): understood, not wanted now. Filed as an idea at closeout with the design note, so the next person does not re-derive it.
- Script steps in a widget (a view-level `blob:` Worker), lease/take-over from a widget, `workflow.http`, presigned file URLs in the harness's own value renderers inside a widget — all children of the run view; gone with it.
- A submitted island/form step's `summary` (needs run contexts; a Phase-2 recorded gap) — still a gap; filed at closeout if not already.
- `workflow.await` over the endpoint (stateless), per-workflow generated tools, `ui/update-model-context` — spec 10 §Later, unchanged.

## Global Constraints

- **Worktrees only, under `.claude/worktrees/`** (git-ignored — verified 2026-09-04): every PR branches off `origin/epic/agent-embedding` (`git worktree add .claude/worktrees/<name> -b <branch> origin/epic/agent-embedding`), then `pnpm install --frozen-lockfile` **and** `pnpm workflow-lint:build && pnpm workflow-cli:build && pnpm workflow-agent-tools:build && pnpm workflow-headless:build && pnpm workflow-live:build` — in a fresh worktree every `apps/workflow` suite fails with `Failed to resolve import "@bffless/workflow-lint/expressions"` until `workflow-lint` is built (the kickoff's list of three was one short). The shared checkout `repos/apps` is never switched. This plan's own worktree is `.claude/worktrees/m5-phase4-run-view` (branch `m5-phase4-run-view`, at epic tip `0d6ef32`).
- **Branching and merging:** PRs target `epic/agent-embedding`, never `main`; the epic PR (#571) is the person's merge. Stacked: PR B bases on PR A's branch, PR C on PR B's, PR D on PR C's, until each merges — then rebase `--onto` and `--force-with-lease` (memory *use worktrees*; CLAUDE.md's squash-merge rule). Story PRs merge on green after the automated review comments on **every** push have been read; each merge checks its story off on #554.
- **PR titles are release commits** (`.claude/apps-pr-review-checklist.md` §3): `docs(workflow): the M5 Phase 4 plan — form steps in the step view, hashed ui:// URIs, the mcp-app walk (#554)` · `feat(workflow): the step view completes form steps — evaluated fields off the row, StepForm in the view, workflow.submitStep serves forms` · `feat(workflow): build-hashed ui:// resource URIs so an agent host's per-URI cache never pins a stale fetch (#587)` · `feat(workflow-live): the mcp-app walk — an emulated MCP Apps host completes an island and a form through the served step view (#586)` · `docs(workflow): M5 Phase 4 as shipped — D24 amended, the epic closes (#554)`. **Never edit a `CHANGELOG.md`.**
- **Apps verification chain per PR** (checklist §4–§7): `pnpm --filter @bffless/workflow-agent-tools lint && pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-agent-tools test:run` when the package changes; `pnpm --filter workflow mcp:build` then `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`; `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test` when the package changes; `pnpm apps:check`; real counts pasted in the PR body. Vitest does not typecheck — `build` is part of the chain.
- **Live targets, ask-first rules.** Every walk runs first on the scratch public project `bffless/workflow-mcp` (`https://workflow-mcp.j5s.dev`; redeploy sequence in `apps/workflow/bffless/README.md` §"M5 Phase 2 — the MCP Apps scratch project"; key in `~/.config/bffless/workflow-mcp.env`; **scratch pushes/uploads are act-and-report**) and then on the members-only `bffless/workflow` harness (`https://workflow.j5s.dev`) for the gate — **a deploy of `workflow.j5s.dev` (a `workflow_dispatch` of `deploy-workflow.yml` on the story branch) and any live change to the `bffless/workflow` project are ask-first.** Walk credentials: `~/.config/bffless/workflow-ci.env` (`WORKFLOW_CI_EMAIL`/`WORKFLOW_CI_PASSWORD`); `mcp` must stay **26/26**, `oauth` **9/9**. Before touching the live hello forwarder or its set, re-read memory *in-process external siblings honour rule header controls*. j5s only; no bffless.dev. Cloudflare's AI-bot block stays off (a person's setting).
- **Sandbox-safety of the bundles:** every function the MCP rules run is an esbuild IIFE that must pass `bundle.test.ts` — CE's `PROHIBITED_PATTERNS` scan and a `node:vm` run in CE's sandbox (no `URL`, no `TextEncoder`, no `Buffer`, no `globalThis`). `validateFormOutputs` pulls `lib/runner/adapters/form.ts` → `inputConstraints.ts`/`outputs.ts`/`fileRef.ts` into `merge.fn.js`; if the vm run or the scan refuses it, the fix is a polyfill in `src/mcp/polyfills.ts` (Phase 2 Decision 2), never a copy of the validator.
- **The catalog owns every tool's words** (D19): descriptions change in `packages/workflow-agent-tools` (release train, `release-please` component `workflow-agent-tools`), and `toolParity` in the `mcp` walk holds `tools/list` byte-equal to it. Results stay catalog `CallToolResult`s.
- **Caching is optional, pipeline `condition`s are simple paths, `data_update` same-record writes are sequenced** (memories) — none of these are touched here, and no new rule is added: the form path reuses the `submitStep` sibling rule's existing steps (`route`, run rows, `merge`, `update`, `reply`).
- **Text-only host rule** (Phase 2 as shipped): every tool result's `text` must stand alone — a model in claude.ai never sees `structuredContent`.

## File structure

```
apps/workflow
  docs/superpowers/plans/2026-09-04-workflow-m5-phase4-step-view-forms.md   this plan                                          (Task 0)
  src/mcp/reply.ts (+ reply.test.ts)          stepView: form branch off the row; agentHostHint names forms; notServed → "drive on the page"   (Task 2)
  src/mcp/merge.ts (+ merge.test.ts)          submit: form branch → validateFormOutputs; workflow.submit refuses forms; panel text by kind   (Task 2)
  src/mcp/hostTools.ts (+ .test.ts)           stepView/submit descriptions name forms; stepViewUri(rev), STEP_VIEW_URI_PATTERN   (Tasks 2, 5)
  src/mcp/mcpConfig.ts (+ .test.ts)           INSTRUCTIONS + resource text name forms; mcpHandlerConfig({ rev })                 (Tasks 2, 5)
  src/mcp/fixtures/index.ts                   formStepRows(): the same run parked on review/0/confirm                              (Task 2)
  .bffless/proxy-rules/workflow/mcp-fn/*.fn.js, rules/api/workflow/mcp/any.rule.yaml, mcp-resources/step-view/get/rule.yaml   regenerated   (Tasks 2, 5)
  src/step-view/deps.ts (+ deps.test.ts)      StepViewData = IslandStepView | FormStepView; readStepView; submitFormValues       (Task 3)
  src/step-view/StepForm.tsx (+ .test.tsx)    the form renderer over FieldControl; no uploads; server errors under fields        (Task 3)
  src/step-view/main.ts → main.tsx            a React root for form answers; island path unchanged; imports ../index.css        (Task 3)
  step/index.html                              <div data-testid="form" hidden>                                                    (Task 3)
  vite.step.config.ts                          + react()                                                                          (Task 3)
  scripts/build-mcp.mjs                        sourceRev(); rev into mcpHandlerConfig and the resource-rule text                  (Task 5)
  CONTEXT.md, bffless/README.md                Step view entry (forms, the revisioned URI); the per-URI cache note                (Task 12)
  docs/spec/10-agent-embedding.md              §Islands and forms inside an agent host (rewrite), D24, §Later                     (Task 12)
  docs/spec/00-overview.md                     M5 done-block; D24 row                                                             (Task 12)
  docs/adr/0005-one-tool-catalog-two-adapters.md   amendment block                                                                (Task 12)
  docs/writing-an-implementation.md            §"Your workflow inside an agent host"                                              (Task 12)
packages/workflow-agent-tools
  src/catalog.ts, README.md                    submitStep description: "an island or form step"                                   (Task 1)
packages/workflow-live
  src/park.ts (+ park.test.ts)                 parkHelloRun(session, until, say)                                                  (Task 7)
  src/walks/mcp.ts                              uses parkHelloRun; STEP_VIEW_URI literal → read from tools/list + pattern         (Tasks 6, 7)
  src/host-emu.ts (+ host-emu.test.ts)          openEmulatedHost(page, callTool) → mount(html, toolInput)                          (Task 8)
  src/walks/mcp-app.ts, walks/index.ts, args.ts, README.md   the walk, registered; --park-only parks on the form                  (Task 9)
docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md   §Layer 2b + §4 Phase 4 amended                             (Task 12)
.claude/agents/apps-live-walk.md               walk list + mcp-app                                                                (Task 10)
```

## Traceability — spec 10 / design §4 / #554 → tasks

| Item | Tasks |
|---|---|
| D24 amended: reports + one input in an agent host; no run view; driving = harness page (person or WebMCP agent), server-side driver later | 0 (gate), 2 (refusal wording), 12 (spec/ADR/design/overview), 14 |
| Story 10 → a waiting form step completes in claude.ai through the step view; same validator as the page | 1, 2, 3, 4 |
| apps#587 build-hashed resource URIs; walks read `_meta.ui.resourceUri` | 5, 6 |
| apps#586 emulated MCP Apps host walk (`mcp-app`) | 7, 8, 9, 10 |
| Phase gate: island + form completed in claude.ai (screenshots); `mcp-app` green on scratch and `workflow.j5s.dev`; `mcp` 26/26, `oauth` 9/9 | 10, 11, 13 |
| Story 12: docs, "Phase 4 as shipped", deferred items as issues, #554 ticked, #571 handed over, handoff memory | 12, 13, 14 |

## Phase 4 as shipped (2026-09-04)

Landed on `epic/agent-embedding` as **#590** (this plan), **#591** (story 10 — `feat/m5-step-view-forms`), **#592** (story 11 — `feat/m5-resource-uris`, one PR for #587 + #586, Decision "one story, one PR") and the closeout docs PR (story 12 — `docs/m5-phase4-closeout`, this block). The run view was **not built** (Decision 1); D24 is amended in spec 10, ADR-0005, the design doc and 00-overview.

**Departures from the tasks, all ledgered as rulings:**
- **Two plan defects in story 10 were found by the checks the phase built, not by reading.** The maintainer's claude.ai check of #591 found the poster tile's image not loading (a File ref's relative `/api/uploads/…` URL resolves against the widget's sandbox origin): fixed as Task 3c — the step view presigns File-ref options *and* a `file` field's prefilled ref through `workflow.sign` (D6), and the three media renderers accept a URL the page signed itself (`lib/url.ts` `isLoadableUrl`/`trustSignedUrl`; `downloadHref` passes a signed URL through). The first live run of the `mcp-app` walk found that the form's **Approve never fired** inside a sandboxed frame — the HTML form-submission algorithm returns before the `submit` event when `allow-forms` is absent (claude.ai's frame is `allow-scripts allow-same-origin`): fixed as Task 3d — `StepForm` submits from a button click (and Enter in a single-line input). Both are on #591.
- **The `<StepForm>` root is keyed per step** (Task 3 fix round 1 — the plan's snippet would have carried one form's state into the next).
- **`packages/workflow-agent-tools` and `packages/workflow-live` vitest configs now include `src/**`** — their `src/*.test.ts` files (13 in `mcp-checks.test.ts`) had never run.
- **`no-restricted-imports` in `apps/workflow/eslint.config.js` admits `lib/runner/adapters/form`** (the one pure module the endpoint's form branch needs); `scripts/build-mcp.d.mts` declares `sourceRev` for `tsc -b`.
- **Every `src/**` change re-keys the resource URI** (Decision 7), so each rebase of story 11 onto a story-10 fix needed a `mcp:build` + a regeneration commit — two of them on #592 (`rev` ended at `bbbac8d6`).
- **Story work ran in the controller's worktree, one implementer at a time** — subagents inherit the session's cwd and the worktree guard blocks cross-worktree git (the first implementer committed on the plan branch; moved).
- **bffless/apps has no automated PR reviewer** (that bot is on bffless/ce) — the "read the automated review comments" steps were dropped.
- **The `mcp-app` walk asserts the record, not `workflow.status`, after a bridge submit:** on the private host the endpoint's in-process `workflow.status` lagged the durable row by minutes (never on scratch; converged ~30 min later) — recorded as a CE-side observation to file (below). The walk carries `workflow.status`'s view as evidence.
- **The deferred-item issues were drafted but not filed** in this session: their citations are epic-only and the triage gate checks `origin/main`; file after #571 merges (drafts: server-side driver idea; uploads over the bridge idea; chat-completed step `summary` gap; the status-read lag with evidence).

**Verified.** Scratch host `workflow-mcp.j5s.dev` (story-11 build, deployment 05e54cec): `mcp` 26/26, `oauth` 9/9, `mcp-app` 10/10. Private host `workflow.j5s.dev` (deployed from `feat/m5-resource-uris` by `deploy-workflow` run 33905444844, the person's yes): `mcp` 26/26, `oauth` 9/9, `mcp-app` **10/10** (record-based checks, `/tmp/claude-1000/gate-mcp-app-3/report.md`; an earlier run read 9/10 through `workflow.status` — the lag above). The person's claude.ai half: the checklist on #591 (comment 5544854762) — island and form completed in the chat, screenshots on #591 — pending the person's screenshots when this block was written; tick stories 10–12 on #554 once they are there. `dist/step.html` = 674 KB. Timings: plan 2026-09-04 morning; story 10 PR #591 by 14:30Z; story 11 PR #592 by 17:00Z; private deploy 18:00Z.

**Rulings of note** (the full list is in the session's ledger): scope re-ruled with the maintainer (no run view; "the agent on my app in my domain running it" = WebMCP; server-side driver later); one PR for story 11; `workflow.start`/`resume`/`cancel` stay not served with the refusal pointing at the page; file fields do not upload from a chat.

---

### Task 0: the plan PR, the gate reworded on #554

**Files:**
- Create: `docs/superpowers/plans/2026-09-04-workflow-m5-phase4-step-view-forms.md` (this file)

- [ ] **Step 1: Commit the plan on its own branch off the epic and open the docs PR**

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/m5-phase4-run-view
git checkout -b docs/m5-phase4-plan
git add docs/superpowers/plans/2026-09-04-workflow-m5-phase4-step-view-forms.md
git commit -m "docs(workflow): the M5 Phase 4 plan — form steps in the step view, hashed ui:// URIs, the mcp-app walk (#554)"
git push -u origin docs/m5-phase4-plan
gh pr create --base epic/agent-embedding --title "docs(workflow): the M5 Phase 4 plan — form steps in the step view, hashed ui:// URIs, the mcp-app walk (#554)" --body-file - <<'EOF'
The Phase 4 plan, re-scoped on 2026-09-04 after the brainstorm: the run view (D24 as spec'd) is **not** built — an MCP app reports back and takes one input; driving stays on the harness page (a person, or an agent through WebMCP) and later a server-side driver. What ships: form steps in the step view, build-hashed `ui://` URIs (#587), the `mcp-app` emulated-host walk (#586), the D24 amendment and closeout. Brainstorm evidence (the claude.ai sandbox probe) is in the plan's header.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Expected: a PR URL. Do not wait for the merge; the story branches base on the epic tip, not on this branch.

- [ ] **Step 2: Post the re-scope and the new gate on #554 (a comment, not an edit)**

```bash
gh issue comment 554 --body-file - <<'EOF'
**Phase 4 re-scoped (2026-09-04, brainstorm with the person).** The run view — the engine bundled into the agent host's iframe (D24) — is **not** built: an MCP app should kick something off, report back, or take one input, never carry the workflow engine; driving is a browser on the harness page (a person, or an agent through the page's WebMCP tools, D21), and long-term a server-side driver. Evidence and the four rejected sub-designs (uploads over the bridge, blob-worker script steps, lease from a widget, `workflow.http`) are in `docs/superpowers/plans/2026-09-04-workflow-m5-phase4-step-view-forms.md`.

**Phase 4 now:** story 10 = the step view completes **form** steps (the Phase-2 gap); story 11 = #587 (build-hashed `ui://` URIs) + #586 (the `mcp-app` emulated-host walk); story 12 = closeout with D24 amended.

**Gate (replaces the one above):** a `hello/interactive` run parked on its island is completed in claude.ai, and one parked on its `review` form is completed in claude.ai — the same step view, the same server-side submit — with screenshots on the story-10 PR; `mcp-app` green on the scratch host and on `workflow.j5s.dev`; `mcp` 26/26 and `oauth` 9/9 unchanged.
EOF
```

Expected: the comment URL.

---

## Story 10 — the step view completes form steps (PR A, branch `feat/m5-step-view-forms`, worktree `.claude/worktrees/m5-step-view-forms`)

*Deliverable: over the endpoint, `workflow.stepView` answers a waiting form's evaluated fields, `workflow.submitStep { values }` completes it with the page's validator, and the served `step-view.html` renders the form and submits it through the bridge. Verified by unit tests, the bundle sandbox test, a scratch-host deploy and a hand `resources/read` + `tools/call` round trip; the emulated-host proof comes in story 11.*

Setup once (a fresh worktree; see Global Constraints):

```bash
cd /home/rico/bffless/repos/apps
git fetch origin && git worktree add .claude/worktrees/m5-step-view-forms -b feat/m5-step-view-forms origin/epic/agent-embedding
cd .claude/worktrees/m5-step-view-forms
pnpm install --frozen-lockfile
pnpm workflow-lint:build && pnpm workflow-cli:build && pnpm workflow-agent-tools:build && pnpm workflow-headless:build && pnpm workflow-live:build
pnpm --filter workflow stage        # hello-dist/ — needed by test:stage and the scratch redeploy
pnpm workflow:test                  # baseline: 1677 passed | 14 skipped (134 files) at epic tip 0d6ef32
```

### Task 1: the catalog says `submitStep` renders a form too

**Files:**
- Modify: `packages/workflow-agent-tools/src/catalog.ts:72-73` (the `workflow.submitStep` description)
- Modify: `packages/workflow-agent-tools/README.md:56` (the sentence "an agent completes an island step with `workflow.submitStep`")

**Interfaces:**
- Produces: the new description string, byte-equal in `tools/list` (the `mcp` walk's `D19.toolsListParity` reads `CATALOG`; `apps/workflow/src/mcp/mcpConfig.ts` renders it into `rules/api/workflow/mcp/any.rule.yaml` — Task 2 regenerates).

- [ ] **Step 1: Write the failing test** — `packages/workflow-agent-tools/src/catalog.test.ts` does not exist; add one:

```ts
import { describe, expect, it } from 'vitest'
import { CATALOG, toolByName } from './index.js'

describe('the catalog names both interactive step kinds for the agent-host panel', () => {
  it('submitStep tells a host-rendering agent to open an island or a form with values: {}', () => {
    const description = toolByName('workflow.submitStep')?.description ?? ''
    expect(description).toContain('call it with `values: {}` for an island or form step')
    expect(description).toContain('do not invent values for them')
    expect(CATALOG.find((t) => t.name === 'workflow.submitStep')?.description).toBe(description)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @bffless/workflow-agent-tools test:run -- catalog`
Expected: FAIL — `expected '…for an island step: the step's own island is shown…' to contain 'call it with \`values: {}\` for an island or form step'`.

- [ ] **Step 3: Change the description**

In `packages/workflow-agent-tools/src/catalog.ts`, replace the `workflow.submitStep` entry of `DESCRIPTIONS` with:

```ts
  'workflow.submitStep':
    'Complete a waiting interactive step, or open it for the person. A `form` step takes a value per field; an `island` step takes its declared outputs. Validated by the same checks a person’s submit runs; a refusal names each bad value. In an agent host that renders this tool’s UI, call it with `values: {}` for an island or form step: the step’s own UI is shown and the person completes it there — do not invent values for them.',
```

In `README.md` line 56, change "an agent completes an island step with `workflow.submitStep`" to "an agent completes an island or form step with `workflow.submitStep`".

- [ ] **Step 4: Run the package chain**

Run: `pnpm --filter @bffless/workflow-agent-tools lint && pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-agent-tools test:run`
Expected: lint clean; build ok; all tests pass including the new one (23 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-agent-tools/src/catalog.ts packages/workflow-agent-tools/src/catalog.test.ts packages/workflow-agent-tools/README.md
git commit -m "feat(workflow-agent-tools): submitStep's panel hint names forms as well as islands"
```

### Task 2: the endpoint answers and completes a form step off the row

**Files:**
- Modify: `apps/workflow/src/mcp/reply.ts` (`stepView`, `agentHostHint`, `notServed`)
- Modify: `apps/workflow/src/mcp/merge.ts` (the kind checks, the submit branch)
- Modify: `apps/workflow/src/mcp/hostTools.ts:64-75` (`workflow.stepView` description), `apps/workflow/src/mcp/mcpConfig.ts:15,55-56` (INSTRUCTIONS, the static resource description)
- Modify: `apps/workflow/src/mcp/fixtures/index.ts` (add `formStepRows()`)
- Test: `apps/workflow/src/mcp/reply.test.ts`, `apps/workflow/src/mcp/merge.test.ts`, `apps/workflow/src/mcp/mcpConfig.test.ts:42`, `apps/workflow/src/mcp/bundle.test.ts` (regenerate)
- Regenerate: `apps/workflow/.bffless/proxy-rules/workflow/mcp-fn/{reply,merge}.fn.js`, `rules/api/workflow/mcp/any.rule.yaml`

**Interfaces:**
- Consumes: `validateFormOutputs(fields: Record<string, InputDef>, values: Record<string, unknown>): { ok: true; outputs } | { ok: false; errors: Record<string, string> }` from `../lib/runner/adapters/form` (pure); the row helpers `rows`/`fieldsOf`/`recordIdOf` from `./rows`; `textResult`/`errorResult` from the catalog.
- Produces (for Task 3): the `workflow.stepView` form answer's `structuredContent`:
  `{ runId, step, impl, workflow, kind: 'form', status: 'waiting', title: string, description?: string, submit: string, fields: Record<string, InputDef>, initial: Record<string, unknown> }`; the `workflow.submitStep` verdict shape is unchanged (`isError` + `structuredContent.errors` per field on refusal; `Submitted <key>; <snapshot>` on success).

- [ ] **Step 1: Add the form fixture** — in `apps/workflow/src/mcp/fixtures/index.ts` append:

```ts
/** The evaluated `with` the harness records on a form's `step.waiting` (`formInputs`, lib/runner/adapters/form.ts): hello's `review` form after `card` drew two posters. */
export const POSTER_A = { path: `workflows/hello/interactive/runs/${RUN_ID}/card/0/draw/poster.svg`, name: 'poster.svg', contentType: 'image/svg+xml', size: 1234, url: `/api/uploads/workflows/hello/interactive/runs/${RUN_ID}/card/0/draw/poster.svg` }
export const POSTER_B = { ...POSTER_A, path: POSTER_A.path.replace('poster.svg', 'poster-2.svg'), name: 'poster-2.svg', url: POSTER_A.url.replace('poster.svg', 'poster-2.svg') }
export const REVIEW_INPUTS = {
  title: 'Review the card',
  fields: {
    cover: { type: 'choice', options: [POSTER_A, POSTER_B], required: true },
    notes: { type: 'markdown', default: '## Notes\n\nHello, world!' },
    extra: { type: 'file', accept: 'image/*' },
  },
  submit: 'Approve',
}

/** The same run, further along: pick and card done, `review/0/confirm` waiting on its form. */
export function formStepRows(): Record<string, unknown>[] {
  const [s1, s2, s3, pick] = stepRows()
  return [
    s1, s2, s3,
    { ...pick, status: 'succeeded', outputs: { line: 'Hello, world!', index: 0 } },
    { id: 'rec_s5', runId: RUN_ID, key: 'card/0/draw', job: 'card', index: 0, step: 'draw', kind: 'script', status: 'succeeded', outputs: { poster: POSTER_A, posters: [POSTER_A, POSTER_B], big: [] } },
    { id: 'rec_s6', runId: RUN_ID, key: 'review/0/confirm', job: 'review', index: 0, step: 'confirm', kind: 'form', status: 'waiting', attempt: 1, inputs: REVIEW_INPUTS, annotations: [], startedAt: 1_756_800_020_000 },
  ]
}
```

- [ ] **Step 2: Write the failing reply tests** — in `apps/workflow/src/mcp/reply.test.ts`, inside the `'workflow.stepView / workflow.pipeline / the write verdict'` describe, add (the file already imports `RUN_ID`, `runRow`, `stepRows`, `callOf`, `result`, `text`; add `formStepRows`, `REVIEW_INPUTS`, `POSTER_A`, `POSTER_B` to the fixtures import):

```ts
  it('answers a waiting form off the row: the evaluated fields, their defaults as initial values, title and submit (Phase 4, Decision 2)', () => {
    const r = result(callOf('workflow.stepView', { runId: RUN_ID, step: 'review/0/confirm' }), { run: [runRow()], steps: formStepRows() })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('review/0/confirm (form) is waiting — 3 fields: cover, notes, extra')
    expect(r.structuredContent).toEqual({
      runId: RUN_ID, step: 'review/0/confirm', impl: 'hello', workflow: 'interactive', kind: 'form', status: 'waiting',
      title: 'Review the card', submit: 'Approve',
      fields: REVIEW_INPUTS.fields,
      initial: { cover: null, notes: '## Notes\n\nHello, world!', extra: null },
    })
    const bare = formStepRows().map((row) => (row.key === 'review/0/confirm' ? { ...row, inputs: {} } : row))
    expect(result(callOf('workflow.stepView', { runId: RUN_ID, step: 'review/0/confirm' }), { run: [runRow()], steps: bare }).structuredContent!.errors).toEqual({
      step: "review/0/confirm: the form's evaluated fields were not recorded — complete it on the harness page",
    })
  })

  it('tells a text-only host how to open a form, and where runs are driven', () => {
    const status = result(callOf('workflow.status', { runId: RUN_ID }), { run: [runRow()], steps: formStepRows() })
    expect(text(status)).toContain(`call workflow.submitStep { runId: "${RUN_ID}", step: "review/0/confirm", values: {} } — the step's form renders in this chat`)
    const start = result(callOf('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: {} }), {})
    expect(start.isError).toBe(true)
    expect(text(start)).toBe('workflow.start is not served by the MCP endpoint: runs are driven on the harness page — by a person, or by an agent through the page’s own workflow.* tools (WebMCP). Ask the person to start it there; then watch it with workflow.status and complete its interactive steps here with workflow.submitStep.')
  })
```

Also update the existing island-only assertion at line ~199 (`'greet/0/say is a pipeline step, not an island'`) to `'greet/0/say is a pipeline step, not an interactive one'`.

- [ ] **Step 3: Write the failing merge tests** — in `apps/workflow/src/mcp/merge.test.ts` (add `formStepRows`, `POSTER_A` to the fixtures import; `FORM = 'review/0/confirm'`):

```ts
describe('merge: form steps (Phase 4, Decisions 2–3)', () => {
  const FORM = 'review/0/confirm'
  it('submitStep validates a form with the page’s validateFormOutputs and records the chosen ref, not its path', () => {
    const m = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: POSTER_A.path, notes: 'ok', extra: null } }), run: run(), steps: formStepRows() } })
    expect(m.update).toBe(true)
    expect(m.recordId).toBe('rec_s6')
    expect(m.fields).toMatchObject({ status: 'succeeded', outputs: { cover: POSTER_A, notes: 'ok', extra: null } })
    expect(text(m)).toBe(`Submitted ${FORM}; Run ${RUN_ID} is running`)
  })

  it('refuses per field, exactly as the page’s form pane words it', () => {
    const m = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { notes: 'x' } }), run: run(), steps: formStepRows() } })
    expect(m.update).toBe(false)
    expect(errors(m)).toEqual({ cover: 'This field is required' })
    const outside = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: 'workflows/elsewhere.svg' } }), run: run(), steps: formStepRows() } })
    expect(errors(outside)).toHaveProperty('cover')
  })

  it('opens the panel for a form with no values, and keeps workflow.submit / annotate island-only', () => {
    const panel = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: {} }), run: run(), steps: formStepRows() } })
    expect(panel.update).toBe(false)
    expect(text(panel)).toContain(`The step's form is rendered for the person to complete ${FORM} in`)
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: FORM, outputs: { cover: POSTER_A.path } }), run: run(), steps: formStepRows() } }))).toBe(`${FORM} is a form step — complete it with workflow.submitStep { values }`)
    expect(text(merge({ steps: { route: call('workflow.annotate', { runId: RUN_ID, step: FORM, summary: 's' }), run: run(), steps: formStepRows() } }))).toBe(`${FORM} is a form step, not an island`)
    const bare = formStepRows().map((row) => (row.key === FORM ? { ...row, inputs: {} } : row))
    expect(text(merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: POSTER_A.path } }), run: run(), steps: bare } }))).toBe(`${FORM}: the form's evaluated fields were not recorded — complete it on the harness page`)
  })
})
```

And in the existing `'needs a waiting island step'` test, replace the last two lines (the `form` case that expects `'form steps are not served'`) with:

```ts
    expect(text(done)).toBe('greet/0/say is a pipeline step, not an interactive one')
```

(the `done` assertion above it changes wording too — keep one assertion on `done`, delete the `form` one).

- [ ] **Step 4: Run both suites to see them fail**

Run: `pnpm --filter workflow test:run -- src/mcp/reply.test.ts src/mcp/merge.test.ts`
Expected: FAIL — the new tests (form answers, wording) and the two reworded assertions.

- [ ] **Step 5: Implement `reply.ts`**

In `apps/workflow/src/mcp/reply.ts`:

(a) `agentHostHint`:

```ts
export function agentHostHint(runId: string, snapshot: { waitingOn: Array<{ key: string; kind: string }> }): string {
  return snapshot.waitingOn
    .map((step) =>
      step.kind === 'island' || step.kind === 'form'
        ? `\nTo let the person complete ${step.key} here, call workflow.submitStep { runId: "${runId}", step: "${step.key}", values: {} } — the step's ${step.kind} renders in this chat; do not invent its values.`
        : '',
    )
    .join('')
}
```

(b) `stepView` — replace the kind check and add the form branch, keeping the island path as is:

```ts
/** `workflow.stepView` for a form (Phase 4, Decision 2): the fields the page evaluated when the step started waiting, straight off the row — nothing is re-evaluated here. */
function formView(route: Route, run: Row, row: Row): CallToolResult {
  if (row.status !== 'waiting') return refuse('step', `${route.key} is ${String(row.status)}, not waiting`)
  const inputs = isPlainObject(row.inputs) ? row.inputs : {}
  const fields = isPlainObject(inputs.fields) ? inputs.fields : null
  if (!fields) return refuse('step', `${route.key}: the form's evaluated fields were not recorded — complete it on the harness page`)
  const initial: Record<string, unknown> = {}
  for (const [name, decl] of Object.entries(fields)) {
    const field = isPlainObject(decl) ? decl : {}
    initial[name] = field.default === undefined ? null : field.default
  }
  const names = Object.keys(fields)
  const title = str(inputs.title) ?? String(row.step ?? route.key)
  const description = str(inputs.description)
  return textResult(`${route.key} (form) is waiting — ${names.length} field${names.length === 1 ? '' : 's'}: ${names.join(', ')}`, {
    runId: route.runId,
    step: route.key,
    impl: String(run.impl ?? ''),
    workflow: String(run.workflow ?? ''),
    kind: 'form',
    status: 'waiting',
    title,
    ...(description === undefined ? {} : { description }),
    submit: str(inputs.submit) ?? 'Submit',
    fields,
    initial,
  })
}
```

and in `stepView(route, steps)`, after `if (!row) return refuse('step', …)`:

```ts
  if (row.kind === 'form') return formView(route, resolved.run, row)
  if (row.kind !== 'island') return refuse('step', `${route.key} is a ${String(row.kind)} step, not an interactive one`)
```

(c) `notServed`:

```ts
function notServed(tool: string): CallToolResult {
  const message =
    tool === 'workflow.await'
      ? 'workflow.await is not served by the MCP endpoint — a stateless POST cannot wait; poll workflow.status'
      : `${tool} is not served by the MCP endpoint: runs are driven on the harness page — by a person, or by an agent through the page’s own workflow.* tools (WebMCP). Ask the person to start it there; then watch it with workflow.status and complete its interactive steps here with workflow.submitStep.`
  return refuse('tool', message)
}
```

- [ ] **Step 6: Implement `merge.ts`**

Add the import `import { validateFormOutputs } from '../lib/runner/adapters/form'` and `import type { InputDef } from '@bffless/workflow-lint/definition'`. Replace the two kind lines

```ts
  if (row.kind === 'form') return { ...refuse('step', 'form steps are not served over the MCP endpoint yet — complete it on the harness'), key }
  if (row.kind !== 'island') return { ...refuse('step', `${key} is a ${String(row.kind)} step, not an island`), key }
```

with

```ts
  const kind = row.kind === 'form' ? 'form' : row.kind === 'island' ? 'island' : null
  if (kind === null) return { ...refuse('step', `${key} is a ${String(row.kind)} step, not an interactive one`), key }
  // workflow.submit is the island's own bridge verb (spec 04); a form is completed with submitStep { values } (Decision 3).
  if (kind === 'form' && route.tool === 'workflow.submit') return { ...refuse('step', `${key} is a form step — complete it with workflow.submitStep { values }`), key }
  if (kind === 'form' && route.tool === 'workflow.annotate') return { ...refuse('step', `${key} is a form step, not an island`), key }
```

In the submit branch, change the panel text to name the kind:

```ts
          `${snapshotText(snapshot)}. The step's ${kind} is rendered for the person to complete ${key} in; no values are needed from you — once they submit, workflow.status shows ${key} succeeded.`,
```

and replace the declared-outputs validation block (`const step = declaredStep(…)` through the `errors` early return) with:

```ts
    let outputs: Record<string, unknown>
    if (kind === 'form') {
      const inputs = isPlainObject(row.inputs) ? row.inputs : {}
      const fields = isPlainObject(inputs.fields) ? (inputs.fields as Record<string, InputDef>) : null
      if (!fields) return { ...refuse('step', `${key}: the form's evaluated fields were not recorded — complete it on the harness page`), key }
      const verdict = validateFormOutputs(fields, raw)
      if (!verdict.ok) return { update: false, recordId, key, result: errorResult(JSON.stringify(verdict.errors), { errors: verdict.errors }) }
      outputs = verdict.outputs
    } else {
      const step = declaredStep(run.definition, String(row.job ?? ''), String(row.step ?? ''))
      if (!step) return { ...refuse('step', `${key}: the run's definition snapshot does not declare it`), key }
      const declared = validateDeclared(outputDecls(step), raw, { defaultType: 'json' })
      if (Object.keys(declared.errors).length > 0) {
        return { update: false, recordId, key, result: errorResult(JSON.stringify(declared.errors), { errors: declared.errors }) }
      }
      outputs = declared.outputs
    }
```

Update the header comment's "Islands only: a form's evaluated fields live in the page's state" sentence to: "Forms too (Phase 4): a form's evaluated fields ride its `waiting` row (`formInputs`), so `validateFormOutputs` — the page's own — judges a submit here."

- [ ] **Step 7: Wording in `hostTools.ts` and `mcpConfig.ts`**

`hostTools.ts` `workflow.stepView` description →

```ts
    description:
      "What the step view needs to mount a waiting interactive step. An island: its HTML (unchanged, fetched from the implementation's bundle), the step's persisted inputs (its tool-input arguments) and its declared outputs. A form: the fields the harness evaluated when the step started waiting, their initial values, the title and the submit label.",
```

`mcpConfig.ts`: `INSTRUCTIONS` → `` `The BFFless Workflow harness: ${CATALOG.length} workflow.* tools to list, describe and watch runs and complete a waiting interactive step (island or form). Pass runId to every run-scoped tool.` ``; the static resource `description` → `'Mounts a waiting island or form step of a run (spec 10).'`. Update `mcpConfig.test.ts` line 42's expected description string to match.

The `mcp` walk pins the old refusal: `packages/workflow-live/src/walks/mcp.ts:175` asserts `/Phase 4/.test(text(start))` in `spec10.notServedHonest`. Change that regex to `/driven on the harness page/` (same check name, same count — 26 stays 26). Because this PR now touches `workflow-live`, its chain (`pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`) joins Task 4's verify list.

- [ ] **Step 8: Regenerate the bundles and run the endpoint suites**

Run: `pnpm --filter workflow mcp:build && pnpm --filter workflow test:run -- src/mcp`
Expected: `wrote …/mcp-fn/reply.fn.js`, `wrote …/mcp-fn/merge.fn.js`, `wrote …/rules/api/workflow/mcp/any.rule.yaml`; every `src/mcp` suite passes including `bundle.test.ts` (fresh, no prohibited pattern, runs in the vm). If `bundle.test.ts` reports a global the vm lacks (e.g. `URL` from `inputConstraints`), add the polyfill in `src/mcp/polyfills.ts` following Phase 2 Decision 2 and rerun — never fork the validator.

- [ ] **Step 9: Commit**

```bash
git add apps/workflow/src/mcp apps/workflow/.bffless/proxy-rules/workflow
git commit -m "feat(workflow): the MCP endpoint answers and completes a waiting form step off its row — stepView's form shape, submitStep through validateFormOutputs; start/resume/cancel point at the page"
```

### Task 3: the step view renders and submits the form

**Files:**
- Modify: `apps/workflow/src/step-view/deps.ts` (`StepViewData` union, `readStepView`, `submitFormValues`)
- Create: `apps/workflow/src/step-view/StepForm.tsx`, `apps/workflow/src/step-view/StepForm.test.tsx`
- Rename + modify: `apps/workflow/src/step-view/main.ts` → `main.tsx`
- Modify: `apps/workflow/step/index.html`, `apps/workflow/vite.step.config.ts`
- Test: `apps/workflow/src/step-view/deps.test.ts`

**Interfaces:**
- Consumes: Task 2's form answer; `FieldControl` (`../components/kickoff/FieldControl`, props `{ name, def, value, onChange, upload?, error? }`); `blank(value, list)` from `../lib/autoStart`; `SubmitAnswer` from `../islands/IslandHost`.
- Produces: `readStepView(result): StepViewData` where `StepViewData = IslandStepView | FormStepView`; `submitFormValues(call, view: FormStepView, values): Promise<SubmitAnswer>`; `<StepForm title description? submitLabel fields initial onSubmit />` with `onSubmit: (values) => Promise<SubmitAnswer>`; DOM hooks the walk uses: `[data-testid="form-step"]`, `[data-testid="form-step-submit"]`, `[data-testid="submitted"]` (existing), `[data-testid="tile"]` (FieldControl's).

- [ ] **Step 1: Failing `deps.test.ts` cases** — append to `apps/workflow/src/step-view/deps.test.ts`:

```ts
const FORM_VIEW = {
  runId: 'run_1', step: 'review/0/confirm', impl: 'hello', workflow: 'interactive', kind: 'form', status: 'waiting',
  title: 'Review the card', submit: 'Approve',
  fields: { cover: { type: 'choice', options: [{ path: 'workflows/x/a.svg', name: 'a.svg', contentType: 'image/svg+xml', size: 1, url: '/api/uploads/workflows/x/a.svg' }], required: true }, notes: { type: 'markdown', default: 'n' } },
  initial: { cover: null, notes: 'n' },
}

describe('readStepView: forms', () => {
  it('reads a form answer, defaults description and initial values', () => {
    const view = readStepView(ok(FORM_VIEW))
    expect(view.kind).toBe('form')
    if (view.kind !== 'form') throw new Error('not a form')
    expect(view.title).toBe('Review the card')
    expect(view.submit).toBe('Approve')
    expect(Object.keys(view.fields)).toEqual(['cover', 'notes'])
    expect(view.initial).toEqual({ cover: null, notes: 'n' })
    expect(() => readStepView(ok({ ...FORM_VIEW, fields: undefined }))).toThrow('workflow.stepView answered without fields')
  })
})

describe('submitFormValues', () => {
  it('sends workflow.submitStep { runId, step, values } and reads the verdict the way the island path does', async () => {
    const { call, calls } = recorder({ 'workflow.submitStep': ok({ runId: 'run_1', step: 'review/0/confirm' }) })
    const view = readStepView(ok(FORM_VIEW))
    if (view.kind !== 'form') throw new Error('not a form')
    expect(await submitFormValues(call, view, { cover: 'workflows/x/a.svg', notes: 'n' })).toEqual({ ok: true })
    expect(calls).toEqual([{ name: 'workflow.submitStep', arguments: { runId: 'run_1', step: 'review/0/confirm', values: { cover: 'workflows/x/a.svg', notes: 'n' } } }])
    const refusing = recorder({ 'workflow.submitStep': refused('{"cover":"This field is required"}', { errors: { cover: 'This field is required' } }) })
    expect(await submitFormValues(refusing.call, view, {})).toEqual({ ok: false, errors: { cover: 'This field is required' } })
    const bare = recorder({ 'workflow.submitStep': refused('A harness tab still drives this run') })
    expect(await submitFormValues(bare.call, view, {})).toEqual({ ok: false, errors: { values: 'A harness tab still drives this run' } })
  })
})
```

(Import `submitFormValues` alongside `readStepView`.)

- [ ] **Step 2: Failing `StepForm.test.tsx`** — create `apps/workflow/src/step-view/StepForm.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { StepForm } from './StepForm'

const A = { path: 'workflows/x/a.svg', name: 'a.svg', contentType: 'image/svg+xml', size: 1, url: '/api/uploads/workflows/x/a.svg' }
const B = { ...A, path: 'workflows/x/b.svg', name: 'b.svg', url: '/api/uploads/workflows/x/b.svg' }
const fields: Record<string, InputDef> = {
  cover: { type: 'choice', options: [A, B], required: true } as InputDef,
  notes: { type: 'markdown', default: '## Notes' } as InputDef,
  extra: { type: 'file', accept: 'image/*' } as InputDef,
}
const initial = { cover: null, notes: '## Notes', extra: null }

function renderForm(onSubmit = vi.fn(async () => ({ ok: true as const }))) {
  render(<StepForm title="Review the card" submitLabel="Approve" fields={fields} initial={initial} onSubmit={onSubmit} />)
  return onSubmit
}

describe('StepForm', () => {
  it('renders the evaluated fields with the harness controls and the form’s own submit label', () => {
    renderForm()
    expect(screen.getByRole('heading', { name: 'Review the card' })).toBeInTheDocument()
    expect(screen.getAllByTestId('tile')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled() // cover is required and blank
  })

  it('submits the values once a required field is answered, and shows the server’s per-field refusal', async () => {
    const onSubmit = vi.fn(async (values: Record<string, unknown>) => (values.notes === 'bad' ? { ok: false as const, errors: { notes: 'Expected a valid markdown value' } } : { ok: true as const }))
    renderForm(onSubmit)
    fireEvent.click(screen.getAllByTestId('tile')[0]!)
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByText('Expected a valid markdown value')).toBeInTheDocument())
    expect(onSubmit).toHaveBeenLastCalledWith({ cover: A.path, notes: 'bad', extra: null })
    fireEvent.change(screen.getByLabelText(/notes/i), { target: { value: 'fine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()) // submitted once; never twice
    expect(onSubmit).toHaveBeenLastCalledWith({ cover: A.path, notes: 'fine', extra: null })
  })

  it('refuses to upload from inside an agent host and says where to attach the file', async () => {
    renderForm()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByText(/attach this one on the harness page/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run both to see them fail**

Run: `pnpm --filter workflow test:run -- src/step-view`
Expected: FAIL — `submitFormValues` is not exported; `StepForm` module not found.

- [ ] **Step 4: `deps.ts`** — replace the `StepViewData` interface and `readStepView` with:

```ts
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { IslandHostDeps, SubmitAnswer } from '../islands/IslandHost'

interface StepViewBase { runId: string; step: string; impl: string; workflow: string; status: string }
/** What `workflow.stepView` answers for an island: enough to mount it exactly as the harness page would. */
export interface IslandStepView extends StepViewBase { kind: 'island'; src: string; arguments: Record<string, unknown>; outputs?: Record<string, unknown>; html: string }
/** …and for a form (Phase 4, Decision 2): the fields the harness evaluated when the step started waiting, off the row. */
export interface FormStepView extends StepViewBase { kind: 'form'; title: string; description?: string; submit: string; fields: Record<string, InputDef>; initial: Record<string, unknown> }
export type StepViewData = IslandStepView | FormStepView

/** The `workflow.stepView` result, validated; throws with the result's text on a refusal or a malformed answer. */
export function readStepView(result: CallToolResult): StepViewData {
  if (result.isError) throw new Error(resultText(result) || 'workflow.stepView refused')
  const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
  const str = (key: string) => (typeof s[key] === 'string' ? (s[key] as string) : '')
  const base: StepViewBase = { runId: str('runId'), step: str('step'), impl: str('impl'), workflow: str('workflow'), status: str('status') }
  for (const key of ['runId', 'step', 'impl'] as const) {
    if (base[key] === '') throw new Error(`workflow.stepView answered without ${key}`)
  }
  if (str('kind') === 'form') {
    if (!isPlainObject(s.fields)) throw new Error('workflow.stepView answered without fields')
    return {
      ...base,
      kind: 'form',
      title: str('title') || base.step,
      ...(str('description') === '' ? {} : { description: str('description') }),
      submit: str('submit') || 'Submit',
      fields: s.fields as Record<string, InputDef>,
      initial: isPlainObject(s.initial) ? s.initial : {},
    }
  }
  const view: IslandStepView = {
    ...base,
    kind: 'island',
    src: str('src'),
    arguments: isPlainObject(s.arguments) ? s.arguments : {},
    ...(isPlainObject(s.outputs) ? { outputs: s.outputs } : {}),
    html: str('html'),
  }
  for (const key of ['src', 'html'] as const) {
    if (view[key] === '') throw new Error(`workflow.stepView answered without ${key}`)
  }
  return view
}

/** A form's submit over the bridge: `workflow.submitStep { runId, step, values }`, the verdict read as the island path reads `workflow.submit`'s (Decision 3). */
export async function submitFormValues(call: ServerCall, view: FormStepView, values: Record<string, unknown>): Promise<SubmitAnswer> {
  const result = await call({ name: 'workflow.submitStep', arguments: { runId: view.runId, step: view.step, values } })
  if (!result.isError) return { ok: true }
  const s = isPlainObject(result.structuredContent) ? result.structuredContent : {}
  const errors = isPlainObject(s.errors)
    ? Object.fromEntries(Object.entries(s.errors).map(([key, value]) => [key, String(value)]))
    : { values: resultText(result) || 'workflow.submitStep refused' }
  return { ok: false, errors }
}
```

`stepViewDeps(call, view: IslandStepView, hooks)` — narrow its parameter type to `IslandStepView` (the body is unchanged). Update the header comment: the surface is the four app-only tools + `workflow.sign` **+ `workflow.submitStep` for forms**.

- [ ] **Step 5: `StepForm.tsx`** — create:

```tsx
/**
 * A waiting form step inside an agent host (Phase 4, Decisions 4–6): the
 * harness's own field controls over the fields the endpoint answered — the
 * ones the page evaluated when the step started waiting — submitted through
 * the bridge. No validation of its own: Submit is disabled while a required
 * field is blank (the kickoff form's rule), the endpoint's `validateFormOutputs`
 * is the authority, and its per-field refusals land under the fields. Files
 * cannot be attached from a sandboxed origin, so the file control's upload
 * refuses with a message that says where to attach one.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { FieldControl } from '../components/kickoff/FieldControl'
import type { SubmitAnswer } from '../islands/IslandHost'
import { blank } from '../lib/autoStart'
import type { FileRef } from '../lib/runner/types'

export const NO_UPLOADS = 'Files cannot be attached from inside an agent host — attach this one on the harness page'

export interface StepFormProps {
  title: string
  description?: string
  submitLabel: string
  fields: Record<string, InputDef>
  initial: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => Promise<SubmitAnswer>
}

const refuseUpload = (): Promise<FileRef> => Promise.reject(new Error(NO_UPLOADS))

export function StepForm({ title, description, submitLabel, fields, initial, onSubmit }: StepFormProps) {
  const names = Object.keys(fields)
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  function setValue(name: string, v: unknown) {
    setValues((prev) => ({ ...prev, [name]: v }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setPending(true)
    try {
      const answer = await onSubmit(values)
      if (answer.ok) {
        setErrors({})
        setDone(true)
      } else {
        setErrors(answer.errors)
      }
    } finally {
      setPending(false)
    }
  }

  const missingRequired = names.some((name) => {
    const def = fields[name]!
    return def.required === true && blank(values[name] ?? null, def.list === true)
  })

  return (
    <form className="form step-form" data-testid="form-step" onSubmit={(e) => void handleSubmit(e)} noValidate>
      <h2 className="graph-panel-title">{title}</h2>
      {description && <p className="field-description">{description}</p>}
      {names.length === 0 && <p className="note">This step declares no fields.</p>}
      {names.map((name) => (
        <FieldControl key={name} name={name} def={fields[name]!} value={values[name] ?? null} onChange={(v) => setValue(name, v)} upload={refuseUpload} error={errors[name]} />
      ))}
      {errors.values && (
        <p className="field-error" role="alert" data-testid="form-step-error">
          {errors.values}
        </p>
      )}
      <button type="submit" data-testid="form-step-submit" disabled={pending || done || missingRequired}>
        {submitLabel}
      </button>
    </form>
  )
}
```

If `FieldControl`'s `FileControl` reports the rejection through a different prop than `onError`/`localError` (check `src/components/kickoff/FieldControl.tsx:225-237` and the `FileControl` it renders), route the message through whatever it shows — the test asserts the text, not the mechanism.

- [ ] **Step 6: `main.ts` → `main.tsx`** — `git mv apps/workflow/src/step-view/main.ts apps/workflow/src/step-view/main.tsx`, then: add the imports

```tsx
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { StepForm } from './StepForm'
import { readStepView, stepViewDeps, submitFormValues } from './deps'
import '../index.css'
```

add `const formRoot = el<HTMLDivElement>('form')` and `let reactRoot: Root | null = null` next to the other elements, and replace the body of the `void (async () => { … })()` in `app.ontoolinput` with:

```tsx
    try {
      const view = readStepView(await call({ name: 'workflow.stepView', arguments: { runId, step } }))
      if (controller.signal.aborted) return
      const finished = () => {
        submitted.textContent = `Submitted ${view.step}. Open run ${view.runId} on the harness and Resume to continue.`
        submitted.hidden = false
        say(`${view.step} submitted`)
      }
      if (view.kind === 'form') {
        title.textContent = `${view.workflow}: ${view.title}`
        frame.hidden = true
        formRoot.hidden = false
        reactRoot ??= createRoot(formRoot)
        reactRoot.render(
          <StepForm
            title={view.title}
            description={view.description}
            submitLabel={view.submit}
            fields={view.fields}
            initial={view.initial}
            onSubmit={async (values) => {
              const answer = await submitFormValues(call, view, values)
              if (answer.ok) finished()
              return answer
            }}
          />,
        )
        say(`${view.step} is waiting for you`)
        return
      }
      formRoot.hidden = true
      frame.hidden = false
      title.textContent = `${view.workflow}: ${view.step}`
      const host = createIslandHost(stepViewDeps(call, view, { onLog: (line) => say(line), onSubmitted: finished }))
      await host.mount(frame, { impl: view.impl, src: view.src, arguments: view.arguments, headless: false, signal: controller.signal })
      say(`${view.impl}/${view.src} is waiting for you`)
    } catch (error) {
      if (controller.signal.aborted) return
      say(error instanceof Error ? error.message : String(error), 'error')
    }
```

`step/index.html`: change the script tag to `<script type="module" src="/src/step-view/main.tsx"></script>`, add `<div data-testid="form" hidden></div>` after the island iframe, and update the head comment to say "the waiting island mounts in the nested frame below, unchanged; a waiting form renders in the React root beside it (Phase 4)".

`vite.step.config.ts`: `import react from '@vitejs/plugin-react'` and `plugins: [react(), viteSingleFile(), flattenStep()]`; extend the header comment's first paragraph with "React (`@vitejs/plugin-react`) is here for the form branch only; the island branch stays vanilla."

- [ ] **Step 7: Run the step-view suites, then the app chain**

Run: `pnpm --filter workflow test:run -- src/step-view`
Expected: PASS (deps: the existing cases + 2 new; StepForm: 3).

Run: `pnpm --filter workflow mcp:build && pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build && pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`
Expected: `mcp:build` all `unchanged` (Task 2 already regenerated — note a `src/step-view` change does not alter any bundle); lint clean; `workflow:test` ≥ 1682 passed (1677 + the new cases; 14 skipped unchanged); `workflow:build` writes `dist/index.html` and `dist/step.html`. Check `ls -la apps/workflow/dist/step.html` — expect roughly 0.5–0.7 MB (React + the css inlined). `workflow-live` green (Task 2's one-line walk change).

- [ ] **Step 8: Commit**

```bash
git add apps/workflow/src/step-view apps/workflow/step/index.html apps/workflow/vite.step.config.ts
git commit -m "feat(workflow): the step view renders a waiting form with the harness's own field controls and submits it through the bridge"
```

### Task 4: story-10 verification on the scratch host, the PR

**Files:** none new. Uses `apps/workflow/bffless/README.md` §"Redeploy" (steps 1–2) and the helper shape below.

- [ ] **Step 1: Deploy the branch to the scratch project (act-and-report)** — the rule set (with the regenerated bundles) and the harness build (with the new `step.html`):

```bash
cat > /tmp/claude-1000/scratch-redeploy.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. "$HOME/.config/bffless/workflow-mcp.env"
WT="$1"
npx -y bffless@0.3.6 rules push "$WT/apps/workflow/.bffless/proxy-rules/workflow" --project bffless/workflow-mcp --api-url "$BFFLESS_API_URL" --prune
(cd "$WT/apps/workflow" && rm -f /tmp/claude-1000/wf.zip && python3 -c "import shutil; shutil.make_archive('/tmp/claude-1000/wf','zip','.','dist')")
curl -sS -X POST "$BFFLESS_API_URL/api/deployments/zip" -H "X-API-Key: $BFFLESS_API_KEY" -F file=@/tmp/claude-1000/wf.zip -F repository=bffless/workflow-mcp -F commitSha="$(git -C "$WT" rev-parse HEAD)" -F branch="$(git -C "$WT" branch --show-current)" -F isPublic=true -F alias=workflow -F proxyRuleSetNames=workflow
echo
EOF
bash /tmp/claude-1000/scratch-redeploy.sh /home/rico/bffless/repos/apps/.claude/worktrees/m5-step-view-forms
```

Expected: `workflow: 0 created, N updated, 0 deleted, …` (the `mcp` endpoint rule, the `submitStep`/`submit`/`annotate`/`stepView` siblings' bundles) and a deployment JSON with `"aliases":["workflow",…]`.

- [ ] **Step 2: Round-trip a form by hand** — park a run on its form through the page tools and complete it over the endpoint with the project key (`allowApiKey: true` on every MCP rule):

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/m5-step-view-forms
set -a; . ~/.config/bffless/workflow-ci.env; set +a   # if the shell guard refuses `source`, put the two exports in a script file
WORKFLOW_EMAIL=$WORKFLOW_CI_EMAIL WORKFLOW_PASSWORD=$WORKFLOW_CI_PASSWORD pnpm workflow-live:walk page-tools --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/pt
```

`page-tools` completes a whole run; to *park* one on the form instead, use the `mcp-app --park-only` flag once Task 9 exists — for this task, park by hand with the driver's page tools in a one-off Node script (`callPageTool` from `@bffless/workflow-headless`, the sequence in `packages/workflow-live/src/walks/page-tools.ts:86-101`: `start` → `await waiting` → `submitStep` island → `await waiting`), close the browser, wait 60 s, then:

```bash
S=/tmp/claude-1000/-home-rico-bffless-repos-apps/a7b15094-fd74-4230-95e4-db7fb795e574/scratchpad/scratch-mcp.sh   # from the brainstorm: one JSON-RPC message with the project key
$S tools/call '{"name":"workflow.stepView","arguments":{"runId":"<RUN>","step":"review/0/confirm"}}' | python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r['content'][0]['text']); print(list(r['structuredContent']['fields']))"
$S tools/call '{"name":"workflow.submitStep","arguments":{"runId":"<RUN>","step":"review/0/confirm","values":{"notes":"x"}}}' | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])"
$S tools/call '{"name":"workflow.submitStep","arguments":{"runId":"<RUN>","step":"review/0/confirm","values":{"cover":"<POSTER PATH FROM fields.cover.options[0].path>","notes":"approved over the endpoint","extra":null}}}' | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['content'][0]['text'])"
$S resources/read '{"uri":"ui://bffless/workflow/step-view.html"}' | python3 -c "import sys,json; c=json.load(sys.stdin)['result']['contents'][0]; print(c['mimeType'], len(c['text']), 'form-step' in c['text'])"
```

Expected: `review/0/confirm (form) is waiting — 3 fields: cover, notes, extra`; the empty submit refused with `errors.cover`; `Submitted review/0/confirm; Run … is running`; the resource ~600 KB containing `form-step`. Paste the four outputs in the PR body.

- [ ] **Step 3: The walks that must not move**

```bash
pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/walk-mcp
pnpm workflow-live:walk oauth --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/walk-oauth
```

Expected: `mcp` **26/26**, `oauth` **9/9** (report.md under each out dir). Read them; paste the counts.

- [ ] **Step 4: Open PR A**

```bash
git push -u origin feat/m5-step-view-forms
gh pr create --base epic/agent-embedding --title "feat(workflow): the step view completes form steps — evaluated fields off the row, StepForm in the view, workflow.submitStep serves forms" --body-file - <<'EOF'
Story 10 of #554 (re-scoped 2026-09-04: the run view is not built; see the Phase 4 plan). A waiting **form** step now completes inside an agent host the way an island does: `workflow.stepView` answers the fields the harness evaluated when the step started waiting (off the row — nothing re-evaluated), the served step view renders them with the harness's `FieldControl`s, and `workflow.submitStep { values }` is judged by `validateFormOutputs` — the page's own validator. `workflow.submit`/`annotate` stay island-only; `start`/`resume`/`cancel` now point at the page. File fields cannot upload from a sandboxed origin and say so.

Verify chain: (paste real counts — agent-tools lint/build/test; `mcp:build`; workflow lint/test/build; `apps:check`); scratch: the four hand round-trip outputs; `mcp` 26/26, `oauth` 9/9.

Gate half for the person (screenshots here): park a run on its form (`pnpm workflow-live:walk mcp-app --harness https://workflow.j5s.dev --park-only`, once #… lands; until then the hand sequence in the plan's Task 4), then in claude.ai: "Show me run <id>" → `submitStep { values: {} }` → the form card → Approve.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Then read every automated review comment on the PR before recommending a merge; fix what is real, answer what is not, on the same branch.

---

## Story 11 — hashed resource URIs (PR B) and the `mcp-app` walk (PR C)

*Deliverable: `tools/list` carries `ui://bffless/workflow/step-view.<rev>.html`, the walks read it; a new `mcp-app` walk mounts the served step view in an emulated MCP Apps host and completes an island and a form through it, green on the scratch host and on `workflow.j5s.dev`.*

Setup: worktree `.claude/worktrees/m5-resource-uris`, branch `feat/m5-resource-uris` off `feat/m5-step-view-forms` (stacked; rebase `--onto origin/epic/agent-embedding <A-tip>` after A merges); then `.claude/worktrees/m5-mcp-app-walk`, branch `feat/m5-mcp-app-walk` off `feat/m5-resource-uris`. Same install/build/stage sequence as story 10.

### Task 5: the resource URI carries a source revision (apps#587)

**Files:**
- Modify: `apps/workflow/scripts/build-mcp.mjs` (`sourceRev()`, `renderedRules()`)
- Modify: `apps/workflow/src/mcp/hostTools.ts` (`STEP_VIEW_URI` → `stepViewUri(rev)` + `STEP_VIEW_URI_PATTERN`), `apps/workflow/src/mcp/mcpConfig.ts` (`mcpHandlerConfig({ rev })`)
- Test: `apps/workflow/src/mcp/hostTools.test.ts`, `apps/workflow/src/mcp/mcpConfig.test.ts`, `apps/workflow/src/mcp/bundle.test.ts` (a `sourceRev` shape test)
- Regenerate: `rules/api/workflow/mcp/any.rule.yaml`, `rules/api/workflow/mcp-resources/step-view/get/rule.yaml`

**Interfaces:**
- Produces: `stepViewUri(rev: string): string`; `STEP_VIEW_URI_PATTERN: RegExp`; `mcpHandlerConfig(o: { rev: string })`; `sourceRev(): string` (build script export). Task 6 and the walks consume only the pattern and `tools/list`.

- [ ] **Step 1: Failing tests** — in `hostTools.test.ts` replace the `'names the MCP Apps MIME type and the step view'` case with:

```ts
  it('names the MCP Apps MIME type and a revisioned step-view URI (apps#587)', () => {
    expect(RESOURCE_MIME).toBe('text/html;profile=mcp-app')
    expect(stepViewUri('0123abcd')).toBe('ui://bffless/workflow/step-view.0123abcd.html')
    expect(STEP_VIEW_URI_PATTERN.test(stepViewUri('0123abcd'))).toBe(true)
    expect(STEP_VIEW_URI_PATTERN.test('ui://bffless/workflow/step-view.html')).toBe(false)
  })
```

In `mcpConfig.test.ts`: `const REV = '0123abcd'`, `mcpHandlerConfig({ rev: REV })`, and every `STEP_VIEW_URI` → `stepViewUri(REV)`. In `bundle.test.ts` add:

```ts
describe('the source revision (apps#587)', () => {
  it('is 8 hex chars, stable across calls, and the rendered endpoint rule carries it', async () => {
    const rev = sourceRev()
    expect(rev).toMatch(/^[0-9a-f]{8}$/)
    expect(sourceRev()).toBe(rev)
    const endpoint = (await renderedRules()).find(([rel]) => rel === 'rules/api/workflow/mcp/any.rule.yaml')![1]
    expect(endpoint).toContain(`ui://bffless/workflow/step-view.${rev}.html`)
  })
})
```

(import `sourceRev` from `../../scripts/build-mcp.mjs`).

- [ ] **Step 2: See them fail**

Run: `pnpm --filter workflow test:run -- src/mcp/hostTools src/mcp/mcpConfig src/mcp/bundle`
Expected: FAIL — `stepViewUri`/`sourceRev` not exported.

- [ ] **Step 3: Implement**

`hostTools.ts` — replace the `STEP_VIEW_URI` constant with:

```ts
/**
 * The step view's resource URI for one source revision (apps#587): claude.ai
 * caches a widget's resource per URI per connector, so a stale fetch (the
 * Phase-3 not-found page) outlived the deploy that fixed it until the URI
 * changed. The revision is a hash of `src/**` (`scripts/build-mcp.mjs`
 * `sourceRev`), rendered into the rule at `mcp:build` time — every deploy
 * that changes the view is a cache miss by construction.
 */
export const stepViewUri = (rev: string): string => `ui://bffless/workflow/step-view.${rev}.html`
/** What a host or a walk may assert about the URI; never a literal (the revision is the build's). */
export const STEP_VIEW_URI_PATTERN = /^ui:\/\/bffless\/workflow\/step-view\.[0-9a-f]{8}\.html$/
```

`mcpConfig.ts` — `export function mcpHandlerConfig({ rev }: { rev: string }): Record<string, unknown>`, `const uri = stepViewUri(rev)`, use `uri` in the `submitStep` `_meta` and the static resource.

`scripts/build-mcp.mjs` — add:

```js
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { sep } from 'node:path'

function walkFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walkFiles(path) : [path]
  })
}

/**
 * The source revision the ui:// resource URIs carry (apps#587): SHA-256 over
 * every non-test source file plus package.json, first 8 hex. Any change to the
 * harness's sources re-keys the step view's URI; bundle.test.ts holds the
 * committed rule to this value, so `mcp:build` stays in the verify chain.
 */
export function sourceRev() {
  const src = join(app, 'src')
  const files = walkFiles(src)
    .filter((f) => !/\.test\.[jt]sx?$/.test(f))
    .filter((f) => !f.includes(`${sep}mocks${sep}`) && !f.includes(`${sep}test${sep}`))
    .sort()
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(relative(app, f)).update('\0').update(readFileSync(f)).update('\0')
  }
  hash.update(readFileSync(join(app, 'package.json')))
  return hash.digest('hex').slice(0, 8)
}
```

In `renderedRules()`: `const rev = sourceRev()`, `const config = cfg.mcpHandlerConfig({ rev })`, and the step-view resource rule's `name`/`description` → `'The step view (' + cfg.stepViewUri(rev) + ', spec 10; apps#587): /step.html fetched in-process …'`. Also export `stepViewUri` from `mcpConfig.ts` (`export { stepViewUri } from './hostTools'`) so `loadConfig()` sees it.

Update `apps/workflow/CONTEXT.md`'s **Step view** entry (line ~208) to name the URI as `ui://bffless/workflow/step-view.<rev>.html` and say what `<rev>` is (Task 12 rewrites the whole entry; do the URI now).

- [ ] **Step 4: Regenerate, run, build**

Run: `pnpm --filter workflow mcp:build && pnpm --filter workflow test:run -- src/mcp && pnpm workflow:lint && pnpm workflow:build`
Expected: the endpoint rule and the step-view resource rule rewritten with the hashed URI; all `src/mcp` suites green; lint/build green.

- [ ] **Step 5: Commit**

```bash
git add apps/workflow/scripts/build-mcp.mjs apps/workflow/src/mcp apps/workflow/.bffless/proxy-rules/workflow apps/workflow/CONTEXT.md
git commit -m "feat(workflow): build-hashed ui:// resource URIs — the step view's URI carries a source revision so a host's per-URI cache never pins a stale fetch (#587)"
```

### Task 6: the walks read the URI from `tools/list`

**Files:**
- Modify: `packages/workflow-live/src/walks/mcp.ts:29` (`STEP_VIEW_URI` constant and its three uses)
- Modify: `packages/workflow-live/src/mcp-checks.ts` (add `STEP_VIEW_URI_PATTERN` mirror + `stepViewUriOf(listed)`)
- Test: `packages/workflow-live/src/mcp-checks.test.ts`

**Interfaces:**
- Produces: `stepViewUriOf(listed: ListedTool[]): string` — `workflow.submitStep`'s `_meta.ui.resourceUri` or `''`; `STEP_VIEW_URI_PATTERN` (the same regex as `hostTools.ts` — `workflow-live` must not import the app).

- [ ] **Step 1: Failing test** — in `mcp-checks.test.ts`:

```ts
import { STEP_VIEW_URI_PATTERN, stepViewUriOf } from './mcp-checks.js'

describe('stepViewUriOf', () => {
  it('reads the revisioned step-view URI off tools/list', () => {
    const listed = [{ name: 'workflow.submitStep', _meta: { ui: { resourceUri: 'ui://bffless/workflow/step-view.0123abcd.html' } } }, { name: 'workflow.status' }]
    expect(stepViewUriOf(listed)).toBe('ui://bffless/workflow/step-view.0123abcd.html')
    expect(STEP_VIEW_URI_PATTERN.test(stepViewUriOf(listed))).toBe(true)
    expect(stepViewUriOf([{ name: 'workflow.status' }])).toBe('')
  })
})
```

- [ ] **Step 2: See it fail** — `pnpm --filter @bffless/workflow-live test:run -- mcp-checks` → FAIL (not exported).

- [ ] **Step 3: Implement** — in `mcp-checks.ts`:

```ts
/** `apps/workflow/src/mcp/hostTools.ts`'s pattern, restated: the walks never import the app. */
export const STEP_VIEW_URI_PATTERN = /^ui:\/\/bffless\/workflow\/step-view\.[0-9a-f]{8}\.html$/

/** The step view's URI as `tools/list` carries it on `workflow.submitStep` (apps#587), `''` when absent. */
export function stepViewUriOf(listed: ListedTool[]): string {
  return listed.find((tool) => tool.name === 'workflow.submitStep')?._meta?.ui?.resourceUri ?? ''
}
```

In `walks/mcp.ts`: delete `const STEP_VIEW_URI = …`; after `const listed = …`, add `const stepViewUri = stepViewUriOf(listed)`; the `spec10.appOnlyHidden` check becomes `… && STEP_VIEW_URI_PATTERN.test(stepViewUri)` with `resourceUri: stepViewUri` in the evidence; `spec10.resourcesList` uses `uris.includes(stepViewUri)`. The check names stay.

- [ ] **Step 4: Chain + a scratch run**

Run: `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`; deploy the branch to scratch (Task 4 Step 1's script with this worktree); `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/walk-mcp-587`
Expected: **26/26**, `spec10.appOnlyHidden` evidence showing the hashed URI.

- [ ] **Step 5: Commit, open PR B (stacked on A)**

```bash
git add packages/workflow-live
git commit -m "feat(workflow-live): the mcp walk reads the step view's revisioned URI off tools/list"
git push -u origin feat/m5-resource-uris
gh pr create --base feat/m5-step-view-forms --title "feat(workflow): build-hashed ui:// resource URIs so an agent host's per-URI cache never pins a stale fetch (#587)" --body "Closes #587. …(counts)…"
```

(retarget `--base epic/agent-embedding` + rebase `--onto` once A merges).

### Task 7: parking is shared — `park.ts`

**Files:**
- Create: `packages/workflow-live/src/park.ts`, `packages/workflow-live/src/park.test.ts`
- Modify: `packages/workflow-live/src/walks/mcp.ts:~183-235` (the inline park block)

**Interfaces:**
- Produces:

```ts
export const ISLAND_STEP = 'pick/0/choose'
export const FORM_STEP = 'review/0/confirm'
export type ParkUntil = 'island' | 'form'
export interface Parked { runId: string; step: string; kind: ParkUntil; waitingOn: Array<{ key: string; kind: string }>; rowStatus: string; rowWaitMs: number; startedOk: boolean; waitingOk: boolean }
export async function parkHelloRun(s: Session, until: ParkUntil, say: (line: string) => void): Promise<Parked>
```

- [ ] **Step 1: Failing test** — `park.test.ts` drives `parkHelloRun` with a fake `Session` (`page` stub whose `callPageTool` is answered by a script; `api.json` answering the row) and asserts the tool sequence per `until`:

```ts
import { describe, expect, it, vi } from 'vitest'
vi.mock('@bffless/workflow-headless', () => ({
  waitForPageTools: vi.fn(async () => undefined),
  callPageTool: vi.fn(async (_page: unknown, name: string, args: Record<string, unknown>) => {
    if (name === 'workflow.start') return { structuredContent: { runId: 'run_1' } }
    if (name === 'workflow.await') return { structuredContent: { waitingOn: [{ key: (args.__nth as number) === 2 ? 'review/0/confirm' : 'pick/0/choose', kind: 'island' }] } }
    if (name === 'workflow.submitStep') return { structuredContent: {} }
    throw new Error(name)
  }),
}))
import { callPageTool } from '@bffless/workflow-headless'
import { parkHelloRun } from './park.js'

const session = (rowStatus: string) => ({ page: {}, api: { json: vi.fn(async () => ({ status: 200, body: { steps: [{ key: 'pick/0/choose', status: rowStatus }, { key: 'review/0/confirm', status: rowStatus }] } })) }, close: vi.fn(async () => undefined), shot: vi.fn(async () => undefined) }) as never

describe('parkHelloRun', () => {
  it('parks on the island: start → await, then closes the browser', async () => {
    const parked = await parkHelloRun(session('waiting'), 'island', () => undefined)
    expect(parked).toMatchObject({ runId: 'run_1', step: 'pick/0/choose', kind: 'island', rowStatus: 'waiting' })
    expect(vi.mocked(callPageTool).mock.calls.map((c) => c[1])).toEqual(['workflow.start', 'workflow.await'])
  })
  it('parks on the form: submits the island through the page tools first', async () => {
    vi.mocked(callPageTool).mockClear()
    const parked = await parkHelloRun(session('waiting'), 'form', () => undefined)
    expect(parked.step).toBe('review/0/confirm')
    expect(vi.mocked(callPageTool).mock.calls.map((c) => c[1])).toEqual(['workflow.start', 'workflow.await', 'workflow.submitStep', 'workflow.await'])
  })
})
```

(The `__nth` trick is not needed if the mock counts `await` calls itself — implement the mock as a closure with a counter; the assertion is the call order.)

- [ ] **Step 2: See it fail** — `pnpm --filter @bffless/workflow-live test:run -- park` → module not found.

- [ ] **Step 3: Implement `park.ts`** — the `mcp` walk's block, generalised:

```ts
/**
 * Park a `hello/interactive` run on one of its interactive steps **through the
 * page tools** (the member's browser drives; spec 10 D21), wait for the row to
 * say what the page says (the endpoint reads rows — Phase 2 as shipped), and
 * close the browser so the lease lapses within 60 s. Shared by the `mcp` walk
 * (island) and the `mcp-app` walk (island, then form); `--park-only` in both.
 */
import { callPageTool, waitForPageTools } from '@bffless/workflow-headless'
import type { Session } from './session.js'

export const ISLAND_STEP = 'pick/0/choose'
export const FORM_STEP = 'review/0/confirm'
export type ParkUntil = 'island' | 'form'
export interface Parked { runId: string; step: string; kind: ParkUntil; waitingOn: Array<{ key: string; kind: string }>; rowStatus: string; rowWaitMs: number; startedOk: boolean; waitingOk: boolean }

const INPUTS = { greeting: 'Hello', names: ['world', 'studio'] }
const ISLAND_VALUES = { line: 'Hello, world!', index: 0 }

export async function parkHelloRun(s: Session, until: ParkUntil, say: (line: string) => void): Promise<Parked> {
  const step = until === 'island' ? ISLAND_STEP : FORM_STEP
  try {
    await waitForPageTools(s.page, { timeoutMs: 30_000 })
    const started = await callPageTool(s.page, 'workflow.start', { impl: 'hello', workflow: 'interactive', inputs: INPUTS })
    const runId = String(((started.structuredContent ?? {}) as { runId?: string }).runId ?? '')
    let waiting = await callPageTool(s.page, 'workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    if (until === 'form') {
      await callPageTool(s.page, 'workflow.submitStep', { step: ISLAND_STEP, values: ISLAND_VALUES })
      waiting = await callPageTool(s.page, 'workflow.await', { until: 'waiting', timeoutMs: 180_000 }) // the page runs the card script in between
    }
    const waitingOn = ((waiting.structuredContent ?? {}) as { waitingOn?: Array<{ key: string; kind: string }> }).waitingOn ?? []
    let rowStatus = ''
    const rowStart = Date.now()
    while (runId !== '' && Date.now() - rowStart < 30_000 && rowStatus !== 'waiting') {
      const record = await s.api.json(`/api/workflow/run?id=${encodeURIComponent(runId)}`)
      const rows = ((record.body as { steps?: Array<Record<string, unknown>> } | null)?.steps ?? []).map((r) => (r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : r))
      rowStatus = String(rows.find((r) => r.key === step)?.status ?? '')
      if (rowStatus !== 'waiting') await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    say(`parked ${runId} on ${step} (${rowStatus})`)
    await s.shot(`01-parked-${until}`)
    return { runId, step, kind: until, waitingOn, rowStatus, rowWaitMs: Date.now() - rowStart, startedOk: !started.isError, waitingOk: !waiting.isError }
  } finally {
    await s.close() // the driver goes away; the lease lapses within 60 s
  }
}
```

In `walks/mcp.ts`, replace the inline block (from `const s = browser` to `browser = null` inside `if (!parked)`) with:

```ts
      const s = browser
      if (!s) return report.block('no browser session to park a run with')
      const p = await parkHelloRun(s, 'island', say)
      browser = null
      parked = p.runId
      report.expect('spec10.parkIsland', p.startedOk && p.waitingOk && parked !== '' && p.waitingOn[0]?.key === STEP && p.waitingOn[0].kind === 'island' && p.rowStatus === 'waiting', {
        runId: parked,
        waitingOn: p.waitingOn,
        rowStatus: p.rowStatus,
        rowWaitMs: p.rowWaitMs,
      })
```

(the `finally { await s.close() }` moves into `parkHelloRun`; `const STEP = 'pick/0/choose'` → `import { ISLAND_STEP as STEP } from '../park.js'`).

- [ ] **Step 4: Chain + the `mcp` walk once more** — `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test`; `pnpm workflow-live:walk mcp --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/walk-mcp-park` → **26/26**, `spec10.parkIsland` evidence identical in shape.

- [ ] **Step 5: Commit** — `git commit -am "refactor(workflow-live): parkHelloRun — the mcp walk's park block, shared, with a form target"`.

### Task 8: the emulated MCP Apps host

**Files:**
- Create: `packages/workflow-live/src/host-emu.ts`, `packages/workflow-live/src/host-emu.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ToolCallParams { name: string; arguments?: Record<string, unknown> }
export interface EmulatedHost {
  /** Mount a ui:// resource's HTML in a fresh sandboxed frame and send `tool-input` once the app reports `initialized`. Resolves with the frame's locator once `ui/initialize` was answered — the `page.locator(iframe).contentFrame()` idiom the `hello`/`interactive` walks use, so `view.getByTestId(...)` and `view.locator('[data-testid="island"]').contentFrame()` (the nested island) both work. */
  mount(html: string, toolInput: Record<string, unknown>): Promise<FrameLocator>
  /** Every JSON-RPC method the app sent, in order (`ui/initialize`, `ui/notifications/initialized`, `tools/call`, `ui/notifications/size-changed …`). */
  log(): Promise<string[]>
  /** Every `size-changed` height received. */
  heights(): Promise<number[]>
}
export async function openEmulatedHost(page: Page, callTool: (params: ToolCallParams) => Promise<unknown>): Promise<EmulatedHost>
export const HOST_HTML: string   // exported for the unit test
```

- [ ] **Step 1: Failing test** — `host-emu.test.ts` (node, no browser): asserts the host page answers the protocol correctly by evaluating its script in a jsdom-free way is not practical; instead test the pure part — export `hostReply(message, callTool)` (the reducer the page script uses) and test it:

```ts
import { describe, expect, it, vi } from 'vitest'
import { hostReply } from './host-emu.js'

describe('hostReply — the host side of the MCP Apps bridge', () => {
  it('answers ui/initialize with a host that proxies server tools and starts inline', async () => {
    const out = await hostReply({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'x', version: '0' }, appCapabilities: {} } }, vi.fn(), { impl: 'hello' })
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'workflow-live host-emu', version: '0.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {} }, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }])
  })
  it('sends tool-input on initialized, proxies tools/call, echoes request-display-mode, ignores notifications', async () => {
    const callTool = vi.fn(async () => ({ content: [] }))
    expect(await hostReply({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, callTool, { runId: 'r' })).toEqual([{ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { runId: 'r' } } }])
    expect(await hostReply({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'workflow.status', arguments: { runId: 'r' } } }, callTool, {})).toEqual([{ jsonrpc: '2.0', id: 7, result: { content: [] } }])
    expect(callTool).toHaveBeenCalledWith({ name: 'workflow.status', arguments: { runId: 'r' } })
    expect(await hostReply({ jsonrpc: '2.0', id: 8, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } }, callTool, {})).toEqual([{ jsonrpc: '2.0', id: 8, result: { mode: 'fullscreen' } }])
    expect(await hostReply({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 300 } }, callTool, {})).toEqual([])
  })
})
```

- [ ] **Step 2: See it fail** — module not found.

- [ ] **Step 3: Implement `host-emu.ts`** — the reducer is shared between the test and the page (serialised into the page with `String(hostReply)`):

```ts
/**
 * An emulated MCP Apps host (apps#586; Phase 4 plan, Decision 8): what
 * claude.ai does that no walk did before — a `sandbox="allow-scripts
 * allow-same-origin"` frame whose document is `document.write`n from the
 * resource text, and the host half of the ext-apps bridge as JSON-RPC over
 * postMessage: `ui/initialize` answered, `ui/notifications/tool-input` sent on
 * `initialized`, `tools/call` proxied to the live endpoint (with the walk's
 * Bearer token, through `callTool`), `ui/request-display-mode` echoed,
 * `size-changed` recorded. Nothing from `@modelcontextprotocol/ext-apps` is
 * bundled for the page: `hostReply` below is the whole protocol the walk needs,
 * unit-tested here and injected into the page as source.
 */
import type { FrameLocator, Page } from 'playwright'

export interface ToolCallParams { name: string; arguments?: Record<string, unknown> }
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }

/** The host's answer(s) to one message from the app — pure, so it is testable and serialisable into the page. */
export async function hostReply(m: Message, callTool: (p: ToolCallParams) => Promise<unknown>, toolInput: Record<string, unknown>): Promise<Message[]> {
  if (m.method === 'ui/initialize') {
    return [{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params as { protocolVersion?: string })?.protocolVersion ?? '2026-01-26', hostInfo: { name: 'workflow-live host-emu', version: '0.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {} }, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }]
  }
  if (m.method === 'ui/notifications/initialized') return [{ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: toolInput } }]
  if (m.method === 'tools/call') return [{ jsonrpc: '2.0', id: m.id, result: await callTool(m.params as ToolCallParams) }]
  if (m.method === 'ui/request-display-mode') return [{ jsonrpc: '2.0', id: m.id, result: { mode: (m.params as { mode?: string })?.mode ?? 'inline' } }]
  if (m.id !== undefined && m.method) return [{ jsonrpc: '2.0', id: m.id, result: {} }]
  return []
}

export const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script>
${String(hostReply)}
window.__log = []; window.__heights = []; window.__frames = []
window.__mount = (html, toolInput) => {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.setAttribute('data-emu-frame', String(window.__frames.length))
  frame.style.cssText = 'width:100%;height:900px;border:0'
  document.body.appendChild(frame)
  window.__frames.push(frame)
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow) return
    const m = e.data
    if (!m || m.jsonrpc !== '2.0') return
    window.__log.push(m.method ? m.method : 'reply ' + m.id)
    if (m.method === 'ui/notifications/size-changed' && m.params && typeof m.params.height === 'number') window.__heights.push(m.params.height)
    for (const out of await hostReply(m, window.__callTool, toolInput)) frame.contentWindow.postMessage(out, '*')
  })
  frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close()
}
</script></body></html>`

export interface EmulatedHost {
  mount(html: string, toolInput: Record<string, unknown>): Promise<FrameLocator>
  log(): Promise<string[]>
  heights(): Promise<number[]>
}

export async function openEmulatedHost(page: Page, callTool: (params: ToolCallParams) => Promise<unknown>): Promise<EmulatedHost> {
  await page.exposeFunction('__callTool', callTool)
  await page.setContent(HOST_HTML)
  return {
    async mount(html, toolInput) {
      const index = await page.evaluate(([h, t]) => { window.__mount(h, t); return window.__frames.length - 1 }, [html, toolInput] as const)
      await page.waitForFunction((n) => window.__log.filter((l: string) => l === 'ui/initialize').length >= n, index + 1, { timeout: 30_000 })
      return page.locator(`iframe[data-emu-frame="${index}"]`).contentFrame()
    },
    log: () => page.evaluate(() => window.__log),
    heights: () => page.evaluate(() => window.__heights),
  }
}
```

(Add a `declare global { interface Window { __log: string[]; __heights: number[]; __frames: HTMLIFrameElement[]; __mount: (html: string, toolInput: Record<string, unknown>) => void; __callTool: (p: ToolCallParams) => Promise<unknown> } }` block. `hostReply` must not close over module scope — it is serialised with `String()`, so keep it self-contained as above.)

- [ ] **Step 4: Chain** — `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test` → green (2 new tests).

- [ ] **Step 5: Commit** — `git add packages/workflow-live/src/host-emu.ts packages/workflow-live/src/host-emu.test.ts && git commit -m "feat(workflow-live): host-emu — the host half of the MCP Apps bridge, for a walk to mount a ui:// resource (#586)"`.

### Task 9: the `mcp-app` walk

**Files:**
- Create: `packages/workflow-live/src/walks/mcp-app.ts`
- Modify: `packages/workflow-live/src/walks/index.ts` (register), `packages/workflow-live/src/args.ts:9` (USAGE lists `mcp-app`; `--park-only` help says "mcp: island · mcp-app: form")

**Interfaces:**
- Consumes: `openMcp`, `rawPost` (`mcp-client.ts`); `mintAppToken` (`token.ts`); `openSession` (`session.ts`); `parkHelloRun`, `ISLAND_STEP`, `FORM_STEP` (`park.ts`); `openEmulatedHost` (`host-emu.ts`); `stepViewUriOf`, `STEP_VIEW_URI_PATTERN`, `cspOf` (`mcp-checks.ts`); `waitForSealedRecord` (`@bffless/workflow-headless`).
- Produces: check names `D24.stepViewUriIsRevisioned`, `D24.parkIsland`, `D24.hostHandshake`, `D24.islandMountsInHost`, `D24.islandSubmitsThroughBridge`, `D24.parkForm`, `D24.formRendersInHost`, `D24.formRefusesBlankRequired`, `D24.formSubmitsThroughBridge`, `D24.runResumesOnHarness` — **10 checks**; `--park-only` parks on the **form** and prints the id.

- [ ] **Step 1: Write the walk** — `walks/mcp-app.ts`:

```ts
/**
 * The MCP Apps host, emulated (apps#586; Phase 4 plan, Decision 8): what a
 * person's claude.ai session proved at the Phase-2/3 gates, headless — the
 * served step view mounts in a sandboxed frame under a host that answers
 * `ui/initialize` and proxies `tools/call` to the live endpoint; an island
 * is completed through it, then (Phase 4, story 10) a form; the run then
 * resumes on the harness page from the rows the widget wrote. Check names
 * cite D24 as amended (reports + one input in an agent host).
 */
import { writeFile } from 'node:fs/promises'
import { waitForSealedRecord } from '@bffless/workflow-headless'
import { chromium } from 'playwright'
import { adminKey, appToken, credentials } from '../env.js'
import { openEmulatedHost } from '../host-emu.js'
import { STEP_VIEW_URI_PATTERN, cspOf, stepViewUriOf, type ListedTool } from '../mcp-checks.js'
import { openMcp } from '../mcp-client.js'
import { FORM_STEP, ISLAND_STEP, parkHelloRun } from '../park.js'
import { openSession } from '../session.js'
import { mintAppToken, type MintedToken } from '../token.js'
import type { Walk } from './index.js'

interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
const text = (r: ToolAnswer) => (r.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')

export const mcpApp: Walk = async ({ args, env, report }) => {
  const log: string[] = []
  const say = (line: string) => void log.push(line)
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (needed to park runs and mint a token)')
  const minted: MintedToken[] = []
  let session: Awaited<ReturnType<typeof openMcp>> | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    // --- sign in, mint the token the host will carry, park a run on its island
    let s = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const project = await s.api.json('/api/workflow/project')
    const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
    let token = appToken(env)
    if (!token) {
      const t = await mintAppToken(s.request, args.harness, repository, ['workflow:read', 'workflow:run', 'workflow:files'], `workflow-live mcp-app ${new Date().toISOString()}`)
      minted.push(t)
      token = t.token
    }
    if (args.parkOnly) {
      const p = await parkHelloRun(s, 'form', say)
      report.note(`parked run ${p.runId}, waiting on ${p.step} — hand it to the agent host`)
      console.log(`parked ${p.runId}`)
      return
    }
    const island = await parkHelloRun(s, 'island', say)
    report.run(island.runId)
    report.expect('D24.parkIsland', island.startedOk && island.waitingOk && island.rowStatus === 'waiting' && island.step === ISLAND_STEP, { runId: island.runId, rowStatus: island.rowStatus, rowWaitMs: island.rowWaitMs })

    // --- the endpoint: the revisioned URI, the resource
    session = await openMcp(args.harness, { token })
    const { client } = session
    const listed = (await client.listTools()).tools as ListedTool[]
    const uri = stepViewUriOf(listed)
    const read = await client.readResource({ uri })
    const resource = read.contents[0] as { mimeType?: string; text?: string } | undefined
    const html = resource?.text ?? ''
    report.expect('D24.stepViewUriIsRevisioned', STEP_VIEW_URI_PATTERN.test(uri) && resource?.mimeType === 'text/html;profile=mcp-app' && html.includes('form-step') && html.includes('data-testid="island"'), { uri, mimeType: resource?.mimeType, bytes: html.length, csp: cspOf(resource) })
    const call = async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const answer = (await client.callTool({ name: params.name, arguments: params.arguments ?? {} })) as ToolAnswer
      say(`host → tools/call ${params.name} → ${answer.isError ? 'error' : 'ok'}: ${text(answer).slice(0, 100)}`)
      return answer
    }

    // --- the emulated host mounts the step view for the island; the island submits through the bridge
    await new Promise((resolve) => setTimeout(resolve, 61_000)) // the page's lease lapses (Phase 2 Decision 7)
    browser = await chromium.launch({ args: ['--no-sandbox'], handleSIGINT: false })
    const page = await browser.newPage({ viewport: { width: 720, height: 1000 } })
    const host = await openEmulatedHost(page, call)
    const view = await host.mount(html, { runId: island.runId, step: ISLAND_STEP, values: {} })
    await page.waitForFunction(() => window.__heights.length > 0, undefined, { timeout: 30_000 })
    report.expect('D24.hostHandshake', (await host.log()).slice(0, 2).join(',') === 'ui/initialize,ui/notifications/initialized' && (await host.heights())[0]! > 0, { log: (await host.log()).slice(0, 6), heights: await host.heights() })
    const islandFrame = view.locator('[data-testid="island"]').contentFrame()
    await islandFrame.getByTestId('line').first().waitFor({ timeout: 30_000 })
    await page.screenshot({ path: `${args.out}/02-island-in-host.png`, fullPage: true })
    report.expect('D24.islandMountsInHost', /is waiting for you/.test((await view.getByTestId('status').textContent()) ?? ''), { status: await view.getByTestId('status').textContent(), lines: await islandFrame.getByTestId('line').count() })
    await islandFrame.getByTestId('line').first().click()
    await islandFrame.getByTestId('submit').click()
    await view.getByTestId('submitted').waitFor({ state: 'visible', timeout: 30_000 })
    const afterIsland = (await client.callTool({ name: 'workflow.status', arguments: { runId: island.runId } })) as ToolAnswer
    report.expect('D24.islandSubmitsThroughBridge', (afterIsland.structuredContent as { steps?: Record<string, string> })?.steps?.[ISLAND_STEP] === 'succeeded', { text: text(afterIsland).slice(0, 200) })
    await page.close()

    // --- a second run, parked on its form; the form renders and submits through the bridge
    s = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const form = await parkHelloRun(s, 'form', say)
    report.run(form.runId)
    report.expect('D24.parkForm', form.startedOk && form.waitingOk && form.rowStatus === 'waiting' && form.step === FORM_STEP, { runId: form.runId, rowStatus: form.rowStatus, rowWaitMs: form.rowWaitMs })
    await new Promise((resolve) => setTimeout(resolve, 61_000))
    const page2 = await browser.newPage({ viewport: { width: 720, height: 1000 } })
    const host2 = await openEmulatedHost(page2, call)
    const view2 = await host2.mount(html, { runId: form.runId, step: FORM_STEP, values: {} })
    await view2.getByTestId('form-step').waitFor({ timeout: 30_000 })
    await page2.screenshot({ path: `${args.out}/03-form-in-host.png`, fullPage: true })
    const tiles = await view2.getByTestId('tile').count()
    report.expect('D24.formRendersInHost', tiles === 2 && (await view2.getByRole('button', { name: 'Approve' }).count()) === 1, { tiles, title: await view2.getByTestId('title').textContent() })
    report.expect('D24.formRefusesBlankRequired', await view2.getByTestId('form-step-submit').isDisabled(), { note: 'cover is required and blank' })
    await view2.getByTestId('tile').first().click()
    await view2.getByTestId('form-step-submit').click()
    await view2.getByTestId('submitted').waitFor({ state: 'visible', timeout: 30_000 })
    const afterForm = (await client.callTool({ name: 'workflow.status', arguments: { runId: form.runId } })) as ToolAnswer
    const formSteps = (afterForm.structuredContent as { steps?: Record<string, string>; status?: string }) ?? {}
    report.expect('D24.formSubmitsThroughBridge', formSteps.steps?.[FORM_STEP] === 'succeeded' && formSteps.status === 'running', { text: text(afterForm).slice(0, 200) })
    await page2.close()

    // --- the harness page resumes the run the widget advanced: same rows, one history
    const s3 = await openSession({ base: args.harness, out: args.out, credentials: creds })
    try {
      await s3.page.goto(`${args.harness}/hello/interactive/runs/${form.runId}`)
      await s3.page.getByTestId('run-resume').click({ timeout: 60_000 })
      const sealed = await waitForSealedRecord(s3.api, form.runId, say, { timeoutMs: 120_000 })
      const status = String(((sealed.body as { run?: { status?: string } } | null)?.run ?? {}).status ?? '')
      report.expect('D24.runResumesOnHarness', status === 'succeeded', { status })
      await s3.shot('04-resumed-on-harness')
    } finally {
      await s3.close()
    }
  } finally {
    await writeFile(`${args.out}/mcp-app.log`, log.join('\n'), 'utf8').catch(() => undefined)
    await session?.close()
    await browser?.close()
    for (const t of minted) await t.revoke()
  }
}
```

Register in `walks/index.ts` (`import { mcpApp } from './mcp-app.js'`; `'mcp-app': mcpApp` in `WALKS`; not in `ALL_ORDER`). `args.ts` USAGE: add `mcp-app` to the list and change the `--park-only` note to "mcp: parks on the island · mcp-app: parks on the form".

Notes for the implementer: `view` is a Playwright `FrameLocator` (`page.locator(iframe).contentFrame()`, the idiom `walks/hello.ts:44` and `walks/interactive.ts:86` use); the island's nested frame is `view.locator('[data-testid="island"]').contentFrame()`. The Resume click assumes the run row's lease lapsed (the 61 s waits above) — the page shows the Resume button, not Take over.

- [ ] **Step 2: Chain** — `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test` → green.

- [ ] **Step 3: Run it on the scratch host** (the branch deployed there with Task 4 Step 1's script from this worktree):

```bash
pnpm workflow-live:walk mcp-app --harness https://workflow-mcp.j5s.dev --out /tmp/claude-1000/walk-mcp-app
```

Expected: **10/10**; screenshots `02-island-in-host.png`, `03-form-in-host.png`, `04-resumed-on-harness.png` in the out dir. If a check fails, the walk's `mcp-app.log` and the host log evidence say which hop; fix on the branch, redeploy, rerun. Then `mcp` (26/26) and `oauth` (9/9) again.

- [ ] **Step 4: Commit** — `git add packages/workflow-live && git commit -m "feat(workflow-live): the mcp-app walk — an emulated MCP Apps host completes an island and a form through the served step view, then the harness resumes the run (#586)"`.

### Task 10: the walk documented; PR C

**Files:**
- Modify: `packages/workflow-live/README.md` (walk table row for `mcp-app`; the Usage block gains `pnpm workflow-live:walk mcp-app --harness https://workflow-mcp.j5s.dev --out /tmp/walk-mcp-app` and `… --park-only   # a run parked on its form for claude.ai`), `.claude/agents/apps-live-walk.md` (walk list lines 3, 24–26; `--park-only` note names both)

- [ ] **Step 1: Write the README row** — after the `oauth` row:

```
| `mcp-app` | the M5 Phase-4 walk (spec 10, D24 as amended; apps#554 stories 10–11, apps#586): the served step view (`ui://bffless/workflow/step-view.<rev>.html`, read off `tools/list`) mounted in an **emulated MCP Apps host** (`src/host-emu.ts`: a sandboxed frame, `document.write`, `ui/initialize` answered, `tools/call` proxied with the walk's Bearer token) — `D24.parkIsland`, `D24.stepViewUriIsRevisioned`, `D24.hostHandshake`, `D24.islandMountsInHost`, `D24.islandSubmitsThroughBridge`, then a second run parked on its `review` form: `D24.parkForm`, `D24.formRendersInHost`, `D24.formRefusesBlankRequired`, `D24.formSubmitsThroughBridge`, and `D24.runResumesOnHarness` (the harness page's Resume finishes the run the widget advanced). `--park-only` parks on the form and prints the id (the person's claude.ai gate). Not part of `all` | two hello runs (one left `running` after its island; one completed) |
```

- [ ] **Step 2: Commit, open PR C (stacked on B)**

```bash
git add packages/workflow-live/README.md .claude/agents/apps-live-walk.md
git commit -m "docs(workflow-live): the mcp-app walk in the walk table and the live-walk agent"
git push -u origin feat/m5-mcp-app-walk
gh pr create --base feat/m5-resource-uris --title "feat(workflow-live): the mcp-app walk — an emulated MCP Apps host completes an island and a form through the served step view (#586)" --body "Closes #586. …(counts: workflow-live lint/build/test; mcp-app 10/10 on scratch with the three screenshots attached; mcp 26/26; oauth 9/9)…"
```

Read the automated review on every push.

### Task 11: the private host — deploy (ask-first) and the gate walks

- [ ] **Step 1: Ask the person** (remote, one message): "PR A/B/C are green on scratch (`mcp-app` 10/10, `mcp` 26/26, `oauth` 9/9). May I dispatch `deploy-workflow.yml` on `feat/m5-mcp-app-walk` to deploy `workflow.j5s.dev`? It replaces the story-9 build there; a later merge to `main` redeploys from `main`." Wait for yes. Before dispatching, re-check the hello forwarder on `bffless/workflow` still forwards `cookie` + `authorization` (memory *in-process external siblings…*; `mcp__j5s-dev__get_proxy_rule` on rule `79cc9bc5-5529-4a19-b0ca-3cb89be743bf` in set `e82ff24f-8afa-44fb-b23e-d50d0f8043f7`) — the walk's island read depends on it.

- [ ] **Step 2: Dispatch and walk**

```bash
gh workflow run deploy-workflow.yml --ref feat/m5-mcp-app-walk
gh run watch $(gh run list --workflow deploy-workflow.yml --limit 1 --json databaseId -q '.[0].databaseId')
pnpm workflow-live:walk mcp --harness https://workflow.j5s.dev --out /tmp/claude-1000/gate-mcp
pnpm workflow-live:walk oauth --harness https://workflow.j5s.dev --out /tmp/claude-1000/gate-oauth
pnpm workflow-live:walk mcp-app --harness https://workflow.j5s.dev --out /tmp/claude-1000/gate-mcp-app
```

Expected: 26/26, 9/9, 10/10. Paste all three tables as a comment on PR C and PR A ("the gate's automatable half").

---

## Story 12 — closeout (PR D, branch `docs/m5-phase4-closeout` off `feat/m5-mcp-app-walk`)

### Task 12: the docs say what shipped and what did not

**Files:**
- Modify: `apps/workflow/docs/spec/10-agent-embedding.md` (§Islands and the run view → §Islands and forms inside an agent host; the `workflow.http` sentence in §Auth; D24 row; §Later; the line-153 sentence naming `run.html`)
- Modify: `apps/workflow/docs/spec/00-overview.md` (M5 block lines 101–110; table row 64; D24 row 139)
- Modify: `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` (an **Amendment 2026-09-04** block after Consequences)
- Modify: `docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md` (§Layer 2b, §4 Phase 4 rows, the `workflow.http` mentions at lines 63/216–218)
- Modify: `apps/workflow/CONTEXT.md` (Step view entry), `apps/workflow/bffless/README.md` (a short "M5 Phase 4" section: nothing to provision; the per-URI cache rule; `mcp-app --park-only`), `apps/workflow/docs/writing-an-implementation.md` (new §"Your workflow inside an agent host" before §Checklist; a Checklist line)
- Modify: `packages/workflow-agent-tools/src/scopes.ts:38-39` (the comment "Phase 4's `workflow.http` inherits…" → "an app-only tool that reached a rule would inherit…; none exists")

- [ ] **Step 1: Spec 10 §"Islands and forms inside an agent host"** — replace the section body (lines 159–204) with:

```markdown
## Islands and forms inside an agent host

An island file renders in claude.ai unchanged: the host fetches it as a `ui://` resource,
mounts it in the sandboxed iframe, sends `tool-input`, and proxies its `tools/call` to the
endpoint — which answers `workflow.submit` by writing the same step rows the page host
writes. The sandbox contract islands were held to from day one (opaque origin, no cookies,
everything through the bridge — 04) is exactly the agent-host contract, which is why this
works without touching a single island.

**What an agent host is for (D24, amended 2026-09-04):** an MCP app *reports back and takes
one input*. It never carries the run engine. A run is driven by a browser on the harness
page — a person, or an agent through the page's own WebMCP tools (D21), which is what
"the agent on my app, in my domain, running it" means — and, when the platform grows one,
by a server-side driver (§Later). So over the endpoint `workflow.start`, `resume` and
`cancel` are listed (D19) but not served: their refusal says where runs are driven.

The one surface an agent host renders is the **step view**, `ui://bffless/workflow/step-view.<rev>.html`
(`<rev>` is a hash of the harness's sources, so a host that caches a widget's resource per
URI — claude.ai does, per connector — fetches every deploy fresh; apps#587). `workflow.submitStep`
links it via `_meta.ui.resourceUri`; called with `values: {}` for a waiting step it opens:

- **an island** — mounted inside the view as a nested srcdoc iframe under the same
  `IslandHost` the harness page uses; its `workflow.submit`/`annotate`/`sign` and its own
  pipelines ride the outer bridge as the app-only tools `workflow.stepView`, `.submit`,
  `.annotate`, `.pipeline` (Phase 2 plan, Decision 4); the island cannot tell which host it
  is in.
- **a form** — the built-in schema form (03). When a form starts waiting, the harness records
  its `with` *evaluated against the run* — title, fields with `default`/`options` resolved,
  the submit label — as the step row's `inputs` (`formInputs`). The endpoint answers exactly
  those fields; the view draws them with the harness's own `FieldControl`s; Submit sends
  `workflow.submitStep { values }`, judged by `validateFormOutputs` — the function the page's
  own form pane runs (D12). Nothing is re-evaluated server-side. A `file` field cannot upload
  from a sandboxed origin (the bucket's CORS will never list a per-widget host origin) and
  says so; a required one keeps Submit disabled, and the person finishes that form on the
  harness page.

The invariant survives: the endpoint takes no lease and seals nothing. A step completed in
Claude is a row; the run continues when a browser resumes it on the harness page — the same
rows, one history. A submit is refused while a harness tab still holds the lease (Phase 2
plan, Decision 7): the widget never races the driver.

**Not built, on purpose:** a *run view* that bundles the runner, the store and the middleware
into the agent host's iframe and drives the run from there (the D24 of 2026-09-01). The
2026-09-04 sandbox probe priced it — the iframe's origin is a random per-widget subdomain,
so every upload, Worker and file read the engine makes on the harness page has to be re-plumbed
over the bridge — and the person ruled the shape wrong regardless of price: small apps in the
chat, the engine in the browser today and on the server tomorrow. `workflow.http` goes with it.
```

Update §Auth's paragraph that starts "The app-only `workflow.http` tool deliberately has no scope of its own" to: "An app-only tool that reached a harness rule would inherit that rule's `requiredScopes` (the fence is the rule's); none exists — the step view's tools each declare their own scope." Update line ~153 ("and `ui://bffless/workflow/run.html`, the run view below") to name only the step view. D24 row → `| D24 | In an agent host the app reports and takes one input: the step view (\`ui://bffless/workflow/step-view.<rev>.html\`) completes a waiting island or form through the endpoint's server-side submit; no run engine in a widget; runs are driven on the harness page (a person, or an agent via WebMCP) — a server-side driver is the long-term direction (amended 2026-09-04; the run view of 2026-09-01 was not built) |`. §Later: put first `- **A server-side run driver** — the person's stated long-term direction (2026-09-04): what would make \`workflow.start\` over the endpoint start a run, and \`on.schedule\`/\`on.webhook\` possible; needs its own ADR (a second engine runtime to keep honest, contradicts D11).` and delete the two run-view bullets ("The harness's own run page going vertical…" stays — it is about the page).

- [ ] **Step 2: ADR-0005 amendment** — append:

```markdown
**Amendment (2026-09-04, apps#554 Phase 4):** the "bundled run view … the agent host's sandboxed
iframe is the browser" clause is withdrawn. An MCP app reports and takes one input (the step
view: islands and forms); it never carries the engine. Runs are driven on the harness page — a
person, or an agent through WebMCP — and, as the long-term direction, by a server-side driver
(its own ADR when it comes). Everything else here stands. Reason: the 2026-09-04 sandbox probe
showed what the engine-in-widget shape would have cost (bridge-relayed uploads, Workers, file
reads against a per-widget origin), and the maintainer ruled the shape wrong on principle: small
apps in the chat, the engine in the browser today and on the server tomorrow.
```

- [ ] **Step 3: 00-overview, the design doc, CONTEXT, README, writing-an-implementation** — 00-overview's M5 block: replace "and a bundled run view keeps the browser-drives-runs invariant inside the agent host's iframe" with "and the step view completes a waiting island or form inside the chat; a widget never carries the engine (D24 amended 2026-09-04)"; add the done-line: "**M5 closed 2026-09-XX on the epic branch** — Phases 1–4; gate: an island and a form completed in claude.ai against the private harness; `mcp` 26/26, `oauth` 9/9, `mcp-app` 10/10." Table row 64 and D24 row 139: mirror spec 10's D24. Design doc §Layer 2b: prepend "**Withdrawn 2026-09-04** — see spec 10 §Islands and forms inside an agent host and ADR-0005's amendment; kept for the record." and strike the §4 Phase 4 rows' text into: "10 — the step view completes forms · 11 — #587 hashed URIs + #586 `mcp-app` walk · 12 — closeout; gate: an island and a form completed in claude.ai; `mcp-app` green on scratch and the private host". CONTEXT.md **Step view** entry: `ui://bffless/workflow/step-view.<rev>.html` — the engine-less host page that mounts one waiting island **or renders one waiting form** inside an agent host…; *Avoid*: "the run view (withdrawn 2026-09-04)". README: a "### M5 Phase 4 — forms in the step view (2026-09-XX)" section: no provisioning; the URI is revisioned (a host's per-URI cache is why); `pnpm workflow-live:walk mcp-app --harness … --park-only` parks a run on its form for claude.ai. `writing-an-implementation.md` new section:

```markdown
## 8. Your workflow inside an agent host

Nothing to add: an implementation's islands and forms already work inside claude.ai (spec 10).
What a member sees there, once the harness's MCP connector is on:

- the workflow listed and described (`workflow.list`, `workflow.describe`), its runs and their
  status and outputs;
- a run waiting on an **island** step: the island, unchanged, in the chat — its pipelines fenced to
  your implementation exactly as on the page;
- a run waiting on a **form** step: the form's fields as the page would draw them (defaults and
  `options` expressions already evaluated), submitted with the same validation. A `file` field
  cannot be attached from the chat — a required one sends the person back to the harness page.

What the chat does **not** do: start or drive a run. A run is driven by a browser on the harness
page — the person, or an agent through the page's own tools. Write forms with that in mind: keep
`file` fields optional where a chat completion should be possible.
```

and a Checklist line "- [ ] forms that should complete in a chat have no required `file` field".

- [ ] **Step 4: Chain** — `pnpm workflow:lint` (docs don't lint) — run `pnpm apps:check` and `pnpm --filter workflow test:run -- src/mcp/refusals` (a spec quote test may pin wording); commit `docs(workflow): D24 amended — the step view completes forms, no run engine in a widget; M5 done-block`.

### Task 13: the claude.ai gate — the person's checklist

- [ ] **Step 1: Post the click-by-click on PR A** (after Task 11's deploy):

```markdown
**The gate's claude.ai half (you):** connector = the private harness (`workflow.j5s.dev`), already set up in Phase 3. Two runs, both parked by the walks:

1. `pnpm workflow-live:walk mcp --harness https://workflow.j5s.dev --park-only --out /tmp/park-island` → prints `parked run_…` (island).
2. In claude.ai: *"Show me the status of run <id>"* → Claude calls `workflow.status` → *"Let me complete it here"* → Claude calls `workflow.submitStep { values: {} }` → the step-view card shows the `pick-line` island → pick a line, **Submit** → the card says *Submitted pick/0/choose…* **Screenshot 1.**
3. `pnpm workflow-live:walk mcp-app --harness https://workflow.j5s.dev --park-only --out /tmp/park-form` → prints `parked run_…` (form).
4. In claude.ai, same two prompts for that id → the card shows **Review the card**: two poster tiles, Notes prefilled with the picked line, an `extra` file field → pick a tile, **Approve** → *Submitted review/0/confirm…* **Screenshot 2.** (Optional: try attaching a file — the field says to attach it on the harness page. **Screenshot 3.**)
5. Open `https://workflow.j5s.dev/hello/interactive/runs/<form run id>` → **Resume** → the run finishes → **Screenshot 4** of the succeeded run.

Post the screenshots here; that ticks stories 10–11. If a card stays empty, disconnect/reconnect is *not* needed any more — the URI is revisioned — tell me and I'll read the endpoint's log.
```

- [ ] **Step 2: Wait for the screenshots; on green, merge A, B, C in order** (rebasing each `--onto` the epic tip with `--force-with-lease` after the one below merges; read the automated review comments after every push), and tick stories 10 and 11 on #554 with a comment linking the PRs and the three walk tables.

### Task 14: "Phase 4 as shipped", the issues, the handover, the memory

- [ ] **Step 1: This plan's "Phase 4 as shipped" block** — under the traceability table, the way Phase 3's plan did: PR numbers, the re-scope and why, departures from the tasks with reasons, the walk counts on both hosts with timestamps, the person's screenshots' PR comment, the size of `step.html`.

- [ ] **Step 2: File the deferred items** (with the `file-issue` skill's shape — one app, one unit, cited): (a) *idea*: a server-side run driver (the long-term direction; what it unlocks; ADR needed; cites spec 10 §Later and ADR-0005's amendment); (b) *idea*: uploads through the bridge (`workflow.upload { contentBase64 }` → a `data:` URL into CE's `file_upload_handler.sourceUrl`, the ~7 MB cap under `BODY_LIMIT` 10 MB, the CE change needed — parked, not wanted now); (c) a submitted island/form step's `summary` over the endpoint (Phase 2 gap) if not already filed. Link all three from the as-shipped block.

- [ ] **Step 3: Close the epic** — tick story 12 on #554 with the as-shipped summary; comment on #571 (the epic→main draft PR) that Phase 4 is on the epic, `workflow.j5s.dev` serves `feat/m5-mcp-app-walk`'s build, and the merge is theirs — remind them of the memory's note: `@bffless/workflow` on npm is still 1.1.0, so **no `workflow-implementations` deploy until the epic merges and release-please publishes the CLI with apps#584's `prepare` change** (the hand-patched hello forwarder would be overwritten). Open PR D (`docs(workflow): M5 Phase 4 as shipped — D24 amended, the epic closes (#554)`).

- [ ] **Step 4: The handoff memory** — write `~/.claude/projects/-home-rico-bffless-repos-apps/memory/m5-phase4-handoff.md` (type `project`) like `m5-phase3-handoff`: what shipped, what was withdrawn and why (one paragraph — the split, so nobody re-proposes the run view), the worktrees to remove (`m5-phase4-run-view`, `m5-step-view-forms`, `m5-resource-uris`, `m5-mcp-app-walk`, `m5-phase4-closeout`), the scratch project decision still open (keep/delete — irreversible, ask), the fresh-worktree build gotcha (`workflow-lint` + `workflow-cli` before `workflow:test`), the probe's findings in five lines, where the probe source lives (the session scratchpad only — cite `localdev-tools/mcp-app-host-emu.mjs` as the one artefact kept outside the repo), and the epic→main handover state. Add the MEMORY.md pointer line.

---

## Self-review (writing-plans checklist, applied)

- **Spec coverage.** D24-as-amended → Tasks 0, 2, 12, 14. Story 10 (forms) → 1–4. #587 → 5–6. #586 → 7–10. Gate (island + form in claude.ai; three walks on two hosts) → 11, 13. Closeout (docs, as-shipped, issues, #554, #571, memory) → 12, 14. The kickoff's "add the run-view walk beside them" → the `mcp-app` walk (Decision 8). The kickoff's "lease and take-over from inside the view" and "`workflow.http`" → withdrawn with D24 (Decision 1), recorded in spec 10 and the ADR (Task 12), not silently dropped.
- **Placeholder scan.** The only forward references are the PR numbers in Task 4's body and the "2026-09-XX" dates in Task 12's done-lines, which the executor fills at the time; every code step carries its code. Task 3 Step 5 names the one thing the implementer must verify in the codebase (`FileControl`'s error prop) and what to do either way.
- **Type consistency.** `FormStepView` (Task 3) fields = the `structuredContent` Task 2's `formView` answers (`title`, `description?`, `submit`, `fields`, `initial`, plus the base). `submitFormValues` returns `SubmitAnswer` = `IslandHost`'s. `parkHelloRun(s, until, say): Promise<Parked>` is used identically in `mcp.ts` (Task 7) and `mcp-app.ts` (Task 9). `stepViewUri(rev)`/`STEP_VIEW_URI_PATTERN` (Task 5) and `stepViewUriOf`/`STEP_VIEW_URI_PATTERN` (Task 6) match by regex, not by import — deliberate (`workflow-live` never imports the app). `hostReply` (Task 8) is the function serialised into `HOST_HTML`; its signature `(m, callTool, toolInput)` is what the page's `__mount` closure calls.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-04-workflow-m5-phase4-step-view-forms.md`. Execution is **Subagent-Driven** (the kickoff's standing choice): a fresh implementer subagent per task, spec + quality review after each, one broad review at the end; rulings in the ledger; stop only for a merge, a push to a shared branch, a live change to `bffless/workflow`/`workflow.j5s.dev`, or a broken plan.
