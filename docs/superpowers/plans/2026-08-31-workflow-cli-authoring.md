# Workflow Authoring CLI (`@bffless/workflow`) Implementation Plan — apps#420

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workflow authoring CLI — `npx @bffless/workflow init|rename|add|lint|index|publish` in a new `packages/workflow-cli` — and prove it by using `init` to create the third real implementation: a deliberate copy of workflow-studio living in `bffless/bffless` (the bffless.app repo), publishing into a fresh catalog install of the Workflow harness on bffless.dev, while the original workflow-studio stays as the dev environment on j5s. Close with the `bffless:workflow` agent skill.

**Architecture:** A thin CLI over what already exists. `@bffless/workflow-lint` stays the parser/schema/resolver library (its `lint`/`index` verbs delegate unchanged); the new package adds the identity engine — read/write `.bffless/workflow.json`, the boundary-aware alias rewrite pass, and generated host-repo deploy/preview workflows — plus a `publish` verb that drives the same four moves the `publish-workflow` action makes (index → prepare/forwarder → rules sync → upload+attach) through published primitives (`buildIndex`, a ported prepare module, spawned `npx bffless rules push`, `@bffless/artifact-client`). The `bffless/publish-workflow` action stays external and authoritative for CI (`uses:` pins must not break); a later action v2 wrapping `npx @bffless/workflow publish` is recorded, not performed. Templates are **not** a coupled repo: `init --from <owner>/<repo> [--path <dir>] [--ref <sha>]` discovers `.bffless/workflow.json` in any readable repo — `bffless/workflow-implementations` is merely the default.

**Tech Stack:** TypeScript ESM (node ≥ 20), `@bffless/workflow-lint` ^1.4 as library, `yaml`, `@bffless/artifact-client` (publish verb), Vitest; release-please component + the `publish-workflow-lint.yml` npm train; the bffless.app repo (`bffless/bffless`, Vite SPA, project `bffless/bffless.app` on admin.bffless.dev) as the dogfood host; `bffless/skills` for the agent skill.

**Spec:** apps#420 (body + the 2026-08-31 direction ruling and identity-file comments) · `apps/workflow/docs/writing-an-implementation.md` (identity definition `:54-70`; gains the CLI as the primary path) · `apps/workflow/docs/spec/06-discovery-publishing-files.md` (Names; publish steps 1–5 the `publish` verb mirrors) · `bffless/publish-workflow` `action.yml` + `scripts/{prepare-rules,attach,teardown}.mjs` (the behavior `publish` must match) · `workflow-implementations` `scripts/check-identity.mjs` + the hello identity inventory (§Decisions 6) · prior plans (M0 for workflow-lint's shape; M4 for the externalization). Live state: `apps/workflow/bffless/README.md`, workflow-implementations README. Related issues folded in: #420 (this plan closes it). Not in scope: publish-workflow action v2, harness-side "new workflow" GUI, catalog installs of implementations (both rejected on #420), multiple copies of one implementation per project.

## Decisions this plan makes (spec-ambiguous points, resolved here)

The five ⚑ items **were confirmed by the user on 2026-08-31** (recorded inline); the rest are reversible planner calls to surface in the plan PR review.

1. **⚑ CONFIRMED — the gate is lifted by dogfooding.** #420's "author a third implementation by hand first" is satisfied by Phase 4: the third implementation is created *with the tool*, against a real external repo and a fresh instance, and every friction point is recorded on #420 (the gate's own checklist). M4's move already hand-exercised the rename surface once.
2. **⚑ CONFIRMED — new `packages/workflow-cli`, published as `@bffless/workflow`.** `workflow-lint` keeps its name, version, deps and consumers; the CLI depends on it as a library. Home is `bffless/apps` `packages/` per the 2026-08-31 ruling on #420 (platform CLI carries platform verbs only; the toolchain co-versions with the spec, which lives here).
3. **⚑ CONFIRMED — `init` is portable, not coupled.** `workflow init <alias> --from <owner>/<repo> [--path <dir>] [--ref <ref>]`: shallow-clone any readable repo, locate `.bffless/workflow.json` (at `--path` if given, else search), copy the package, run the identity pass. Default `--from bffless/workflow-implementations --path workflows/hello`. The identity file is the discovery contract — exactly what M4 shipped it for.
4. **⚑ CONFIRMED — the dogfood third implementation.** A deliberate **copy** of workflow-studio into `bffless/bffless` (local `~/bffless/repos/bffless.app`), created by `workflow init` from `workflow-implementations --path workflows/workflow-studio`; it publishes into a **new catalog install of the Workflow harness on bffless.dev** (project `bffless/bffless.app`; `workflow.bffless.dev` 404s today — the install is part of the phase), while the original workflow-studio continues as the dev env on j5s. Copies diverge from here by design (same stance as M4 Decision 3 — the vendor-frozen libs travel with the copy).
5. **⚑ CONFIRMED — the `bffless:workflow` skill is in scope** (Phase 5), written after the CLI exists so it teaches real verbs; ships from `bffless/skills` (no manifest edit needed — `plugin.json` globs `./skills/`).
6. **The rename engine is a boundary-aware alias rewrite plus structural moves, validated rather than enumerated.** The identity surface is real but long-tailed (hello's inventory: identity file, rule-set **directory name**, `ruleset.yaml` `name:`/description, `$schema:<alias>_*` schema names + their `schemaId:` refs, `package.json` name + `rules:validate` path, `scripts/build.mjs` `--impl` default + strings, vite plugin name, README prose). Enumerated rewrites can't keep up with arbitrary `--from` sources, so the engine does: (a) structural: rename `.bffless/proxy-rules/<old>/` → `<new>/`, rewrite `.bffless/workflow.json`; (b) textual: replace the old alias in text files only at word boundaries (`(?<![a-z0-9-])old(?![a-z0-9-])`? no — boundary = not `[a-z0-9]`, hyphen **is** part of alias tokens, so `hello` must not match inside `hello-pr-1`… it must: `hello-pr-1` derives from the alias. Rule: replace `old` when not preceded/followed by `[a-z0-9]` — hyphen-adjacent occurrences ARE replaced); schema names get the same pass (`hello_jobs` → `<new>_jobs` via the `_`-prefixed form). (c) validation gate: `check-identity` logic + `workflow lint` + `bffless rules validate` must pass on the result, and `init --dry-run` prints the full rewrite diff. Misses become lint failures, not silent drift.
7. **Both packages keep a `workflow` bin; the CLI's wins by usage.** `workflow-lint`'s `bin: workflow` cannot be dropped (a breaking change under `publish-workflow`'s `^1.0.0` npx pin). `workflow-cli` claims the same bin name — correct end state for `npx @bffless/workflow`. Inside the apps workspace nothing invokes the bare bin today (the studio stager moved out in M4), so the pnpm bin-name collision is theoretical; the root `package.json` gets a `workflow:cli` script pinned to the CLI package to make invocation explicit. The action's migration to the CLI's `index` is action-v2 territory (deferred).
8. **`publish` drives CE primitives, not the composite actions.** index via `buildIndex` (library) → prepare/forwarder as a ported, unit-tested module in workflow-cli (behavior pinned against `publish-workflow`'s `prepare-rules.test.mjs` fixtures: same `RESERVED_ALIASES`, `ALIAS_RE`, forwarder shape, `assertDisjoint`) → rules sync by spawning `npx --yes bffless@<pinned> rules push --path-prefix /api/<alias> --project <repo>` (downward platform dependency — permitted; the ruling forbids the reverse) → upload via `@bffless/artifact-client` (multipart zip deploy, alias + `proxy-rule-set-names`) → attach via ported `attach.mjs` logic. Credentials: `BFFLESS_API_KEY` env + `--api-url`. No teardown verb (previews are CI's concern; the action keeps it).
9. **The dogfood copy's alias is `studio`** (planner call — surface in review): not reserved, distinct from j5s's `workflow-studio` so the rename pass is genuinely exercised end-to-end, short enough to read well at `/api/studio/…` and `/w/studio/…` on bffless.dev.
10. **`init` generates the host repo's deploy/preview workflows** from templates mirroring `workflow-implementations`' `deploy-hello.yml`/`preview-hello.yml` (inputs filled from the identity file + flags: `repository` = the target BFFless project, `harness-alias`, paths under the chosen package dir), written to `.github/workflows/{deploy,preview}-<alias>.yml` if absent, and prints the remaining manual steps (secrets/vars, harness project role) — the issue's "print the manual steps" sketch, made concrete.
11. **`add <name>`** scaffolds `.bffless/workflows/<name>.yaml` (one job, one pipeline step) plus `rules/<path>/post/{rule.yaml,<segment>.fn.js,<segment>.fn.test.yaml}` per `--step <path>` so `rule-missing` is green from the first lint — the stub shapes copied from hello's `slow` rule (the smallest real precedent).

## Deferred out of this plan, explicitly

- `publish-workflow` action v2 (wrapping `npx @bffless/workflow publish`, reading `.bffless/workflow.json` to drop the `alias` input) → new issue on `bffless/publish-workflow` after the CLI ships.
- A `teardown` verb → stays action-only (preview lifecycle is CI's).
- Migrating `workflow-implementations`' publishing off j5s → the standing memory item, untouched here (the dogfood targets bffless.dev from `bffless/bffless`, which is a *different* repo and project).
- Removing `workflow-lint`'s bin → only ever as part of action v2's major.
- The stale `bffless workflows lint` sentence in `packages/workflow-lint/README.md:7-8` → fixed in passing by Phase 1 (one line, not deferred, listed here so it isn't lost).

## Global Constraints

- **Repos in play:** `bffless/apps` (worktrees per phase: `git worktree add .claude/worktrees/wf-cli-<phase> -b <branch> origin/main`; shared checkout read-only) · `bffless/bffless` at `~/bffless/repos/bffless.app` (dogfood host; its BFFless **project is `bffless/bffless.app`** on `admin.bffless.dev` — the repo≠project pin its `build.yml:62-66` documents is load-bearing for every generated workflow) · `bffless/workflow-implementations` (read-only source of the copy) · `bffless/skills` (Phase 5).
- **PR titles are release commits:** `feat(workflow-cli): the @bffless/workflow CLI — identity engine, init, rename, add` · `feat(workflow-cli): publish drives index → rules push → upload → attach` · (bffless/bffless) `feat: studio implementation — workflow init from workflow-implementations` · (bffless/skills) `feat: bffless:workflow — authoring workflow implementations`.
- **npm release train:** a new `packages/*` component costs exactly four mechanical edits — `release-please-config.json` block, `.release-please-manifest.json` seed (`"packages/workflow-cli": "0.0.0"`), the env+jq lines in `release.yml` (`:85-87`/`:103-105` — a forgotten line is a silently unpublished package; the empty-ref check is the fence), and `publish-workflow-lint.yml`'s `options:`/`case` lists. The publish job's bin-exists gate will verify `dist/cli.js` ships.
- **Identity rules are the published constants:** alias `^[a-z][a-z0-9-]*$`, reserved `workflow`/`w`/`auth`/`_bffless` — imported/ported from `prepare-rules.mjs`, never re-typed.
- **Live surfaces:** nothing in `bffless/apps` deploys from this plan's PRs (packages only — npm publishes on release-please merge). The dogfood phase writes live state on **bffless.dev** (harness catalog install = admin action; the `studio` alias + rule set on merge of the bffless/bffless PR) and none on j5s.
- Commit after every task; touched package's `lint` + `test:run` before each commit; `pnpm apps:check` before each apps PR.

## File structure

```
bffless/apps
  packages/workflow-cli/
    package.json                  @bffless/workflow, bin: workflow → dist/cli.js   (Task 1)
    tsconfig.json, eslint.config.js                                               (Task 1)
    src/cli.ts                    verb router; lint/index delegate to workflow-lint (Task 1)
    src/identity.ts               read/write .bffless/workflow.json; ALIAS_RE; RESERVED (Task 2)
    src/rewrite.ts                boundary-aware alias pass + structural renames + dry-run diff (Task 2)
    src/verbs/rename.ts           in-place identity pass                          (Task 3)
    src/verbs/init.ts             clone --from/--path/--ref, copy, rename, gen workflows, manual steps (Task 4)
    src/verbs/add.ts              workflow + rule stubs                           (Task 5)
    src/verbs/publish.ts          index → prepare → rules push → upload → attach  (Task 6)
    src/prepare.ts                ported prepare-rules (forwarder, alias-named set) (Task 6)
    src/templates/                deploy/preview yml templates, workflow/rule stubs (Tasks 4-5)
    test/*.test.ts                per-verb; rewrite engine against a hello fixture tree (Tasks 2-6)
  release-please-config.json / .release-please-manifest.json / release.yml /
    publish-workflow-lint.yml     the four mechanical edits                       (Task 1)
  packages/workflow-lint/README.md:7-8   stale CE-CLI sentence fixed              (Task 1)
  apps/workflow/docs/writing-an-implementation.md   CLI becomes the primary path  (Task 7)
bffless/bffless (bffless.app repo)                                               (Phase 4)
  .bffless/workflows/*, .bffless/proxy-rules/studio/, .bffless/workflow.json     (init output)
  .github/workflows/{deploy,preview}-studio.yml                                   (generated)
bffless/skills
  plugins/bffless/skills/workflow/SKILL.md                                        (Phase 5)
```

## Traceability — #420 scope → tasks

| #420 item | Tasks |
|---|---|
| `.bffless/workflow.json` identity anchor (exists since M4) → tooling operates on it | 2–4 |
| `workflow rename` | 3 |
| `workflow init [--from]` incl. manual-steps print + generated deploy ymls | 4 |
| `workflow add` with rule stubs (`rule-missing` green) | 5 |
| npx ergonomics / `@bffless/workflow` (direction ruling) | 1, 6 |
| Gate: field notes from a real third implementation | 8–10 (friction log → #420) |
| `bffless:workflow` skill | 11 |
| Template-repo flip | superseded by Decision 3 (portable `--from`), recorded in Task 12's issue close |

---

# Phase 1 — the package and the identity engine (Tasks 1–3)

*Deliverable: `@bffless/workflow` exists on the release train; `workflow rename` works and is fixture-proven. Branch `feat/wf-cli-core`, worktree `.claude/worktrees/wf-cli-core`.*

### Task 1: Scaffold `packages/workflow-cli` + release plumbing

**Files:** Create `packages/workflow-cli/{package.json,tsconfig.json,eslint.config.js,src/cli.ts,src/index.ts,test/cli.test.ts,README.md}`; modify `release-please-config.json`, `.release-please-manifest.json`, `.github/workflows/release.yml` (env `WORKFLOW_CLI_TAG` + jq entry), `.github/workflows/publish-workflow-lint.yml` (`options:` + `case`), root `package.json` (`workflow-cli:*` scripts + `workflow:cli`), `packages/workflow-lint/README.md:7-8` (drop the retired CE-CLI sentence, cite the #420 ruling).

**Interfaces:** Produces `@bffless/workflow` `0.0.0`, `bin: { workflow: "dist/cli.js" }`, deps `@bffless/workflow-lint: ^1.4.0` + `yaml`; `src/cli.ts` routes `lint`/`index` straight into workflow-lint's exported `lintFile`/`buildIndex` arg-compatibly (same flags, same exit codes 0/1/2 — the lint CLI's contract), `--version`, usage banner naming all six verbs (unbuilt ones exit 2 "not implemented" until their task).

- [ ] **Step 1:** failing test: `cli.test.ts` spawns the built CLI — `workflow --version` prints the package version; `workflow lint <fixture>` mirrors workflow-lint's exit code on a knowingly-bad fixture; `workflow nope` exits 2.
- [ ] **Step 2–4:** implement, `pnpm --filter @bffless/workflow-cli lint && build && test:run` green; `node --test scripts/workflow-invariants.test.mjs` and `pnpm apps:check` green (packages need no catalog assets).
- [ ] **Step 5:** commit `feat(workflow-cli): scaffold @bffless/workflow — lint/index delegation and release plumbing`.

### Task 2: identity + rewrite engine

**Files:** Create `src/identity.ts`, `src/rewrite.ts`, `test/rewrite.test.ts`, `test/fixtures/hello-tree/**` (a trimmed copy of `workflow-implementations` `workflows/hello` — identity file, rule set with `hello_jobs` schema + `$schema:` refs, package.json, build.mjs excerpt, README excerpt).

**Interfaces:** `readIdentity(dir): { alias, harness }` / `writeIdentity(dir, id)`; `ALIAS_RE`, `RESERVED_ALIASES` (values byte-equal to `publish-workflow/scripts/prepare-rules.mjs`); `renamePass(dir, oldAlias, newAlias, { dryRun }): { renames: [from,to][], edits: { file, count }[] }` implementing Decision 6 — structural renames (rule-set dir; any `<old>.workflow.yaml` stays untouched: workflow filenames are not identity), boundary rule "replace `old` where not adjacent to `[a-z0-9]`" (hyphenated derivatives like `hello-pr-1` DO rewrite), `_`-joined schema tokens (`hello_jobs` → `<new>_jobs`), binary/vendor/node_modules skipped.

- [ ] **Step 1:** failing tests: renaming the hello fixture `hello`→`studio` renames the rule-set dir, rewrites every row of the Decision-6 inventory present in the fixture, does **not** touch `othello`/`shellhello` planted decoys, rewrites `hello-pr-1` and `hello_jobs`, and `dryRun` returns the same report with zero writes; renaming to `w` or `Hello!` throws citing the constants.
- [ ] **Steps 2–5:** implement; green; commit `feat(workflow-cli): identity file + boundary-aware rename engine`.

### Task 3: `workflow rename <old> <new>`

**Files:** Create `src/verbs/rename.ts`, `test/rename.test.ts`; modify `src/cli.ts`.

- [ ] **Step 1:** failing test: on a temp copy of the fixture tree, `workflow rename hello studio` rewrites identity + tree, then a ported `check-identity` assertion (alias ↔ identity file) and `workflow lint` on the tree both pass; `--dry-run` prints the diff report and writes nothing; mismatched `<old>` (identity file says otherwise) exits 2 with the actual alias named.
- [ ] **Steps 2–5:** implement; green; commit. **Phase gate before the PR:** full chain `pnpm workflow-cli:lint && pnpm workflow-cli:build && pnpm workflow-cli:test && pnpm apps:check`; PR `feat(workflow-cli): the @bffless/workflow CLI — identity engine, init, rename, add` opens after Task 5 (one phase PR).

# Phase 2 — init and add (Tasks 4–5, same branch/PR as Phase 1)

### Task 4: `workflow init <alias> --from <owner>/<repo> [--path <dir>] [--ref <ref>]`

**Files:** Create `src/verbs/init.ts`, `src/templates/{deploy.yml.tmpl,preview.yml.tmpl}`, `test/init.test.ts`.

**Interfaces:** clone `https://github.com/<owner>/<repo>` shallow at `--ref` (default default-branch) into a temp dir (`git` spawned; a local path in `--from` is accepted for tests/offline); locate `.bffless/workflow.json` under `--path` (else error listing candidates found by glob); copy the package dir into `<dest>/` (default `./<alias>`, `--dest .` for repo-root implementations like bffless.app's); run `renamePass(old→new)`; write generated `.github/workflows/{deploy,preview}-<alias>.yml` **only when the destination repo root differs from the package source layout's** — filled from flags `--project <owner/name>` (the BFFless project; REQUIRED for generation, echoing bffless.app's repo≠project lesson), `--harness-alias` (default `workflow`), paths relative to the repo root; print the manual-steps block (create/choose the GitHub repo, `BFFLESS_API_KEY` secret + `BFFLESS_URL` var, contributor role on the harness project, "install the Workflow harness from the catalog if the instance lacks one").
- [ ] **Step 1:** failing tests (local-path `--from` against the fixture repo layout): init `studio --from <tmp-repo> --path workflows/hello --dest impl --project acme/site` produces a tree whose identity file reads `studio`, whose rule set dir is `.bffless/proxy-rules/studio`, whose generated `deploy-studio.yml` carries `alias: studio`, `repository: acme/site`, paths under `impl/`; `--dry-run` prints and writes nothing; missing `--project` with workflow generation requested exits 2.
- [ ] **Steps 2–5:** implement; green; commit `feat(workflow-cli): init — portable --from any repo via the identity file`.

### Task 5: `workflow add <name> [--step <path>]…`

**Files:** Create `src/verbs/add.ts`, `src/templates/{workflow.yaml.tmpl,rule.yaml.tmpl,fn.js.tmpl,fn.test.yaml.tmpl}`, `test/add.test.ts`.

- [ ] **Step 1:** failing test: in the fixture tree, `workflow add summarize --step summarize` writes `.bffless/workflows/summarize.yaml` (one job, one pipeline step with `path: summarize`) and `rules/summarize/post/{rule.yaml,summarize.fn.js,summarize.fn.test.yaml}` shaped after hello's `slow` rule; `workflow lint` on the tree then reports **zero** `rule-missing` findings; an existing workflow name exits 2.
- [ ] **Steps 2–5:** implement; green; commit; open the phase PR (title from Global Constraints); after merge, release-please cuts `workflow-cli-v0.1.0` and the npm train publishes it — verify `npx @bffless/workflow@latest --version` before Phase 4.

# Phase 3 — publish (Task 6)

*Branch `feat/wf-cli-publish`, worktree `.claude/worktrees/wf-cli-publish`.*

### Task 6: `workflow publish`

**Files:** Create `src/verbs/publish.ts`, `src/prepare.ts`, `test/{prepare,publish}.test.ts`; modify `src/cli.ts`, `package.json` (add `@bffless/artifact-client`).

**Interfaces:** flags `--api-url` (or `BFFLESS_API_URL`), `--project <owner/name>`, `--alias` (default: identity file), `--harness-alias` (default `workflow`), `--path dist`, `--workflows`, `--rules`, `--dry-run`; key from `BFFLESS_API_KEY` only. Sequence per Decision 8; `src/prepare.ts` ports `prepare-rules.mjs` (alias-named copy under a temp dir + generated `/w/<alias>/*` forwarder with `forwardCookies: true, order: 5`; `assertDisjoint`; behavior pinned by porting the cases from `publish-workflow/test/prepare-rules.test.mjs` into `test/prepare.test.ts` — byte-compatible forwarder yaml).
- [ ] **Step 1:** failing tests: prepare produces the forwarder + renamed set on the hello fixture identical (yaml-normalized) to the action's fixture expectation; `publish --dry-run` prints the four moves with resolved values and performs none; missing key exits 2 before any network.
- [ ] **Steps 2–4:** implement (rules sync spawns `npx --yes bffless@0.3.3 rules push …` — same pin the packages already use; upload via `@bffless/artifact-client`'s zip deploy with `proxyRuleSetNames: [alias]`; attach ports `attach.mjs`'s union-PATCH); green.
- [ ] **Step 5:** commit + PR `feat(workflow-cli): publish drives index → rules push → upload → attach`. Live-prove **on j5s** (the dev env, cheap and reversible): `workflow publish` a throwaway alias `cli-smoke` into `bffless/workflow`, confirm `/w/cli-smoke/` serves and the harness lists it, then delete the alias + rule set (MCP), and record the proof in the PR body.

# Phase 4 — the dogfood: studio on bffless.dev (Tasks 7–10)

*The gate-satisfying phase. Every friction moment goes in a running log posted to #420.*

### Task 7: docs first

- [ ] `apps/workflow/docs/writing-an-implementation.md`: the CLI becomes the primary path (init/add/rename/publish with real invocations); hand-authoring demoted to the appendix; PR `docs(workflow): the CLI is the authoring path` (can ride the Phase 3 PR).

### Task 8: create the implementation in `bffless/bffless`

- [ ] In `~/bffless/repos/bffless.app` (fresh branch `feat/studio-workflow-implementation`): run `npx @bffless/workflow init studio --from bffless/workflow-implementations --path workflows/workflow-studio --dest . --project bffless/bffless.app --harness-alias workflow` (Decision 9: alias `studio`). Expect friction — the studio package's vendor tree, per-package scripts, and the SPA-repo destination are exactly the hard case; log everything. Wire what the tool can't (root scripts if any; CI paths filters), commit, PR to `bffless/bffless` — **maintainer merges** (their repo, their landing site's CI).

### Task 9: the harness install + instance readiness on bffless.dev (maintainer + agent)

- [ ] Maintainer: Admin → Apps on admin.bffless.dev → install **Workflow** (registry has v1.1.0) into project `bffless/bffless.app`; set the repo's `BFFLESS_API_KEY`-equivalent secret if the generated workflows need a separate key. Agent verifies the install gates (shell 200, `GET /api/workflow/project` → `{"repository":"bffless/bffless.app"}`).
- [ ] Instance readiness for a *studio* implementation, verified not assumed (install-app skill discipline): AI provider tokens (Anthropic, Gemini, Replicate) on the project, server video ops enabled + executor ready (`ffmpeg probe`), storage presigning. Each missing one is a maintainer admin-panel step — list them, don't guess.

### Task 10: publish, run, and the friction log

- [ ] Merge the bffless/bffless PR → `deploy-studio.yml` publishes alias `studio` into `bffless/bffless.app`; the harness at its bffless.dev install lists **Studio**; kick one interactive run end-to-end (maintainer or a walk with `--harness <install-url>` if credentials exist there). 
- [ ] Post the complete friction log as a comment on #420, tick its field-notes checklist rows (init ✔ / add — exercised in Task 5's fixtures + any real use / fork ✔ = this copy), and re-read the issue against the notes (the issue's own final row).

# Phase 5 — the skill (Task 11) and close-out (Task 12)

### Task 11: `bffless:workflow` skill

- [ ] `bffless/skills` branch: `plugins/bffless/skills/workflow/SKILL.md` — frontmatter per house pattern (`name: workflow`, one-line description covering authoring implementations with @bffless/workflow + publish-workflow + the YAML↔rule contract); body: when to use, the identity file, the six verbs with real invocations, the YAML↔rule naming link (`rule-missing`), publish vs the CI action, links to writing-an-implementation + spec 06. Scope: authoring **and** enough run/debug to be useful (the issue's open question — resolved as: authoring-first, with a short "reading a run" section pointing at the harness). No manifest edit needed. PR; release-please bumps the plugin.
- [ ] Verify per that repo's checks; PR title from Global Constraints.

### Task 12: close #420

- [ ] Comment: what shipped (verbs, package, skill), the friction log link, the template-repo idea retired by portable `--from` (Decision 3), action-v2 follow-up issue filed on `bffless/publish-workflow`. Close the issue. Update the M4 plan's Deferred line and `00-overview`'s follow-up list (authoring tooling → done).

## Self-review (writing-plans checklist, applied)

- **Spec coverage:** every #420 body item traced (table above); its four open questions each land in a Decision (2, 3, 8, 11) ; the gate handled by Decision 1 + Phase 4; the 2026-08-31 ruling enforced by Decisions 2/8. The user's three answers (gate/package/portable-from) and skill inclusion are the ⚑ items.
- **Placeholder scan:** the deliberately open values are Phase-4 instance-readiness findings (a verification procedure, not TBDs) and the friction log (the phase's product). Verb flags, template inputs, fixture assertions, and the four release-plumbing edits are concrete.
- **Type consistency:** `renamePass` report shape identical in Tasks 2/3/4; `ALIAS_RE`/`RESERVED_ALIASES` single-sourced (Task 2) and referenced in 4/6; exit-code contract (0/1/2) uniform with workflow-lint's.

## Execution handoff

Plan complete. **1. Subagent-Driven (recommended)** — fresh subagent per task, review between (superpowers:subagent-driven-development). **2. Inline** (superpowers:executing-plans). Maintainer-gated moments to expect: merging each PR; the bffless/bffless PR (Task 8); the catalog install + instance tokens on bffless.dev (Task 9); the Phase-3 live smoke's alias cleanup approval.
