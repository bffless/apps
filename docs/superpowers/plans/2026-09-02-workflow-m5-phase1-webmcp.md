# Workflow M5 Phase 1 — WebMCP page tools Implementation Plan (apps#554, stories 2–4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first of spec 10's two adapters: a published tool catalog (`@bffless/workflow-agent-tools`) and the WebMCP adapter that registers it on the harness page (`document.modelContext`, polyfill-always) so an agent in the member's own browser can list, describe, start, await, complete, sign, cancel and resume runs by driving the very same store a click does — proven by a headless walk that drives a full `hello/interactive` run through `page.evaluate(executeTool(…))` on `workflow.j5s.dev`.

**Architecture:** One catalog, two adapters (D19, ADR-0005) — this phase builds the catalog and adapter 1. The catalog package owns names, descriptions, JSON Schemas, `readOnlyHint` annotations, the tool→scope map, `CallToolResult` builders and the `RunSnapshot` type (`window.__workflow` + `waitingOn`), plus the one derivation both adapters need (`snapshotFromRows`). On the page, `src/agent/` is three files: `registry.ts` (feature-detect `document.modelContext ?? navigator.modelContext`, install `@mcp-b/webmcp-polyfill` when absent), `executors.ts` (catalog → store: reads via `snapshotOf` + the discovery cache, mutations via `startRun` / the submit thunk / `cancelRun` / `takeOver`), `useWebMcp.ts` (one effect, one `AbortController`, executors read the store at call time so nothing re-registers as a run progresses). No new state, no new server surface, no pipeline tools on the page (D21).

**Tech Stack:** TypeScript ESM (node ≥ 20) for the package; React 19 + Redux Toolkit on the page; `@mcp-b/webmcp-polyfill` 5.1.0 (strict `document.modelContext` polyfill, Chrome-shaped `executeTool(tool, inputArgsJson)` returning a JSON string); Vitest; Playwright via `@bffless/workflow-headless`'s `PageLike` seam; `@bffless/workflow-live` for the live walk; release-please + `publish-workflow-lint.yml` for the npm train.

**Spec:** `apps/workflow/docs/spec/10-agent-embedding.md` (the contract — §The tool catalog, §WebMCP, D19–D21 govern this phase; D22–D24 are Phase 2–4) · `apps/workflow/docs/adr/0005-one-tool-catalog-two-adapters.md` · `docs/superpowers/specs/2026-09-01-workflow-agent-embedding-design.md` (§3 Layer 0 + Layer 1, §4 stories 2–4 and the Phase-1 gate) · `apps/workflow/docs/spec/07-headless.md` (the `window.__workflow` shape and the exhaustive refusal table `workflow.start` must reuse verbatim) · `apps/workflow/docs/spec/04-islands.md` (tool naming: dot-canonical, slash-tolerant; `workflow.sign` semantics) · tracking issue **apps#554** (check off stories 2–4 there as they merge into `epic/agent-embedding`). Not in scope: the MCP endpoint rule, `ui://` resources, app tokens, the run view (Phases 2–4); per-workflow generated tools; dynamic island tools (`toolchange`); any CE change.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **The store owns the two paths the page did not yet expose as actions.** Spec 10 says mutations "dispatch the same actions a click does (`startRun`, the form-submit path, `cancelRun`, take-over)". `startRun`/`cancelRun`/`takeOver` are thunks already; "the form-submit path" is today an inline call in `FormStepPane.tsx:112-122` (`completeFormStep` → `dispatch(runEvent)`), and loading a definition is inline in `KickoffPage.tsx`. Both become thunks — `submitStep` (`src/store/submitActions.ts`, forms **and** islands, each through its kind's own validator) and `loadWorkflowDefinition` (`src/store/workflowLoad.ts`, discovery → listing → YAML → `loadWorkflow`) — and `FormStepPane` switches to `submitStep`, so a person's submit and an agent's are literally one function. That is what lets the executors honour the hard fence: **`src/agent/**` imports the catalog package, `../store/*`, `../lib/workflowGlobal`, `../lib/autoStart`, `../lib/describe` and `../islands/hostDeps` (`signFile`) — never `../lib/runner/**`, `../components/**`, `../pages/**`, `../islands/*` beyond `hostDeps`** — enforced by an eslint `no-restricted-imports` block shaped like the existing `lib/runner` fence (`apps/workflow/eslint.config.js`).
2. **Spec 07's refusal strings are single-sourced.** The four page-level refusals (`discovery`, three `workflow` causes) live as string literals in `KickoffPage.tsx:120-125`. They move to exported constants in `lib/autoStart.ts` (`START_REFUSALS`), the kickoff page imports them, and `loadWorkflowDefinition` returns them — so "verbatim" is a property of the code, not of a copy. Input-level messages already come from `validateInputs`.
3. **The registration effect mounts as a sibling of `App`, not inside it.** Spec 10 says "one App-level effect". `App.tsx` is mounted by dozens of tests in a `MemoryRouter`; the polyfill patches `document`/`navigator`/form submit globals (`installSubmitEventPolyfill`), which must never run under jsdom for unrelated suites. So `main.tsx` renders `<App /><AgentTools />` inside the same `Provider` + `BrowserRouter` — mounted once for the app's life, inside the router (so `useNavigate` works), outside every existing test. `useWebMcp` is tested with an injected fake registry (spec 10 §Testing).
4. **Catalog is 11 names.** Spec 10's table lists `list, describe, start, status, await, runs, submitStep, outputs, sign, cancel, resume` while calling itself "the 10-tool catalog" (the design doc pairs `cancel / resume`). The package ships all 11; nothing else.
5. **`workflow.runs` takes `impl?` too.** The spec table says `{ workflow?, status?, limit? }`, but `GET /api/workflow/runs` filters on both `impl` and `workflow` (`rules/api/workflow/runs/get/rule.yaml`), so the schema carries `impl?` and `workflow?`, both defaulting on the page to the current run's (or the route's) pair; with neither available the tool refuses with `errors.workflow`. `status?` filters and `limit?` caps client-side (Decision 6 of 05: the rule sorts nothing).
6. **`snapshotFromRows` lives in the catalog.** `workflow.status`/`outputs`/`runs` for a run this tab is not driving read `/api/workflow/run` rows; deriving a `RunSnapshot` from a run row + step rows needs only the rows and the run's own definition JSON — pure data, and exactly what the Phase-2 MCP endpoint will do server-side. So the catalog owns it (`snapshotFromRows`), typed against structural `RunRowLike`/`StepRowLike` rather than the app's `RunRow`. The live-slice derivation (`runSnapshotOf(def, state)`) stays on the page in `src/agent/snapshot.ts` because it reads `getIslandHandle(...).src` (the resolved island URL) off the store.
7. **`workflow.await` is store-subscription for the driven run, polling for any other.** For the run in the slice it subscribes to the store and resolves on the first state where `until: 'waiting'` (some step `waiting`, or terminal) / `until: 'terminal'` holds; for another `runId` it re-reads `getRun` every 2 s. `timeoutMs` defaults to 120 000 and is capped at 600 000; on timeout it returns an **error** result whose `structuredContent` carries `{ timedOut: true, snapshot }` so the agent still learns where the run got to.
8. **`workflow.cancel` only cancels the run this tab drives.** `cancelRun` reads the slice; a `runId` the tab does not hold is refused with `errors.runId: 'This page is not driving that run — workflow.resume it first'`. Adopt-then-cancel is one call away and is the same thing a person does (`ResumeBanner`'s copy says exactly that).
9. **`workflow.start` starts a person-shaped run.** `headless: false`, `unattended: false` — an agent on the page is the member acting (spec 10 §Auth); the driver's `?auto=1` remains the only headless start. It navigates to `/${impl}/${workflow}/runs/${runId}` exactly as `KickoffPage.start` does, and returns `{ runId, snapshot }`.
10. **`describe` output shape is the catalog's `WorkflowDescription`, built by `src/lib/describe.ts`.** Inputs (`on.manual.inputs` as declared: type/list/required/default/options), run `outputs` (declared type/list/render), jobs in `jobOrder` with `needs`/`matrix`/`if`, each step's `id`, `kind`, and for `island`/`form` its `headless` mode (`headlessMode(step)` — the one reader of that spelling) plus its declared `outputs` map (islands) or `with.fields` (forms, *unevaluated* — a description is not a run). Lives in `lib/`, not `agent/`, because it imports `lib/runner/{graph,headless}`.
11. **The driver helpers are written against the polyfill's Chrome-shaped API and feature-test the native one.** `executeTool` takes the descriptor object from `getTools()` and a **JSON string** of arguments, and returns a JSON string of the `CallToolResult` (polyfill 5.1.0 `serializeChromeToolResult`). `callPageTool` in `workflow-headless` finds the descriptor by name, passes `JSON.stringify(args)`, and `JSON.parse`s a string result (an object result from a native implementation passes through). If the strict polyfill's `validateOriginAgentCluster` throws `SecurityError` on the live harness (it does when `window.originAgentCluster === false`), the fix is a `Origin-Agent-Cluster: ?1` response-header rule on the harness — recorded here so the walk's first red is not a mystery.
12. **The mock backend gets a CI proof too.** Besides the live walk, `apps/workflow/e2e/page-tools.spec.ts` drives the same sequence against the Playwright `webServer` in `?mocks=on` mode (the way `headless.spec.ts` proves the driver without a deployment), using the same `workflow-headless` helpers — so a regression in the executors fails `workflow-app.yml`, not only the live gate.

## Deferred out of this plan, explicitly

- Per-workflow generated tools (`studio.publish-blog` as its own tool) → Later in spec 10; MCP-endpoint option, Phase 2+.
- Registering a waiting island's own tools on the page (`toolchange`) → spec 10 Later.
- `unattended` as a `workflow.start` input (agent-initiated "Don't wait for me") → not in the spec's input table; file an issue if an agent needs it.
- Native-Chrome WebMCP verification (origin trial) and the `@mcp-b` extension bridge demo → documented, not automated (spec 10 §Testing).
- Anything Phase 2–4: `POST /api/workflow/mcp`, `ui://` resources, app tokens, OAuth, the run view.

## Global Constraints

- **Worktrees only:** every story branch is `git worktree add .claude/worktrees/<name> -b <branch> epic/agent-embedding`; the shared checkout is never switched (memory: `use-worktrees-in-apps-repo`).
- **Branching:** all PRs target `epic/agent-embedding`, never `main`; the epic PR (draft, label `epic`) is merged by a human. Story PRs merge into the epic on green; each merge checks its story off on #554.
- **PR titles are release commits** (`.claude/apps-pr-review-checklist.md` §3): `feat(workflow-agent-tools): the @bffless/workflow-agent-tools catalog — 11 workflow.* tools, MCP results, RunSnapshot` · `feat(workflow): WebMCP page tools — the read-only catalog on document.modelContext` · `feat(workflow): WebMCP mutations — start/await/submitStep/sign/cancel/resume, and the page-tools live walk`. Never edit a `CHANGELOG.md`.
- **npm release train, four mechanical edits** (the CLI plan's list, verbatim): `release-please-config.json` block, `.release-please-manifest.json` seed `"packages/workflow-agent-tools": "0.0.0"`, `release.yml` env line + jq `--arg` + map entry (a forgotten line is a silently unpublished package; the empty-ref check is the fence), `publish-workflow-lint.yml`'s `options:` + `case`. Plus: `workflow-app.yml` paths + build/lint/test steps **before** `pnpm --filter workflow lint` (the app imports the package, and Vitest/`tsc -b` resolve it from `dist/`), and root `package.json` `workflow-agent-tools:{build,lint,test}` scripts.
- **Spec-10 invariants** (D21): no pipeline tools on the page; islands never register page tools (nothing in `src/islands/` touches `modelContext`); executors read state at call time and never re-register; polyfill always when native is absent.
- **Tool naming**: dot-canonical, slash-tolerant (04) — `canonicalToolName('workflow/start') === 'workflow.start'`; registered names are the dot form only.
- **Every result is a `CallToolResult`**: `content[0]` is `{ type: 'text', text }` (human-readable), `structuredContent` the machine half; refusals are `isError: true` with `structuredContent.errors` keyed exactly as spec 07's global (`inputs`, `workflow`, `discovery`, or a per-input key) — plus `runId`/`step` keys for the run-scoped tools.
- **Verification chain per PR**: touched package `lint` + `build` + `test:run`; app `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build`; `pnpm apps:check`; `pnpm --filter workflow test:e2e` when `e2e/` changes. Paste real counts in the PR body (checklist §7).
- **Live surfaces:** nothing in these PRs deploys (`apps/workflow` deploys on merge to `main`, which only happens when the human merges the epic). The Phase-1 gate walk writes real `hello` runs on `workflow.j5s.dev` — cheap, and the walk's runs are left as history like every other walk's.

## File structure

```
bffless/apps
  packages/workflow-agent-tools/                                    (Story 2)
    package.json           @bffless/workflow-agent-tools, pure TS, no deps, exports "."    (Task 1)
    tsconfig.json, eslint.config.js, vitest.config.ts, README.md                          (Task 1)
    src/index.ts           barrel                                                           (Task 1)
    src/catalog.ts         TOOL_NAMES, ToolName, ToolDef, CATALOG, canonicalToolName, toolByName (Task 2)
    src/schemas.ts         one JSON Schema object per tool + the TS arg types              (Task 2)
    src/scopes.ts          SCOPES, TOOL_SCOPES, scopeOf                                    (Task 2)
    src/results.ts         CallToolResult, textResult, errorResult, isErrorResult          (Task 3)
    src/snapshot.ts        RunSnapshot, WaitingStep, RunRowLike, StepRowLike, snapshotFromRows (Task 3)
    src/describe.ts        WorkflowDescription (+ DescribedJob/DescribedStep) types        (Task 3)
    test/{catalog,scopes,results,snapshot}.test.ts                                        (Tasks 2–3)
  release-please-config.json / .release-please-manifest.json / .github/workflows/release.yml /
    .github/workflows/publish-workflow-lint.yml / .github/workflows/workflow-app.yml / package.json (Task 1)
  apps/workflow/                                                    (Stories 3–4)
    package.json           + "@bffless/workflow-agent-tools": "workspace:*", + "@mcp-b/webmcp-polyfill": "^5.1.0" (Task 5)
    eslint.config.js       + the src/agent fence                                          (Task 6)
    src/lib/autoStart.ts   + START_REFUSALS (the four page-level refusal strings)         (Task 4)
    src/pages/KickoffPage.tsx  reads START_REFUSALS instead of literals                   (Task 4)
    src/store/workflowLoad.ts  loadWorkflowDefinition thunk (+ .test.ts)                  (Task 4)
    src/lib/describe.ts    describeWorkflow(def, listing, impl) → WorkflowDescription (+ .test.ts) (Task 5)
    src/agent/registry.ts  ModelContextLike, resolveModelContext (native ?? polyfill)      (Task 5)
    src/agent/snapshot.ts  runSnapshotOf(def, state) → RunSnapshot (+ .test.ts)           (Task 5)
    src/agent/executors.ts createExecutors(deps) — one function per tool (+ .test.ts)     (Tasks 6, 9)
    src/agent/useWebMcp.ts + AgentTools.tsx  the effect (+ .test.tsx)                     (Task 7)
    src/main.tsx           <App /><AgentTools />                                           (Task 7)
    src/store/submitActions.ts  submitStep thunk (+ .test.ts)                             (Task 8)
    src/components/run/FormStepPane.tsx  handleSubmit → dispatch(submitStep(...))          (Task 8)
    e2e/page-tools.spec.ts  the mock-backend proof                                         (Task 11)
  packages/workflow-headless/src/pageTools.ts  listPageTools, callPageTool, waitForPageTools (+ test) (Task 10)
  packages/workflow-headless/src/index.ts, README.md   exports + a "Page tools" section     (Task 10)
  packages/workflow-live/src/walks/page-tools.ts  the walk; walks/index.ts, args.ts USAGE, README, test (Task 11)
  .claude/agents/apps-live-walk.md   walk list gains `page-tools`                          (Task 11)
  apps/workflow/CONTEXT.md           glossary: "Page tools", "Tool catalog"                 (Task 7)
```

## Traceability — spec 10 / #554 → tasks

| Spec 10 / #554 item | Tasks |
|---|---|
| Catalog package: names, descriptions, schemas, annotations (`readOnlyHint`), result builders | 1–3 |
| Tool→scope map owned by the catalog (D23's read/run/files split) | 2 |
| `RunSnapshot` = `window.__workflow` + `waitingOn` (key, kind, inputs/outputs, island `src`) | 3, 5 |
| Names dot-canonical, slash-tolerant (04) | 2 |
| Feature-detect `document.modelContext ?? navigator.modelContext`; polyfill-always (D21) | 5 |
| One App-level effect, `AbortSignal` cleanup, zero `toolchange` churn | 7 |
| Read tools: `list` (with `headlessSafe`), `describe`, `status`, `runs`, `outputs` | 4–6 |
| `start` validates through `lib/autoStart` with 07's refusal vocabulary verbatim; navigates like the kickoff form | 4, 9 |
| `submitStep` — kind picks the validator, same checks as a person's submit | 8, 9 |
| `await`, `sign` (same presigned GET islands get), `cancel`, `resume` (take-over) | 9 |
| No pipeline tools on the page; islands never register tools (D21) | 6 (fence + test), 11 (walk check) |
| Contract test: headless walk drives a full `hello` run via `page.evaluate(executeTool(…))`, asserting on `run.json`; unit tests inject a fake registry | 7, 10, 11 |
| Package joins the release train | 1 |
| Phase-1 gate: live walk green on j5s; stories checked off on #554 | 12 |

---

## Phase 1 as shipped (2026-09-02)

Landed on `epic/agent-embedding` as #572 (Story 2), #573 (Story 3), #574 (Story 4) and #575 (a deploy-workflow fix); the gate passed 16/16 on `workflow.j5s.dev` (report on #554). Departures from the plan, all recorded on the PRs: the "only the driving tab may submit" guard lives in the **executor**, not the `submitStep` thunk (the pane's fixtures replay in read-only mode, and adopting them live under real timers stalls the suite); `workflow.await` grew a `pollMs` seam and `workflow.sign` a `sign` seam for tests; the mock-backend e2e proves `resume` by adopting the seeded parked run rather than reloading (the mock db lives in the page). The gate ran against j5s itself, not a local Vite server: `deploy-workflow.yml` was dispatched on the epic branch, which is also what surfaced the missing catalog-package build step there — j5s serves the epic build until `main` next deploys.

# Phase A — Story 2: the catalog package (Tasks 1–3)

*Deliverable: `@bffless/workflow-agent-tools` exists on the release train, with the 11 tools, their schemas, scopes, result builders, `RunSnapshot`, `snapshotFromRows` and `WorkflowDescription`, fully unit-tested. Branch `feat/m5-agent-tools`, worktree `.claude/worktrees/m5-agent-tools`.*

### Task 1: Scaffold `packages/workflow-agent-tools` + release plumbing

**Files:** Create `packages/workflow-agent-tools/{package.json,tsconfig.json,eslint.config.js,vitest.config.ts,README.md,src/index.ts,test/index.test.ts}`; modify `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml` (`WORKFLOW_AGENT_TOOLS_TAG` env at `:91-94`, `--arg workflow_agent_tools` and the `"workflow-agent-tools": $workflow_agent_tools` map entry at `:103-114`), `.github/workflows/publish-workflow-lint.yml` (`options:` list + `case` arm `@bffless/workflow-agent-tools) DIR=packages/workflow-agent-tools ;;`), `.github/workflows/workflow-app.yml` (path `packages/workflow-agent-tools/**`; steps `pnpm --filter @bffless/workflow-agent-tools build|lint|test:run` placed right after the workflow-lint build, **before** `pnpm --filter workflow lint`), root `package.json` (`workflow-agent-tools:build|lint|test`).

**Interfaces:** `package.json` copies `packages/workflow-cli/package.json`'s shape minus `bin`/deps: `"name": "@bffless/workflow-agent-tools"`, `"version": "0.0.0"`, `"type": "module"`, `main`/`types`/`exports["."]` → `dist/index.js` + `dist/index.d.ts`, `files: ["dist","README.md"]`, `engines.node >= 20`, scripts `build: tsc -b`, `lint`, `test`, `test:run`; `dependencies: {}`; devDependencies identical to workflow-cli's. `tsconfig.json` = workflow-cli's (ES2023, NodeNext, `declaration`, `rootDir: src`). `src/index.ts` exports `CATALOG_VERSION = 1` for now (Task 2 fills the barrel).

- [ ] **Step 1: failing test** — `test/index.test.ts`: `import { CATALOG_VERSION } from '../src/index.js'` → `expect(CATALOG_VERSION).toBe(1)`. Run `pnpm --filter @bffless/workflow-agent-tools test:run` → fails (module missing).
- [ ] **Step 2: scaffold** the files above; `pnpm install` (lockfile gains the workspace package); `pnpm --filter @bffless/workflow-agent-tools lint && build && test:run` green.
- [ ] **Step 3: the plumbing edits** — all six files; then `jq . release-please-config.json .release-please-manifest.json > /dev/null` and `node --test scripts/*.test.mjs` (`pnpm scripts:test`) green; grep `release.yml` to confirm the new `--arg` is used in both the env block and the map (the fence in `:116` only catches an *empty* ref, not a missing map entry).
- [ ] **Step 4: commit** `feat(workflow-agent-tools): scaffold @bffless/workflow-agent-tools and its release plumbing`.

### Task 2: the catalog — names, descriptions, schemas, annotations, scopes

**Files:** Create `src/catalog.ts`, `src/schemas.ts`, `src/scopes.ts`, `test/catalog.test.ts`, `test/scopes.test.ts`; modify `src/index.ts`.

**Interfaces (what Stories 3–4 and Phase 2 import):**

```ts
// src/catalog.ts
export const TOOL_NAMES = ['workflow.list','workflow.describe','workflow.start','workflow.status','workflow.await',
  'workflow.runs','workflow.submitStep','workflow.outputs','workflow.sign','workflow.cancel','workflow.resume'] as const
export type ToolName = (typeof TOOL_NAMES)[number]
export interface ToolAnnotations { readOnlyHint: boolean }
export interface ToolDef { name: ToolName; description: string; inputSchema: JsonSchema; annotations: ToolAnnotations; scope: Scope }
export const CATALOG: readonly ToolDef[]           // in TOOL_NAMES order
export function toolByName(name: string): ToolDef | undefined   // slash-tolerant via canonicalToolName
/** `workflow/start` → `workflow.start`; anything else returned as-is. */
export function canonicalToolName(name: string): string
// src/schemas.ts — one `const … = { type:'object', properties, required, additionalProperties:false }` per tool, plus:
export interface StartArgs { impl: string; workflow: string; inputs: Record<string, unknown> }
export interface AwaitArgs { runId?: string; until: 'waiting' | 'terminal'; timeoutMs?: number }
export interface RunsArgs { impl?: string; workflow?: string; status?: 'running'|'succeeded'|'failed'|'cancelled'; limit?: number }
export interface SubmitStepArgs { runId?: string; step: string; values: Record<string, unknown> }
export interface SignArgs { runId?: string; path: string }
export interface RunIdArg { runId?: string }
export interface DescribeArgs { impl: string; workflow: string }
export interface ListArgs { impl?: string }
export type ToolArgs = { 'workflow.list': ListArgs; 'workflow.describe': DescribeArgs; /* … all 11 */ }
// src/scopes.ts
export const SCOPES = ['workflow:read','workflow:run','workflow:files'] as const
export type Scope = (typeof SCOPES)[number]
export const TOOL_SCOPES: Record<ToolName, Scope>   // read: list/describe/status/await/runs/outputs · run: start/submitStep/cancel/resume · files: sign
export function scopeOf(name: string): Scope | undefined
```

Descriptions are spec 10's "answers" column, written for a model (one sentence each, e.g. `workflow.describe`: "Describe one workflow before deciding a run can complete without a person: its inputs (types, required, defaults), outputs, the job/step graph, and each interactive step's `headless` declaration."). `readOnlyHint: true` on exactly the six `workflow:read` tools.

- [ ] **Step 1: failing tests** — `catalog.test.ts`: `CATALOG.map(t => t.name)` equals `TOOL_NAMES`; every description non-empty; every `inputSchema.type === 'object'` with `additionalProperties: false`; `required` lists match the spec table (`describe`: `[impl, workflow]`; `start`: `[impl, workflow, inputs]`; `await`: `[until]`; `submitStep`: `[step, values]`; `sign`: `[path]`; `resume`: `[runId]`; others `[]`); `annotations.readOnlyHint` is `true` iff scope is `workflow:read`; `canonicalToolName('workflow/submitStep') === 'workflow.submitStep'`, `toolByName('workflow/list')?.name === 'workflow.list'`, `toolByName('echo')` is `undefined`. `scopes.test.ts`: the exact read/run/files partition from spec 10; `SCOPES` order stable.
- [ ] **Steps 2–4:** implement; `lint && build && test:run` green; commit `feat(workflow-agent-tools): the 11-tool catalog — names, schemas, annotations, scope map`.

### Task 3: results, `RunSnapshot`, `snapshotFromRows`, `WorkflowDescription`

**Files:** Create `src/results.ts`, `src/snapshot.ts`, `src/describe.ts`, `test/results.test.ts`, `test/snapshot.test.ts`; modify `src/index.ts`.

**Interfaces:**

```ts
// src/results.ts
export interface TextContent { type: 'text'; text: string }
export interface CallToolResult { content: TextContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }
export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult
/** `isError: true`; `structured.errors` is the 07-keyed map. */
export function errorResult(text: string, structured: { errors: Record<string, string>; [k: string]: unknown }): CallToolResult
export function isErrorResult(r: CallToolResult): boolean
// src/snapshot.ts
export type StepStatus = 'queued'|'running'|'polling'|'waiting'|'succeeded'|'failed'|'skipped'|'cancelled'
export type RunStatus = 'running'|'succeeded'|'failed'|'cancelled'
export interface WaitingStep {
  key: string; kind: 'form' | 'island'
  /** A form's evaluated `with` (title, fields with defaults/options resolved, submit); an island's tool arguments. */
  inputs: Record<string, unknown>
  /** The step's declared output map (islands); a form's outputs are its fields, already in `inputs.fields`. */
  outputs?: Record<string, unknown>
  /** Islands only: the resolved iframe URL when known, else the declared `with.src`. */
  src?: string
}
export interface RunSnapshot {   // window.__workflow (07) + waitingOn
  runId: string; status: RunStatus | 'invalid'; currentSteps: string[]
  outputs: Record<string, unknown>; steps: Record<string, StepStatus>
  errors?: Record<string, string>; waitingOn: WaitingStep[]
}
export interface RunRowLike { runId: string; status: string; outputs?: unknown; definition?: unknown }
export interface StepRowLike { key: string; job: string; step: string; kind: string; status: string; inputs?: unknown }
/** The snapshot of a run read as rows — the same derivation the MCP endpoint will run server-side (D19). */
export function snapshotFromRows(run: RunRowLike, steps: StepRowLike[]): RunSnapshot
// src/describe.ts
export interface DescribedInput { type: string; list?: boolean; required?: boolean; default?: unknown; options?: unknown }
export interface DescribedOutput { type?: string; list?: boolean; render?: string }
export interface DescribedStep { id: string; kind: 'pipeline'|'island'|'form'|'script'; headless?: 'skip'|'auto'; outputs?: Record<string, unknown>; fields?: Record<string, unknown>; title?: string }
export interface DescribedJob { id: string; needs: string[]; if?: string; matrix?: Record<string, unknown>; steps: DescribedStep[] }
export interface WorkflowDescription { impl: string; workflow: string; name: string; description?: string; headlessSafe: boolean;
  inputs: Record<string, DescribedInput>; outputs: Record<string, DescribedOutput>; jobs: DescribedJob[] }
```

`snapshotFromRows`: `currentSteps` = keys whose status is running/polling/waiting (the same `ACTIVE` set as `workflowGlobal.ts`); `waitingOn` = `waiting` rows of kind `form`/`island`, `inputs` = the row's `inputs` if a plain object else `{}`, `outputs` = `definition.jobs[row.job].steps[].find(s => s.id === row.step)?.outputs` when the definition is a plain object, `src` = that step's `with.src` (unresolved — the page's own derivation resolves it).

- [ ] **Step 1: failing tests** — `results.test.ts`: `textResult('x', { a: 1 })` → `{ content: [{type:'text',text:'x'}], structuredContent: { a: 1 } }` with no `isError`; `errorResult('no', { errors: { greeting: 'This field is required' } }).isError === true`; `isErrorResult`. `snapshot.test.ts`: a fixture of hello's rows mid-run (`pick/0/choose` waiting island with inputs `{ lines: […] }`, definition JSON declaring `outputs: { line, index }` and `with.src: islands/pick-line.html`) → `waitingOn[0]` is `{ key: 'pick/0/choose', kind: 'island', inputs, outputs: { line…, index… }, src: 'islands/pick-line.html' }`, `currentSteps` `['pick/0/choose']`, `status: 'running'`; a finished run → `waitingOn: []`, `outputs` the row's; a `waiting` row whose definition is missing → `outputs` undefined, no throw; a form row → `kind: 'form'`, no `src`.
- [ ] **Steps 2–4:** implement; barrel exports everything; `lint && build && test:run` green; commit `feat(workflow-agent-tools): CallToolResult builders, RunSnapshot + snapshotFromRows, WorkflowDescription`.
- [ ] **Step 5: README** (usage from both adapters, the scope table, the result contract) and the PR: `feat(workflow-agent-tools): the @bffless/workflow-agent-tools catalog — 11 workflow.* tools, MCP results, RunSnapshot` into `epic/agent-embedding`. Body: consumers (none yet in-repo until Story 3 — say so per checklist §6), the release-train edits listed, real test counts. Merge on green; tick story 2 on #554.

# Phase B — Story 3: WebMCP read-only (Tasks 4–7)

*Deliverable: the harness page registers the full catalog on `document.modelContext` (native or polyfill); `list`/`describe`/`status`/`runs`/`outputs` work; the six mutation tools are registered but answer an honest "not yet" error until Story 4 lands (so `getTools()` is stable across the two stories and `toolchange` never fires between them). Branch `feat/m5-webmcp-read`, worktree `.claude/worktrees/m5-webmcp-read`, based on the epic after Story 2 merged.*

### Task 4: `loadWorkflowDefinition` thunk + single-sourced refusals

**Files:** Modify `apps/workflow/src/lib/autoStart.ts` (add `START_REFUSALS`), `src/pages/KickoffPage.tsx:120-125` (use them); create `src/store/workflowLoad.ts`, `src/store/workflowLoad.test.ts`.

**Interfaces:**

```ts
// lib/autoStart.ts — verbatim the strings KickoffPage publishes today
export const START_REFUSALS = {
  discovery: 'The implementations could not be listed',
  noWorkflow: 'No implementation here publishes that workflow',
  fileUnreadable: "This workflow's file could not be fetched",
  doesNotLint: 'This workflow does not validate, so it cannot be run',
} as const
// store/workflowLoad.ts
export type LoadedTarget =
  | { ok: true; impl: Implementation; listing: WorkflowListing; workflow: string; def: Definition; yaml: string }
  | { ok: false; errors: Partial<Record<'discovery' | 'workflow', string>> }
/** discovery → the alias's listing (`workflowId(listing.file) === workflow`) → YAML → `loadWorkflow`; refusals keyed as 07's global. */
export function loadWorkflowDefinition(a: { impl: string; workflow: string }): AppThunk<Promise<LoadedTarget>>
```

Implementation: `dispatch(workflowApi.endpoints.discover.initiate())` (unsubscribe in `finally`), error → `{ errors: { discovery } }`; no impl/listing → `{ errors: { workflow: START_REFUSALS.noWorkflow } }`; `getWorkflowYaml.initiate({ impl, file })` error → `fileUnreadable`; `loadWorkflow(yaml, file)` not ok → `doesNotLint`.

- [ ] **Step 1: failing tests** (`workflowLoad.test.ts`, MSW-backed like `workflowApi.test.ts`): hello resolves `ok` with `def.name === 'Interactive hello'`; unknown alias → `errors.workflow === START_REFUSALS.noWorkflow`; a 500 on the alias list → `errors.discovery`; a listing whose file 404s → `fileUnreadable`. `KickoffPage.auto.test.tsx` still green after the literal swap.
- [ ] **Steps 2–4:** implement; `pnpm workflow:lint && pnpm workflow:test` green; commit `refactor(workflow): loadWorkflowDefinition thunk; spec-07 refusal strings single-sourced in lib/autoStart`.

### Task 5: registry, page snapshot, describe

**Files:** Modify `apps/workflow/package.json` (deps: `@bffless/workflow-agent-tools: workspace:*`, `@mcp-b/webmcp-polyfill: ^5.1.0`); create `src/agent/registry.ts`, `src/agent/snapshot.ts`, `src/agent/snapshot.test.ts`, `src/lib/describe.ts`, `src/lib/describe.test.ts`.

**Interfaces:**

```ts
// src/agent/registry.ts
export interface RegisteredToolInput { name: string; description: string; inputSchema: object; annotations?: { readOnlyHint?: boolean }; execute(args: Record<string, unknown>): Promise<unknown> | unknown }
export interface ModelContextLike {
  registerTool(tool: RegisteredToolInput, options?: { signal?: AbortSignal }): Promise<void> | void
  getTools(): Promise<Array<{ name: string }>> | Array<{ name: string }>
}
/** `document.modelContext ?? navigator.modelContext`; when neither exists, install `@mcp-b/webmcp-polyfill` (dynamic import) and read again. `null` when still absent (no DOM, insecure context). */
export async function resolveModelContext(): Promise<ModelContextLike | null>
// src/agent/snapshot.ts
export function runSnapshotOf(def: Definition, state: RunState): RunSnapshot   // snapshotOf(state) + waitingOn; island src from getIslandHandle(runId,key)?.src ?? raw with.src
// src/lib/describe.ts
export function describeWorkflow(a: { impl: string; workflow: string; listing: WorkflowListing; def: Definition }): WorkflowDescription   // jobs in jobOrder(def); headless via headlessMode(step)
```

- [ ] **Step 1: failing tests** — `snapshot.test.ts` (node env): a hello `RunState` with `pick/0/choose` waiting → `waitingOn[0].kind === 'island'`, `.inputs` = the step's inputs, `.outputs` = declared map, `.src` = the handle's `src` when one is registered else `'islands/pick-line.html'`; a waiting form → `kind: 'form'`, `inputs.fields` present; the rest equals `snapshotOf(state)`. `describe.test.ts`: hello interactive → `inputs.greeting.required === true`, `inputs.names.options` equals `['world','studio','reader']`, `jobs.map(j => j.id)` in topo order starting `greet, analyze`, the `pick` job's step `choose` has `kind: 'island'`, `headless: 'auto'`, `outputs.line`; `review/confirm` has `kind: 'form'`, `headless: 'skip'`, `fields.cover`; `headlessSafe` copied from the listing.
- [ ] **Steps 2–4:** implement (`registry.ts` has no unit test of its own beyond a jsdom smoke that `resolveModelContext()` resolves to an object exposing `registerTool` — the polyfill installs in jsdom); green; commit `feat(workflow): agent registry (native modelContext or polyfill), page RunSnapshot, describeWorkflow`.

### Task 6: read-only executors + the `src/agent` fence

**Files:** Create `src/agent/executors.ts`, `src/agent/executors.test.ts`; modify `eslint.config.js`.

**Interfaces:**

```ts
export interface ExecutorDeps {
  store: AppStore
  navigate: (to: string) => void
  /** The route the page is on, for defaults (`/:impl/:workflow/...`); read at call time. */
  location: () => { pathname: string }
  now?: () => number
}
export type Executor = (args: Record<string, unknown>) => Promise<CallToolResult>
export function createExecutors(deps: ExecutorDeps): Record<ToolName, Executor>
```

Read tools: `workflow.list` → `discover.initiate()` → `{ implementations: [{ alias, name, version?, preview, error?, workflows: [{ id, name, description?, headlessSafe }] }] }` (filtered to `args.impl` when given; text: one line per implementation); `workflow.describe` → `loadWorkflowDefinition` → `describeWorkflow`, or its refusal; `workflow.status` → current slice run (`runSnapshotOf`) when `runId` is absent or equals it, else `getRun.initiate(runId, { forceRefetch: true })` → `snapshotFromRows`; no run → `errorResult('No run is on this page — pass runId', { errors: { runId } })`; `workflow.outputs` → the same resolution, returns `{ runId, status, outputs }` (File refs, never bytes); `workflow.runs` → `listRuns.initiate({ impl, workflow })` with Decision 5's defaults → `{ runs: [{ runId, status, startedAt, finishedAt?, headless, waitingOn }] }` filtered/capped. The six mutation tools are present in the record and return `errorResult('workflow.<x> arrives with the next story', { errors: { tool: 'not implemented yet' } })` — replaced in Task 9.

Fence (`eslint.config.js`, a new block for `files: ['src/agent/**/*.ts', 'src/agent/**/*.tsx']`): `no-restricted-imports` patterns `['../lib/runner/*', '../lib/runner/**', '../components/*', '../components/**', '../pages/*', '../pages/**', '../islands/*', '!../islands/hostDeps', '../mocks/*']` with the message *"src/agent binds the catalog to the store (spec 10, D19): import @bffless/workflow-agent-tools, ../store/*, lib/workflowGlobal, lib/autoStart, lib/describe and islands/hostDeps only."*

- [ ] **Step 1: failing tests** (`executors.test.ts`, MSW-backed with `makeStore()`): `list` names hello with `interactive.headlessSafe` a boolean; `describe { impl:'hello', workflow:'interactive' }` returns `structuredContent.inputs.greeting`; `describe { impl:'nope' … }` is an error with `errors.workflow === START_REFUSALS.noWorkflow`; `status {}` with no run is an error keyed `runId`; after `store.dispatch(startRun(...))` with a fake `RunnerDeps`, `status {}` returns the slice's snapshot with `waitingOn`; `status { runId: <a mock past run> }` returns rows-derived snapshot; `runs {}` on `/hello/interactive` lists the mock's runs, `{ status: 'succeeded', limit: 1 }` caps; slash-form names are accepted by the registry wrapper (Task 7) not here. A `lint` run proves the fence: a throwaway `src/agent/bad.ts` importing `../lib/runner/types` must fail lint (then delete it).
- [ ] **Steps 2–4:** implement; `pnpm workflow:lint && pnpm workflow:test && pnpm workflow:build` green; commit `feat(workflow): read-only WebMCP executors — list/describe/status/runs/outputs — and the src/agent fence`.

### Task 7: `useWebMcp` + `AgentTools`, mounted once

**Files:** Create `src/agent/useWebMcp.ts`, `src/agent/AgentTools.tsx`, `src/agent/useWebMcp.test.tsx`; modify `src/main.tsx`, `apps/workflow/CONTEXT.md` (glossary entries: **Page tools** — the catalog registered on `document.modelContext`; **Tool catalog** — `@bffless/workflow-agent-tools`; avoid: "MCP server" for the page, "plugin").

**Interfaces:**

```ts
export interface UseWebMcpOptions { resolve?: () => Promise<ModelContextLike | null> }   // test seam; default resolveModelContext
export function useWebMcp(options?: UseWebMcpOptions): void
export function AgentTools(props?: UseWebMcpOptions): null
```

The effect: `const ac = new AbortController()`; `resolve().then(ctx => { if (!ctx || ac.signal.aborted) return; const exec = createExecutors({ store, navigate: (to) => navigateRef.current(to), location: () => ({ pathname: window.location.pathname }) }); for (const tool of CATALOG) void ctx.registerTool({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, execute: (args) => exec[tool.name](args ?? {}) }, { signal: ac.signal }) })`; cleanup `ac.abort()`. `store` from `useStore()`, `navigate` from `useNavigate()` mirrored into a ref, effect deps `[]` (the `resolve` option is read once, by design — document it). A registration rejection is `console.error`'d, never thrown.

- [ ] **Step 1: failing tests** — a fake registry `{ tools: Map, registerTool(t, { signal }) { tools.set(t.name, t); signal.addEventListener('abort', () => tools.delete(t.name)) } }`; render `<Provider><MemoryRouter><AgentTools resolve={async () => fake} /></MemoryRouter></Provider>`: after a tick, `fake.tools.size === 11` and every name is in `TOOL_NAMES`; `fake.tools.get('workflow.list').annotations.readOnlyHint === true`; calling `fake.tools.get('workflow.status').execute({})` resolves to a `CallToolResult`; unmount → `fake.tools.size === 0`; re-render (props change) does **not** re-register (`registerTool` call count stays 11); a `resolve` resolving `null` registers nothing and logs nothing; a resolve that settles after unmount registers nothing.
- [ ] **Step 2: `main.tsx`** — `<App /><AgentTools />` inside `BrowserRouter`; a Vite dev smoke (`pnpm workflow:dev`, `node localdev-tools/shot.mjs http://localhost:5173/ --out …`) shows no console error and, via chrome-devtools `evaluate_script`, `(await document.modelContext.getTools()).map(t => t.name)` lists the 11.
- [ ] **Steps 3–4:** green chain (`workflow:lint`, `workflow:test`, `workflow:build`, `apps:check`); commit `feat(workflow): register the catalog on document.modelContext from one AgentTools effect`; PR `feat(workflow): WebMCP page tools — the read-only catalog on document.modelContext` into the epic, body naming the new app dependency on the package (checklist §6) and the fence. Merge on green; tick story 3 on #554.

# Phase C — Story 4: mutations + the live proof (Tasks 8–12)

*Deliverable: all 11 tools work; a `page-tools` walk in `workflow-live` drives `hello/interactive` end to end through page tools and asserts on `run.json`; the same sequence runs in CI against the mock backend. Branch `feat/m5-webmcp-mutations`, worktree `.claude/worktrees/m5-webmcp-mutations`, based on the epic after Story 3 merged.*

### Task 8: the `submitStep` thunk (forms and islands, one path)

**Files:** Create `src/store/submitActions.ts`, `src/store/submitActions.test.ts`; modify `src/components/run/FormStepPane.tsx:110-123`.

**Interfaces:**

```ts
export type SubmitResult = { ok: true } | { ok: false; errors: Record<string, string> }
/** Completes the *waiting* step `key` of the run this tab drives: a form's values through `completeFormStep`, an island's outputs through `completeIslandStep` — the same validators a person's submit and an island's `workflow.submit` run. Refuses (never throws) when no live run, unknown key, wrong status, or a kind that does not wait. */
export function submitStep(a: { key: StepKey; values: Record<string, unknown>; at?: number }): AppThunk<SubmitResult>
```

Refusal keys: `step` (`'No such step in this run'`, `'That step is not waiting (status: running)'`, `'A pipeline step cannot be submitted'`), `runId` (`'This page is not driving a run'`). `FormStepPane.handleSubmit` becomes `const r = dispatch(submitStep({ key, values })); r.ok ? setErrors({}) : setErrors(r.errors)`.

- [ ] **Step 1: failing tests** — with `makeStore(fakeDeps)` and a hello run advanced to `review/0/confirm` waiting (the fixtures `runnerMiddleware.form.test.ts` already builds): a valid submit dispatches `step.succeeded` with the validated outputs and the run proceeds; a missing required `cover` returns `{ ok: false, errors: { cover: … } }` and dispatches nothing; an island step at `waiting` accepts `{ line: 'Hello, world!', index: 0 }` and refuses `{ index: 'x' }` with the island validator's message; a `running` step is refused under `step`; `FormStepPane.test.tsx` still green.
- [ ] **Steps 2–4:** implement; green; commit `feat(workflow): submitStep thunk — the one submit path for forms, islands, people and agents`.

### Task 9: the six mutation executors + navigation coupling

**Files:** Modify `src/agent/executors.ts`, `src/agent/executors.test.ts`.

Behaviour (each an `Executor`, replacing Task 6's stubs):

- `workflow.start { impl, workflow, inputs }` → `loadWorkflowDefinition` (refusal → its error result) → `initialValues(def.inputs, inputs)` → `validateInputs` → non-empty → `errorResult('These inputs cannot start a run', { errors })`; `inputs` not an object → `errorResult(…, { errors: { inputs: '`inputs` must be an object of input values' } })`; else `dispatch(startRun({ impl, workflow, def, yaml, workflowName: def.name, workflowVersion, values, headless: false, unattended: false }))` → `navigate(`/${impl}/${workflow}/runs/${runId}`)` → `textResult('Started …', { runId, snapshot: runSnapshotOf(def, state) })`.
- `workflow.await { runId?, until, timeoutMs? }` → Decision 7; text `'Run <id> is waiting on pick/0/choose (island)'` / `'Run <id> succeeded'`; `until` outside the enum → error keyed `until`.
- `workflow.submitStep { runId?, step, values }` → `runId` must be absent or the slice's (else the Decision-8 refusal) → `dispatch(submitStep({ key: step, values }))` → ok → `textResult('Submitted <step>', { runId, snapshot })`; refusal → `errorResult('Could not submit <step>', { errors })`.
- `workflow.sign { runId?, path }` → `signFile(httpJsonWithReauth)(path)` → `{ url, expiresIn }`; a rejection's message becomes `errors.path`.
- `workflow.cancel { runId? }` → slice check (Decision 8) → `await dispatch(cancelRun())` → snapshot.
- `workflow.resume { runId }` → `getRun.initiate(runId, { forceRefetch: true })` → no row → `errors.runId: 'No such run'`; row not `running` → `errors.runId: 'Run <id> is <status>; only a running run can be resumed'`; else `await dispatch(takeOver({ runId, run, steps }))`; adopted live → navigate to `/${run.impl}/${run.workflow}/runs/${runId}` + snapshot; not adopted → `errors.runId: 'Could not take this run over — it is still held elsewhere'` (the banner's wording); `LeaseTransportError` → `errors.runId: "Couldn't reach the server — try again"`.

- [ ] **Step 1: failing tests** — `start` with `{ greeting: 42 }` → error, `errors.greeting === 'Expected a valid string value'` (the `validateInputs` string) and `store.getState().run.state === null`; `start` valid → `navigate` called with `/hello/interactive/runs/<runId>`, `structuredContent.runId` matches, `run.state.headless === false`; `await { until: 'waiting' }` resolves once the fake deps park `pick/0/choose` (virtual clock), `{ until: 'terminal', timeoutMs: 10 }` → `isError` with `structuredContent.timedOut === true`; `submitStep` happy + refused; `cancel {}` → `status: 'cancelled'`; `cancel { runId: 'other' }` → Decision-8 refusal; `resume` for a mock `running` row whose lease is expired → `navigate` called and `mode === 'live'`; `resume` of a `succeeded` row → refused; `sign` with an MSW-served `/api/workflow/files/sign` → `url` returned, an out-of-prefix path → `errors.path` equals `hostDeps`'s `NOT_CONFINED` message.
- [ ] **Steps 2–4:** implement; green; commit `feat(workflow): WebMCP mutations — start/await/submitStep/sign/cancel/resume drive the store and navigate`.

### Task 10: `workflow-headless` page-tool helpers

**Files:** Create `packages/workflow-headless/src/pageTools.ts`, `test/pageTools.test.ts`; modify `src/index.ts`, `README.md` (a "Page tools (WebMCP)" section).

**Interfaces:**

```ts
export interface PageToolInfo { name: string; description: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }
export interface PageToolResult { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }
export class PageToolError extends Error { constructor(message: string, readonly result?: PageToolResult) }
/** `document.modelContext.getTools()` (falling back to `navigator.modelContext`), as plain data. */
export function listPageTools(page: PageLike): Promise<PageToolInfo[]>
/** Polls `listPageTools` until every `names` entry is present (default: all 11 `workflow.*`), or times out (DriverError, EXIT.TIMEOUT). */
export function waitForPageTools(page: PageLike, o: { timeoutMs: number; names?: string[]; pollMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<PageToolInfo[]>
/** Finds the descriptor by (canonical) name, calls `executeTool(descriptor, JSON.stringify(args))`, parses a string result (Decision 11). Never throws on `isError` — the caller reads it; throws `PageToolError` when the tool is absent or the bridge itself fails. */
export function callPageTool(page: PageLike, name: string, args?: Record<string, unknown>): Promise<PageToolResult>
```

The in-page function passed to `page.evaluate` is self-contained (no closures): `async ({ name, argsJson }) => { const ctx = document.modelContext ?? navigator.modelContext; if (!ctx) return { missing: 'modelContext' }; const tools = await ctx.getTools(); const tool = tools.find(t => t.name === name); if (!tool) return { missing: name }; const raw = await ctx.executeTool(tool, argsJson); return { raw: typeof raw === 'string' ? JSON.parse(raw) : raw } }`.

- [ ] **Step 1: failing tests** — a `PageLike` whose `evaluate(fn, arg)` runs `fn(arg)` in-process with `globalThis.document = { modelContext: fake }` (restored after): `listPageTools` maps the fake's descriptors; `callPageTool(page, 'workflow/status', {})` canonicalises and calls `executeTool` with `'{}'`, parsing the fake's JSON-string result; an object result passes through; an unknown tool throws `PageToolError`; `waitForPageTools` with an instant `sleep` resolves once the fake grows to the full list and throws `DriverError(EXIT.TIMEOUT)` otherwise.
- [ ] **Steps 2–4:** implement; `pnpm workflow-headless:lint && build && test` green; commit `feat(workflow-headless): page-tool helpers — listPageTools, waitForPageTools, callPageTool`.

### Task 11: the `page-tools` walk, the mock-backend e2e, docs

**Files:** Create `packages/workflow-live/src/walks/page-tools.ts`, `apps/workflow/e2e/page-tools.spec.ts`; modify `packages/workflow-live/src/walks/index.ts` (`WALKS['page-tools']`; **not** in `ALL_ORDER` — it spends a hello run like `hello` does, and `all` stays the M3/M4 sequence), `src/args.ts` USAGE, `test/walks.test.ts` REGISTERED, `README.md` (a row in the walk table), `.claude/agents/apps-live-walk.md` (the walk list in the description and "How you are invoked").

**The walk (`page-tools`)**, check names after the decisions they prove; every browser wait bounded, the whole walk under `report.guard` groups so a red step reads FAIL not BLOCKED:

1. `openSession` (login), `page.goto(`${harness}/`)`, `waitForPageTools(page, { timeoutMs: 30_000 })`.
2. `D21.onlyWorkflowTools` — every registered name is one of the 11; **no** name outside `workflow.*` (no pipeline tools on the page). `D19.readOnlyHints` — the six read tools carry `readOnlyHint: true`, the five others `false`.
3. `D19.listsHello` — `workflow.list` structured `implementations` has `hello` with an `interactive` workflow and a boolean `headlessSafe`.
4. `D20.describeInteractive` — `workflow.describe { impl:'hello', workflow:'interactive' }` → `inputs.greeting.required === true`, a `pick` job step `choose` with `kind:'island'`, `headless:'auto'`; `review`/`confirm` `kind:'form'`, `headless:'skip'`.
5. `spec07.refusalVerbatim` — `workflow.start` with `{ greeting: 42, names: ['world'] }` → `isError`, `structuredContent.errors.greeting === 'Expected a valid string value'`, and `workflow.status {}` afterwards still has no run (nothing started).
6. `D21.startNavigates` — `workflow.start { impl:'hello', workflow:'interactive', inputs:{ greeting:'Hello', names:['world','studio'] } }` → `runId`; `page.url()` ends `/hello/interactive/runs/<runId>` within 10 s (the member watches what the agent does). `report.run(runId)`.
7. `spec10.awaitWaitingIsland` — `workflow.await { until:'waiting', timeoutMs:120000 }` → `waitingOn[0]` is `{ key:'pick/0/choose', kind:'island', src: /pick-line\.html/ }` with `inputs.lines` a non-empty list.
8. `D21.submitIslandStep` — `workflow.submitStep { step:'pick/0/choose', values:{ line: inputs.lines[0], index: 0 } }` → not `isError`; `steps['pick/0/choose'] === 'succeeded'`.
9. `spec10.awaitWaitingForm` — `await { until:'waiting' }` → `waitingOn[0]` is `{ key:'review/0/confirm', kind:'form' }` whose `inputs.fields.cover.options` is a list of File refs.
10. `D21.submitFormStep` — `submitStep { step:'review/0/confirm', values:{ cover: options[0].path, notes:'approved by page tools', extra: null } }` → ok.
11. `run.succeeded` — `await { until:'terminal', timeoutMs:120000 }` → `status === 'succeeded'`; `outputs.poster` is a File ref (`isFileRef`).
12. `D6.signIsPresigned` — `workflow.sign { path: outputs.poster.path }` → `url` matches `/X-Goog-Signature=|X-Amz-Signature=|[?&]sig(nature)?=/` and is not on the harness origin (redact with `redactUrl` in evidence); `expiresIn > 0`.
13. `spec10.runsListsIt` — `workflow.runs { impl:'hello', workflow:'interactive', limit: 5 }` contains `runId`.
14. `record.matchesPage` — `waitForSealedRecord(s.api, runId, …)`; write the record to `<out>/run.json`; `parseRecord` → `run.status === 'succeeded'`, `run.headless === false`, `stepByKey(rec,'pick/0/choose').outputs.line === inputs.lines[0]`, `review/0/confirm` succeeded with `outputs.cover` a File ref, `run.outputs.poster` a File ref.
15. Cancel + resume: `workflow.start` a second run (`report.run`), `await { until:'waiting' }`, then `page.goto(runUrl)` (a reload drops the tab's driver; the lease is held by the same owner id in `sessionStorage`) → `waitForPageTools` → `D21.resumeAdopts` — `workflow.resume { runId }` → not `isError`, `page.url()` on the run, and a subsequent `workflow.status {}` reports the run as this page's (same `runId`) → `D21.cancelIsCancelled` — `workflow.cancel {}` → `status === 'cancelled'`; record read → `run.status === 'cancelled'`.
16. `page.noConsoleErrors` (from `s.consoleErrors`); `network.log` written; `99-failed.png` on any throw (the `hello` walk's pattern).

**The e2e (`e2e/page-tools.spec.ts`)**: the Playwright `page` fixture, `page.goto('/?mocks=on')`, then steps 1–14 above with the mock backend's hello (the mock's `pick-line` island and sign rule answer; the presigned check becomes "a `url` string is returned"), asserting through `callPageTool` from `@bffless/workflow-headless` (imported from `dist/` like `headless.spec.ts` does, and failing loudly when unbuilt). `test.setTimeout(300_000)`.

- [ ] **Step 1:** `test/walks.test.ts` REGISTERED gains `'page-tools'` and asserts `ALL_ORDER` unchanged → fails until the walk exists; write the walk and the spec.
- [ ] **Step 2:** `pnpm workflow-live:lint && pnpm workflow-live:build && pnpm workflow-live:test` green; `pnpm --filter workflow test:e2e` green locally (needs `pnpm --filter workflow stage` + `pnpm --filter @bffless/workflow-headless build` first, as CI does).
- [ ] **Step 3:** README row, USAGE, agent doc; commit `feat(workflow-live): the page-tools walk — hello/interactive driven end to end through WebMCP page tools`.
- [ ] **Step 4:** PR `feat(workflow): WebMCP mutations — start/await/submitStep/sign/cancel/resume, and the page-tools live walk` into the epic. Body: the walk's check list, the e2e, real counts. Merge on green; tick story 4 on #554.

### Task 12: the Phase-1 gate

- [ ] From the epic branch (a worktree at `epic/agent-embedding` after Story 4 merged): `pnpm --filter @bffless/workflow-agent-tools build && pnpm --filter @bffless/workflow-headless build && pnpm --filter @bffless/workflow-live build`, then dispatch the **apps-live-walk** agent with `page-tools` against `https://workflow.j5s.dev` — note the harness there is `main`'s deploy, which has **no page tools until the epic merges**; the gate therefore runs against a preview of the epic branch. `apps/workflow` has no PR preview deploy (checklist §1), so the epic-branch harness is served locally: `pnpm workflow:dev` (Vite proxies `/api`, `/w`, `/_bffless` to `workflow.j5s.dev`, so runs, rows, uploads and signing are the live j5s instance's) and the walk runs with `--harness http://localhost:5173`. Record in the #554 comment that the page came from the epic branch and the backend was j5s. (If a maintainer prefers a real preview alias, `deploy-workflow.yml` with an alias input is the Phase-2 ask — not this plan's.)
- [ ] Verdict `PASS` → check off Phase 1's three stories on #554 with the walk's `report.md` rows pasted and run ids named; `FAIL` → fix on a `fix/…` PR into the epic and re-walk; Decision 11's `Origin-Agent-Cluster` note is the first thing to check if registration itself is red.
- [ ] Update this plan's "as shipped" notes (one paragraph at the top of Phase C, the way the M3 plan did) and `apps/workflow/docs/spec/00-overview.md`'s M5 block to say Phase 1 landed on the epic branch (a `docs(workflow):` PR into the epic).

## Self-review (writing-plans checklist, applied)

- **Spec coverage:** every row of spec 10's tool table has an executor (Tasks 6, 9) and a walk check (Task 11); D19 (catalog + `CallToolResult` in both adapters) — Tasks 2–3 and Decision 6's shared `snapshotFromRows`; D20 (generic tools + `describe`) — Tasks 3, 5; D21 (page only, polyfill always, store-driven, navigation, no pipeline tools, islands never register) — Tasks 5–7, 9, the fence, the `D21.onlyWorkflowTools` check; the scope map — Task 2; refusals verbatim — Decision 2 + Tasks 4, 9, `spec07.refusalVerbatim`; the testing paragraph — Tasks 7 (fake registry), 10–11 (headless walk). Design-doc story boundaries 2/3/4 map to Phases A/B/C.
- **Placeholder scan:** the only open value is the gate's harness URL choice (local Vite over j5s vs a preview alias), resolved with a default and a recorded alternative in Task 12. Every executor's refusal string is spelled out; every check name is fixed.
- **Type consistency:** `RunSnapshot`/`WaitingStep`/`CallToolResult` defined once (Task 3) and used by `runSnapshotOf` (Task 5), the executors (6, 9), `PageToolResult` (10, a structural mirror, deliberately not an import — the driver must not depend on the catalog to read a page); `LoadedTarget` (Task 4) consumed by `describe` (6) and `start` (9); `submitStep`'s `SubmitResult` (8) surfaced by the executor (9); `START_REFUSALS` (4) asserted in 6 and 11.

## Execution handoff

Plan complete. Execute story by story with **superpowers:subagent-driven-development** (fresh subagent per task, review between tasks) or inline with **superpowers:executing-plans**. Human-gated moments: merging the epic PR itself; nothing else in Phase 1 touches a production surface.
