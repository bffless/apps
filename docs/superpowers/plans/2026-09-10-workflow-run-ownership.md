# Workflow — user-owned runs (D26–D29, ADR-0007) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Part A (CE) is built first, in a `repos/ce` worktree, and must release before Part B merges** — the harness bumps `requires.ceMin` behind it. Part C (the headless driver) is independent of CE and may run in parallel with Part A. Part D is the person-gated cutover.

**Goal:** A run belongs to `startedBy`; every surface — harness UI, MCP endpoint, `workflow-headless`, raw API — defaults to the caller's own runs, an owner/admin widens only by asking (`scope=all`), a dispatched driver acts on a nonce, and run bytes follow run records.

**Architecture:** CE gains one derived field, `PipelineUser.projectRole`, resolved once per pipeline request from `project_permissions` (global admin ⇒ `owner`, as CE's own guard already rules) and projected into the function sandbox. The harness gets **one** shared gate, `src/mcp/runGate.ts` → `mcp-fn/runGate.fn.js`, imported by every hand-written run-scoped rule and rendered into every run-scoped MCP tool rule by the generator; every gated rule loads its run into a `data_query` step named `run` and runs the gate as a step named `runGate`, so one CI fence can classify all 36 rules. Dispatch attribution is a `workflow_run_claims` row written by `run/drive` and consumed by `runs/post`; the driver carries the nonce as the `x-workflow-drive-key` header on every request the driven page makes. Lists are two conditional queries (`mine` / `all`).

**Tech Stack:** CE backend — NestJS 10, Drizzle (no migration in this change), Jest (`pnpm --filter backend test -- <spec>`), Prettier-gated CI. Harness — rules-as-code under `apps/workflow/.bffless/proxy-rules/workflow/` (YAML rules, `.fn.js` functions inlined by the CLI at sync), esbuild bundles from `apps/workflow/src/mcp/*.ts` (`pnpm --filter workflow mcp:build`, held fresh by `src/mcp/bundle.test.ts`), React 19 + Vite + RTK Query SPA, Vitest + MSW (`onUnhandledRequest: 'error'`), Playwright. `@bffless/workflow-agent-tools` (published catalog, release-please). `packages/workflow-headless` (Playwright driver, published), `packages/workflow-cli` (ships `drive.yml.tmpl`), `packages/workflow-live` (walks). `bffless` CLI `rules push --adopt-fields` for the two new optional columns.

**Spec:** `apps/workflow/docs/spec/11-run-ownership.md` (the whole document; D26–D29) · `apps/workflow/docs/adr/0007-user-owned-runs.md` · amended passages in `05-runs-and-persistence.md` and `06-discovery-publishing-files.md` · the D-table in `00-overview.md`. Related: 07 (headless), 10 (MCP endpoint, D23 scopes), ADR-0006 (driven runs). Read the spec before any task; every task below cites the section it implements.

## Decisions this plan makes (spec-ambiguous points, resolved here)

1. **`projectRole` is CE's answer, including CE's global-admin rule.** `ProjectPermissionGuard` (`project-permission.guard.ts:92-99`) and the public docs say a global `admin` is `owner` on every project, but `PermissionsService.getUserProjectRole` does not apply that bypass. CE's new resolver applies it, so `projectRole` means the same thing in a pipeline as it does on the admin API. This is *not* the harness falling back to the global role (rejected in ADR-0007): the harness reads `projectRole` only. A pinned-`'user'` API key and the guard-path key (no role) never trip the bypass, so a leaked key still cannot widen.
2. **The union includes `guest`.** CE's `ProjectRole` is `owner | admin | contributor | viewer | guest`; `PipelineUser.projectRole` uses that type verbatim. The gate only ever asks "∈ {owner, admin}", so a guest is simply not exempt.
3. **One enrichment site, not four.** All credential branches funnel through `ProxyMiddleware.getOptionalUser`; the groups-enrichment block in `handlePipelineExecution` (`proxy.middleware.ts:1112-1127`) already has `projectId` in scope and `PermissionsService` injected. `projectRole` is resolved there against the **pipeline's** project (never the token's or key's), degrading to `undefined` on lookup failure exactly as `groups` degrades to `[]`. The "test this rule" endpoint (`proxy-rules.controller.ts:308-336`) resolves it the same way for the real caller and accepts `mockUser.projectRole`.
4. **"Not found" is whatever the rule answers for an unknown id today.** `run/get` answers 200 `{ run: null, steps: [] }` for an unknown id and the SPA's "No such run" state keys off that, so an invisible run answers the same 200 — not a 404 that would render "Couldn't load this run". Every other gated rule answers 404 `{ ok:false, error:'run not found' }`; MCP tools answer their existing `No such run` `CallToolResult` (HTTP 200, `isError`), and `workflow.status`'s pending window is untouched (an invisible run is indistinguishable from a not-yet-written one, which is the point).
5. **The gate reads `steps.run` and nothing else.** Every gated rule's run loader is a `data_query` step with `id: run` over `$schema:workflow_runs` (rules whose loader was `find`/`parent` rename it), and the gate step is `id: runGate`. Uniform names are what make the fence one predicate. The gate's only exception is a `runless` flag set by a path-parsing predecessor (`steps.route` in MCP rules; `steps.confine` / `steps.normalize` in the file rules) for `inputs/` paths, which name no run (D18).
6. **"Asked for" on a single run is a header; on a list it is `scope=all`.** The list endpoints read `request.query.scope` (and `request.body.scope` for the MCP tool). Every gated single-run rule also honours the request header `x-workflow-scope: all`, which the SPA sends on every `/api/workflow/*` and `/api/uploads/*` request while the person's "All runs" toggle is on (only rendered for `projectRole` owner/admin). An MCP caller has no header and the run-scoped tool schemas gain no `scope` argument in this plan — **deferred** (sharing/grants is the real answer for "act on someone else's run from claude.ai").
7. **The nonce is a header the driver injects with `page.route`.** `runs/post` is issued by the harness SPA inside the driven page, not by the driver (`apps/workflow/src/lib/runStore.ts:108-110`), so `api.ts`'s own header path cannot carry it. `workflow-headless` reads `WORKFLOW_DRIVE_KEY` (env, or `--drive-key`) and installs a Playwright route on `/api/workflow/**` and `/api/uploads/**` that adds `x-workflow-drive-key` to every request the page makes — the SPA's `runs/post`, its reads and writes in resume mode, the driver's own in-page fetches, and the run page's file loads. The presigned bucket PUT/GET never sees it (different origin, not matched).
8. **The nonce is minted with CE's sandbox `utils.randomToken`.** `function_handler` receives `utils` on the handler argument (`function-runner.service.ts`, `randomToken(bytes)` → crypto-strong hex). `run/drive` mints a fresh key on **every** dispatch: `mode: run` writes it to the claim; `mode: resume` writes it onto the run row (`driveKey`) — a browser-started run has none until it is resumed from the endpoint. A retry of `mode: run` by the same requester reuses the existing claim; another member's `mode: run` on a claimed id is `RUN_EXISTS`.
9. **`driveKey` clears at terminal status in two places.** `run/update`'s merge writes `driveKey: ''` whenever the merged status is terminal (belt), and the gate refuses the nonce door on a terminal row (braces). A row with no key gets `''` written, which the gate treats as "no key". — **Superseded 2026-09-11 (apps#665 review): neither half survives.** The driver reads the run *after* sealing it (the record, then every file output — spec 07 §Results), holding nothing but the nonce, so the drive door admits regardless of status and the merge carries `driveKey` through unchanged; a later dispatch re-mints it. A row with no key still gets `''`.
10. **`startedByEmail` is written at create.** `runs/post` (from `user.email`, or the claim's copy), `run/fork` (from the caller), and the claim row carries it so a dispatched run shows the requester. The SPA renders `startedByEmail ?? startedBy`.
11. **Three apps PRs, in this order:** (C) `feat(workflow-headless): carry the drive nonce` — harmless without a key, releases the driver; (C3) the `bffless/workflow-implementations` `drive.yml` env line — harmless without a payload key; (B) `feat(workflow): user-owned runs` — everything else, one PR on one branch with one commit per task. Harness rules go live only on merge to `main` (memory: *workflow app rules land on merge only*), so B is the cutover and must merge **after** CE ≥ 0.4.57 is on both instances and after C/C3 are live.
12. **Fixtures move to the mock member.** Three of four MSW run fixtures carry `startedBy: 'user_fixture'`; a default-to-mine list would hide them from every existing SPA test. They become `MOCK_MEMBER.id` (`user_mock`) with a `startedByEmail`; tests that need "someone else's run" seed `{ ...fixture, startedBy: MOCK_OTHER.id }`.
13. **No new rules, so the fixed counts hold.** `bundle.test.ts` (`1 + 15 + 2`), `scopes.test.ts` (`RULE_SCOPES` = 16) are unchanged; `rules.fence.test.ts`'s `mcp-fn` regex widens to admit `runGate`.

## Deferred out of this plan, explicitly

- `workflow_run_grants` and any sharing UI — the gate calls `hasGrant()` which returns `false`.
- `scope` on the run-scoped MCP tool schemas (Decision 6).
- Surfacing an unconsumed claim as a `queued` run in lists; garbage-collecting stale claims.
- A cross-workflow "my runs" page; guest/public runs; per-user `inputs/`.
- Adding an `adopt-fields` input to `bffless/deploy-proxy-rules` (the standing sync gap stays a hand step, Part D).

## Global Constraints

- **Spec 11 verbatim:** default visibility is the caller's own runs on every surface · four doors (owner, drive nonce, all-scope, grant-stub) · unreachable run = the rule's not-found answer · explicit `scope=all` without the role = **403** · ownerless run = all-scope only · the exemption is asked for, never assumed · `projectRole ∈ {owner, admin}` is the only role test · the gate **never throws** · one shared gate, one flag per outcome, every later step gated on `ok` · `inputs/` stays member-wide.
- **CE stays app-agnostic (D22, and the person's standing rule).** The CE PR contains exactly one behavioural change — `PipelineUser.projectRole`, a project fact every pipeline on every install can read — and nothing else: no word `workflow`, `run`, `startedBy`, `driveKey` or `scope` appears in CE code, tests or docs from this plan; no CE endpoint, handler, validator or header convention is added for the harness. Every ownership rule lives in the harness's rule set. If a task in Part B turns out to need a second CE change, stop and raise it — do not fold it into Part A.
- **Worktrees only, in both repos, under `.claude/worktrees/`** (memory: *use worktrees in repos/apps*). CE: `cd /home/rico/bffless/repos/ce && git worktree add .claude/worktrees/project-role -b feat/pipeline-user-project-role origin/main && cd .claude/worktrees/project-role && pnpm install --frozen-lockfile`. Apps: `cd /home/rico/bffless/repos/apps && git worktree remove .claude/worktrees/run-ownership` (the merged spec worktree) then `git worktree add .claude/worktrees/run-ownership -b feat/run-ownership origin/main && cd .claude/worktrees/run-ownership && pnpm install --frozen-lockfile`; the headless PR uses `.claude/worktrees/drive-key -b feat/headless-drive-key origin/main`. The shared checkouts are never switched.
- **PR titles are release commits.** CE: `feat(pipelines): projectRole on PipelineUser — the caller's project role, resolved on every credential path`. Apps: `feat(workflow-headless): carry the drive nonce on every request the driven page makes` · `feat(workflow): user-owned runs — ownership enforced on reads, asked-for all-scope, drive claims, files follow the run (D26–D29)`. Never edit a `CHANGELOG.md`.
- **Commit only after the task's verify chain is green**; never `git push --force` on a shared branch; ask before merging anything (CLAUDE.md).
- **CE verify chain (per task):** `pnpm --filter backend exec tsc --noEmit` · `cd apps/backend && pnpm test -- <spec>` for the touched specs · `pnpm --filter backend format:check` (Prettier gates CI). No `pnpm --filter backend lint` drive-bys.
- **Apps verify chain (per task):** `pnpm --filter workflow mcp:build` after any edit under `apps/workflow/src/**` (the source rev re-keys the rendered endpoint rule) · `pnpm --filter workflow lint` · `pnpm --filter workflow test:run` · for catalog changes `pnpm --filter @bffless/workflow-agent-tools build lint test:run` · for headless `pnpm --filter @bffless/workflow-headless build test:run` · for the CLI `pnpm --filter @bffless/workflow-cli test:run` · `pnpm --filter workflow build` before the PR.
- **CE step conditions are simple paths** (memory: *pipeline conditions are simple paths only*): every gate outcome is a boolean flag on the step output; never `&&`/`!` in a `condition:`.
- **`response_handler.status` is a literal number**, so one responder per status, each gated on its own flag; a skipped responder leaves the response to the last one that ran, so every success `respond` is gated on `ok` too (the `run/delete` comment block is the reference).
- **Never hand-edit generated files** (`mcp-fn/*.fn.js`, `rules/api/workflow/mcp/**`, `mcp-tools/**`, `mcp-resources/**`); edit `src/mcp/**` / `scripts/build-mcp.mjs` and run `mcp:build`.
- **Rule-set schema changes:** new schema files sync cleanly; new optional fields on `workflow_runs` need `bffless rules push --adopt-fields` by hand after merge (Part D).

## Cross-repo sequencing

```
A  CE: projectRole ──► CE release v0.4.57 ──► on j5s + bffless.dev (person confirms)
C  headless drive nonce ──► headless release ──► C3 implementations drive.yml merged
                                                        │
B  harness (branch feat/run-ownership, tests green throughout) ──► PR opens after A's release exists;
   merges only after A is on both instances AND C3 is live ──► D: adopt-fields push, ownership walk on j5s, prove on bffless.dev
```

What B's PR waits on, and how the session knows: (1) `gh release view --repo bffless/ce` shows a tag ≥ v0.4.57 whose notes mention `projectRole`; (2) the person confirms both harness instances run it (ask via remote — the session cannot deploy CE); (3) `gh pr view --repo bffless/workflow-implementations` shows the `drive.yml` PR merged; (4) `npm view @bffless/workflow-headless version` ≥ the release cut by C.

## File structure

**CE (`repos/ce/apps/backend/src`)**
- `pipelines/execution/pipeline-context.interface.ts` — `projectRole?: ProjectRole` on `PipelineUser`.
- `proxy-rules/proxy.middleware.ts` — `resolveProjectRole(user, projectId)` + the enrichment in `handlePipelineExecution`.
- `proxy-rules/proxy-rules.controller.ts` — the test-rule endpoint's user gets `projectRole`.
- `pipelines/handlers/function.handler.ts` — sandbox projection adds `projectRole`.
- `pipelines/execution/step-handler.interface.ts` — the stale `data.user` doc comment.
- specs: `proxy-rules/proxy.middleware.spec.ts`, `proxy-rules/proxy-rules.controller.spec.ts`, `pipelines/handlers/function.handler.spec.ts`, `pipelines/execution/expression-evaluator.spec.ts`.

**Harness rule set (`apps/workflow/.bffless/proxy-rules/workflow`)**
- `mcp-fn/runGate.fn.js` (generated from `src/mcp/runGate.ts`) — the one gate.
- `schemas/workflow_run_claims.schema.yaml` (new); `schemas/workflow_runs.schema.yaml` (+ `driveKey`, `startedByEmail`).
- `rules/api/workflow/runs/get/` — `scope.fn.js` (new), `rule.yaml` (two queries), `shape.fn.js`.
- `rules/api/workflow/runs/post/` — `admit.fn.js` (replaces `exists.fn.js`), `rule.yaml` (claim query, consume).
- `rules/api/workflow/run/{get,update,lease,delete,fork}/…`, `rules/api/workflow/run-step/post/`, `rules/api/workflow/run/drive/post/` — `run` loader + `runGate` step + responders.
- `rules/api/workflow/files/{sign,prepare,register}/post/`, `rules/api/uploads/workflows/[...path]/get.rule.yaml` — locator + `run` + `runGate`.
- `rules/api/workflow/whoami/get/me.fn.js` — `projectRole`.

**Harness source (`apps/workflow/src`)**
- `mcp/runGate.ts` (new) — the gate, pure; `mcp/route.ts` (scope flags, `runless`, `user`), `mcp/reply.ts`, `mcp/merge.ts`, `mcp/plan.ts` (read runs through the gate), `mcp/driveGate.ts` + `mcp/drivePlan.ts` (claims, nonce), `mcp/mcpConfig.ts` (step lists), `scripts/build-mcp.mjs` (`runGate` entry, `RUN_ROWS`, `runs`/`runsAll`).
- `mocks/runGate.ts` (new, the mock twin), `mocks/runGate.fn.parity.test.ts` (new), `mocks/db.ts` (`MOCK_OTHER`, claims table), `mocks/handlers.ts`, `mocks/browser.ts`, `mocks/fixtures/*`.
- `lib/scope.ts` (new) — the toggle's persisted state + header; `lib/http.ts`, `store/workflowApi.ts` (send it); `store/uiSlice.ts`; `pages/RunsPage.tsx`; `components/run/RunHeader.tsx`; `store/useRunDelete.ts`; `lib/coerce.ts`.
- `rules.fence.test.ts` — the classification fence.

**Catalog** — `packages/workflow-agent-tools/src/schemas.ts` (`scope`), `src/catalog.ts` (description), tests.

**Headless / CLI** — `packages/workflow-headless/src/{args,cli,run,resume,login,runs}.ts` + tests; `packages/workflow-cli/src/templates/drive.yml.tmpl`.

**Live** — `packages/workflow-live/src/walks/ownership.ts` (new), `src/walks/index.ts`, `src/env.ts`, `README.md`.

## Traceability — spec 11 → tasks

| Spec section | Tasks |
|---|---|
| The model (D26): four doors, 404-not-403, ownerless | B1 (gate), B4–B6 (rules), B8 (MCP) |
| The exemption is asked for (D27); `projectRole` + CE; `whoami` reports it | A1–A4, B9 (whoami + toggle), B3/B8 (403 on lists) |
| One gate, not twenty-five copies; the fence | B1, B8 (fence) |
| Listing: two queries; `scope` is a catalog change | B3, B8 |
| Attribution: a claim (D28) | B2 (schema), B7 (rules), C1–C3 (driver) |
| Files follow the run (D29) | B6 |
| What the person sees | B9 |
| Testing: fence, parity, second identity, live walk | B1, B8, B9, B10, D |
| Sequencing: CE first, `ceMin` | A5, B11, D |

---

# Part A — CE: `projectRole` on `PipelineUser`

Worktree: `repos/ce/.claude/worktrees/project-role`, branch `feat/pipeline-user-project-role` off `origin/main`. No migration: the field is derived at request time from `project_permissions`. PR title in Global Constraints; body says what and why (spec 11 §"Why `projectRole`, and why it needs CE"), links the spec, and notes "no schema change; backwards compatible: the field is absent for callers with no project role; generic — CE learns nothing about any app, the field is a project fact any pipeline may read".

### Task A1: the type and the resolver

**Files:**
- Modify: `apps/backend/src/pipelines/execution/pipeline-context.interface.ts:6-18`
- Modify: `apps/backend/src/permissions/permissions.service.ts` (one new public method beside `getUserProjectRole` at `:93`)
- Modify: `apps/backend/src/proxy-rules/proxy.middleware.ts:1112-1127` (the groups block)
- Test: `apps/backend/src/permissions/permissions.service.spec.ts` (or the existing spec that covers `getUserProjectRole` — find it with `grep -rl getUserProjectRole apps/backend/src --include=*.spec.ts`), `apps/backend/src/proxy-rules/proxy.middleware.spec.ts` (new `describe('handlePipelineExecution — projectRole (spec 11, D27)')`)

**Interfaces:**

```ts
// pipeline-context.interface.ts
import type { ProjectRole } from '../../permissions/permissions.service';
export interface PipelineUser {
  id: string;
  email?: string;
  role?: string;
  groups?: string[];
  credential?: 'session' | 'api_key' | 'app_token' | 'custom_domain';
  scopes?: string[];
  tokenProjectId?: string;
  /**
   * The caller's role on the PIPELINE's project (`project_permissions`, direct or
   * via a group; a global `admin` is `owner` on every project, as
   * ProjectPermissionGuard rules). Absent when the caller holds no role there or
   * the lookup failed. Orthogonal to `role` (the global role) and to the API-key
   * pinning: an API key's user resolves through their own permission rows.
   */
  projectRole?: ProjectRole;
}

// permissions.service.ts (public) — the one resolver both the proxy middleware and the
// test-rule endpoint call. Generic: a project fact, nothing app-specific.
/**
 * The role `user` effectively holds on `projectId`: a global `admin` is `owner` on every
 * project (the rule ProjectPermissionGuard applies), otherwise the highest of the direct and
 * group rows (`getUserProjectRole`). Never throws — `undefined` on no role or on a failed lookup.
 */
async getEffectiveProjectRole(user: { id: string; role?: string }, projectId: string): Promise<ProjectRole | undefined>
```

- [ ] **Step 1: write the failing tests.**
  - `PermissionsService.getEffectiveProjectRole` (in the spec that already mocks `db/client` for `getUserProjectRole`): four cases — `{ id:'u1', role:'user' }` with a direct `contributor` row → `'contributor'`; `{ id:'u1', role:'admin' }` → `'owner'` and the db is **not** queried; `{ id:'u1', role:'user' }` with no rows → `undefined`; `{ id:'u1' }` (no role — the guard-path API key) with the query rejecting → `undefined`, no throw.
  - `proxy.middleware.spec.ts`, a new describe reusing the existing harness (`mockPermissionsService` at `:83-86` gains `getEffectiveProjectRole: jest.fn().mockResolvedValue(undefined)`; `getOptionalUser` is spied as at `:866`). Two cases asserting the `user` argument `mockPipelineExecutionService.executePipelineWithDebug` receives (call shape at `proxy.middleware.ts:1129-1135`):

```ts
it('enriches the pipeline user with projectRole resolved against the PIPELINE project', async () => {
  jest.spyOn(middleware as any, 'getOptionalUser').mockResolvedValue({ id: 'u1', role: 'user', credential: 'session' });
  mockPermissionsService.getEffectiveProjectRole.mockResolvedValue('contributor');
  await (middleware as any).handlePipelineExecution(req, res, rule, 'proj-1', undefined);
  expect(mockPermissionsService.getEffectiveProjectRole).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1', role: 'user' }), 'proj-1');
  expect(mockPipelineExecutionService.executePipelineWithDebug).toHaveBeenCalledWith(
    expect.anything(), expect.anything(), expect.objectContaining({ id: 'u1', projectRole: 'contributor', groups: [] }), expect.anything());
});
it('leaves projectRole absent (not undefined-valued) when the resolver answers undefined', …
  // getEffectiveProjectRole → undefined → the user passed on has groups [] and `not.toHaveProperty('projectRole')`
```
Build `req`/`res`/`rule` the way the `X-Pipeline-Log-Id (#716)` describe at `:829` does (copy its fixtures).

- [ ] **Step 2: run to verify they fail.** `cd apps/backend && pnpm test -- permissions.service.spec proxy.middleware.spec` → the new cases FAIL (no such method; `projectRole` never set).

- [ ] **Step 3: implement.** In `pipeline-context.interface.ts` add the import and the field as above. In `permissions.service.ts`:

```ts
  async getEffectiveProjectRole(user: { id: string; role?: string }, projectId: string): Promise<ProjectRole | undefined> {
    // Global admins act as project owners on every project (project-permission.guard.ts).
    // The API-key paths never carry `admin` (pinned to `user`, or no role at all), so a
    // leaked key cannot widen through this line.
    if (user.role === 'admin') return 'owner';
    try {
      return (await this.getUserProjectRole(user.id, projectId)) ?? undefined;
    } catch (error) {
      this.logger.warn(`Project role lookup failed for ${user.id} on ${projectId}: ${error}`);
      return undefined;
    }
  }
```
(add a `Logger` to the service if it has none — `private readonly logger = new Logger(PermissionsService.name)`). In `proxy.middleware.ts` replace the groups block with:

```ts
      let pipelineUser: PipelineUser | undefined = user;
      if (user) {
        let groups: string[] = [];
        try {
          groups = await this.userGroupsService.getGroupIdsForUser(user.id);
        } catch (error) {
          this.logger.warn(`Group membership lookup failed for ${user.id}: ${error}`);
        }
        const projectRole = await this.permissionsService.getEffectiveProjectRole(user, projectId);
        pipelineUser = { ...user, groups, ...(projectRole ? { projectRole } : {}) };
      }
```
`PermissionsService` is already injected into the middleware (`proxy.middleware.ts:82`).

- [ ] **Step 4: verify.** `pnpm test -- permissions.service.spec proxy.middleware.spec` → all green; `pnpm --filter backend exec tsc --noEmit`; `pnpm --filter backend format:check`.
- [ ] **Step 5: commit** `feat(pipelines): projectRole on PipelineUser, resolved once per pipeline request`.

### Task A2: the function sandbox sees it; the test-rule endpoint matches production

**Files:**
- Modify: `apps/backend/src/pipelines/handlers/function.handler.ts:71-83`
- Modify: `apps/backend/src/pipelines/execution/step-handler.interface.ts:303-311` (doc comment)
- Modify: `apps/backend/src/proxy-rules/proxy-rules.controller.ts:308-336`; the `mockUser` DTO (`apps/backend/src/proxy-rules/dto/*test*.dto.ts` — find the class that declares `mockUser.groups` and add `projectRole?: string` with the same decorators as `role`)
- Test: `apps/backend/src/pipelines/handlers/function.handler.spec.ts`, `apps/backend/src/proxy-rules/proxy-rules.controller.spec.ts`, `apps/backend/src/pipelines/execution/expression-evaluator.spec.ts`

**Behaviour:** `data.user.projectRole` is present in the sandbox exactly when `context.user.projectRole` is set (conditional spread, like `credential`/`scopes`, so `it('adds nothing for a session user')` keeps passing). `user.projectRole` resolves in expressions with no evaluator change (the `user` root is a nested read). The test endpoint resolves `projectRole` for the real caller through A1's `getEffectiveProjectRole` and passes `dto.mockUser.projectRole` through.

- [ ] **Step 1: failing tests.**
  - `function.handler.spec.ts`: a new `describe('FunctionHandler.execute — user.projectRole (spec 11)')` cloning the `credential / scopes` describe at `:86-110`: `exposes the project role` (context user `{ id:'u1', role:'user', projectRole:'admin' }` → `runnerMock.run` called with `user: expect.objectContaining({ projectRole: 'admin' })`) and `adds nothing without one` (`not.toHaveProperty('projectRole')`).
  - `expression-evaluator.spec.ts`: `it('reads user.projectRole off the pipeline user')` — build a minimal context `{ user: { id:'u1', projectRole:'owner' }, stepOutputs: {}, metadata: {...}, projectId:'p', pipelineId:'x' }` and assert `evaluator.evaluateExpression('user.projectRole', context)` is `'owner'` and `'user.projectRole'` on a user without one is `undefined`/`null` (match what `getNestedValue` returns for a missing leaf — read it at `expression-evaluator.ts` and assert that exact value).
  - `proxy-rules.controller.spec.ts`: beside `passes mockUser.groups through` (`:344`): `passes mockUser.projectRole through`, `resolves the real caller's projectRole (contributor) for the test run`, `a global admin tests as owner`, `degrades to no projectRole when the lookup fails` — mirror the groups tests' assertions on the `executePipelineWithDebug` user argument.
- [ ] **Step 2: run them** (`pnpm test -- function.handler.spec expression-evaluator.spec proxy-rules.controller.spec`) → new cases FAIL.
- [ ] **Step 3: implement.** `function.handler.ts`: after the `scopes` spread add `...(context.user.projectRole ? { projectRole: context.user.projectRole } : {}),`. `step-handler.interface.ts` doc: `data.user`: `id, email, role, groups, and — when present — credential, scopes, projectRole (the caller's role on this project)`. Controller: inject `PermissionsService` if the controller does not already have it, and call A1's `getEffectiveProjectRole` — one implementation, two call sites. The `mockUser` branch: `...(dto.mockUser.projectRole ? { projectRole: dto.mockUser.projectRole as ProjectRole } : {})`; the real-user branch: `const projectRole = await this.permissionsService.getEffectiveProjectRole(user, projectId)` where `projectId` is the rule set's project id already known in that method (find the variable — the endpoint is project-scoped).
- [ ] **Step 4: verify** the three specs + A1's spec, `tsc --noEmit`, `format:check`.
- [ ] **Step 5: commit** `feat(pipelines): expose user.projectRole to function_handler and the test-rule endpoint`.

### Task A3: docs — the pipelines skill and the public docs

**Files:**
- Modify: `/home/rico/bffless/repos/skills/plugins/bffless/skills/pipelines/SKILL.md:189` (the six-roots table row for `user.*`)
- Modify: `/home/rico/bffless/repos/docs-public/docs/features/pipelines.md:386-388` (the auth validator's `user.*` list — it says `user.roles`, which does not exist)

Both are separate repos; each gets its own tiny PR (worktrees `.claude/worktrees/project-role` in each, branches `docs/user-project-role`), titles `docs(pipelines): user.projectRole — the caller's project role in expressions and functions (CE ≥ 0.4.57)`.

- [ ] **Step 1:** skills row becomes: `| \`user.*\` | \`id\`, \`email\`, \`role\` (global: admin/user/member), \`groups\`, \`credential\`, \`scopes\` (app tokens), \`projectRole\` (owner/admin/contributor/viewer/guest on this project; CE ≥ 0.4.57) — \`null\` when unauthenticated |` and a version note below in the file's existing house style (see the `now_ms()` note at `:196-201`).
- [ ] **Step 2:** docs-public list becomes `user.id`, `user.email`, `user.role` (global), `user.projectRole` (the caller's role on this project, CE ≥ 0.4.57), `user.groups`.
- [ ] **Step 3:** open both PRs; they merge on green after CE's release (their version note must be true).

### Task A4: the CE PR, review, release

- [ ] **Step 1:** `pnpm --filter backend test` (full) green; `tsc --noEmit`; `format:check`. Push `feat/pipeline-user-project-role`; `gh pr create --repo bffless/ce` with the title in Global Constraints. Body: the spec paragraph, "Backwards compatible: additive optional field, no migration, no behaviour change for rules that do not read it", the test list, and the `Claude-Session` footer.
- [ ] **Step 2:** `.claude/ce-pr-review-checklist.md` self-review; request review per the CE repo's flow (`ce-pr-review` agent if configured, else the person).
- [ ] **Step 3 (person):** merge; release-please's `chore(main): release 0.4.57` PR merges; tag `v0.4.57`. Deploy to `workflow.j5s.dev` and `workflow.bffless.dev` is the person's; the session asks via remote and waits. **Stop-and-check before Part B's PR opens:** `gh release view v0.4.57 --repo bffless/ce` exists and the person has confirmed both instances.

---

# Part B — the harness: one gate, the sweep, the claim, the files, the UI

Worktree: `repos/apps/.claude/worktrees/run-ownership`, branch `feat/run-ownership` off `origin/main`. Every task ends with the apps verify chain green and one commit. The PR opens at B11.

### Task B1: the shared gate — `src/mcp/runGate.ts`, its bundle, its mock twin, and parity

**Files:**
- Create: `apps/workflow/src/mcp/runGate.ts`
- Modify: `apps/workflow/scripts/build-mcp.mjs:84` (`ENTRIES` gains `'runGate'`)
- Create: `apps/workflow/src/mocks/runGate.ts` (the pure mock twin, modelled on `src/mocks/forkGate.ts`)
- Create: `apps/workflow/src/mocks/runGate.fn.parity.test.ts` (modelled on `forkGate.fn.parity.test.ts`; loads the **generated** bundle through `runInCeSandbox` from `src/mcp/bundle.test.ts`, not `new Function` — the bundle is an IIFE)
- Create: `apps/workflow/src/mcp/runGate.test.ts` (unit tests of the pure function)
- Generated: `apps/workflow/.bffless/proxy-rules/workflow/mcp-fn/runGate.fn.js` (via `mcp:build`)

**Interfaces:**

```ts
// src/mcp/runGate.ts — spec 11 §The model (D26), §One gate. Pure; never throws.
import type { FnRequest } from './route'
import { fieldsOf, rows } from './rows'

export const ALL_SCOPE_ROLES: ReadonlyArray<string> = ['owner', 'admin']
export const TERMINAL_STATUSES: ReadonlyArray<string> = ['succeeded', 'failed', 'cancelled']
export const SCOPE_HEADER = 'x-workflow-scope'
export const DRIVE_KEY_HEADER = 'x-workflow-drive-key'

export interface FnUser { id?: string; email?: string; role?: string; projectRole?: string; groups?: string[] }
export type Door = 'owner' | 'drive' | 'all' | 'grant' | 'runless' | ''

export interface RunGate {
  /** The caller may act on the run named by `steps.run` (or the request names no run). */
  ok: boolean
  /** No such run, or not this caller's — the two are one answer (D26). */
  notFound: boolean
  door: Door
  /** The run row's record id, for data_update/data_delete; `null` unless ok. */
  recordId: string | null
  /** The run's columns (`fieldsOf`), `null` unless ok and a row exists. */
  run: Record<string, unknown> | null
  /** The refusal body one literal-status responder renders; `null` on ok. */
  result: { ok: false; error: string } | null
}

/** A header's first value, case-insensitively (CE lowercases; a proxy may not). */
export function header(request: FnRequest | undefined, name: string): string
/** `?scope=all`, `body.scope === 'all'`, or the `x-workflow-scope: all` header — the caller ASKED (D27). */
export function scopeAsked(request: FnRequest | undefined): boolean
export function isAllScopeRole(projectRole: unknown): boolean
/** Sharing/grants — not built; the door exists so the sweep need not reopen (spec 11 §The model). */
export function hasGrant(_run: Record<string, unknown>, _user: FnUser): boolean // returns false
/** The gate over already-loaded rows: what `handler` does, callable from other bundles (driveGate, reply, merge, plan). */
export function gateRun(input: { run: unknown; runless?: boolean; request?: FnRequest; user?: FnUser }): RunGate
/** The run a later bundle may read: `steps.run`'s row iff `steps.runGate.ok`, else `undefined`. */
export function admittedRun(steps: Record<string, unknown> | undefined): Record<string, unknown> | undefined
/** CE's function_handler entry. Reads `steps.run`, `runless` from `steps.route | steps.confine | steps.normalize`, `request`, `user`. */
export function handler(data: { steps?: Record<string, unknown>; request?: FnRequest; user?: FnUser }): RunGate
```

Door order inside `gateRun` (first match wins; **every** branch returns a flag object, nothing throws):
1. `runless === true` → `{ ok:true, door:'runless', notFound:false, recordId:null, run:null, result:null }`.
2. `const row = rows(run)[0]; if (!row) → refuse()` where `refuse = () => ({ ok:false, notFound:true, door:'', recordId:null, run:null, result:{ ok:false, error:'run not found' } })`.
3. `const f = fieldsOf(row); const caller = user ?? {}; const startedBy = typeof f.startedBy === 'string' ? f.startedBy : ''`.
4. **owner:** `caller.id && startedBy !== '' && startedBy === caller.id` → ok, door `owner`.
5. **drive:** `const key = header(request, DRIVE_KEY_HEADER); const rowKey = typeof f.driveKey === 'string' ? f.driveKey : ''; key !== '' && rowKey !== '' && key === rowKey && !TERMINAL_STATUSES.includes(String(f.status))` → ok, door `drive`.
6. **all:** `scopeAsked(request) && isAllScopeRole(caller.projectRole)` → ok, door `all`.
7. **grant:** `hasGrant(f, caller)` → ok, door `grant`.
8. otherwise `refuse()` — a 404, never a 403, on a single run (D26; the list's 403 is B3's).
`recordId` on ok = `String(row.id ?? f.id ?? '') || null`.

`scopeAsked`: `query.scope === 'all' || body.scope === 'all' || header(request, SCOPE_HEADER) === 'all'` reading `request.query` and `request.body` defensively (either may be undefined or non-object). `header()` walks `Object.keys(request.headers)` comparing lowercased names; a `string[]` value → its first element.

`handler(data)`: `const steps = data.steps ?? {}; const runless = [steps.route, steps.confine, steps.normalize].some((s) => isPlainObject(s) && s.runless === true); return gateRun({ run: steps.run, runless, request: data.request, user: data.user })`.

- [ ] **Step 1: unit tests first** (`src/mcp/runGate.test.ts`, `// @vitest-environment node`): a table of cases over `gateRun`: no row → notFound; owner match → ok/owner; owner mismatch → notFound; id-less caller vs ownerless row → notFound (the `!caller.id` guard from `run/delete/gate.fn.js:33-37`); ownerless row + `scope=all` + `projectRole: 'admin'` → ok/all; `scope=all` + `projectRole: 'contributor'` → notFound; `x-workflow-scope: all` header + owner role → ok/all; drive key match on a `waiting` row → ok/drive; drive key match on a `succeeded` row → notFound; key mismatch → notFound; `runless: true` with no row → ok/runless; header lookup is case-insensitive and takes the first of an array; `hasGrant` is `false`; `admittedRun({ run: [row], runGate: { ok:true } })` → the row's fields, `admittedRun({ run: [row], runGate: { ok:false } })` → undefined, `admittedRun({ run: [row] })` → undefined; `handler` reads `runless` from each of the three locators; nothing throws on `handler({})`, `handler({ steps: { run: 'garbage' } })`, `handler({ request: { headers: null } as never })`.
- [ ] **Step 2: run** `pnpm --filter workflow test:run -- src/mcp/runGate.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** `src/mcp/runGate.ts` as specified; add `'runGate'` to `ENTRIES`; `pnpm --filter workflow mcp:build` (writes `mcp-fn/runGate.fn.js`; the endpoint + step-view rules re-render with the new source rev — commit them too).
- [ ] **Step 4: the mock twin.** `src/mocks/runGate.ts`: `export { gateRun, scopeAsked, isAllScopeRole, header, SCOPE_HEADER, DRIVE_KEY_HEADER, TERMINAL_STATUSES } from '../mcp/runGate'` is **not** allowed (the mock must be independently written so parity means something — same rule `forkGate.ts` follows); write `export function mockGate(row: RunRow | undefined, request: Request, user: MockUser, opts: { runless?: boolean; bodyScope?: string } = {}): { ok: boolean; door: string }` reading the same three signals from an MSW `Request` (`request.headers.get(...)`, `new URL(request.url).searchParams.get('scope')`, and `opts.bodyScope`, which a handler passes once it has parsed the body).
- [ ] **Step 5: parity test.** `src/mocks/runGate.fn.parity.test.ts`: one `CASES` table (the Step-1 table minus the pure-helper cases) run twice — against the committed `mcp-fn/runGate.fn.js` through `runInCeSandbox(readFileSync(outFile('runGate')), { steps: { run: row ? [row] : [] , route: { runless } }, request, user })` and against `mockGate(...)` — asserting `ok` and `door` agree.
- [ ] **Step 6: verify** `pnpm --filter workflow lint && pnpm --filter workflow test:run` (bundle.test's freshness + prohibited-pattern + smoke checks now cover `runGate`; the smoke `SMOKE_DATA` has no `steps.run` → the gate answers `notFound`, an object — fine).
- [ ] **Step 7: commit** `feat(workflow): the shared run gate — one bundle, four doors, never throws (D26)`.

### Task B2: schemas — `workflow_run_claims`, `driveKey`, `startedByEmail`

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/workflow/schemas/workflow_run_claims.schema.yaml`
- Modify: `apps/workflow/.bffless/proxy-rules/workflow/schemas/workflow_runs.schema.yaml` (two optional fields)
- Modify: `apps/workflow/src/rules.fence.test.ts:48-50` (`SCHEMAS.workflow` gains `workflow_run_claims`)
- Modify: `apps/workflow/src/lib/coerce.ts:336` (`startedByEmail` beside `startedBy`; **never** coerce `driveKey` onto the client row — the SPA must not carry it)
- Modify: `apps/workflow/src/mocks/db.ts` (`claims: Map<string, ClaimRow>` on the db, reset in `resetDb()`; `MOCK_OTHER`), `src/mocks/fixtures/{finishedRun,waitingRun,scriptRun,renderedRun}.ts` (`startedBy: MOCK_MEMBER.id`, `startedByEmail: MOCK_MEMBER.email` — Decision 12), `src/mocks/handlers.ts:230-242` (`runs/post` also stores `startedByEmail: mockUser().email` and strips any body `driveKey`), `src/mocks/browser.ts:184-192` (`?as=other`)

```yaml
# schemas/workflow_run_claims.schema.yaml — spec 11 §Attribution (D28). One row per dispatch
# from the endpoint: who asked, and the nonce the driver must present to `runs/post`.
# Consumed (deleted) by `runs/post`; a claim nobody consumes is inert (deferred: `queued`).
name: workflow_run_claims
fields:
  - { name: runId, type: string, required: true }
  - { name: impl, type: string, required: true }
  - { name: workflow, type: string, required: true }
  - { name: startedBy, type: string, required: true }
  - { name: startedByEmail, type: string, required: false }
  - { name: driveKey, type: string, required: true }
  - { name: createdAt, type: number, required: true }
```
`workflow_runs` additions (with the `--adopt-fields` comment in the house style of `workflow_run_steps.schema.yaml:22`):
```yaml
  # Spec 11 (D28/D26): the dispatched driver's nonce (cleared at terminal status) and a
  # denormalised owner email for lists. Both optional → adopted live via `--adopt-fields`.
  - { name: driveKey, type: string, required: false }
  - { name: startedByEmail, type: string, required: false }
```

- [ ] **Step 1:** fence test first: add `'workflow_run_claims'` to `SCHEMAS.workflow`; `pnpm --filter workflow test:run -- src/rules.fence.test.ts` → FAIL (`ships its schemas`).
- [ ] **Step 2:** write the two schema files; fence green.
- [ ] **Step 3:** `coerce.ts`: `...(optionalStr(f.startedByEmail) ? { startedByEmail: str(f.startedByEmail) } : {})` and the `ServerRunRow`/row type gains `startedByEmail?: string`; a `coerce.test.ts` case that a row with `driveKey` in its fields comes out **without** it.
- [ ] **Step 4:** mocks: `MOCK_OTHER: MockUser = { id: 'user_other', email: 'else@example.test', role: 'user' }`; `MockUser` gains `projectRole?: string` (`MOCK_ADMIN` gets `projectRole: 'owner'`; `MOCK_MEMBER`/`MOCK_OTHER` get `projectRole: 'contributor'`); `db.claims`; fixtures re-owned; `?as=other` in `browser.ts`. Run the whole SPA suite: `RunsPage.test.tsx:38` (expects `user_fixture`) flips to expect `MOCK_MEMBER.email` once B9 renders it — for now change it to `MOCK_MEMBER.id` so the suite stays green; any other test asserting `user_fixture` (`grep -rn user_fixture src`) is updated the same way.
- [ ] **Step 5:** verify chain; **commit** `feat(workflow): workflow_run_claims schema; driveKey + startedByEmail on workflow_runs; a second mock member`.

### Task B3: `runs/get` — two queries, `scope`, 403

**Files:**
- Create: `…/rules/api/workflow/runs/get/scope.fn.js`
- Modify: `…/rules/api/workflow/runs/get/rule.yaml`, `…/runs/get/shape.fn.js:29`
- Modify: `apps/workflow/src/mocks/handlers.ts:248-256` (the mock list), `src/mocks/runs.shape.fn.parity.test.ts` (reads `steps.query` today → `steps.mine`)
- Create: `apps/workflow/src/mocks/scope.fn.parity.test.ts`

**Behaviour (spec 11 §Listing):** `scope.fn.js` → `{ isMine, isAll, forbidden, ok, result }`: `asked = query.scope === 'all' || header x-workflow-scope === 'all'`; `role = String((user||{}).projectRole||'').toLowerCase()`; `asked && !(role==='owner'||role==='admin')` → `{ forbidden:true, ok:false, isMine:false, isAll:false, result:{ ok:false, error:'scope=all needs the project owner or admin role', code:'SCOPE_FORBIDDEN' } }`; `asked` → `isAll`; else `isMine`. Rule steps: `scope` → `refuse-403` (`condition: steps.scope.forbidden`, status 403, body `{{{steps.scope.result}}}`) → `mine` (`condition: steps.scope.isMine`; filters `impl`, `workflow`, `startedBy: { op: eq, value: user.id }`) → `all` (`condition: steps.scope.isAll`; filters `impl`, `workflow`) → `waiting` (unchanged, but `condition: steps.scope.ok`) → `shape` (`config: { condition: steps.scope.ok }`) → `respond` (`condition: steps.scope.ok`). `shape.fn.js:29` reads `rows(steps.mine !== undefined ? steps.mine : steps.all)`. Reword the two descriptions: drop "members see all runs, D14" for "the caller's own runs by default; `?scope=all` for a project owner/admin (D26/D27), 403 otherwise".

- [ ] **Step 1: mock + parity tests first.** `scope.fn.parity.test.ts` table: no scope → isMine; `?scope=all` as contributor → forbidden; `?scope=all` as `projectRole: 'admin'` → isAll; header `x-workflow-scope: all` as owner → isAll; user undefined + `?scope=all` → forbidden; run each against `scope.fn.js` (`new Function` loader, as `deleteGate.fn.parity.test.ts:65-69`) and against `fetch('/api/workflow/runs?impl=…&workflow=…&scope=all')` on the mock (status 403 / 200, and that a 200 list under `mine` contains only `mockUser().id`'s runs). Update `runs.shape.fn.parity.test.ts` for the `mine` key. Run → FAIL.
- [ ] **Step 2:** write `scope.fn.js`, the rule, `shape.fn.js`, the mock (`db.runs` filtered by `startedBy === mockUser().id` unless `scope=all` and `mockUser().projectRole ∈ {owner, admin}`; 403 body as above).
- [ ] **Step 3:** verify chain; **commit** `feat(workflow): runs/get lists the caller's own runs; scope=all is asked for, 403 without the role (D26, D27)`.

### Task B4: `run/get`, `run/update`, `run-step/post` on the gate

**Files:**
- Modify: `…/run/get/rule.yaml` (+ `runGate` after `run`; `steps` query `condition: steps.runGate.ok`), `…/run/get/shape.fn.js` (`run: steps.runGate && steps.runGate.ok ? runRows[0] || null : null`, `steps: … ok ? stepRows : []`) — **no 404 responder** (Decision 4)
- Modify: `…/run/update/post/rule.yaml` (`find`→`run`; `runGate` after it; `merge` `config: { condition: steps.runGate.ok }`; `update` condition stays `steps.merge.found`; a `refuse-404` on `steps.runGate.notFound` replaces the `notFound` responder; `respond` gains `condition: steps.runGate.ok` — it is ungated today, which is a latent bug); `…/run/update/post/merge.fn.js` (`steps.find`→`steps.run`; `KEYS` gains `'driveKey'`; after the loop: `if (TERMINAL[fields.status]) fields.driveKey = ''; else if (typeof fields.driveKey !== 'string') fields.driveKey = ''` with `const TERMINAL = { succeeded:true, failed:true, cancelled:true }`) — note `driveKey` is **not** patchable from the body: read it from `row` only (`fields.driveKey = row && typeof row.driveKey === 'string' ? row.driveKey : ''` before the terminal check; ignore `patch.driveKey`)
- Modify: `…/run-step/post/rule.yaml` (new first step `run`: `data_query` on `workflow_runs`, `runId: { op: eq, value: request.body.runId }`, limit 1; then `runGate`; then `refuse-404` on `steps.runGate.notFound`; the existing `find` (step rows) gets `condition: steps.runGate.ok`; `merge` `config: { condition: steps.runGate.ok }`; `respond` gains `condition: steps.runGate.ok`)
- Modify: `src/mocks/handlers.ts` (`run/get` returns `{ run: null, steps: [] }` when `!mockGate(...).ok`; `run/update` and `run-step` answer 404 `{ ok:false, error:'run not found' }` when not ok)
- Modify: `src/pages/run/RunShell.summary.test.tsx` (new case: a run owned by `MOCK_OTHER` renders `No such run`), `src/mocks/runGate.fn.parity.test.ts` (add the three mock routes to the fetch side, as `deleteGate…:169-194` does for delete)

Add a shared comment block (copy the `run/delete/post/rule.yaml:19-24` responder explanation, shortened) above each new `refuse-404`.

- [ ] **Step 1:** tests first (mock handler cases via the parity fetch side; the `RunShell` case; a `run/update` on another member's run → 404; `run-step` likewise). Run → FAIL.
- [ ] **Step 2:** rules + fns + mocks as above. Read `merge.fn.js` back: the full merged column set is still written (`run/update`'s determinism note at `rule.yaml:5`).
- [ ] **Step 3:** verify chain; **commit** `feat(workflow): run/get, run/update, run-step behind the gate; driveKey cleared at terminal status`.

### Task B5: `run/lease`, `run/delete`, `run/fork` on the gate

**Files:**
- Modify: `…/run/lease/post/rule.yaml` (`find`→`run`; `runGate`; `refuse-404`; `gate` `config: { condition: steps.runGate.ok }`; `grant` unchanged (`steps.gate.ok`); `respond` `condition: steps.runGate.ok`); `…/run/lease/post/gate.fn.js` (`steps.find`→`steps.run`; the `!row` branch stays as a defensive no-op)
- Modify: `…/run/delete/post/rule.yaml` (`runGate` after `run`; `gate` `config: { condition: steps.runGate.ok }`; `refuse-404` now on `steps.runGate.notFound`; **delete `refuse-403`**; keep `refuse-409`); `…/run/delete/post/gate.fn.js` (remove the ownership block `:29-39` and the `forbidden` flag; the description at `rule.yaml:5` reads "owner, or a project owner/admin who asked (`x-workflow-scope: all`), via the shared gate (D26)")
- Modify: `…/run/fork/post/rule.yaml` (`parent`→`run`; `runGate` after it; `rows`/`existing` gain `condition: steps.runGate.ok`; `gate` `config: { condition: steps.runGate.ok }`; `refuse-404` moves onto `steps.runGate.notFound` **and** keeps the job-not-found case — so two 404 responders: `refuse-404-run` on `steps.runGate.notFound` and the existing one on `steps.gate.notFound`; delete `refuse-403`); `…/run/fork/post/gate.fn.js` (`steps.parent`→`steps.run`; remove the ownership block `:61-69` and `forbidden`; `run.startedByEmail: caller.email || null` beside `startedBy`); `rule.yaml`'s `create` fields gain `startedByEmail: steps.gate.run.startedByEmail`
- Modify: `src/mocks/handlers.ts` (`run/delete:307-330` loses its 403 branch; the 404 comes from `mockGate`; `run/fork` likewise; `run/lease` 404 when not ok), `src/mocks/forkGate.ts` (drop its ownership check), `src/mocks/deleteGate.fn.parity.test.ts` + `forkGate.fn.parity.test.ts` (the `403 not-owner` rows become `404` via the gate; the `id-less caller` row too; `owner`/`admin` rows: admin now needs `projectRole: 'owner'|'admin'` **and** the scope header — add `headers: { 'x-workflow-scope': 'all' }` to those cases)
- Modify: `src/store/useRunDelete.ts:66-75` (advisory check becomes `startedBy === me.id || (isAllScopeRole(me.projectRole) && readScope() === 'all')` — `readScope` lands in B9; until then use `me.projectRole` only and leave a `// B9: and the toggle` marker that B9 removes)

- [ ] **Step 1:** update the two parity tables + mock expectations first; run → FAIL.
- [ ] **Step 2:** rules/fns/mocks as above.
- [ ] **Step 3:** verify chain; **commit** `feat(workflow): lease, delete, fork move onto the shared gate; delete's private ownership branch retired`.

### Task B6: files follow the run — `sign`, `prepare`, `register`, the serve rule (D29)

**Files:**
- Modify: `…/files/sign/post/confine.fn.js` (parse `workflows/<impl>/<workflow>/runs/<runId>/…` → `{ ok, notOk, storagePath, hasRun, runId, runless }`; `runless = ok && !hasRun` i.e. an `inputs/` path or any confined path without a `runs/<id>/` segment — `RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/` on the segment); `…/files/sign/post/rule.yaml` (`confine` → `refuse` (400) → `run` (`condition: steps.confine.hasRun`, filter `runId eq steps.confine.runId`) → `runGate` (`config: { condition: steps.confine.ok }`) → `refuse-404` (`steps.runGate.notFound`) → `sign` (`condition: steps.runGate.ok`) → `respond` (`condition: steps.runGate.ok`))
- Create: `…/files/prepare/post/confine.fn.js` (from `request.body.scope`: `runs/<runId>/…` → `hasRun/runId`; `inputs` or `inputs/…` → `runless`; anything else → `notOk`); `…/files/prepare/post/rule.yaml` (`confine` → `refuse` 400 on `steps.confine.notOk` with `{"error":"scope must be inputs or runs/<runId>/<step>"}` → `run` → `runGate` → `refuse-404` → `prepare` (`condition: steps.runGate.ok`) → `respond` (`condition: steps.runGate.ok`))
- Modify: `…/files/register/post/normalize.fn.js` (also emit `hasRun/runId/runless` from the normalised uploads-relative path); `…/files/register/post/rule.yaml` (`normalize` → `refuse` 400 → `run` (`steps.normalize.hasRun`) → `runGate` (`condition: steps.normalize.ok`) → `refuse-404` → `register`/`shape`/`respond` conditions become `steps.runGate.ok`)
- Modify: `…/rules/api/uploads/workflows/[...path]/get.rule.yaml` — from one step to: `confine` (`function_handler`, new `./confine.fn.js`: parse `request.path` after `/api/uploads/`; same output shape as sign's) → `run` (`steps.confine.hasRun`) → `runGate` → `refuse-404` (`steps.runGate.notFound`, body `{"error":"not found"}`, `contentType: application/json`) → `serve` (`file_serve_handler`, `config.condition: steps.runGate.ok` — conditions are generic on every handler, `pipeline-execution.service.ts:422`)
- Modify: `src/mocks/handlers.ts` (`files/sign:464-479`, `files/prepare:396-399`, `files/register:422-457`, `uploads/*:483-487` — each parses the run id the same way and answers 404 when `!mockGate(row, request, mockUser(), { runless }).ok`), `src/mocks/confine.fn.parity.test.ts` + `normalize.fn.parity.test.ts` (new columns), new `src/mocks/uploadsConfine.fn.parity.test.ts` and `prepareConfine.fn.parity.test.ts` (same loader)

- [ ] **Step 1:** parity tables first (paths: a run path owned by the member → ok; another member's run → 404; `inputs/` → ok for anyone; traversal → 400 (sign/prepare/register) or 404 (serve); a `runs/<id>/` path whose run does not exist → 404). Run → FAIL.
- [ ] **Step 2:** the four rules + three fns + mocks.
- [ ] **Step 3:** `src/pages/run/*.test.tsx` and the island/media tests still pass (they fetch fixtures owned by `MOCK_MEMBER` now); verify chain; **commit** `feat(workflow): run files follow the run — sign, prepare, register and the serve rule gate by the runId in the path (D29)`.

### Task B7: attribution — the claim at `run/drive`, consumed by `runs/post` (D28)

**Files:**
- Modify: `apps/workflow/src/mcp/drivePlan.ts` (`steps.find`→`steps.run`; `DrivePlan` gains `isResume: boolean` = `mode === 'resume'`), `apps/workflow/src/mcp/driveGate.ts` (see below), `apps/workflow/src/mcp/drive.test.ts`
- Modify: `…/run/drive/post/rule.yaml`
- Create: `…/runs/post/admit.fn.js` (replaces `exists.fn.js` — delete it); modify `…/runs/post/rule.yaml`
- Modify: `src/mocks/handlers.ts` (`runs/post` claim-aware; a **new** `run/drive` handler: validates like the real gate's body checks, writes `db.claims` on `mode: run` with a `driveKey` of `crypto.randomUUID()`, writes `driveKey` onto the run on `mode: resume`, answers 202 `{ dispatched:true, runId, repo:'mock/impl', eventType:'workflow-drive' }` — the response never carries the key); `src/mocks/db.ts` (`ClaimRow`)
- Create: `src/mocks/admit.fn.parity.test.ts`

**`driveGate.ts` changes** (`handler(data: { request?, steps?: DriveGateSteps, user?: FnUser, utils?: { randomToken?: (bytes?: number) => string } })`):
- `DriveGateSteps`: `run?: unknown` (was `find`), `claim?: unknown`, `runGate?: unknown`, `plan?`, `index?`.
- `DriveGate` gains: `writeClaim: boolean`, `rekey: boolean`, `recordId: string`, `driveKey: string`, `claim: { runId, impl, workflow, startedBy, startedByEmail, driveKey, createdAt } | null`.
- After the body checks: `const mint = typeof data.utils?.randomToken === 'function' ? data.utils.randomToken : null; if (mint === null) return refuse('NO_RANDOM', 'this CE exposes no utils.randomToken — the driver nonce cannot be minted')` (a fixed refusal, never a throw).
- `mode === 'resume'`: `if (!(isPlainObject(steps.runGate) && steps.runGate.ok === true)) return refuse('RUN_NOT_FOUND', 'no run with this id — start one instead')` (replaces the `matched.length === 0` check; the gate answers not-found for someone else's run too — D26). Then the existing terminal/lease checks over `admittedRun(steps)`. `driveKey = mint(24)`; `rekey = true`; `recordId = String(row.id)`.
- `mode === 'run'`: `matched.length > 0` → `RUN_EXISTS` as today. Then the claim: `const claim = fieldsOf(rows(steps.claim)[0] ?? {})`; if a claim exists and `claim.startedBy === user.id` → reuse `claim.driveKey`, `writeClaim = false`; if it exists for someone else → `refuse('RUN_EXISTS', 'this run id is already claimed by another member')`; else `driveKey = mint(24)`, `writeClaim = true`, `claim = { runId, impl, workflow, startedBy: user.id, startedByEmail: user.email ?? '', driveKey, createdAt: Date.now() }`. An id-less caller (`!user?.id`) → `refuse('BAD_REQUEST', 'the endpoint could not tie this caller to a member')`.
- `payload` gains `drive_key: driveKey` in **both** modes.

**`run/drive/post/rule.yaml`** steps: `run` (renamed `find`) → `claim` (`data_query` `$schema:workflow_run_claims`, `runId eq request.body.id`, limit 1) → `plan` → `index` → `runGate` (`config: { condition: steps.plan.isResume }`) → `gate` → `claimWrite` (`data_create` `$schema:workflow_run_claims`, `condition: steps.gate.writeClaim`, fields `runId/impl/workflow/startedBy/startedByEmail/driveKey/createdAt: steps.gate.claim.<f>`) → `rekey` (`data_update` `$schema:workflow_runs`, `condition: steps.gate.rekey`, `recordId: steps.gate.recordId`, fields `driveKey: steps.gate.driveKey`) → `dispatch` (`clientPayload` gains `drive_key: steps.gate.payload.drive_key`) → `refuse` → `respond`. Comment on `claimWrite`: the claim is written before the dispatch so a dispatched driver can never find no claim (that path would make the driver the owner); a retry after a failed dispatch reuses it.

**`runs/post`**: `find` → `claim` (`data_query` claims, `runId eq request.body.runId`) → `admit` (`./admit.fn.js`: `{ exists, fresh, claimed, claimRecordId, startedBy, startedByEmail, driveKey }` — run exists → `exists`; claim present and `header x-workflow-drive-key === claim.driveKey` → `fresh, claimed, from the claim`; claim present otherwise → `exists` (409, spec: key missing or wrong); no claim → `fresh, startedBy: user.id || null, startedByEmail: user.email || '', driveKey: ''`) → `create` (`startedBy: steps.admit.startedBy`, `startedByEmail: steps.admit.startedByEmail`, `driveKey: steps.admit.driveKey`; `condition: steps.admit.fresh`) → `consume` (`data_delete` claims, `recordId: steps.admit.claimRecordId`, `condition: steps.admit.claimed`) → `duplicate` (`steps.admit.exists`) → `respond` (`steps.admit.fresh`). The `startedBy: user.id` line is gone: the function decides, and a body `startedBy`/`driveKey` is never read.

- [ ] **Step 1:** `drive.test.ts` first: `run` mode writes a claim with the requester's id and a 48-hex key and puts `drive_key` in the payload; a second `run` by the same requester reuses the claim (`writeClaim: false`, same key); by another member → `RUN_EXISTS`; `resume` needs `steps.runGate.ok` (a not-ok gate → `RUN_NOT_FOUND`), mints a key and sets `rekey`; no `utils` → `NO_RANDOM`; the existing `dispatches with the client_payload the Actions file reads` case gains `drive_key: expect.stringMatching(/^[0-9a-f]{48}$/)`. `admit.fn.parity.test.ts`: the four outcomes above against `admit.fn.js` and against the mock `runs/post` (with/without the header). Run → FAIL.
- [ ] **Step 2:** implement; `mcp:build`; the mock `run/drive` handler.
- [ ] **Step 3:** verify chain; **commit** `feat(workflow): run/drive claims the run for the requester; runs/post consumes the claim on the driver's nonce (D28)`.

### Task B8: the MCP tools — the gate in the generator, `scope` on `workflow.runs`, the classification fence

**Files:**
- Modify: `packages/workflow-agent-tools/src/schemas.ts:105-121` (`RunsArgs.scope?: 'mine' | 'all'`; `RUNS_SCHEMA.properties.scope = { type: 'string', enum: ['mine', 'all'], description: 'mine (default): runs you started. all: every run of the workflow — project owner/admin only, and only when asked (D27); refused with errors.scope otherwise.' }`), `src/catalog.ts:71` (the `workflow.runs` description gains one sentence: "Lists your own runs unless scope is all."); `test/catalog.test.ts` (`workflow.runs` schema has `scope` with that enum; `required` still `[]`)
- Modify: `apps/workflow/src/mcp/route.ts` — `handler(data: { request; deployment?; user?: FnUser })`; `Route` gains `isMine: boolean`, `isAll: boolean`, `scopeForbidden: boolean`, `runless: boolean`; `RUN_SCOPED` gains `'workflow.await'`, `'workflow.cancel'`, `'workflow.sign'`; for `workflow.runs`: `asked = args.scope === 'all'`; `scopeForbidden = isRuns && asked && !isAllScopeRole(user?.projectRole)`; `isAll = isRuns && asked && !scopeForbidden`; `isMine = isRuns && !asked`; for `workflow.sign`: parse `runs/<runId>/` out of `signPath` → `route.runId` (when `args.runId` is empty) and `needsRun = true`, else `runless = true` (an `inputs/` path)
- Modify: `apps/workflow/scripts/build-mcp.mjs` — `stepDefs` gains `runGate: fn('runGate')` and `runsAll: query('runsAll', 'steps.route.isAll', 'workflow_runs', 50, { impl…, workflow… })`; `runs` becomes `query('runs', 'steps.route.isMine', …, { impl…, workflow…, startedBy: { op: 'eq', value: 'user.id' } })`; `steps` query condition becomes `'steps.runGate.ok'`; `signed` condition becomes `'steps.runGate.ok'`; `waiting` condition stays `steps.route.isRuns`
- Modify: `apps/workflow/src/mcp/mcpConfig.ts` — `StepKey` gains `'runGate' | 'runsAll'`; `RUN_ROWS = ['run', 'runGate', 'steps']`; `'workflow.runs': ['route', 'runs', 'runsAll', 'waiting', 'reply']`; `'workflow.await': ['route', 'run', 'runGate', 'reply']`; `'workflow.cancel': ['route', 'run', 'runGate', 'reply']`; `'workflow.sign': ['route', 'run', 'runGate', 'signed', 'reply']`; `mcpConfig.test.ts:55-60` pins updated (`resume` = `['route','run','runGate','steps','plan','drive','reply']`, `submitStep` likewise with the gate after `run`)
- Modify: `apps/workflow/src/mcp/reply.ts:216-222` (`resolveRun`: `const run = admittedRun(steps)`), `:257-287` (`runs()`: `if (route.scopeForbidden) return errorResult('scope=all needs the project owner or admin role on this project', { errors: { scope: 'forbidden' } })`; rows from `steps.runs !== undefined ? steps.runs : steps.runsAll`), `sign()` at `:289` (when `route.needsRun` and `!steps.runGate?.ok` → the `No such run` result), the `await`/`cancel` branches (same refusal when `route.runId !== '' && !steps.runGate?.ok`), `apps/workflow/src/mcp/merge.ts:86` and `plan.ts:164,235` (`rows(data.steps.run)[0]` → `admittedRun(data.steps)`), `src/mcp/rows.ts` if `admittedRun` belongs there instead (keep it in `runGate.ts`; import from there)
- Modify: `apps/workflow/src/agent/executors.ts` (the in-page `workflow.runs` executor passes `scope` through to `listRuns`), `src/store/workflowApi.ts:223-230` (`listRuns` arg gains `scope?: 'all'`; `params: { impl, workflow, ...(scope ? { scope } : {}) }`)
- Modify: `apps/workflow/src/rules.fence.test.ts:152` (regex admits `runGate`) and a **new** classification fence (below)
- Generated: every `mcp-tools/*` rule, the endpoint rule, `mcp-fn/*.fn.js` (`mcp:build`)

**The classification fence** (`rules.fence.test.ts`, new `it('classifies every rule against the ownership boundary (spec 11)')`):
```ts
const GATED = ['/run/get/', '/run/update/post/', '/run-step/post/', '/run/lease/post/', '/run/delete/post/', '/run/fork/post/', '/run/drive/post/',
  '/files/sign/post/', '/files/prepare/post/', '/files/register/post/', '/uploads/workflows/[...path]/',
  '/mcp-tools/status/', '/mcp-tools/await/', '/mcp-tools/outputs/', '/mcp-tools/sign/', '/mcp-tools/cancel/', '/mcp-tools/resume/', '/mcp-tools/submitStep/',
  '/mcp-tools/submit/', '/mcp-tools/annotate/', '/mcp-tools/pipeline/', '/mcp-tools/stepView/']
const FILTERED = ['/runs/get/', '/mcp-tools/runs/']
const NEITHER = ['/runs/post/', '/project/get/', '/aliases/get/', '/whoami/get/', '/mcp-tools/list/', '/mcp-tools/describe/', '/mcp-tools/start/',
  '/_custom/well-known/', '/api/auth/', '/api/workflow/mcp/', '/mcp-resources/']
// every rule file matches exactly one list (a new rule must be placed);
// every GATED rule has a data_query step `run` on $schema:workflow_runs followed (later in `steps`) by a function_handler step `runGate` whose `code` ends with `mcp-fn/runGate.fn.js`;
// every FILTERED rule has a data_query whose filters include `startedBy` with value `user.id`, and a second one without it, and no `runGate`;
// no NEITHER rule references runGate.fn.js.
```

- [ ] **Step 1:** catalog test + `mcpConfig.test.ts` pins + the classification fence + `reply.test.ts` cases (scope forbidden → `errors.scope`; `runs` reads `runsAll` when `steps.runs` is absent; `status` for a not-admitted run → `No such run`; `sign` for an `inputs/` path stays signable with no run; `sign` for a run path that the gate refused → `No such run`) + `route.test.ts` cases (scope flags; `sign` runId from path; `runless`). Run → FAIL.
- [ ] **Step 2:** implement in the order listed; `pnpm --filter @bffless/workflow-agent-tools build`; `pnpm --filter workflow mcp:build`; inspect one generated rule (`mcp-tools/status/post/rule.yaml`) — `run` → `runGate` → `steps` (condition `steps.runGate.ok`) → `reply` → `respond`.
- [ ] **Step 3:** verify chain for both packages; `pnpm --filter workflow test:e2e` is CI's, but run `pnpm --filter workflow test:run -- src/mcp` locally; **commit** `feat(workflow): the eleven run-scoped MCP tools go through the gate; workflow.runs takes scope (D26, D27)`.

### Task B9: what the person sees — `whoami.projectRole`, the "All runs" toggle, `startedByEmail`, someone else's run

**Files:**
- Modify: `…/rules/api/workflow/whoami/get/me.fn.js:17-21` (`projectRole: str(caller.projectRole)` — a fourth always-present string, per the contract note at `:13-16`), `…/whoami/get/rule.yaml:5` (mention it); `src/mocks/handlers.ts:562` (returns `mockUser().projectRole ?? ''`); `src/mocks/whoami.fn.parity.test.ts` (both identities carry it)
- Modify: `src/lib/coerce.ts:302-317` (`Whoami.projectRole?: 'owner' | 'admin' | 'contributor' | 'viewer' | 'guest'`, coerced like `role`, dropped when empty)
- Create: `src/lib/scope.ts`:
  ```ts
  /** The "All runs" toggle (spec 11 §What the person sees): view state that must reach every request, so it lives here, not only in Redux. */
  export type RunsScope = 'mine' | 'all'
  export const SCOPE_HEADER = 'x-workflow-scope'
  const KEY = 'workflow.runsScope'
  export function readScope(): RunsScope           // localStorage, try/catch, default 'mine'
  export function writeScope(scope: RunsScope): void
  /** `{ 'x-workflow-scope': 'all' }` while widened, else `{}` — spread into every /api/workflow and /api/uploads request. */
  export function scopeHeaders(): Record<string, string>
  export function isAllScopeRole(projectRole: string | undefined): boolean
  ```
- Modify: `src/lib/http.ts:51-52` (`const headers = { ...scopeHeaders(), ...init.headers }`), `src/store/workflowApi.ts:66` (`fetchBaseQuery({ baseUrl: '/', prepareHeaders: (h) => { for (const [k, v] of Object.entries(scopeHeaders())) h.set(k, v); return h } })`)
- Modify: `src/store/uiSlice.ts` (`runsScope: RunsScope`, initial `readScope()`, reducer `runsScopeChanged` that also calls `writeScope` — a side effect in a reducer is tolerated here because the value must be readable synchronously by `http.ts` on the next request; document it), `src/pages/RunsPage.tsx:104-142` (`useListRunsQuery({ impl, workflow, ...(scope === 'all' ? { scope: 'all' } : {}) })`; beside the status `<select>`: `{isAllScopeRole(me?.projectRole) && <label className="filter"><input type="checkbox" checked={scope==='all'} onChange={…} /> All runs</label>}`; the change handler dispatches `runsScopeChanged(next)` **and** `workflowApi.util.invalidateTags(['Runs', 'Run'])` (confirm the run-record tag name in `workflowApi.ts`; if `run/get` is untagged, use `resetApiState()` instead); `:191` renders `run.startedByEmail ?? run.startedBy ?? '—'`), `src/components/run/RunHeader.tsx:174-179` (same fallback), `src/store/useRunDelete.ts` (finish B5's marker: `startedBy === me.id || (isAllScopeRole(me.projectRole) && readScope() === 'all')`)
- Tests: `src/pages/RunsPage.test.tsx` (the `startedBy` cell shows the email; `MOCK_OTHER`'s run is not listed by default; as `MOCK_ADMIN` the toggle renders, is off by default, and turning it on lists both runs and puts `scope=all` on the request — assert via an MSW `server.use` spy on the URL; as `MOCK_MEMBER` no toggle; a member who hand-sets `writeScope('all')` (no toggle, but the header still rides) gets the mock's 403 and the page shows its load error — assert that, then `writeScope('mine')` in `afterEach`), `src/components/Shell.test.tsx` or a new `scope.test.ts` (`scopeHeaders()` follows `writeScope`; `localStorage` throwing → `'mine'`), `src/lib/http.test.ts` (the header rides on a `httpJson` call while widened, not otherwise), `src/pages/run/RunShell.summary.test.tsx` (B4's "someone else's run → No such run" case now also asserts that as `MOCK_ADMIN` with `writeScope('all')` the same run **renders**)
- Modify: `src/mocks/browser.ts` (dev override `?scope=all` → `writeScope('all')` is unnecessary — the toggle does it; nothing to add)

- [ ] **Step 1:** tests first (all of the above); run → FAIL.
- [ ] **Step 2:** implement; check `LastRunPill`/`WorkflowPage` still call `useListRunsQuery({ impl, workflow })` (mine — correct: a "last run" pill is yours).
- [ ] **Step 3:** run the dev server against MSW and screenshot the toggle as `?as=admin` (`node /home/rico/bffless/localdev-tools/shot.mjs http://localhost:5173/hello/driven/runs?as=admin --out /tmp/…/runs-admin.png`, `consoleErrors:0`); verify chain; **commit** `feat(workflow): whoami reports projectRole; the runs list defaults to yours with an asked-for "All runs" toggle; startedBy renders a person`.

### Task B10: a second identity, live — the `ownership` walk

**Files:**
- Create: `packages/workflow-live/src/walks/ownership.ts`; modify `src/walks/index.ts` (register `ownership`; **not** in `ALL_ORDER` — it needs a second member the `all` run may not have), `src/env.ts` (`secondCredentials()` from `WORKFLOW_EMAIL_2` / `WORKFLOW_PASSWORD_2`, or `WORKFLOW_APP_TOKEN_2`), `README.md` (walk table row + Env section: the second member is a person-created prerequisite; the walk BLOCKs without it), `test/walks.test.ts`, `test/env.test.ts`

**Checks** (names are stable once shipped — README "Adding a walk"): as member A (the walk's usual login) start a `hello/driven` run on the page and let it finish (reuse the `hello` walk's page mechanics); then as member B (a fresh context, `sessionLogin(secondToken, secondCreds)`):
- `D26.listDefaultsToMine` — `GET /api/workflow/runs?impl=hello&workflow=driven` as B does not contain A's run id;
- `D26.runGetIsNotFound` — `GET /api/workflow/run?id=<A's>` as B answers 200 `{ run: null }`;
- `D26.runUpdateIsNotFound` — `POST /api/workflow/run/update { id, patch: {} }` as B → 404;
- `D29.signIsNotFound` — `POST /api/workflow/files/sign { path: 'workflows/hello/driven/runs/<A's>/x' }` as B → 404, and `D29.inputsStaySigned` — a `workflows/hello/driven/inputs/…` path as B → 200 (or 400 only if the path does not exist — pick a real inputs key from A's run's inputs if any, else skip with `note`);
- `D27.scopeAllIsForbiddenForAMember` — `?scope=all` as B → 403 **if** `whoami` as B reports `projectRole` ∉ {owner, admin}; else `note` that B is an owner and assert `D27.scopeAllListsAll` (A's run present) instead;
- `D27.scopeAllAsked` — as A: if `whoami.projectRole` ∈ {owner, admin}, `?scope=all` lists B's runs too (start one as B first) and the plain list does not; else `note`;
- `D26.mcpStatusIsNotFound` — over the MCP endpoint as B (mint a token as the `mcp` walk does), `workflow.status { runId: <A's> }` → `errors.runId: 'No such run'`.
- `report.block('second member not configured: set WORKFLOW_EMAIL_2/WORKFLOW_PASSWORD_2 or WORKFLOW_APP_TOKEN_2')` when the env is absent (exit 2, never a FAIL).

- [ ] **Step 1:** `test/walks.test.ts` registers the walk and asserts the block path; `test/env.test.ts` for `secondCredentials()`. Run → FAIL.
- [ ] **Step 2:** write the walk; `pnpm --filter @bffless/workflow-live build test:run`.
- [ ] **Step 3:** **commit** `feat(workflow-live): the ownership walk — a second member cannot see, sign or touch another member's run (D26, D27, D29)`. Running it live is Part D.

### Task B11: `ceMin`, the app README, the PR

**Files:**
- Modify: `apps/workflow/bffless-app.json:10` (`"ceMin": "0.4.57"` — the release A4 cut; if release-please produced another number, use that), `apps/workflow/bffless/README.md` (a short "Run ownership (spec 11)" section: the header names `x-workflow-scope` / `x-workflow-drive-key`, the two columns needing `--adopt-fields`, the claims schema, the walk), `apps/workflow/docs/spec/11-run-ownership.md` (one line under "The exemption is asked for": the single-run ask is the `x-workflow-scope: all` header, the list's is `scope=all`; and under "Attribution": the nonce rides `x-workflow-drive-key`, injected by the driver with a Playwright route — the spec said "already injects `WORKFLOW_TOKEN` that way", which was the wrong path), `apps/workflow/CONTEXT.md` if it lists the rule set's conventions (add: `run` + `runGate` step names are load-bearing for the fence)

- [ ] **Step 1:** full apps verify chain: `pnpm --filter workflow mcp:build && pnpm --filter workflow lint && pnpm --filter workflow build && pnpm --filter workflow test:run && pnpm --filter workflow test:stage && pnpm --filter @bffless/workflow-agent-tools test:run && pnpm --filter @bffless/workflow-live test:run`; `git status` clean apart from the intended files; `pnpm skills:sync` only if a skill under `.claude/skills/**` changed (none should).
- [ ] **Step 2:** **stop-and-check** (Cross-repo sequencing): A's release exists; C's headless release exists; C3 merged. If not, the branch waits — do not open the PR early, because merge = deploy.
- [ ] **Step 3:** push; `gh pr create` with the title in Global Constraints; the body: the spec's four doors table, the decisions list above (Decisions 4–9 verbatim), the cutover checklist (Part D) as a "Before merging / After merging" section, the `Claude-Session` footer. Request `apps-pr-review`. **Ask the person before merging** (merge deploys rules to `workflow.bffless.dev`).

---

# Part C — the driver carries the nonce (`workflow-headless`, `workflow-cli`, `workflow-implementations`)

Independent of Part A. Worktree `.claude/worktrees/drive-key`, branch `feat/headless-drive-key` off `origin/main`. One PR: `feat(workflow-headless): carry the drive nonce on every request the driven page makes`.

### Task C1: `WORKFLOW_DRIVE_KEY` / `--drive-key` → `x-workflow-drive-key` on every page request; `runs --all`

**Files:**
- Modify: `packages/workflow-headless/src/page.ts:36-53` (`PageLike` gains `route(matcher: (url: URL) => boolean, handler: (route: RouteLike) => Promise<void>): Promise<void>` with `interface RouteLike { request(): { headers(): Record<string, string> }; continue(overrides?: { headers?: Record<string, string> }): Promise<void> }` — Playwright's `Page.route` with a URL predicate satisfies it structurally), `src/args.ts` (`RunCommand`/`ResumeCommand` gain `driveKey?: string`; `--drive-key <key>` parsed after `--run-id`; `credentialsFromEnv` untouched; a new `driveKeyFromEnv(env)` = `env.WORKFLOW_DRIVE_KEY || undefined`; `USAGE` documents both; `RunsCommand` gains `all: boolean` from `--all`), `src/cli.ts` (`doRun`/`doResume` pass `driveKey: command.driveKey ?? driveKeyFromEnv(io.env)`; the `runs` verb passes `all`), `src/run.ts` + `src/resume.ts` (`RunOptions`/`ResumeOptions` gain `driveKey?: string`; right after `newPage()` and before `openHarness`: `if (o.driveKey) await installDriveKey(page, o.driveKey)`), a new `src/driveKey.ts`:
  ```ts
  export const DRIVE_KEY_HEADER = 'x-workflow-drive-key'
  /** Same-origin API paths the header rides on: the SPA's runs/post and every read/write in resume mode, the run page's file loads. Never the bucket (different origin, never matched). */
  export const isHarnessApiPath = (url: URL): boolean => /^\/api\/(workflow|uploads)\//.test(url.pathname)
  export async function installDriveKey(page: PageLike, key: string): Promise<void> {
    await page.route(isHarnessApiPath, async (route) => {
      await route.continue({ headers: { ...route.request().headers(), [DRIVE_KEY_HEADER]: key } })
    })
  }
  ```
  `src/runs.ts:64-78` (`listRuns(api, impl, workflow, last, all = false)` appends `&scope=all` when `all`)
- Modify: `test/args.test.ts` (`--drive-key`, `--all`), `test/run.test.ts` (with `driveKey` the fake page's `route` was installed with a matcher that accepts `/api/workflow/runs` and `/api/uploads/x` and rejects `https://bucket.example/o` and `/w/hello/x`; the handler adds the header and preserves existing ones; without `driveKey` no route is installed), `test/resume.test.ts` (same), `test/runs.test.ts` (`all` → `scope=all` in the URL), `test/fakes.ts` (the fake page records `route` calls), `test/cli.test.ts` (env fallback)
- Modify: `packages/workflow-headless/README.md` (the env var; "set by `workflow-drive.yml` from `client_payload.drive_key`")

- [ ] **Step 1:** tests first; `pnpm --filter @bffless/workflow-headless test:run` → FAIL.
- [ ] **Step 2:** implement; `pnpm --filter @bffless/workflow-headless build lint test:run`.
- [ ] **Step 3:** **commit** `feat(workflow-headless): carry WORKFLOW_DRIVE_KEY as x-workflow-drive-key on every harness request the driven page makes (spec 11, D28)`.

### Task C2: the CLI template — `drive.yml.tmpl` passes the key

**Files:**
- Modify: `packages/workflow-cli/src/templates/drive.yml.tmpl:66-83` — add `WORKFLOW_DRIVE_KEY: ${{ github.event.client_payload.drive_key }}` to the `Drive` step's `env:` (harmless while the payload has no key: the env is empty and the driver installs no route); `packages/workflow-cli/test/init.test.ts` (the rendered file contains the line); `packages/workflow-cli/README.md:75-88`
- [ ] **Step 1:** test first → FAIL; implement; `pnpm --filter @bffless/workflow-cli test:run`.
- [ ] **Step 2:** **commit** `feat(workflow-cli): workflow-drive.yml hands the driver client_payload.drive_key`. Push; open the Part C PR (C1 + C2); request review; **ask before merging** (it publishes `@bffless/workflow-headless`).

### Task C3: the live implementation repo

- [ ] **Step 1:** in `bffless/workflow-implementations` (`gh repo clone bffless/workflow-implementations /tmp/…/wfi` if no local checkout — check `ls /home/rico/bffless/repos` first), branch `feat/drive-key-env`, add the same `env:` line to `.github/workflows/workflow-drive.yml` (byte-identical to the template's rendering); PR `ci: hand the driver client_payload.drive_key (spec 11, D28)`. It is harmless before B merges. **Ask before merging.**

---

# Part D — cutover (person-gated, in this order)

- [ ] **D1.** CE v0.4.57 (or later) confirmed on `workflow.j5s.dev` and `workflow.bffless.dev` (A4). `@bffless/workflow-headless` released with C1; C3 merged.
- [ ] **D2.** Merge B's PR (person). Wait for `deploy-workflow.yml` green: rules + SPA are live.
- [ ] **D3.** The two new optional columns: `bffless rules push --adopt-fields` from `apps/workflow` against **each** instance (memory: *sync adopts schema fields only with --adopt-fields*; the deploy action has no such input). Verify: `mcp__j5s-dev__get_pipeline_schema` for `workflow_runs` lists `driveKey` and `startedByEmail`; `workflow_run_claims` exists.
- [ ] **D4.** Smoke on j5s as the session's own member: `GET /api/workflow/whoami` carries `projectRole`; the runs list is yours; a `workflow.start` over the MCP endpoint (`mcp` walk or the connector) dispatches, the driver's run lands with `startedBy` = the requester and no 409 (the D28 loop end to end — `apps-live-walk driven` proves it).
- [ ] **D5.** The `ownership` walk on j5s with a second member the person creates (`WORKFLOW_EMAIL_2`/`_PASSWORD_2` in `~/.config/bffless/workflow-ci.env`): `pnpm workflow-live:walk ownership --harness https://workflow.j5s.dev --out …` → exit 0.
- [ ] **D6.** Prove on `workflow.bffless.dev`: `driven` walk + the connector's `workflow.runs` from claude.ai shows only the person's runs; `scope: 'all'` lists all (the person is the project owner there).
- [ ] **D7.** Closeout: remove the three worktrees; file the deferred items as issues (`file-issue` skill): `scope` on the run-scoped MCP tools; queued claims in the list + claim GC; `adopt-fields` input on `deploy-proxy-rules`; update the `m5`-style memory with what shipped.
