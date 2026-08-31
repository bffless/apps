# Workflow M4 — Implementations Monorepo + Catalog Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Externalize the workflow implementations (studio, hello) into a new `bffless/workflow-implementations` monorepo, give the harness runtime project self-discovery (#363), and package the harness — and only the harness — as a catalog app (`bffless-app.json` + release-please component + registry publish), completing phase 2 of spec 06.

**Architecture:** Three moves in dependency order. First the topology: implementations leave `bffless/apps` for `bffless/workflow-implementations` (hello joins from `bffless/workflow-hello`, which is then archived), each publishing via `bffless/publish-workflow@v1` exactly as today — the deployed aliases do not change, so the live instance and every walk are untouched by the move. Second, discovery stops being build-time: the harness learns its serving project from a rule (probing CE's `deployment` handler-context root first; a CE issue only if the probe disproves it), so a prebuilt catalog bundle works on any instance. Third, the harness ships as a catalog app through the existing `apps/*` machinery (manifest → release-please component → `app-bundles.yml` → registry), which is only correct once the first two moves have made the bundle instance-agnostic and the repo implementation-free. Per the 2026-08-29 ruling recorded on #420, implementations are **never** catalog apps — they stay repos that publish into a harness project — so the manifest work here touches `apps/workflow` alone.

**Tech Stack:** pnpm workspaces (new repo), `bffless/publish-workflow@v1` (deploy + preview + teardown), `@bffless/workflow-lint` `workflow index`, release-please (`component: workflow`), `scripts/build-app-bundle.mjs` + `app-bundles.yml` + `registry.json` on `apps.bffless.dev`, CE app-catalog installer (`app-installer.service.ts`), CE proxy-rule `function_handler` context (`deployment` root), Playwright walks in `packages/workflow-live` as the live gate.

**Spec:** `apps/workflow/docs/spec/06-discovery-publishing-files.md` (Phase 1 → phase 2 section `:241-246` is what this plan completes; Names `:8-20`; publish steps `:94-142`; the local-FS `PUBLIC_ORIGIN` caveat `:213-215` becomes a manifest manual step) · `apps/workflow/docs/spec/00-overview.md` (M4 milestone bullet + follow-up list — follow-ups stay unscoped) · `apps/workflow/docs/writing-an-implementation.md` (identity definition `:48-52`; gains the monorepo layout) · prior plans `2026-08-19-workflow-m1-harness-core.md`, `2026-08-24-workflow-m2-interactive-steps.md`, `2026-08-27-workflow-m3-publish-headless-studio.md` · Live state: `apps/workflow/bffless/README.md`, `apps/workflow-studio/bffless/README.md` · Epic: bffless/apps#359 · Related issues folded in: #363 (runtime discovery — Phase 2), #420 (identity file only — the tooling stays deliberately unstarted per its own status line) · Not in scope: ce#698 `alias://` (optional spelling, not a dependency), WebMCP, attestations, guest/public runs, reusable workflows, deployment-pinned `/w/<alias>@<deployment>/`, cancel-time semantics, `bffless/run-workflow` action, response-header rules as code (ce#700).

## Decisions this plan makes (spec-ambiguous points, resolved here)

The five ⚑ items **were confirmed by the user on 2026-08-31** (recorded inline); the rest are reversible planner calls.

1. **⚑ CONFIRMED — implementations leave `bffless/apps`; the new home is the `bffless/workflow-implementations` monorepo.** The harness is the app; implementations are content published into its project. `bffless/apps` keeps `apps/workflow` and the `packages/workflow-*` toolchain only.
2. **⚑ CONFIRMED — hello moves in too; `bffless/workflow-hello` is archived after the move.** The monorepo is the one home for implementations; `writing-an-implementation.md` and `publish-workflow`'s README repoint their examples at `workflow-implementations/hello`. History is preserved by archiving, not deleting.
3. **⚑ CONFIRMED — Studio's libs are copied and frozen into the monorepo, not published.** The M3 port rule ("import Studio's pure libs via the `studio` workspace `exports`, byte-identical") **retires at move time**. Every copied file gets a provenance header naming the `bffless/apps` commit it was frozen at; the 152 rule fixtures and the script/island unit tests move with the code and remain the behavioral pin. From then on, Studio drift does not flow into workflow-studio — divergence is deliberate.
4. **⚑ CONFIRMED — one M4 plan, externalization first.** Phase order: monorepo + move → runtime discovery (#363, CE-first) → harness manifest/catalog/registry → docs + live proof.
5. **⚑ CONFIRMED — #420 is a design constraint here, not a deliverable.** Each implementation package in the monorepo gains the identity file #420 proposed (`.bffless/workflow.json { "alias", "harness" }`), and the deploy workflows read alias/rules paths consistently with it — but `workflow init`/`add`/`rename` tooling stays unbuilt until a real third implementation is authored by hand (its own status line).
6. **#363 is resolved by provenance, probed before designed.** The `deployment: { owner, repo }` root already exists in CE's `function_handler` context (asserted by `apps/workflow-studio/.bffless/proxy-rules/workflow-studio/rules/thumbnail/render/post/shape.fn.test.yaml:9`). If a live probe shows it names the **serving project** (or names the deployment's repository *and* the catalog installer sets that to the project, per CE `app-installer.service.ts:948` `repository: '<owner>/<name>'`), the harness answers its own project from a new `GET /api/workflow/project` pipeline rule and no CE change is needed. Only if the probe disproves both readings does a CE issue get filed (option (b), query-pinning, stays the fallback design in #363's body). `VITE_BFFLESS_PROJECT` stays as a build-time **override**, no longer a requirement.
7. **The harness manifest declares no domain by default risk-free values.** `install.alias: "workflow"`, `domain: { subdomain: "workflow", isPublic: false, isSpa: true }` — the harness is a private members-only app (spec 06 Access), so `isPublic: false`, unlike Handoff. `requires: { ceMin: … }` is pinned to the CE release that carries the files quartet + `frames` op semantics the walks prove (v0.4.37 floor; raise if Phase 2's probe lands a CE change).
8. **Registry assets are house-standard.** `apps/workflow/catalog/description.md` + `catalog/thumbnail.png` are mandatory with a manifest (`scripts/check-app-conventions.mjs:200,203`); the thumbnail is a build-time export of the run-page screenshot already in the walk artifacts, not new art.
9. **The move is deploy-neutral by construction.** Aliases (`hello`, `workflow-studio`), rule-set names, `/api/<impl>/…`, `/w/<impl>/…`, and the harness project `bffless/workflow` are all unchanged; only the publishing repo changes. The proof obligation is the walk suite re-run after each cutover, not new checks.
10. **`apps/workflow/hello.ref` changes meaning, not mechanism.** It pins a `bffless/workflow-implementations` commit after the move (the stager fetches hello's sources for the mock bundle from there); one task updates the fetch URL and the ref in the same commit.

## Deferred out of M4, explicitly

- `workflow init / add / rename` CLI, template repo, `bffless:workflow` skill → #420 (unstarted by design).
- CE `targetUrl: alias://<name>` → ce#698 (nice-to-have; the in-process forwarder covers it).
- WebMCP, attestations, guest/public runs, reusable workflows, deployment-pinned `/w/<alias>@<deployment>/` → 00-overview M4 follow-up list, unscoped.
- Publishing Studio's libs as an npm package — rejected 2026-08-31 in favor of copy/freeze (Decision 3); revisit only if the frozen copies rot badly enough to hurt.
- Catalog packaging of implementations — rejected 2026-08-29 (#420 non-goals), reaffirmed here.

## Global Constraints

- **Two repos are in play.** `bffless/apps` (this checkout; shared checkout is read-only — every phase works in a worktree: `git worktree add .claude/worktrees/workflow-m4-<phase> -b <branch> origin/main`) and the new `bffless/workflow-implementations` (cloned fresh under `~/bffless/repos/workflow-implementations`; same worktree discipline once it has parallel work).
- **PR titles are release commits** (squash merges): `chore(workflow-implementations): scaffold the implementations monorepo` · `feat(workflow-implementations): move hello from bffless/workflow-hello` · `feat(workflow-implementations): move workflow-studio from bffless/apps` · `chore(workflow-studio): remove the app from the monorepo — moved to bffless/workflow-implementations` · `feat(workflow): runtime project self-discovery via the serving rule set (#363)` · `feat(workflow): bffless-app.json manifest, catalog assets and release component` · `docs(workflow): spec 06 phase-2 topology as shipped + epic/README updates`.
- **A merge is a live deploy** in three places: `bffless/apps` main (harness rule set + alias `workflow`), `workflow-implementations` main (each implementation's alias + rule set via `publish-workflow`), and — new — a release-please **release** of `apps/workflow` publishes a bundle + registry entry. PR-open deploys nothing anywhere (no preview for the harness; previews in the new repo use `<impl>-pr-<n>` + teardown).
- **Aliases, rule-set names, API/file prefixes never change** during the move (Decision 9). Any diff in `bffless rules diff` output before/after a cutover that isn't empty is a defect.
- `pnpm --filter workflow build` (tsc) belongs in every `apps/workflow` verify chain (M3 standing rule); `pnpm apps:check` green before every `bffless/apps` PR; the new repo's CI gate is per-package `lint && stage && build && test` + `rules:validate` + `rules:test` (same commands, new root).
- Secrets: the new repo gets `BFFLESS_API_KEY` (contributor role on `bffless/workflow`, same key material as `BFFLESS_WORKFLOW_API_KEY` in apps) as an Actions secret; never in YAML.
- Commit after every task; before each commit run the touched package's `lint` + `test:run`; before each phase PR the phase's gate (listed in its last task).

## File structure

```
bffless/workflow-implementations/            (new repo — Phase 1)
  pnpm-workspace.yaml                        # Task 1
  package.json                               # Task 1 (root scripts: <impl>:lint/stage/build/test, rules:*)
  .github/workflows/
    ci.yml                                   # Task 1 (per-package build/lint/test on PR)
    deploy-hello.yml                         # Task 2 (publish-workflow@v1, alias hello)
    preview-hello.yml + teardown             # Task 2 (mode: teardown on PR close)
    deploy-workflow-studio.yml               # Task 3 (ported from bffless/apps, path filters localized)
    preview-workflow-studio.yml + teardown   # Task 3
  hello/                                     # Task 2 (from bffless/workflow-hello @ its main)
    .bffless/workflow.json                   # Task 2 { "alias": "hello", "harness": "workflow" }
  workflow-studio/                           # Task 3 (from apps/workflow-studio @ bffless/apps main)
    .bffless/workflow.json                   # Task 3 { "alias": "workflow-studio", "harness": "workflow" }
    vendor/studio/                           # Task 3 — frozen copies of the `studio` exports surface
bffless/apps                                 (this repo)
  apps/workflow-studio/                      # Task 4: DELETED (with deploy/preview ymls, CI filters, docs pointers)
  apps/workflow/hello.ref                    # Task 4: repointed at workflow-implementations
  apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/project/get/
    rule.yaml + project.fn.js + project.fn.test.yaml   # Task 6 (#363)
  apps/workflow/src/lib/discovery.ts         # Task 7: runtime source first, VITE_ override second
  apps/workflow/bffless-app.json             # Task 8
  apps/workflow/catalog/{description.md,thumbnail.png}  # Task 8
  release-please-config.json + .release-please-manifest.json  # Task 9 (component: workflow)
  docs/spec 06 / 00-overview / writing-an-implementation.md   # Task 11
```

## Traceability — M4 scope → tasks

| Epic #359 M4 checkbox / decision | Spec | Tasks |
|---|---|---|
| Externalize implementations (user decision 2026-08-31) | 06 Names, CI obligations | 1–5 |
| #363 runtime self-discovery | 06 Discovery; #363 body | 6–7 |
| `bffless-app.json` + release-please component + registry publish | 06 Phase 1 → phase 2; publish-app skill | 8–10 |
| phase-1→phase-2 topology changes per spec 06 | 06 `:241-246` | 11 |
| #420 identity constraint | writing-an-implementation `:48-52` | 2, 3 (the `.bffless/workflow.json` files) |
| Live proof | walks (packages/workflow-live) | 5, 12 |

---

# Phase 1 — the implementations monorepo (Tasks 1–5)

*Deliverable: `bffless/workflow-implementations` exists, deploys both implementations to their unchanged aliases, previews + teardown work, `bffless/apps` no longer contains an implementation, and the full walk suite is green. Branches: repo-local `main` PRs in the new repo; `chore/m4-remove-workflow-studio` in worktree `.claude/worktrees/workflow-m4-remove` for the apps side.*

### Task 1: Scaffold `bffless/workflow-implementations`

**Files:**
- Create (new repo root): `pnpm-workspace.yaml` (`packages: ['*']`, excluding `vendor`), `package.json` (private, root scripts `hello:*` / `workflow-studio:*` / `rules:validate` / `rules:test` mirroring the verbs `bffless/apps` uses), `.github/workflows/ci.yml`, `README.md` (what this repo is: implementations that publish into a harness project; the #420 non-goal line quoted), `.gitignore`, `.nvmrc` (copy from `bffless/apps`).

**Interfaces:**
- Produces: repo layout Tasks 2–3 drop packages into; CI that runs each package's `lint`/`build`/`test` on PR.

- [ ] **Step 1:** `gh repo create bffless/workflow-implementations --private --clone` (private until Task 5 proves the walks; flip public with the archive step if desired). Scaffold the six files. `ci.yml` runs on `pull_request`: `pnpm install --frozen-lockfile`, then for each package directory found: `pnpm --filter <pkg> lint && pnpm --filter <pkg> build && pnpm --filter <pkg> test:run` (packages define the scripts; a package without a script is skipped via `--if-present`).
- [ ] **Step 2:** Set Actions secret `BFFLESS_API_KEY` (`gh secret set BFFLESS_API_KEY --repo bffless/workflow-implementations`) — the same contributor-role key `bffless/apps` holds as `BFFLESS_WORKFLOW_API_KEY`; and Actions variable `BFFLESS_URL` (the instance URL). Record both names in the README.
- [ ] **Step 3:** Verify CI runs green on the scaffold PR (no packages yet — the loop is empty but the workflow must parse and pass).
- [ ] **Step 4:** Merge (PR title from Global Constraints).

### Task 2: Move hello in; archive `bffless/workflow-hello`

**Files:**
- Create: `hello/**` (full tree of `bffless/workflow-hello` at its current `main` — post-#5, the commit `apps/workflow/hello.ref` will pin), `hello/.bffless/workflow.json`, `.github/workflows/deploy-hello.yml`, `.github/workflows/preview-hello.yml` (with the `mode: teardown` job on PR close, exactly the shape proven on workflow-hello#1).

**Interfaces:**
- Produces: `hello/` package whose `dist/` layout, alias (`hello`), rule set (`hello`) and workflows are byte-identical to today's; `.bffless/workflow.json` shape `{ "alias": "hello", "harness": "workflow" }` (Decision 5 — the identity file #420 proposed; nothing reads it yet beyond Task 3's consistency check pattern).

- [ ] **Step 1:** Import history: `git remote add hello https://github.com/bffless/workflow-hello && git fetch hello && git read-tree --prefix=hello/ -u hello/main && git commit` (subtree add keeps the tree; full history stays reachable in the archived repo — Decision 2).
- [ ] **Step 2:** Port `deploy.yml`/`preview.yml` from workflow-hello into `.github/workflows/{deploy,preview}-hello.yml`, changing only: paths filters gain the `hello/**` prefix, `path:`/`workflows:`/`rules:` inputs gain the `hello/` prefix, secrets/vars use this repo's names. `repository: bffless/workflow`, `alias: hello`, `harness-alias: workflow` stay verbatim.
- [ ] **Step 3:** Write `hello/.bffless/workflow.json`: `{ "alias": "hello", "harness": "workflow" }`. Add a 5-line node script `scripts/check-identity.mjs` at the repo root asserting, for every `*/.bffless/workflow.json`, that the alias equals the package dir's deploy yml `alias:` input; wire it as the first step of `ci.yml`.
- [ ] **Step 4:** Open the PR; verify the **preview** publishes `hello-pr-1` (browsable via `/w/hello-pr-1/`) and closing/reopening exercises teardown. Merge; verify `deploy-hello.yml` republishes alias `hello` and `bffless rules diff hello` (from the new repo, `--project bffless/workflow`) reports **no drift**.
- [ ] **Step 5:** Archive the old repo: `gh repo archive bffless/workflow-hello -y`. Its README gains one line first (PR or direct, it's about to freeze): "Moved to bffless/workflow-implementations/hello — this repo is an archive."

### Task 3: Move workflow-studio in, freezing the Studio libs

**Files:**
- Create: `workflow-studio/**` (from `bffless/apps` `apps/workflow-studio/` at current main), `workflow-studio/vendor/studio/**` (frozen copies), `workflow-studio/.bffless/workflow.json`, `.github/workflows/{deploy,preview}-workflow-studio.yml`.
- Modify: every `from 'studio/...'` import inside `workflow-studio/` → `from '../vendor/studio/...'` (relative, per-file depth).

**Interfaces:**
- Consumes: the `studio` package's `exports` surface (`apps/studio/package.json:6-13`): `./lib/*` → `src/lib/*.ts`, `./components/Studio/{CutEditor,MarkdownBody,MermaidDiagramView,clipPlayer}`, `./index.css`.
- Produces: a self-contained `workflow-studio/` package with **zero** workspace dependencies on `bffless/apps`; the same staged `dist/` (Step 5 proves it byte-comparable).

- [ ] **Step 1:** Enumerate the real import surface: in `apps/workflow-studio`, `grep -rn "from 'studio" scripts islands src` → the file list is known (sheet-plan, scene-sheet-plan, frame-times, scene-inputs, final-script, blog-bundle, lib/inputs, cut-editor App/filmstrip/keep, blog-editor App/post/mermaid + tests). Resolve each specifier to its `apps/studio/src/...` file; copy that file **and its transitive local imports** into `workflow-studio/vendor/studio/`, preserving relative structure (`lib/…`, `components/Studio/…`, `index.css`). Every copied file gets a header: `// Frozen from bffless/apps apps/studio @ <commit sha> (M4 Decision 3 — divergence from Studio is deliberate from here).`
- [ ] **Step 2:** Rewrite the imports to relative `vendor/` paths; delete `"studio": "workspace:*"` from `workflow-studio/package.json`. `pnpm install && pnpm --filter workflow-studio lint && pnpm --filter workflow-studio build && pnpm --filter workflow-studio test:run` — the 154 unit tests and 152 rule fixtures must pass unchanged (they are the behavioral pin; a test edit in this task is a defect, not a fix).
- [ ] **Step 3:** `workflow-studio/.bffless/workflow.json` `{ "alias": "workflow-studio", "harness": "workflow" }`; port `deploy-workflow-studio.yml`/preview+teardown with localized path filters (`workflow-studio/**` only — the `apps/studio/**` seam filters from `bffless/apps:.github/workflows/deploy-workflow-studio.yml:21-31` are **dropped**: frozen code has no seam). Identity check from Task 2 passes.
- [ ] **Step 4:** Byte-comparability gate before any deploy: run the stager in both repos at the same commit pair and diff the staged bundles — `diff -r <apps>/apps/workflow-studio/dist <new>/workflow-studio/dist` ignoring only the `generatedAt`/`commit` fields of `index.json`. Non-empty diff beyond those fields = stop and explain.
- [ ] **Step 5:** PR → preview `workflow-studio-pr-1` browsable → merge → `deploy-workflow-studio.yml` republishes alias `workflow-studio`; `bffless rules diff workflow-studio --project bffless/workflow` reports no drift.

### Task 4: Remove the implementation from `bffless/apps`

**Files (worktree `.claude/worktrees/workflow-m4-remove`, branch `chore/m4-remove-workflow-studio`):**
- Delete: `apps/workflow-studio/**`, `.github/workflows/deploy-workflow-studio.yml`.
- Modify: `.github/workflows/workflow-app.yml` (drop the workflow-studio steps `:37-40`-adjacent), `pnpm-workspace.yaml`/root `package.json` (drop `workflow-studio:*` scripts), `apps/workflow/hello.ref` (new meaning: a `bffless/workflow-implementations` commit; update the stager's fetch URL in `apps/workflow/scripts/stage.mjs` from the workflow-hello raw URL to `workflow-implementations`'s `hello/` path at that ref), `CLAUDE.md`/`docs/agents` pointers, `.claude/skills` references if any name `apps/workflow-studio` paths (then `pnpm skills:sync` — the mirror rule).
- Test: full `pnpm apps:check`; `pnpm workflow:lint && pnpm workflow:build && pnpm workflow:test` (the stager fetch is exercised by `test:stage`).

- [ ] **Step 1:** Delete + modify per the list. The deletion PR must **not** touch the live rule set: `deploy-workflow-studio.yml` is deleted, not run — the alias and rule set now belong to the new repo's workflows (already proven in Task 3).
- [ ] **Step 2:** Repoint `hello.ref`: pin the `workflow-implementations` commit from Task 2's merge; update the fetch URL; `pnpm --filter workflow test:stage` green.
- [ ] **Step 3:** `pnpm apps:check` green (6 apps becomes 5 — update the count anywhere it is asserted); `git grep -l "apps/workflow-studio"` returns only history/plan docs (which keep their text — plans are frozen history).
- [ ] **Step 4:** PR + merge (title from Global Constraints). Note in the PR body: deploy-neutral — no rule/alias write happens on this merge.

### Task 5: Move-complete live proof

- [ ] **Step 1:** Run the walk suite against the live instance via the `apps-live-walk` agent: `interactive` (27/27), `hello` (7/7), `studio-audit` (7/7), `headless --dispatch` (15/15). `studio-headless` is optional here (spends one Studio kickoff) — run it only if any studio check regressed.
- [ ] **Step 2:** Record the walk results + the two `rules diff` no-drift proofs in `apps/workflow/bffless/README.md` (new dated block "M4 Phase 1 — the move was deploy-neutral") and tick the epic's Phase-1 row (added by the plan PR, Task 13).

---

# Phase 2 — runtime project self-discovery, #363 (Tasks 6–7)

*Deliverable: a catalog-installed (or any) harness answers its own project at runtime; `VITE_BFFLESS_PROJECT` demotes to an override. Branch `feat/m4-runtime-discovery`, worktree `.claude/worktrees/workflow-m4-discovery`.*

### Task 6: Probe `deployment.*`, then the `GET /api/workflow/project` rule

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/project/get/{rule.yaml,project.fn.js,project.fn.test.yaml}`.
- Modify: `apps/workflow/src/mocks/handlers.ts` (mock the new endpoint), `apps/workflow/bffless/README.md` (the probe's findings, whatever they are).

**Interfaces:**
- Produces: `GET /api/workflow/project` → `200 { "repository": "<owner>/<repo>" | null }`, `auth_required` + `allowApiKey: true`, `Cache-Control: no-store` — the whoami rule (`rules/api/workflow/whoami/get/rule.yaml`, `order: 17`) is the template; pick a free `order`.

- [ ] **Step 1 (the probe — do this before writing the rule):** On the live instance, add a **temporary** probe rule via MCP (project `bffless/workflow`, a scratch path like `/api/workflow/_probe-deployment`) whose `function_handler` returns `JSON.stringify(deployment ?? null)`; call it with the member session; **record verbatim** what `deployment` contains for (a) a CI-deployed harness. Delete the probe rule. Decision 6's fork resolves here: if `owner/repo` = `bffless/workflow` (the project), option (a) holds. If it echoes the *git* repo (`bffless/apps`) instead, check CE `app-installer.service.ts:948` still sets `repository` to the project for catalog installs — then the endpoint is correct for catalog installs and wrong only for CI deploys, which keep the `VITE_` override; record that split. If `deployment` is absent entirely, **stop**: file the CE issue (option (b) from #363's body — query-pinning via a CE query-add feature or `http_request` pipeline) via the `file-issue` flow against `bffless/ce`, mark #363 blocked again, and skip Task 7 (the rest of the plan does not depend on it — the manifest ships with the `VITE_` bake documented as a manual step).
- [ ] **Step 2:** Write the failing fixture `project.fn.test.yaml`: case 1 `data: { deployment: { owner: "o", repo: "r" } }` → `expect: { result: { repositoryJson: '{"repository":"o/r"}' } }`; case 2 `data: {}` → `expect: { result: { repositoryJson: '{"repository":null}' } }`. Run `pnpm --filter workflow rules:test` — fails (no handler).
- [ ] **Step 3:** Implement `project.fn.js` (returns `{ repositoryJson: JSON.stringify({ repository: deployment?.owner && deployment?.repo ? deployment.owner + '/' + deployment.repo : null }) }`) and `rule.yaml` (pipeline: the fn step + `response_handler` body `{{{steps.project.repositoryJson}}}`, mirroring whoami's quote-safe shape). `rules:test` green; `rules:validate` green.
- [ ] **Step 4:** Verify — `pnpm workflow:lint && pnpm workflow:build && pnpm workflow:test && pnpm apps:check`.
- [ ] **Step 5:** Commit `feat(workflow): GET /api/workflow/project — the serving project from deployment provenance (#363)`.

### Task 7: Discovery consumes it; `VITE_BFFLESS_PROJECT` demotes to override

**Files:**
- Modify: `apps/workflow/src/lib/discovery.ts` (add `fetchProjectRepository()`; precedence: `VITE_BFFLESS_PROJECT` if set → else `GET /api/workflow/project`), `apps/workflow/src/store/workflowApi.ts:184` (the aliases query building awaits the resolved repository), `apps/workflow/src/mocks/handlers.ts:50-52`.
- Test: `src/lib/discovery.test.ts` (precedence, null answer → unscoped call preserved), `src/store/workflowApi.test.ts`, `src/pages/ImplementationsPage.test.tsx`.

- [ ] **Step 1:** Failing tests: env set → no fetch made, `?repository=` from env; env empty + endpoint answers `{repository:"o/r"}` → `?repository=o%2Fr`; env empty + endpoint `{repository:null}` → unscoped `api/workflow/aliases` (today's fallback, which ce#702 made role-scoped server-side — cite that in the test comment).
- [ ] **Step 2:** Verify fail → implement → green. The resolved value is fetched once and cached for the session (module-level promise, the `discovery.ts` doc comment rewritten to describe runtime-first).
- [ ] **Step 3:** `deploy-workflow.yml:34` keeps `VITE_BFFLESS_PROJECT: bffless/workflow` **with a comment** ("override — runtime discovery works without it since #363; kept to save one request and to pin CI deploys explicitly").
- [ ] **Step 4:** Verify chain + `pnpm apps:check`; PR `feat(workflow): runtime project self-discovery via the serving rule set (#363)`; after merge+deploy, live-check `curl` the new endpoint (session cookie via the relay, not X-API-Key) and close #363 citing the probe record.

---

# Phase 3 — the harness as a catalog app (Tasks 8–10)

*Deliverable: `apps/workflow` ships a manifest, release-please component `workflow`, and a registry entry; a CE instance can 1-click install the harness. Branch `feat/m4-harness-catalog`, worktree `.claude/worktrees/workflow-m4-catalog`.*

### Task 8: `bffless-app.json` + catalog assets

**Files:**
- Create: `apps/workflow/bffless-app.json`, `apps/workflow/catalog/description.md`, `apps/workflow/catalog/thumbnail.png`.
- Test: `pnpm apps:check` (`scripts/check-app-conventions.mjs` enforces the manifest/assets/version-agreement rules).

**Interfaces:**
- Produces the manifest (exact content — Handoff's is the template, values workflow's own):

```json
{
  "schemaVersion": 1,
  "id": "workflow",
  "name": "Workflow",
  "version": "0.0.0",
  "summary": "Run reviewable, resumable AI workflows — interactive or headless — against your own BFFless project.",
  "category": "automation",
  "sourceUrl": "https://github.com/bffless/apps/tree/main/apps/workflow",
  "requires": { "ceMin": "0.4.37" },
  "install": {
    "alias": "workflow",
    "deployment": { "path": "dist", "basePath": "/apps/workflow/dist" },
    "ruleSets": [{ "file": "rulesets/workflow.json", "attachToAlias": true }],
    "domain": { "subdomain": "workflow", "isPublic": false, "isSpa": true },
    "schedules": [],
    "manualSteps": [
      { "id": "public-origin-local-fs", "title": "Set PUBLIC_ORIGIN (local storage only)", "body": "On local-FS storage, presigned media URLs are relative and island viewers cannot resolve them. Set PUBLIC_ORIGIN on the backend so signed URLs are absolute.", "appliesWhen": "localStorage" },
      { "id": "install-implementations", "title": "Publish an implementation", "body": "The harness starts empty. Publish an implementation (e.g. hello) into project {projectPath} with bffless/publish-workflow — see the workflow-implementations repo.", "externalLink": { "label": "workflow-implementations", "url": "https://github.com/bffless/workflow-implementations" }, "appliesWhen": "always" }
    ]
  },
  "eject": { "repo": "bffless/apps", "appPath": "apps/workflow", "deployWorkflow": ".github/workflows/deploy-workflow.yml", "variables": ["BFFLESS_URL"], "secrets": ["BFFLESS_API_KEY"] }
}
```

- [ ] **Step 1:** Write the three files (`version` seeded to the current `apps/workflow/package.json` version; description.md ≤ the house shape, body strings ≤ 220 chars — `apps:check` enforces). The rule-set JSON for the bundle is the compiled `workflow` set (`bffless rules build apps/workflow/.bffless/proxy-rules/workflow -o …` — `scripts/build-app-bundle.mjs` already does this for the other apps; confirm it picks the set up by convention, else wire the path the way the reader app does).
- [ ] **Step 2:** Run `pnpm apps:check` — expect FAIL listing the release-please gaps (component missing) — that failure is Task 9's input, not this task's defect; the manifest-shape rules themselves must pass.
- [ ] **Step 3:** Commit `feat(workflow): bffless-app.json manifest and catalog assets`.

### Task 9: Release-please component + bundle wiring

**Files:**
- Modify: `release-please-config.json` (add the `apps/workflow` block — the catalog-app shape with `extra-files` for `bffless-app.json`), `.release-please-manifest.json` (seed `"apps/workflow": "<current version>"`), `.github/workflows/release.yml` / `app-bundles.yml` only if the app list is explicit anywhere (the invariant test `scripts/workflow-invariants.test.mjs` says registry writes happen only in `release.yml` — keep it true).

- [ ] **Step 1:** Add the config block + manifest seed; align the three version numbers (package.json / bffless-app.json / manifest seed) — `apps:check` asserts agreement.
- [ ] **Step 2:** `pnpm apps:check` fully green now; `node --test scripts/workflow-invariants.test.mjs` green.
- [ ] **Step 3:** Commit; open the phase PR `feat(workflow): bffless-app.json manifest, catalog assets and release component`. **This reverses M1 Decision 9** (workflow deliberately had no release component) — say so in the PR body with the epic line that authorizes it.

### Task 10: Registry publish + install proof

- [ ] **Step 1:** Merge the phase PR; let release-please open the `workflow` Release PR; merging that cuts `workflow-v<version>`, `release.yml` builds `workflow-v<version>.bundle.zip` + sha256 and rewrites `registry.json` on `apps.bffless.dev`. Verify the entry: `curl -L https://<registry alias host>/registry.json | jq '.apps[] | select(.id=="workflow")'` — `bundleUrl` https, `sha256` 64-hex.
- [ ] **Step 2:** Install proof on a scratch CE project (NOT `bffless/workflow` — the catalog installer would fight the CI-deployed alias): a self-hosted CE ≥ 0.4.37 or a scratch project on the dev instance. Admin → Apps → install Workflow. Gate: install job reports `ruleSets: 1, alias: true`; the app loads; `GET /api/workflow/project` answers the scratch project (Phase 2's payoff — discovery scoped correctly with no `VITE_` bake); the empty-state "Publish an implementation" manual step renders with `{projectPath}` expanded.
- [ ] **Step 3:** Record the install proof in `apps/workflow/bffless/README.md`; delete the scratch install.

---

# Phase 4 — docs, spec, epic (Tasks 11–13)

*Deliverable: the written record matches what shipped. Branch `docs/m4-as-shipped`, worktree `.claude/worktrees/workflow-m4-docs`.*

### Task 11: Spec + authoring docs as shipped

**Files:**
- Modify: `apps/workflow/docs/spec/06-discovery-publishing-files.md` (Phase 1 → phase 2 section rewritten past-tense: manifest shipped, registry, the unchanged-between-phases claim re-affirmed or amended by what Task 10 found), `apps/workflow/docs/spec/00-overview.md` (M4 milestone bullet → done; follow-up list stays), `apps/workflow/docs/writing-an-implementation.md` (the monorepo is the home; `.bffless/workflow.json` documented as the identity file; the `gh repo fork` row replaced by "add a package to workflow-implementations"), `apps/workflow/docs/adr/0001-*.md` (amendment note: implementations externalized, workflow-hello archived).

- [ ] **Step 1:** Make the edits; every claim that something is live cites the run/walk/install evidence recorded in Phases 1–3.
- [ ] **Step 2:** `pnpm workflow:lint` (docs lint rides along) + `pnpm apps:check`; PR `docs(workflow): spec 06 phase-2 topology as shipped + epic/README updates`; merge.

### Task 12: Post-M4 walk baseline

- [ ] **Step 1:** One full `walk all` via `apps-live-walk` against the live instance (spends one Studio kickoff — the M4 closing baseline). All green → record in both bffless READMEs.

### Task 13: Epic bookkeeping

- [ ] **Step 1:** Tick the epic #359 M4 rows (plan written; externalization; #363; manifest/registry) with PR numbers and walk evidence; comment the closing summary; close #363 (done in Phase 2) and leave #420 open with a pointer to the identity files now existing.

---

## Self-review (writing-plans checklist, applied)

- **Spec coverage:** spec 06 phase-2 (Task 8–10), Names/identity (Tasks 2–3 identity files), `PUBLIC_ORIGIN` caveat (Task 8 manual step), epic M4 checkbox (all), #363 (Tasks 6–7 with the probe-first fork and its blocked-path exit), #420 constraint (Decision 5, Tasks 2–3), user's externalization decisions 1–4 (Phase 1). The M4 follow-up list is explicitly deferred.
- **Placeholder scan:** the one deliberately open value is the probe's outcome in Task 6 Step 1 — it is a decision procedure with all three outcomes specified, not a TBD. Manifest JSON, identity-file JSON, fixture cases and command lines are concrete.
- **Type consistency:** `GET /api/workflow/project` → `{ repository: string | null }` is used identically in Tasks 6, 7, and 10; `.bffless/workflow.json` `{ alias, harness }` identical in Tasks 2, 3, 11.

## Execution handoff

Plan complete. Two execution options: **1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks (superpowers:subagent-driven-development). **2. Inline** — batch execution with checkpoints (superpowers:executing-plans). Phase 1 Task 1 requires creating a GitHub repo and setting a secret — maintainer-gated actions to approve at execution time.
