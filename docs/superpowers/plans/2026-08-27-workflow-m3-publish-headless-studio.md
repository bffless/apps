# Workflow M3 — Publish, Headless and the Studio Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the Workflow harness from "one implementation, hand-wired, driven by a person" (M2) to the M3 bar: a **publish toolchain** (`bffless rules … --path-prefix` + the `bffless/publish-workflow` composite action) that lets an implementation live in its own repo with relative rule paths; **hello extracted** to `bffless/workflow-hello` as that toolchain's first customer; the harness made **headless-capable** (`?auto=1&inputs=`, `window.__workflow`, `headless: skip|auto` at run time, island/form clocks, a Playwright driver CLI) and **hardened** (script Workers in an opaque-origin sandbox, media for islands via signed URLs); and the **Studio port** — `apps/workflow-studio`, the reference implementation that proves Studio's pipelines are reusable by a generic harness (path-in/path-out pipelines, a cut-editor island, blog-bundle scripts, two new CE `ffmpeg_handler` ops for frames) — run end to end on j5s, headless and by hand.

**Architecture:** Five phases, each its own PR set, in dependency order. Phase 1 changes three repos outside the monorepo (CE's CLI, `deploy-proxy-rules`, a new `publish-workflow` action) and publishes `@bffless/workflow-lint` so a separate implementation repo can lint and index. Phase 2 moves hello out (`bffless/workflow-hello`) and turns the monorepo's hello into a pinned checkout the harness's mock-backed e2e builds from. Phase 3 is harness-only: the script Worker moves inside a `sandbox="allow-scripts"` iframe (a `data:`-URL module Worker there has origin `null` — spiked in Chromium and Firefox 2026-08-27), islands get a clock and a `workflow.sign` host tool, and the headless page contract lands with `packages/workflow-headless` driving it. Phase 4 is the port: CE gains one `frames` op with optional `draw`/`tile` (a Worker script cannot touch `<video>`), and `apps/workflow-studio` re-authors Studio's rules as `auth_required`, prefix-free, `outPrefix`-taking pipelines, reusing Studio's pure libs through a workspace dependency. Phase 5 walks it all live. The engine (`src/lib/runner/**`) stays pure; the only new persisted vocabulary is `outputs` on `step.skipped`.

**Tech Stack:** Everything M2 pinned (TypeScript ~6.0.2, React ^19.2, RTK ^2.12, `@modelcontextprotocol/ext-apps ^1.7.5`, MSW ^2, vitest ^4, Playwright 1.61.1, eslint ^10, pnpm 10 / Node ≥20). New: `@bffless/workflow-lint` and `@bffless/workflow-script` **published** to npm (release-please components `workflow-lint` / `workflow-script`); `bffless` CLI **0.4.0** (`--path-prefix`; shipped as **0.3.3**); `@bffless/deploy-proxy-rules` **1.3.0** (`path-prefix` input, `bffless ^0.3.3` re-frozen into `dist/`); new composite action `bffless/publish-workflow@v1` (bash + two Node scripts, no ncc); new package `packages/workflow-headless` (Playwright + Chromium from `~/.cache/ms-playwright`, bin `workflow-headless`); `apps/workflow-studio` (Vite single-file islands with React + `studio` workspace dep, Vite lib-mode scripts, `fflate`); CE backend `ffmpeg_handler` op `frames` (ffmpeg `-ss` fast-seek stills + optional `drawtext` overlay + optional `tile`).

**Spec:** `apps/workflow/docs/spec/` — 00-overview.md (M3 bullet, D1/D2/D11/D12/D15/D17), 01-workflow-yaml.md (`timeout-minutes`, `headless:`, Paths), 03-step-kinds.md (`script` — **amended by Decision 4**, `island`), 04-islands.md (Headless — **amended by Decision 7**; Sandbox), 05-runs-and-persistence.md (rows, Resume), 06-discovery-publishing-files.md (Implementation CI obligations — **amended by Decisions 3/5/6**, files trio + `sign`), 07-headless.md (page contract, driver — **amended by Decisions 10–13**), 08-harness-ui.md (Kickoff route), 09-state-management.md ("from M3 the headless CLI *is* the e2e"), ADR-0001/0002/0004, `workflow.schema.json` (`headless` = `skip|auto` — unchanged), `examples/hello.workflow.yaml` + `examples/interactive.workflow.yaml` (now mirrors of `bffless/workflow-hello`, drift-tested), `examples/studio.workflow.yaml` (**replaced** by `apps/workflow-studio/.bffless/workflows/studio.workflow.yaml`). Prior plans: M1 `docs/superpowers/plans/2026-08-19-workflow-m1-harness-core.md` (Decisions 2 and 3 are paid down here), M2 `docs/superpowers/plans/2026-08-24-workflow-m2-interactive-steps.md` (its "Deferred out of M2" list is this plan's input). Live state: `apps/workflow/bffless/README.md`. Epic: bffless/apps#359 (M3 block). Related issues folded in: apps#382 (its "M3 item" is superseded, see Decision 19), apps#362/ce#697 (`?download=1` — the driver GETs the url, Decision 12), ce#700 (header rules stay manual, recorded per new install). Not in scope: apps#363/#364 + ce#698 (M4), preview teardown (Decision 3, new issue), COOP/COEP (Decision 4).

## Decisions this plan makes (spec-ambiguous points, resolved here)

Locked D1–D18, the M1 decisions and the M2 decisions are not re-litigated. The nine ⚑ items **were confirmed by the user on 2026-08-27** (answers recorded inline); two of them carry a planner adjustment discovered while writing (marked **adjusted**) — surface them in this plan's PR review. The rest are reversible planner calls.

1. **⚑ CONFIRMED — `workflow-studio` lives in the monorepo as `apps/workflow-studio`.** Not a separate repo (D15 is proven by hello, Decision 5); not inside `apps/studio` (Studio "keeps existing", 00). Its islands and scripts import Studio's **pure** libs through a workspace dependency (`"studio": "workspace:*"` + an `exports` map added to `apps/studio/package.json` for `./lib/*` and `./components/Studio/CutEditor` — all of which import nothing from Studio's store, router or hooks; verified 2026-08-27). Its 14 rules are **re-authored**, not copied: Studio's rules have `validators: []`, hard-code `projects/<id>/…` output paths and take `/api/uploads/` serve URLs; the port's take `outPrefix` + uploads-relative `path`s and carry `auth_required { allowApiKey: true }` (06 Access). The system prompts (`prep.fn.js` text) are copied verbatim — they are the product.
2. **⚑ CONFIRMED, then REWORKED 2026-08-29 — CE gains ONE new `ffmpeg_handler` op, `frames`, with optional `draw` and `tile` blocks.** Spec 03/06 assumed `scripts/contact-sheet.js`; a Worker has no `<video>`/canvas, so *frame capture* had to move server-side. The original decision went further and added a second op, `contact_sheet`, that baked Studio's sampling policy (5–30 s interval, 3 columns, 9–12 cells, ≤10 sheets) into CE as defaults. **The user rejected that after reviewing ce#706:** *"we should be abstract and give the server the ability to draw, not the ability to draw a contact sheet… build something we can re-use, not a contact sheet factory."* The line now drawn: **a curated op encodes a format contract or a mechanism, never a tuning policy about "how much".** `extract_audio`'s 16 kHz mono is a format contract (Whisper's input spec, one right answer); `MAX_SHEETS = 10` and `PREFERRED_CELLS_PER_SHEET = 9` were tuned to one model's ~1 MP vision budget, and CE releases on a different cadence than model capabilities do. As shipped: `frames` takes `input`, `times` (the CALLER computes them), `outputPrefix`, `height`, `quality`, plus optional `draw` (one text overlay: `text` / `position` enum / `size` / `color` / `background`) and `tile` (`perSheet` / `columns`). No `tile` → `frames[]`; with `tile` → `sheets[]`, cells staying scratch-only. A contact sheet is `draw` + `tile`; a title on a screenshot is one time, a `draw`, and no `tile`. `planContactSheet`, its six constants and `clockLabel` are **not in CE** — they live in the consuming app, which the plan already anticipated (`scripts/frame-times.ts`, Task 22). `drawtext` needs an ffmpeg built with libfreetype (CE's images are Alpine and have it; do not say "Debian"), and the op degrades to un-drawn stills with `drawn: false` rather than failing.
3. **⚑ CONFIRMED (adjusted) — `publish-workflow` = CLI `--path-prefix` + a new composite action `bffless/publish-workflow`.** `--path-prefix <prefix>` on `bffless rules build|push|diff` prepends a literal prefix (`/api/<alias>`) to every **derived** `pathPattern` (`rules/echo/post/` → `/api/hello/echo`); an implementation authors `rules/echo/post/`, `rules/job/get/` — no `api`, no alias. *Adjustment:* a rule with an explicit `pathPattern:` is **exempt** (verbatim) — the escape hatch already means "exactly this pattern", and it is how the generated `/w/<alias>/*` forwarder rides inside the same set (the action writes it as `rules/_custom/forward/get.rule.yaml` with an explicit `pathPattern`). Pipeline default names stay prefix-free (`echo POST`). The action runs, in order: `workflow index` (lint + `index.json`) → `deploy-proxy-rules@v1` with `path-prefix` on a temp copy of the set renamed to `<alias>` + the forwarder → `upload-artifact@v1` (`proxy-rule-set-names: <alias>`) → attach to the harness alias by `PUT /api/aliases/<repo>/<harness-alias>` with the union of `proxyRuleSetIds` (the only attach API; `upload-artifact` only attaches to the alias it deploys). Chain of releases: `bffless@0.4.0` → `deploy-proxy-rules@1.3.0` (re-freeze `dist/`) → `publish-workflow@v1.0.0`. **Preview teardown** (06 step 5) is deferred to a new issue — nothing in M3 opens PR previews of an implementation.
4. **⚑ CONFIRMED (adjusted) — Script Workers get an opaque origin: a `data:`-URL module Worker spawned from inside a hidden `sandbox="allow-scripts"` srcdoc iframe.** *Adjustment:* the confirmed mechanism was "a `data:` URL Worker"; spiked 2026-08-27 (`localdev-tools/workflow-sandbox-worker-spike.mjs`): a bare `data:` Worker is opaque in **Firefox** (`self.origin === 'null'`) but **inherits the creator's origin in Chromium** (a same-origin fetch returned 200). What holds in both: the creator must itself be opaque — inside a sandboxed iframe, `new Worker(dataUrl, { type: 'module' })` + `import(dataUrl)` gives origin `null`, a relative `fetch` throws, an absolute `fetch` with or without credentials is refused. (`blob:` module Workers fail there in Chromium with a muted error; classic Workers work but cannot `import()`.) The page and the Worker talk over a **`MessageChannel` port** handed through the iframe, so the relay stays one hop. No COOP/COEP in M3 (nothing needs threads — the Studio port uses server ffmpeg); spec 03's open item closes.
5. **⚑ CONFIRMED — hello has one source: `bffless/workflow-hello`.** `apps/workflow/hello/**`, `.bffless/proxy-rules/hello/**` and the deploy steps leave the monorepo; the harness's `pnpm stage` clones the repo at a pinned ref (`WORKFLOW_HELLO_REF` in `apps/workflow/hello.ref`) and builds its `dist/` into `hello-dist/` for the mock-backed e2e. Spec examples `hello.workflow.yaml` / `interactive.workflow.yaml` stay as documentation, byte-equal to the pinned checkout by a drift test. The MSW handlers for `/api/hello/*` stay (they are the mock backend). Hello's domain path changes once to `/` (its bundle is now uploaded from `dist/`, base-path `/`).
6. **⚑ CONFIRMED — Islands get media through signed URLs: host tool `workflow.sign` + rule `POST /api/workflow/files/sign`.** A sandboxed iframe has an opaque origin, so `<video src="/api/uploads/…">` sends no cookie and 401s. `workflow.sign { path }` → the rule confines `path` to `workflows/` (the harness prefix), resolves `<owner>/<repo>/uploads/<path>` and mints a CE `signed_url` (1 h, Range-capable on bucket storage — S3/GCS presigned GETs honour `Range`; the local-FS adapter cannot presign and answers 501, recorded). Islands ask for a signed URL per media ref on mount; hello's `line-viewer` proves it with an image. 04's mapping table and 06's files trio gain the row.
7. **⚑ CONFIRMED — The headless channel is `hostContext.bffless.headless`.** Verified 2026-08-27: ext-apps 1.7.5's `McpUiHostContextSchema` and its `ui/initialize` result are `.passthrough()`, so an unknown `bffless` key survives to `app.getHostContext()` (unlike `_meta` on `tool-input`, which the View strips). The host sets `hostContext.bffless = { headless: run.headless }` before `bridge.connect`; the `_meta` stamp goes. Spec 04 Headless + 07 amended.
8. **⚑ CONFIRMED — One plan, five phases, in this order:** 1 publish toolchain → 2 hello extraction → 3 harness (3a sandbox/clocks/sign, 3b headless + driver) → 4 Studio port (CE ops first) → 5 live walk. One checkbox in epic #359 ≈ one session.
9. **⚑ CONFIRMED — The implementation is named `workflow-studio` everywhere** (alias, rule set, `/api/workflow-studio/*`, `/w/workflow-studio/*`, domain `workflow-studio.j5s.dev`), not `studio`: CE scopes aliases per repository so `studio` would not collide technically, but domains are global (`studio.j5s.dev` is the real Studio) and two `studio` aliases + two `studio` rule sets in the admin UI would mislead. 00's topology comment and 06's examples are amended.
10. **Island and form clocks.** `timeout-minutes` on an `island` or `form` step is honoured whenever declared, interactive or headless: the clock starts at `step.waiting` (the reducer records `startedAt` on `step.waiting` when the row has none — forms never emit `step.started`) and fires `step.failed { code: 'TIMEOUT' }` (interactive) or `HEADLESS_TIMEOUT` (headless `auto`, 07). Undeclared: no clock when interactive (a person is not on a budget — M2 stance kept); **5 minutes** when headless `auto` (04's default). Resume re-arms the remaining budget from the persisted `startedAt`; a budget already spent on resume fails the step at once. The timer lives in the launcher (`islandLaunch`/the form branch) through `deps.clock`, exactly as `scriptLaunch.ts:229-243` does.
11. **`headless:` at run time is the middleware's business, not the scheduler's.** `next.ts` stays as it is; `handleNextAction`'s `form`/`island` branches consult `runState.headless` and the step's `headless` (shared `headlessMode(step)` moves from `StepChip.tsx` to `src/lib/runner/headless.ts`). `skip` → `step.skipped` carrying `outputs` (evaluated `headless.outputs` through the step's contexts; a bare `skip` gives `{}`); the event and `StepState` gain an optional `outputs`, the row write includes it, replay carries it — the one vocabulary change. `auto` → the step runs as when interactive; a form auto-submits its `formInitialValues` through `completeFormStep` on the next macrotask after `step.waiting` (a rejected submit fails the step `HEADLESS_FORM` with the field errors as the message); an island mounts and is expected to submit. *(none)* → `step.started` + `step.failed { code: 'HEADLESS_REQUIRED', message: 'step <key> needs a person; declare headless:' }` plus a run annotation — never a hang.
12. **The page contract, made concrete.** `GET /<impl>/<workflow>/run?auto=1&inputs=<base64url(JSON)>`. The kickoff page decodes, validates like `KickoffForm.handleSubmit` (required, `validateValue`, `validateInputConstraints`), and on success dispatches `startRun({ …, headless: true })` without rendering the form; on failure it renders the errors under `data-testid="kickoff-invalid"` and sets `window.__workflow = { status: 'invalid', errors }` — `RunStatus` is untouched (`invalid` is a page state, not a row state). `file` inputs are **already-stored paths** (the driver uploads through the files trio first); `https://` inputs (07) are deferred — the driver does the download+upload, the page never fetches. `window.__workflow` is a module-level mirror of the run slice kept by one effect in `RunPage` (`{ runId, status, currentSteps, outputs, steps: { [key]: status } }`), present on every run page, not only headless ones — cheap and useful in devtools. Headless runs auto-select the oldest `running|waiting` island so its pane mounts (an island must be mounted to submit); with `max-parallel` islands they take turns.
13. **The driver is `packages/workflow-headless`, bin `workflow-headless`** (the lint package already owns bin `workflow`), commands `run` and `runs` per 07. Auth is a **member login through the admin relay** (`WORKFLOW_EMAIL`/`WORKFLOW_PASSWORD`, the `workflow-live.mjs` recipe) — 07's "inject `X-API-Key` on every request" is disproved by the harness's two `forwardCookies` relays (`/api/workflow/aliases`, `/w/<impl>/*` — the run page's own discovery goes through them), and an API key cannot mint a session. `--token` stays as an optional extra header for `/api/workflow/*` reads. This is also the deliberate direction (user, 2026-08-27): an unattended run acts **as a signed-in member**, the same identity an island's `tools/call` runs under and the one a future WebMCP agent on the harness page will have (04 Later) — a project key is a deploy credential, not a person. It is what 04's "every call goes through the harness under the user's session" already says. Exit codes: 0 succeeded · 1 failed/cancelled · 2 usage/auth · 3 invalid inputs · 4 driver timeout · 130 SIGINT (Cancel clicked first). Artifacts in `--out`: `run.json` (the `/api/workflow/run?id=` record), `outputs/<name>.<ext>` for `file` outputs (GET through the page's session — `?download=1` is not relied on, apps#362), `steps.log` (transitions with timestamps), `console.log`, `NN-*.png` milestones and a `failed.png`. A `workflow_dispatch` workflow in this repo (`workflow-headless-run.yml`) runs it against j5s; the `bffless/run-workflow` action wrapper (07) is a follow-up.
14. **Cancel semantics stay as M1/M2 (deferred again, dated).** The Studio port has no `if: cancelled()`/`always()` cleanup step (orphaned `workflow_studio_jobs` rows are harmless, storage is under `run.prefix` and goes with the run's deletion), so there is still nothing to decide against. Recorded in "Deferred out of M3" with the M4 pointer.
15. **No `resume:` hint (M1 Decision 3 closed).** Every Studio pipeline is enqueue-and-poll: a `running` row resumes as a re-enqueue (a duplicate job row, no duplicate side effect on the run's outputs since each run writes under its own `step.prefix`), a `polling` row resumes polling. 05's open question is answered "not needed" and the text is amended.
16. **Transcripts travel as small text, words as an in-page value.** A 1-hour WhisperX word list is ~0.5 MB; the edge caps pipeline bodies at 1 MB (06), so the workflow never POSTs `words` back to a pipeline. `transcribe` returns `{ words, text, timed }` where `timed` is Studio's `timedTranscript(words)` (8-second `[m:ss]` buckets, ~45 KB/hour) computed server-side in `flatten.fn.js`; `scenes` and `blog` take `timed` text, `refine-scene` takes one scene's `wordTimings` lines computed by a `script` step (`scripts/scene-inputs.js`, pure — words reach the Worker as `ctx.inputs`, in-page, no body cap). `words` itself is a step output (`render: transcript`), offloaded past 256 KB by M2's `{"$file"}` path automatically.
17. **Dead space is out of the M3 port.** Studio measures silence from the WAV in the browser (WebAudio, unavailable to a Worker). The refiner prompt and the cut editor both treat `deadSpace` as optional; the port passes none. A `silence` op (ffmpeg `silencedetect`) is filed as a CE follow-up.
18. **Scripts are built, not copied, in `workflow-studio`.** Hello's scripts are verbatim single files (06); the port's import Studio libs and `fflate`, so the stage runs Vite in library mode per script (`format: es`, one file, no code splitting) into `dist/scripts/<name>.js`. The Worker still receives one module text; the contract is unchanged.
19. **apps#382's "M3 item" is superseded.** Review round 7 (PR `feat/workflow-file-refs-through-forms`) made form-picked files record the ref; job/run-level `type: file` outputs fed by a path still resolve through `FileRefProvider`. Nothing further is built; the issue comment says so.
20. **Two harness PRs, not one.** 3a (`feat(workflow): sandboxed script Worker, interactive-step clocks and workflow.sign`) is engine/host work with no UI contract change; 3b (`feat(workflow): headless execution and the driver CLI`) is the contract. Each leaves `workflow.j5s.dev` runnable.
21. **`@bffless/workflow-lint` grows the publish half: `workflow index`.** The index/landing-page generator moves out of `stage-hello.mjs` into the package as a CLI verb (`workflow index <workflows-dir> --out <dist> --impl <alias> --name <display> [--description] [--rules <dir>] [--path-prefix <p>] [--alias]`): lints every YAML against the rule set (with the prefix the publisher will apply), copies them, lists `<dist>/islands/*.html` and `<dist>/scripts/*.js`, writes `index.json` + the one-line `index.html`. `rule-missing` learns `--path-prefix` (URL prefix ≠ on-disk layout). The package goes public on npm so a separate repo's CI can run it.

## Deferred out of M3, explicitly

- ~~Preview aliases of an implementation and their teardown (06 step 5) — new issue (Decision 3).~~ **Amended 2026-08-27: pulled into Phase 2 as Task 6b (apps#399)** — `workflow-hello` is the first repo with PR previews, so teardown is built and proven there.
- ~~`targetUrl: alias://` for the forwarder~~ — **Resolved 2026-08-28 without a CE change:** `publish-workflow` v1.2.0 targets the backend's alias route in-process (see the ADR-0001 amendment), so ce#698 is a nice-to-have, not a dependency.
- `run.impl` validation on the read-only page, runtime project self-discovery — M4 (apps#363/#364).
- Cancel-time semantics (`if: cancelled()`/`always()`) — M4, decided against the first implementation that has a cleanup step (Decision 14).
- COOP/COEP / threads in scripts; per-island CSP; double-iframe island proxy — 03/04 "Later" (Decision 4).
- `https://` values for `file` inputs in `?inputs=` (07) — the driver downloads and uploads instead (Decision 12).
- `bffless/run-workflow` GitHub Action wrapper around the driver (07) — follow-up.
- Dead space / `silence` ffmpeg op (Decision 17); `thumbnail/render` with `count > 1` in one call (the port draws two covers with a two-item matrix instead); voice pipelines (not part of the port).
- MSW mocks for `workflow-studio` — its proof is the live walk (Decision 22 below); mock-backed coverage is a follow-up.
- Response-header rules as code (ce#700) — each new install still adds the two `no-transform` rules by hand; the READMEs say so.

22. **`workflow-studio` has no mock backend in M3.** Its CI = lint (`workflow index` against the rule set), script unit tests (pure), island type-check + build, `bffless rules validate`. The end-to-end proof is Phase 5 on a 3-minute clip (spends real AI credits — dispatch-only, never on push).

## Global Constraints

- Monorepo: pnpm 10 workspace `bffless-apps`; Node `>=20`; ESM only; TypeScript `~6.0.2`. Other repos: `repos/ce` (CLI in `packages/cli`, pnpm 9 in its CI), `repos/deploy-proxy-rules` (CJS ncc bundle, `dist/` committed), new `bffless/publish-workflow`, new `bffless/workflow-hello`.
- **Shared checkouts are read-only.** Monorepo work in a worktree: `git worktree add .claude/worktrees/workflow-m3-<phase> -b <branch> origin/main` from `/home/rico/bffless/repos/apps`; CE work in `repos/ce/.claude/worktrees/…` likewise. Verify `git rev-parse --show-toplevel` before the first commit; hygiene-check `git -C <shared> status --short` before each PR.
- **PR titles are release commits** (squash + release-please): CE `feat(cli): --path-prefix for rules build, push and diff`; deploy-proxy-rules `feat: path-prefix input`; apps Phase 1 `feat(workflow-lint): publish the package, add the index verb and --path-prefix`; apps Phase 2 `refactor(workflow): hello lives in bffless/workflow-hello`; apps 3a/3b per Decision 20; CE Phase 4 `feat(pipelines): ffmpeg_handler frames op with draw and tile`; apps Phase 4 `feat(workflow-studio): the Studio port`. Push every commit before opening a PR; re-check merge state before follow-ups (the user merges fast).
- **A merge is a live deploy** (`deploy-workflow.yml` on `apps/workflow/**`; from Phase 2 `bffless/workflow-hello`'s `deploy.yml` on its `main`; from Phase 4 `deploy-workflow-studio.yml` on `apps/workflow-studio/**`). Every phase leaves `workflow.j5s.dev` runnable with hello.
- One parser (`@bffless/workflow-lint/expressions`), no `eval`, island HTML injected verbatim; `src/lib/runner/**` imports nothing from React/Redux/MSW/`src/islands`/`src/scripts`/`src/store`.
- Persisted step keys and statuses unchanged. **Vocabulary change:** `step.skipped` gains optional `outputs` (Decision 11). Reducer change: `step.waiting` sets `startedAt` when absent (Decision 10).
- Lease numbers unchanged (heartbeat 15 s, lease 60 s). Island init timeout 30 s (`ISLAND_LOAD`). Headless `auto` default budget **5 min** → `HEADLESS_TIMEOUT`; declared `timeout-minutes` → `TIMEOUT` (interactive) / `HEADLESS_TIMEOUT` (headless).
- Error codes added: `HEADLESS_TIMEOUT`, `HEADLESS_REQUIRED`, `HEADLESS_FORM`, `HEADLESS_SKIP` (a `headless.outputs` value that fails the declared map).
- All new `/api/workflow/*` and `/api/workflow-studio/*` rules carry `validators: [{ type: auth_required, config: { allowApiKey: true } }]`.
- UI contract (07): existing `data-testid`s unchanged. New: `kickoff-invalid`, `kickoff-auto` (the auto-start notice), `island-sign-error`. `window.__workflow` shape is a contract (Decision 12). Renaming any is a driver-breaking change.
- `pnpm apps:check` green after every task — `apps/workflow-studio/bffless/README.md` needs both required headings from its first commit.
- Commit after every task; before each commit run the touched package's `lint` + `test:run`; before each phase PR the phase's gate (listed in its last task).

## File structure

```
repos/ce/packages/cli/
  src/format/routes.ts             + applyPathPrefix(pattern, prefix), assertPathPrefix(prefix)          Task 1
  src/compile/build.ts             buildRuleSet(setDir, { exportedAt?, pathPrefix? })                     Task 1
  src/commands/{build,push,diff}.ts  pathPrefix threaded; PushOptions/DiffOptions/buildOne opts           Task 2
  src/index.ts                     --path-prefix on build/push/diff                                       Task 2
  src/lib.ts                       + applyPathPrefix export                                               Task 2
  test/{routes,build,cli,push}.test.ts + fixtures/synthetic/plain/                                        Tasks 1–2
  docs/reference.md                "Path prefix" section under Route derivation                           Task 2
repos/deploy-proxy-rules/
  action.yml, src/{inputs,types,run-sets}.ts, __tests__/{inputs,run-sets}.test.ts, README.md, dist/      Task 3
bffless/publish-workflow/  (new repo)
  action.yml                       composite: index → rules → upload → attach                             Task 5
  scripts/prepare-rules.mjs        copy set, rename to <alias>, write the forwarder                        Task 5
  scripts/attach.mjs               PATCH /api/repo/<owner>/<repo>/aliases/<harness-alias> with the id union   Task 5
  test/*.test.mjs (node --test), README.md, .github/workflows/ci.yml                                      Task 5
packages/workflow-lint/
  package.json                     private:false, version from release-please, files, bin                 Task 4
  src/rules/{match,scan}.ts        RuleSetIndex.layout; scanRuleSet(dir, { alias, pathPrefix })           Task 4
  src/index/{index.ts,landing.ts}  the `workflow index` implementation (ex stage-hello.mjs)               Task 4
  src/cli.ts                       `index` verb, --path-prefix                                            Task 4
  test/{index,cli}.test.ts, test/rules/scan.test.ts, README.md                                            Task 4
packages/workflow-script/          private:false                                                          Task 4
release-please-config.json, .release-please-manifest.json   components workflow-lint, workflow-script    Task 4
.github/workflows/publish-workflow-lint.yml                 npm publish on the component tag              Task 4
scripts/check-app-conventions.mjs  checkReleaseComponents: packages/* components are not catalog apps     Task 4
bffless/workflow-hello/  (new repo)
  .bffless/workflows/{hello,interactive}.workflow.yaml   headless-ready                                   Task 6
  .bffless/proxy-rules/hello/{ruleset.yaml,schemas/,rules/{echo,fail,slow,analyze}/post/,rules/job/get/}  Task 6
  islands/{pick-line,line-viewer}/, scripts/poster-card.js, vite.islands.config.ts, tsconfig.json        Task 6
  scripts/build.mjs, package.json, README.md, .github/workflows/{ci,deploy}.yml                          Task 6
apps/workflow/
  hello.ref                        the pinned workflow-hello commit                                       Task 7
  scripts/stage-hello.mjs          clone at hello.ref → run its build → hello-dist/                       Task 7
  src/hello-drift.test.ts          examples ≡ pinned checkout                                             Task 7
  src/rules.fence.test.ts, src/hello-stage.test.ts, src/hello-scripts.test.ts   updated                   Task 7
  .bffless/proxy-rules/hello/      REMOVED; hello/ REMOVED                                                Task 7
  .bffless/proxy-rules/workflow/rules/api/workflow/files/sign/post/{rule.yaml,confine.fn.js}             Task 10
  src/scripts/{ScriptHost.ts,worker-shim.ts,sandbox-frame.ts,rpc.ts}    sandboxed Worker + port          Task 8
  src/lib/runner/headless.ts       headlessMode(), skipOutputs(), budgets                                Task 9/12
  src/lib/runner/{types,reducer,rows,replay}.ts   step.skipped.outputs; startedAt on waiting             Task 9/12
  src/store/{islandLaunch,runnerMiddleware,formLaunch}.ts   clocks, headless branches                     Task 9/12
  src/islands/IslandHost.ts        hostContext.bffless, workflow.sign                                     Task 10/11
  src/lib/runner/adapters/island.ts  HOST_TOOLS + 'workflow.sign'                                          Task 10
  src/pages/KickoffPage.tsx, src/lib/autoStart.ts, src/lib/workflowGlobal.ts, src/pages/RunPage.tsx     Task 13
  src/mocks/handlers.ts            files/sign mock, headless fixtures                                     Task 10/13
  e2e/headless.spec.ts             the driver in mock mode is the e2e (09)                                Task 15
  bffless/README.md                sign rule, headless rows, M3 checklist                                 Task 10/15
  docs/spec/{03,04,05,06,07}.md, docs/adr/0002, docs/writing-an-implementation.md   amendments           Tasks 8,10,11,13,16
packages/workflow-headless/  (new)
  package.json (bin workflow-headless), src/{cli,args,login,run,runs,observe,artifacts}.ts, test/        Task 14
.github/workflows/{workflow-headless-run.yml,workflow-app.yml}                                            Task 14/15
repos/ce/apps/backend/src/pipelines/
  ffmpeg/ffmpeg-args.ts            buildFrameArgs(), buildTileArgs()                                      Task 17
  handlers/ffmpeg.handler.ts       runFrames(), runContactSheet(); OPERATIONS                             Task 17
  execution/step-handler.interface.ts, ffmpeg/ffmpeg-capability.service.ts, mcp/tools/proxy-rules.tools.ts Task 17
repos/ce/apps/frontend/src/components/pipelines/handlers/{types.ts,FfmpegHandlerConfig.tsx}              Task 17
repos/docs docs/features/server-video-ops.md; repos/skills …/pipelines/SKILL.md                          Task 17
apps/studio/package.json           exports map for ./lib/* and ./components/Studio/CutEditor              Task 18
apps/workflow-studio/  (new)
  package.json, README.md, CLAUDE.md, bffless/README.md, tsconfig*.json, vite.islands.config.ts, vite.scripts.config.ts
  .bffless/workflows/studio.workflow.yaml                                                                Task 19
  .bffless/proxy-rules/workflow-studio/{ruleset.yaml,schemas/workflow_studio_jobs.schema.yaml,rules/**}  Tasks 20–21
  scripts/{scene-inputs,final-script,frame-times,blog-bundle}.ts + tests                                 Task 22
  islands/cut-editor/{index.html,main.tsx,App.tsx}                                                        Task 23
  scripts/stage.mjs                islands + scripts builds, then `workflow index`                        Task 24
.github/workflows/{workflow-studio.yml,deploy-workflow-studio.yml}                                       Task 24
localdev-tools/workflow-live.mjs   --headless and --studio walks                                          Task 25
```

## Traceability — M3 scope → tasks

| Epic #359 M3 checkbox / spec item | Spec | Tasks |
|---|---|---|
| Write the M3 plan | — | this document |
| `publish-workflow` action/CLI + `--path-prefix` rewrite; pair with #388 | 06, D17 | 1, 2, 3, 4, 5 |
| Extract hello to `bffless/workflow-hello` (M1 Decision 2's condition) | 06, D15 | 6, 7 |
| Decide island `timeout-minutes` + the headless channel | 04, 07 | 9, 11 |
| Bound a script Worker's own `fetch` | 03 | 8 |
| Headless execution — page contract, `window.__workflow`, `headless: skip\|auto`, driver CLI | 07, D11/D12 | 12, 13, 14, 15 |
| Studio port 1 — pipelines + `studio.workflow.yaml`; `resume:` hint revisited | 06 D7, 05 | 17, 18, 19, 20, 21 |
| Studio port 2 — cut-editor island | 04 | 23 |
| Studio port 3 — blog-bundle script + full end-to-end run on j5s | 03, 09 | 22, 24, 25 |
| `workflow.sign` (islands with media) | 04, 06 | 10 |
| Spec amendments (03/04/05/06/07, ADR-0002, writing-an-implementation) | — | 8, 10, 11, 13, 16 |
| Live verification | 06 phase 1, 09 | 25 |

---

# Phase 1 — The publish toolchain

> **As shipped (2026-08-27, epic #359 Phase 1 ticked).** The tasks below are the plan as written; four things came out differently and later phases must use the shipped values:
>
> - **Versions.** The CLI released as **`bffless@0.3.3`** (CE's release-please bumps patch for `feat` pre-1.0; a `Release-As: 0.4.0` footer was not used — it leaks into other CE components). `@bffless/workflow-lint` and `@bffless/workflow-script` released as **`1.0.0`** (a `0.0.0` manifest seed makes release-please use its initial version 1.0.0, not 0.1.0). `deploy-proxy-rules` is **v1.3.0** (`bffless ^0.3.3` frozen, `v1` moved). `bffless/publish-workflow` is **v1.0.0** / `v1`; its `lint-version` default is `^1.0.0`. Wherever the text says `0.4.0` / `0.1.0` / `^0.1.0`, read `0.3.3` / `1.0.0` / `^1.0.0`.
> - **The CE aliases API** is not what Task 5 assumed. Real: `GET /api/repo/<owner>/<repo>/aliases` → `{ repository, aliases: [{ name, proxyRuleSetIds, … }] }` (viewer) and **`PATCH`** `/api/repo/<owner>/<repo>/aliases/<name>` with `{ proxyRuleSetIds }` (replaces the join set; needs the **contributor** project role). `scripts/attach.mjs` sends the union.
> - **Ordering under a prefix** (Task 1): derived `order:` is computed from the *exported* (prefixed) pattern — CE picks the first match by `order` over what it stores — so an explicit `pathPattern: /api/<alias>/*` catch-all orders after the specific derived routes; relative order among derived rules is prefix-invariant. A prefixed root rule collapses to the prefix (`/api/hello`, not `/api/hello/`). The reference doc's "derived `order:` is unaffected" sentence was wrong and is amended.
> - **Previews** must pass `rules: .bffless/proxy-rules/<impl>` explicitly — the set directory is named for the implementation, not the alias (the default `.bffless/proxy-rules/<alias>` would not resolve for `hello-pr-12`; `workflow index` exits 2 on an explicit `--rules` that does not resolve). Preview teardown (spec 06 step 5) is **#399 — built in Phase 2, Task 6b** (amended 2026-08-27).
>
> Also: `publish-workflow-lint.yml` is a `workflow_call`/`workflow_dispatch` workflow invoked from `release.yml` (tags cut with `GITHUB_TOKEN` never fire `push` workflows — apps#398); `release.yml`'s `bundles` skips on a package-only release. Session ledger with every ruling: `.superpowers/sdd/2026-08-27-workflow-m3-publish-headless-studio/progress.md` (git-ignored, local).

Three repos change before any implementation can move: the CE CLI (the rewrite), `deploy-proxy-rules` (carries it into CI), and the lint package (the index + prefix-aware `rule-missing`); then the new composite action ties them together. Work in `repos/ce/.claude/worktrees/cli-path-prefix` (branch `feat/cli-path-prefix` off `origin/main`), `repos/deploy-proxy-rules` (branch `feat/path-prefix`), `repos/apps/.claude/worktrees/workflow-m3-toolchain` (branch `feat/workflow-lint-publish`), and a fresh clone of the new `bffless/publish-workflow` repo.

### Task 1: `applyPathPrefix` + `buildRuleSet({ pathPrefix })` (CE CLI)

**Files:**
- Modify: `packages/cli/src/format/routes.ts` (append), `packages/cli/src/compile/build.ts:231` (signature), `:293` (the derivation)
- Create: `packages/cli/test/fixtures/synthetic/plain/{ruleset.yaml,rules/echo/post/rule.yaml,rules/job/get.rule.yaml,rules/_custom/forward/get.rule.yaml}`
- Test: `packages/cli/test/routes.test.ts`, `packages/cli/test/build.test.ts`

**Interfaces:**
- Produces: `applyPathPrefix(pattern: string, prefix?: string): string`, `assertPathPrefix(prefix: string): void` (throws `Error('--path-prefix must start with "/" …')`), `buildRuleSet(setDir, opts?: { exportedAt?: string; pathPrefix?: string })`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/cli/test/routes.test.ts (append)
import { applyPathPrefix, assertPathPrefix } from '../src/format/routes.js';

describe('applyPathPrefix', () => {
  it('prepends a literal prefix to a derived pattern', () => {
    expect(applyPathPrefix('/echo', '/api/hello')).toBe('/api/hello/echo');
    expect(applyPathPrefix('/items/*', '/api/studio-pr-12')).toBe('/api/studio-pr-12/items/*');
  });
  it('is the identity without a prefix', () => {
    expect(applyPathPrefix('/echo', undefined)).toBe('/echo');
  });
  it('rejects a prefix that is not a clean absolute literal path', () => {
    for (const bad of ['api/hello', '/api/hello/', '/api/*', '/a/../b', '', '/']) {
      expect(() => assertPathPrefix(bad)).toThrow(/--path-prefix/);
    }
  });
});
```

```ts
// packages/cli/test/build.test.ts (append)
const plainDir = path.resolve('test/fixtures/synthetic/plain');

describe('buildRuleSet with pathPrefix', () => {
  it('prefixes every derived pathPattern and leaves explicit ones verbatim', async () => {
    const { export: out } = await buildRuleSet(plainDir, { exportedAt: EXPORTED_AT, pathPrefix: '/api/hello' });
    const patterns = out.rules.map((r) => `${r.method ?? 'ANY'} ${r.pathPattern}`).sort();
    expect(patterns).toEqual(['GET /api/hello/job', 'GET /w/hello/*', 'POST /api/hello/echo']);
  });
  it('keeps pipeline default names prefix-free', async () => {
    const { export: out } = await buildRuleSet(plainDir, { exportedAt: EXPORTED_AT, pathPrefix: '/api/hello' });
    const echo = out.rules.find((r) => r.pathPattern === '/api/hello/echo')!;
    expect(echo.pipelineConfig?.name).toBe('echo POST');
  });
  it('derives the same order with and without a prefix', async () => {
    const a = await buildRuleSet(plainDir, { exportedAt: EXPORTED_AT });
    const b = await buildRuleSet(plainDir, { exportedAt: EXPORTED_AT, pathPrefix: '/api/hello' });
    expect(a.export.rules.map((r) => r.order)).toEqual(b.export.rules.map((r) => r.order));
  });
});
```

Fixture (`plain`): `ruleset.yaml` = `name: plain`; `rules/echo/post/rule.yaml` = a one-step `function_handler` pipeline with `code: ./echo.fn.js` (`function handler({ request }) { return { text: String((request.body || {}).text || '') } }`); `rules/job/get.rule.yaml` = `pipeline: { steps: [{ name: respond, handler: response_handler, config: { body: '{}', status: 200, contentType: application/json } }] }`; `rules/_custom/forward/get.rule.yaml` = `pathPattern: /w/hello/*` + `targetUrl: https://hello.example.test` + `forwardCookies: true` + `order: 5`.

- [x] **Step 2: Run to verify they fail** — `cd packages/cli && pnpm build && pnpm vitest run test/routes.test.ts test/build.test.ts` → FAIL (`applyPathPrefix is not exported`, `pathPrefix` ignored).

- [x] **Step 3: Implement**

```ts
// packages/cli/src/format/routes.ts (append)
const PATH_PREFIX_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** `--path-prefix`: a literal, absolute, `..`/`*`-free path with no trailing slash. */
export function assertPathPrefix(prefix: string): void {
  if (!PATH_PREFIX_RE.test(prefix) || prefix.split('/').includes('..')) {
    throw new Error(
      `--path-prefix must start with "/", contain only literal segments and end without "/" (got ${JSON.stringify(prefix)})`,
    );
  }
}

/**
 * Prepend `prefix` to a *derived* pattern (`/echo` → `/api/hello/echo`). Explicit `pathPattern:`
 * manifests are never passed through here — the escape hatch means "exactly this pattern", which
 * is how a publish-time forwarder (`/w/<alias>/*`) rides inside a prefixed set (spec 06).
 */
export function applyPathPrefix(pattern: string, prefix?: string): string {
  if (!prefix) return pattern;
  assertPathPrefix(prefix);
  return `${prefix}${pattern}`;
}
```

```ts
// packages/cli/src/compile/build.ts
import { relPathToPattern, deriveOrders, METHOD_STEMS, UUID_RE, defaultPipelineName, applyPathPrefix } from '../format/routes.js';
// …
export async function buildRuleSet(
  setDir: string,
  opts?: { exportedAt?: string; pathPrefix?: string },
): Promise<BuildResult> {
// … line 293 becomes:
    const pathPattern = manifest.pathPattern ?? applyPathPrefix(relPathToPattern(d.dirSegments), opts?.pathPrefix);
```

- [x] **Step 4: Run to verify they pass** — same command → PASS. Also `pnpm vitest run` (whole suite) stays green: the existing fixtures never pass a prefix.

- [x] **Step 5: Commit** — `git commit -am "feat(cli): buildRuleSet takes a pathPrefix for derived patterns"`.

### Task 2: `--path-prefix` on `rules build`, `push`, `diff` + docs (CE CLI)

**Files:**
- Modify: `packages/cli/src/commands/build.ts:26`, `packages/cli/src/commands/push.ts:21-29,101-112`, `packages/cli/src/commands/diff.ts:63-90`, `packages/cli/src/index.ts:70-102,188-236,237-275`, `packages/cli/src/lib.ts`, `packages/cli/docs/reference.md:404`
- Test: `packages/cli/test/cli.test.ts`, `packages/cli/test/push.test.ts`

**Interfaces:**
- Produces: `PushOptions.pathPrefix?`, `DiffOptions.pathPrefix?`, `buildOne(setDir, { output?, pathPrefix? })`; `bffless/lib` exports `applyPathPrefix`.

- [x] **Step 1: Write the failing tests**

```ts
// packages/cli/test/cli.test.ts (append inside describe('bffless rules build'))
it('--path-prefix rewrites derived patterns in the written export', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bffless-cli-test-plain-'));
  cpSync(path.resolve('test/fixtures/synthetic/plain'), dir, { recursive: true });
  const out = path.join(dir, 'out.json');
  const result = run(['rules', 'build', dir, '-o', out, '--path-prefix', '/api/hello']);
  expect(result.status, result.stderr).toBe(0);
  const exp = JSON.parse(readFileSync(out, 'utf8'));
  expect(exp.rules.map((r: { pathPattern: string }) => r.pathPattern).sort()).toEqual(['/api/hello/echo', '/api/hello/job', '/w/hello/*']);
});
it('--path-prefix rejects a relative prefix with a usage error', () => {
  const result = run(['rules', 'build', path.resolve('test/fixtures/synthetic/plain'), '-o', '/dev/null', '--path-prefix', 'api/hello']);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/--path-prefix must start with/);
});
```

```ts
// packages/cli/test/push.test.ts (append; follow the file's existing fake-fetch harness)
it('sends prefixed pathPatterns in the sync body when pathPrefix is set', async () => {
  const calls: unknown[] = [];
  const fetchImpl = fakeFetch(calls);           // the file's helper: records the PUT body, answers an empty SyncResponse
  await runPushOne(path.resolve('test/fixtures/synthetic/plain'), { pathPrefix: '/api/hello', apiUrl: 'http://x', apiKey: 'k', project: 'o/n' }, process.cwd(), { fetchImpl });
  const body = lastSyncBody(calls);
  expect(body.rules.map((r) => r.pathPattern).sort()).toEqual(['/api/hello/echo', '/api/hello/job', '/w/hello/*']);
});
```

- [x] **Step 2: Run to verify they fail** — `pnpm test -- test/cli.test.ts test/push.test.ts` → FAIL (`unknown option '--path-prefix'`).

- [x] **Step 3: Implement**

```ts
// push.ts
export interface PushOptions { nameSuffix?: string; pathPrefix?: string; prune?: boolean; dryRun?: boolean; strictSchemas?: boolean; apiUrl?: string; apiKey?: string; project?: string; }
// runPushOne:
    built = await buildRuleSet(setDir, { pathPrefix: opts.pathPrefix });
// diff.ts
export interface DiffOptions { pathPrefix?: string; apiUrl?: string; apiKey?: string; project?: string; }
    local = (await buildRuleSet(setDir, { pathPrefix: opts.pathPrefix })).export;
// build.ts
export async function buildOne(setDir: string, opts?: { output?: string; pathPrefix?: string }): Promise<BuildOutcome> {
    result = await buildRuleSet(setDir, { pathPrefix: opts?.pathPrefix });
```

`index.ts`: add `.option('--path-prefix <prefix>', 'prepend a literal prefix to every derived pathPattern (explicit pathPattern: manifests are left verbatim), e.g. /api/hello (spec: workflow implementations)')` to `build`, `push` and `diff`; thread `opts.pathPrefix` into `buildOne` / `runPushOne` / `runDiffOne`. `assertPathPrefix` throws from inside `buildRuleSet`, so `build` reports it through the existing `result.summary` path and `push` through `outcome.error` — no extra parsing. `lib.ts`: `export { applyPathPrefix, assertPathPrefix } from './format/routes.js';`.

`docs/reference.md` — new subsection after "Ordering":

```markdown
### Path prefix (`--path-prefix`)

`rules build|push|diff --path-prefix /api/hello` prepends the prefix to every **derived** `pathPattern`
(`rules/echo/post/` → `POST /api/hello/echo`). A manifest with an explicit `pathPattern:` is left verbatim —
that is how a generated `/w/hello/*` forwarder lives in the same set. Pipeline default names and the
derived `order:` are unaffected (a uniform prefix keeps specificity order). Written for BFFless Workflow
implementations, which author prefix-free rules and are published under one alias-named prefix per
deploy (`bffless/publish-workflow`); `rules diff` needs the same flag or it reports permanent drift.
```

- [x] **Step 4: Run to verify** — `pnpm test` (builds first) → PASS.
- [x] **Step 5: Commit + PR** — `git commit -am "feat(cli): --path-prefix for rules build, push and diff"`; push; `gh pr create --title "feat(cli): --path-prefix for rules build, push and diff" --body-file -` (body: what/why, the exemption rule, the workflow spec pointer). **Ask the user to merge and cut the CLI release** (`bffless-v0.4.0` via release-please; the `publish-cli` job publishes). Tasks 3–5 wait on `npm view bffless version` = `0.4.x`.

### Task 3: `path-prefix` input on `deploy-proxy-rules` (v1.3.0)

**Files:**
- Modify: `action.yml` (inputs), `src/inputs.ts:36-40,50-65`, `src/types.ts` (`ActionInputs.pathPrefix?: string`), `src/run-sets.ts:104-117`, `package.json` (`"bffless": "^0.4.0"`, version 1.3.0), `README.md` (inputs table + a "Workflow implementations" note), `dist/**` (rebuilt)
- Test: `__tests__/inputs.test.ts`, `__tests__/run-sets.test.ts`

- [x] **Step 1: Failing tests** — in `inputs.test.ts` (mirroring the `name-suffix` cases): `path-prefix` read as `pathPrefix`, empty string → `undefined`. In `run-sets.test.ts`: `runPushOne` is called with `pathPrefix: '/api/hello'` when the input is set (the file already spies on `lib.runPushOne`; add the assertion on the options object).
- [x] **Step 2: Verify fail** — `pnpm test` → FAIL.
- [x] **Step 3: Implement**

```yaml
# action.yml (after name-suffix)
  path-prefix:
    description: 'Prepend a literal prefix to every derived pathPattern before syncing (e.g. /api/hello). Explicit pathPattern: manifests are left verbatim. Requires bffless >= 0.4.0.'
    required: false
```

```ts
// src/inputs.ts
  const pathPrefix = core.getInput('path-prefix') || undefined;   // '' = unset, like name-suffix
  return { …, nameSuffix, pathPrefix, … };
// src/run-sets.ts (runPushOne options)
        nameSuffix: inputs.nameSuffix,
        pathPrefix: inputs.pathPrefix,
```

`pnpm install` (bumps `bffless` to 0.4.x in the lockfile), `pnpm build` (regenerates `dist/index.js` and `dist/vendor/esbuild` — build on linux-x64), commit `dist/`.
- [x] **Step 4: Verify** — `pnpm test` → PASS including `dist-smoke.test.ts`; `node -e "require('./dist/index.js')"` loads.
- [x] **Step 5: Commit + PR + release** — `feat: path-prefix input`; after merge, release-please cuts `v1.3.0`; **move the `v1` tag** (`git tag -f v1 v1.3.0 && git push -f origin v1` — the repo's documented release step; confirm in `README.md`/`release.yml` first and ask before the force-push of a tag).

### Task 4: `@bffless/workflow-lint` goes public: `workflow index`, `--path-prefix`, release component

**Files:**
- Modify: `packages/workflow-lint/package.json` (`private: false`, `"version": "0.1.0"`, `publishConfig: { access: public }`, `files: ["dist","schema","README.md"]`), `packages/workflow-lint/src/rules/match.ts` (`RuleSetIndex.layout`), `src/rules/scan.ts` (`scanRuleSet(dir, { alias?, pathPrefix? })`), `src/cli.ts` (`index` verb, `--path-prefix`), `src/index.ts` (export `buildIndex`), `README.md`
- Create: `packages/workflow-lint/src/index/index.ts` (pure `buildIndex`), `src/index/write.ts` (fs), `test/index.test.ts`, `test/fixtures/plain-impl/` (a prefix-free set + one YAML)
- Modify: `packages/workflow-script/package.json` (`private: false`, `version: 0.1.0`, `publishConfig`), `release-please-config.json`, `.release-please-manifest.json`, `scripts/check-app-conventions.mjs:259-294` (`checkReleaseComponents` only inspects `apps/*` keys), `scripts/check-app-conventions.test.mjs`
- Create: `.github/workflows/publish-workflow-lint.yml`
- Test: `packages/workflow-lint/test/rules/scan.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `scanRuleSet(dir, { alias?: string; pathPrefix?: string }): RuleSetIndex` where `index.prefix` is the URL prefix (`pathPrefix ?? (rules/api/<alias> exists ? '/api/<alias>' : '/api')`) and `index.layout` is the on-disk prefix (`''` when `pathPrefix` is given, else `index.prefix`); `expectedRuleFile` uses `layout`. `buildIndex(a: { impl, name, description?, version, commit, workflows: { file, yaml }[], islands: string[], scripts: string[], rules: RuleSetContext }): { ok: true; index: IndexJson } | { ok: false; findings }`. CLI: `workflow index <workflows-dir> --out <dist> --impl <alias> --name <display> [--description <text>] [--rules <dir>] [--alias <alias>] [--path-prefix <p>] [--version <v>] [--commit <sha>]` (exit 0/1/2 like `lint`).

- [x] **Step 1: Failing tests**

```ts
// test/rules/scan.test.ts (append)
it('a pathPrefix set means the URL prefix is the flag and the layout is bare', () => {
  const index = scanRuleSet(fixture('rules/plain'), { alias: 'hello', pathPrefix: '/api/hello' })
  expect(index.prefix).toBe('/api/hello')
  expect(index.layout).toBe('')
  expect(resolveUrl(index, 'echo')).toBe('/api/hello/echo')
  expect(expectedRuleFile(index, 'echo', 'POST')).toBe('rules/echo/post/rule.yaml')
  expect(findRule(index, '/api/hello/echo', 'POST')?.source).toBe('rules/echo/post/rule.yaml')
})
```
(`test/fixtures/rules/plain` from PR #394 already has `rules/api/echo/post/` — add a second fixture `rules/bare` with `rules/echo/post/rule.yaml` and use it here.)

```ts
// test/index.test.ts
import { buildIndex } from '../src/index/index.js'
it('lints, counts and lists', () => {
  const r = buildIndex({ impl: 'hello', name: 'Hello', version: '1.0.0', commit: 'abc1234',
    workflows: [{ file: 'hello.workflow.yaml', yaml: HELLO_YAML }], islands: ['islands/pick-line.html'], scripts: [], rules: { found: false, reason: 'test' } })
  expect(r.ok && r.index.workflows[0]).toMatchObject({ file: 'hello.workflow.yaml', name: 'Hello workflow', inputs: 3, jobs: 4, headlessSafe: false })
})
it('a lint error fails the index', () => {
  const r = buildIndex({ …, workflows: [{ file: 'x.yaml', yaml: 'spec: 1\n' }] })
  expect(r.ok).toBe(false)
})
```
And in `test/cli.test.ts`: `workflow index <fixture>/.bffless/workflows --out <tmp> --impl plain --name Plain --rules <fixture>/.bffless/proxy-rules/plain --path-prefix /api/plain` writes `<tmp>/.bffless/workflows/index.json` + the YAML + `index.html`, exit 0; with a renamed step path exit 1 mentioning `rule-missing`.

- [x] **Step 2: Verify fail.**
- [x] **Step 3: Implement** — `match.ts`: add `layout: string` to `RuleSetIndex`; `expectedRuleFile` builds from `index.layout.split('/')`. `scan.ts`: in `scanRuleSet`, `const prefix = opts.pathPrefix ?? (existsSync(join(setDir,'rules','api',alias)) ? `/api/${alias}` : '/api')`; `const layout = opts.pathPrefix ? '' : prefix`; and in `push()` the derived pattern becomes `(opts.pathPrefix ?? '') + segmentsToPattern(segments)` for manifests without `pathPattern` (thread `pathPrefix` through `collect`). `resolveRuleSet` gains `pathPrefix` in `ResolveOptions`. `src/index/index.ts` is `stage-hello.mjs` lines 48–69 + 141–150 made pure (takes YAML texts, returns the JSON); `src/index/write.ts` does the fs half (read YAMLs, list `islands/*.html` + `scripts/*.js` under `--out`, write `index.json` + the landing `index.html` — the exact HTML from `stage-hello.mjs:156-165` with `hello.` generalised to the `--impl` value). `cli.ts` gains the `index` command with its own `parseArgs` branch; `--path-prefix` accepted by both verbs.

Release wiring: `release-please-config.json` gains
```json
    "packages/workflow-lint": { "release-type": "node", "component": "workflow-lint", "include-component-in-tag": true },
    "packages/workflow-script": { "release-type": "node", "component": "workflow-script", "include-component-in-tag": true }
```
and the manifest `"packages/workflow-lint": "0.1.0", "packages/workflow-script": "0.1.0"`. `checkReleaseComponents` (line 282–288) currently errors on any component that is not a catalog app — change the guard to `key.startsWith('apps/')` only, with a test. `.github/workflows/publish-workflow-lint.yml`: on `push` tags `workflow-lint-v*` / `workflow-script-v*` → pnpm install → build → `pnpm --filter <pkg> publish --access public --no-git-checks` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (**ask the user whether `NPM_TOKEN` exists on `bffless/apps`; the CE repo has one**).

- [x] **Step 4: Verify** — `pnpm --filter @bffless/workflow-lint build && pnpm --filter @bffless/workflow-lint test:run && pnpm --filter @bffless/workflow-lint lint && pnpm scripts:test && pnpm apps:check`. `apps/workflow/scripts/stage-hello.mjs` still works unchanged (it imports `scanRuleSet`, whose default behaviour is unchanged).
- [x] **Step 5: Commit + PR** — `feat(workflow-lint): publish the package, add the index verb and --path-prefix`. After merge: release-please PR for the two components → merge → tags → `npm view @bffless/workflow-lint version` = `0.1.0`.

### Task 5: The `bffless/publish-workflow` composite action (v1.0.0)

**Files (new repo, `gh repo create bffless/publish-workflow --public`):**
- Create: `action.yml`, `scripts/prepare-rules.mjs`, `scripts/attach.mjs`, `test/prepare-rules.test.mjs`, `test/attach.test.mjs`, `package.json` (`"type": "module"`, `"scripts": { "test": "node --test test/" }`, no deps), `README.md`, `LICENSE.md` (copy `deploy-proxy-rules`'), `.github/workflows/ci.yml` (`node --test` + `actionlint`)

**Interfaces (action inputs):** `alias` (required), `api-url` (required), `api-key` (required), `repository` (required, `owner/name` — the harness's project), `path` (built bundle dir, default `dist`), `workflows` (default `.bffless/workflows`), `rules` (default `.bffless/proxy-rules/<alias>` — a rule-set dir), `harness-alias` (default `workflow`), `target-url` (required until ce#698 — the alias host, e.g. `https://hello.j5s.dev`), `name` (display name, default `alias`), `description`, `prune` (default `true`), `lint-version` (default `^0.1.0`). Outputs: `rule-set-id`, `deployment-id`, `index` (path of the written `index.json`).

- [x] **Step 1: Failing tests (node --test)**

```js
// test/prepare-rules.test.mjs
import { test } from 'node:test'; import assert from 'node:assert/strict'
import { prepareRules } from '../scripts/prepare-rules.mjs'
test('copies the set, renames it, writes the forwarder', async () => {
  const out = await prepareRules({ rulesDir: fixture('hello'), alias: 'hello-pr-3', targetUrl: 'https://hello-pr-3.example.test', outDir: tmp() })
  assert.equal(readYaml(`${out}/ruleset.yaml`).name, 'hello-pr-3')
  const fwd = readYaml(`${out}/rules/_custom/forward/get.rule.yaml`)
  assert.deepEqual(fwd, { pathPattern: '/w/hello-pr-3/*', targetUrl: 'https://hello-pr-3.example.test', forwardCookies: true, order: 5, description: fwd.description })
  assert.ok(existsSync(`${out}/rules/echo/post/rule.yaml`))
})
test('refuses an authored forwarder (it is generated)', async () => {
  await assert.rejects(prepareRules({ rulesDir: fixture('with-forwarder'), alias: 'x', targetUrl: 'https://x', outDir: tmp() }), /rules\/_custom\/forward/)
})
```

```js
// test/attach.test.mjs
import { unionIds, attach } from '../scripts/attach.mjs'
test('unionIds appends once, in order', () => {
  assert.deepEqual(unionIds(['a', 'b'], 'b'), ['a', 'b']); assert.deepEqual(unionIds(['a'], 'c'), ['a', 'c'])
})
test('attach GETs the alias then PUTs the union', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push([url, init?.method ?? 'GET', init?.body]); return url.includes('/api/aliases?') ? json({ data: [{ alias: 'workflow', proxyRuleSetIds: ['a'] }] }) : json({}) }
  await attach({ apiUrl: 'https://x', apiKey: 'k', repository: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl })
  assert.equal(calls[1][0], 'https://x/api/aliases/o%2Fn/workflow'); assert.equal(calls[1][1], 'PUT')
  assert.deepEqual(JSON.parse(calls[1][2]), { proxyRuleSetIds: ['a', 'b'] })
})
```

- [x] **Step 2: Verify fail.**
- [x] **Step 3: Implement**

`scripts/prepare-rules.mjs` — `prepareRules({ rulesDir, alias, targetUrl, outDir })`: validate `alias` against `^[a-z][a-z0-9-]*$` and the reserved list (`workflow`, `w`, `auth`, `_bffless`); `cpSync(rulesDir, outDir, { recursive: true })`; rewrite `ruleset.yaml`'s `name:` to `alias` (parse with a 20-line YAML-safe replace: the file is `name:` + optional `description:`; use `yaml` — vendored? no deps allowed → use `npx --yes yaml`? Simpler: the action's `package.json` has `"dependencies": { "yaml": "^2.8.0" }` and the composite runs `npm ci --omit=dev` in `$GITHUB_ACTION_PATH` first — accepted); throw if `rules/_custom/forward` exists; write the forwarder:

```yaml
pathPattern: /w/<alias>/*
targetUrl: <target-url>
forwardCookies: true
order: 5
description: 'Generated by bffless/publish-workflow: single-origin forwarding (ADR-0001) — /w/<alias>/[...path] on the harness host → the implementation alias. targetUrl is per-install until CE grows targetUrl: alias:// (bffless/ce#698).'
```

`scripts/attach.mjs` — `attach({ apiUrl, apiKey, repository, harnessAlias, ruleSetId, fetchImpl = fetch })`: `GET ${apiUrl}/api/aliases?repository=${encodeURIComponent(repository)}` (header `X-API-Key`), find `harnessAlias`, `PUT ${apiUrl}/api/aliases/${encodeURIComponent(repository)}/${harnessAlias}` with `{ proxyRuleSetIds: unionIds(existing, ruleSetId) }`; non-2xx → throw with the body. CLI entry reads env `INPUT_*`/args.

`action.yml` (composite):

```yaml
name: 'Publish a BFFless Workflow implementation'
description: 'Lint + index the workflows, sync the rule set under /api/<alias>/ with a generated /w/<alias>/ forwarder, deploy the bundle to alias <alias>, attach the set to the harness alias.'
inputs: { … as above … }
outputs:
  rule-set-id: { value: ${{ steps.rules.outputs.rule-set-ids }} }
  deployment-id: { value: ${{ steps.upload.outputs.deployment-id }} }
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - name: Install action deps
      shell: bash
      working-directory: ${{ github.action_path }}
      run: npm ci --omit=dev
    - name: Lint + index
      shell: bash
      run: |
        npx --yes @bffless/workflow-lint@${{ inputs.lint-version }} index "${{ inputs.workflows }}" \
          --out "${{ inputs.path }}" --impl "${{ inputs.alias }}" --name "${{ inputs.name || inputs.alias }}" \
          --description "${{ inputs.description }}" --rules "${{ inputs.rules || format('.bffless/proxy-rules/{0}', inputs.alias) }}" \
          --path-prefix "/api/${{ inputs.alias }}" --commit "${{ github.sha }}"
    - name: Prepare the rule set (rename + forwarder)
      id: prepare
      shell: bash
      run: node "${{ github.action_path }}/scripts/prepare-rules.mjs" --rules "${{ inputs.rules || format('.bffless/proxy-rules/{0}', inputs.alias) }}" --alias "${{ inputs.alias }}" --target-url "${{ inputs.target-url }}" --out "$RUNNER_TEMP/publish-workflow-rules" >> "$GITHUB_OUTPUT"
    - name: Sync the rule set
      id: rules
      uses: bffless/deploy-proxy-rules@v1
      with:
        path: ${{ steps.prepare.outputs.dir }}
        path-prefix: /api/${{ inputs.alias }}
        api-url: ${{ inputs.api-url }}
        api-key: ${{ inputs.api-key }}
        project: ${{ inputs.repository }}
        prune: ${{ inputs.prune }}
        summary-title: Workflow rules (${{ inputs.alias }})
    - name: Deploy the bundle
      id: upload
      uses: bffless/upload-artifact@v1
      with:
        path: ${{ inputs.path }}
        base-path: /
        api-url: ${{ inputs.api-url }}
        api-key: ${{ inputs.api-key }}
        repository: ${{ inputs.repository }}
        alias: ${{ inputs.alias }}
        proxy-rule-set-names: ${{ inputs.alias }}
    - name: Attach to the harness alias
      shell: bash
      env: { BFFLESS_API_KEY: ${{ inputs.api-key }} }
      run: node "${{ github.action_path }}/scripts/attach.mjs" --api-url "${{ inputs.api-url }}" --repository "${{ inputs.repository }}" --harness-alias "${{ inputs.harness-alias }}" --rule-set-id "${{ steps.rules.outputs.rule-set-ids }}"
```

`README.md`: the five obligations from spec 06, the inputs table, "what is still manual per install" (domain → alias with path `/`, the two `no-transform` header rules until ce#700, bucket CORS, member project role ce#701), and the preview-teardown deferral. `.github/workflows/ci.yml`: `npm ci && npm test` + `rhysd/actionlint`.

- [x] **Step 4: Verify** — `npm test` green; `actionlint action.yml`.
- [x] **Step 5: Commit, push, tag** — `git tag v1.0.0 && git tag v1 && git push --tags` (ask first — the repo is new, the tags are the contract). The first real run is Phase 2, Task 6.

---

# Phase 2 — hello moves to `bffless/workflow-hello`

> **As shipped (2026-08-28, epic #359 Phase 2).**
>
> - Repo `bffless/workflow-hello` created 2026-08-27; `deploy.yml` via `bffless/publish-workflow@v1`; `preview.yml` (opened/synchronize/reopened → publish `hello-pr-N`; closed → `mode: teardown`). First live publish run 33126465003; hello runs live on workflow.j5s.dev (`run_01M12S51910QYNSSSMTJY6CAAM`).
> - **Domain path is `/dist`, not `/`** (Task 6 Step 4 text says `/`): `upload-artifact` keeps the uploaded directory name as the bundle root (`/` → 400 double slash, empty → 404). Same for any preview alias domain. Wherever the text says path `/`, read `/dist`.
> - Task 6 Step 2: the two forms already carried correct `headless: { mode: skip, … }`; the only YAML change was `pick/choose` → `headless: auto`. `build.mjs` takes `--impl/--name` (preview passes `hello-pr-N`) and both deploy workflows assert `index.json` `impl` equals the alias after the action step. In GitHub workflow YAML an unquoted ` #` (as in `Hello (PR #N)`) starts a comment — quote the scalar.
> - `@bffless/workflow-lint` **1.0.1** (apps#401/#402): 1.0.0's CLI main-module guard compared `import.meta.url` (realpath) to `argv[1]` (bin symlink) → every `npx`/`.bin` invocation exited 0 doing nothing; this would have made every live `publish-workflow` index step a silent no-op. Fixed before the first live publish.
> - Task 6b: `bffless/publish-workflow` **v1.1.0** / `v1` moved (manual tags — the repo has no release-please; the plan's "release-please v1.1.0" is wrong). CE routes verified: `DELETE /api/repo/<o>/<r>/aliases/<name>` → 204 (contributor; attached sets don't block), `DELETE /api/proxy-rule-sets/<id>` → 200 (contributor; cascades rules + alias join rows; 409 only for the project default). Teardown also sweeps harness-attached sets named `<alias>` (recovery after a partial failure); an unknown `mode` fails instead of skipping every step; shared helpers in `scripts/lib.mjs`. Live proof on workflow-hello#1 (open → `hello-pr-1` alias + set + harness attachment; close → all gone); apps#399 closed.
> - A preview alias has no domain mapping — attached and discoverable, not browsable; out of scope, READMEs say so.
> - **Superseded 2026-08-28:** the generated forwarder now targets the backend's alias serve route in-process (`http://localhost:3000/public/<owner>/<repo>/alias/<alias>/dist`, `forwardCookies: true`) in `publish-workflow` v1.2.0, so `target-url` is optional, no implementation needs a domain, and preview aliases *are* browsable at `/w/<alias>/…` (the preview alias itself) — ADR-0001 amendment; ce#698 demoted to a nice-to-have (Task 6 Step 4's *Manual, once* domain step is no longer required).
> - Task 7 (apps#403): `hello.ref` = `1b7f4606c4d29042cfbea15c965bd649549018e3`; the nested `pnpm install` needs `--ignore-workspace` (the clone sits inside this workspace); the drift test uses `fileURLToPath` (the brief's `new URL(x, import.meta.url)` breaks under jsdom); mock tests that read the staged bundle (`hello-scripts`, `analyze.fn.parity`, the script-route block of `handlers.test`) skip on a fresh checkout — `pnpm stage` is the prerequisite for the full unit run; `packages/workflow-lint` got its own two-set fixture (`test/fixtures/hello-workspace`) and the CI studio-lint line passes an explicit `--alias` (with one set left, the search auto-picks it); `stage-hello.mjs` refuses to clear an `--out` that lacks its own `.bffless/workflows/index.json`.
> - The deploy key on the new repo is a fresh admin-session key scoped to project bffless/workflow; workflow-ci@bffless.app holds contributor on that project.

The first customer of Phase 1. Two repos: the new one (Task 6), the teardown half of the toolchain that only a repo with PR previews can prove (Task 6b, `bffless/publish-workflow` — apps#399, pulled in from "Deferred" on 2026-08-27), and the monorepo (Task 7). Hello ships **headless-ready** here (the `headless:` declarations and the islands' auto-submit branch) so Phase 3 needs no second round trip: `hostContext.bffless` is simply absent until 3a lands.

### Task 6: The `bffless/workflow-hello` repo

**Files (new repo, `gh repo create bffless/workflow-hello --public`):**
- Create: `.bffless/workflows/hello.workflow.yaml`, `.bffless/workflows/interactive.workflow.yaml` (from `apps/workflow/docs/spec/examples/`, plus the headless keys below), `.bffless/proxy-rules/hello/ruleset.yaml`, `.bffless/proxy-rules/hello/schemas/hello_jobs.schema.yaml`, `.bffless/proxy-rules/hello/rules/{echo,fail,slow,analyze}/post/**`, `.bffless/proxy-rules/hello/rules/job/get/**` (from `apps/workflow/.bffless/proxy-rules/hello/rules/api/hello/*` — the `api/hello/` segments dropped, the `w/hello/[...path]` forwarder **deleted**), `islands/pick-line/{index.html,main.ts}`, `islands/line-viewer/{index.html,main.ts}`, `scripts/poster-card.js`, `vite.islands.config.ts` (from `apps/workflow/hello/`, paths re-rooted), `tsconfig.json`, `scripts/build.mjs`, `package.json`, `README.md`, `.gitignore` (`dist/`, `node_modules/`), `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`

- [ ] **Step 1: Seed the repo** — copy the files listed above from the monorepo at `origin/main`; `git mv`-style path changes only. `package.json`:

```json
{ "name": "workflow-hello", "private": true, "type": "module", "packageManager": "pnpm@10.33.0",
  "scripts": { "build": "node scripts/build.mjs", "check": "tsc -p tsconfig.json && node scripts/build.mjs --check", "test": "vitest run" },
  "dependencies": { "@modelcontextprotocol/ext-apps": "^1.7.5", "@modelcontextprotocol/sdk": "^1.30.0", "zod": "^4.4.3" },
  "devDependencies": { "@bffless/workflow-lint": "^1.0.0", "@bffless/workflow-script": "^1.0.0", "typescript": "~6.0.2", "vite": "^8.0.12", "vite-plugin-singlefile": "^2.3.3", "vitest": "^4.1.7", "@types/node": "^24.12.3" } }
```

`scripts/build.mjs` = `stage-hello.mjs` lines 87–132 (the island builds + script copy, `--out dist`) followed by `execFileSync('npx', ['workflow', 'index', '.bffless/workflows', '--out', 'dist', '--impl', 'hello', '--name', 'Hello', '--description', '…', '--rules', '.bffless/proxy-rules/hello', '--path-prefix', '/api/hello'])` — the linter package's bin, resolved from `node_modules/.bin`. The `WORKFLOWS`/`ISLANDS` lists are read from the directories, not hard-coded.

- [ ] **Step 2: Headless-ready YAML + islands.** `hello.workflow.yaml` `confirm/review` form gains `headless: { mode: skip, outputs: { note: "auto-approved", approve: true } }` (match the form's field names as declared in the file); `interactive.workflow.yaml` `pick/choose` island gains `headless: auto` and `review/confirm` gains `headless: { mode: skip, outputs: { cover: "${{ needs.card.outputs.posters[0].path }}", … } }` (every referenced output — `headless-skip-outputs` enforces it). `islands/pick-line/main.ts`: after `app.connect()`,

```ts
const bffless = (app.getHostContext() as { bffless?: { headless?: boolean } } | undefined)?.bffless
if (bffless?.headless) {
  // Headless run (spec 07 / plan Decision 7): pick the first line the way a person would.
  const first = lines.querySelector('button')
  if (first) attempt(async () => { await preview(first.textContent ?? '', 0, first); await submit({ line: first.textContent ?? '', index: 0 }) })
}
```
(`hostContext` is only known after `connect()`; register `ontoolinput` before it as today, and run the auto-pick from inside `ontoolinput` when `bffless.headless` is set, since `lines` is populated there — implement it as a flag checked at the end of `ontoolinput`.)

- [ ] **Step 3: CI + deploy** — `ci.yml` (PR): pnpm install → `pnpm check` → `pnpm test` → `pnpm build` → `npx bffless rules validate .bffless/proxy-rules/hello`. `deploy.yml` (push `main`, `workflow_dispatch`):

```yaml
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: bffless/publish-workflow@v1
        with:
          alias: hello
          name: Hello
          description: 'M2 test implementation: hello (echo, slow job + poll, fail-on-purpose) and an interactive island round-trip; two islands (pick-line, line-viewer); analyze.'
          repository: bffless/workflow
          api-url: ${{ vars.BFFLESS_URL }}
          api-key: ${{ secrets.BFFLESS_WORKFLOW_API_KEY }}
          target-url: https://hello.j5s.dev
```
Repo settings: variable `BFFLESS_URL=https://admin.j5s.dev`, secret `BFFLESS_WORKFLOW_API_KEY` (**ask the user for the value used by `deploy-workflow.yml`, or mint a new key on project `bffless/workflow` via MCP `create_api_key` and set it with `gh secret set`**).

- [ ] **Step 4: First publish** — dispatch `deploy.yml`. Live checks: `GET https://workflow.j5s.dev/w/hello/.bffless/workflows/index.json` (through the forwarder — now the generated one), `POST /api/hello/echo` on the harness host, `list_aliases` shows the `hello` alias's set attached and the `workflow` alias carrying both ids. **Manual, once:** the `hello.j5s.dev` domain's path `/apps/workflow/hello-dist` → `/` (admin UI or MCP `update_domain`).
- [ ] **Step 5: README** — the repo is the reference for "writing an implementation" now: layout, the relative-path convention, the four manual per-install items, and a link to `apps/workflow/docs/writing-an-implementation.md`.

### Task 6b: Preview teardown — `bffless/publish-workflow` `mode: teardown` (apps#399, spec 06 step 5)

**Files (`bffless/publish-workflow`, v1.1.0):**
- Modify: `action.yml` (input `mode: publish | teardown`, default `publish`; `target-url`/`path`/`workflows` not required in teardown), `README.md` (obligation 5 no longer "not yet"; the preview recipe)
- Create: `scripts/teardown.mjs` (`detach({ …, ruleSetName })` = the inverse of `attach.mjs`, then delete the alias, then delete the set), `test/teardown.test.mjs`
- Consumer: `bffless/workflow-hello/.github/workflows/preview.yml` (`pull_request: [opened, synchronize, reopened]` → `mode: publish`, `alias: hello-pr-${{ github.event.number }}`, `rules: .bffless/proxy-rules/hello`; `pull_request: [closed]` → `mode: teardown`, same alias)

**Interfaces:** in teardown mode the action (1) `GET /api/repo/<owner>/<repo>/aliases`, finds the harness alias and PATCHes `proxyRuleSetIds` **minus** every id whose set is named `<alias>` (no write if none); (2) deletes alias `<alias>` (`DELETE /api/repo/<owner>/<repo>/aliases/<alias>` — verify the CE route and whether deleting an alias with an attached set is allowed or needs the set detached first); (3) deletes the rule set named `<alias>` (`DELETE /api/proxy-rule-sets/<id>` — verify; `rules push --prune` cannot delete a set). Idempotent: every step tolerates "already gone". **Refuses** unless `alias` matches `^[a-z][a-z0-9-]*-pr-[0-9]+$` or `preview: true` is passed — the contributor-role key can repoint any alias on the harness project, and a typo must not tear down production. Outputs: `detached` (bool), `deleted-alias` (bool), `deleted-rule-set` (bool).

- [ ] **Step 1: Failing tests (node --test)** — `unionIds` inverse (`withoutIds(['a','b'],'b')` → `['a']`, no-op when absent); `teardown` against a fake `fetchImpl`: GET → PATCH with the reduced list → DELETE alias → DELETE set, in that order; a second run (GET returns no such alias/set) makes no writes and exits 0; `alias: hello` without `preview: true` rejects before any request.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `scripts/teardown.mjs` + the `mode` branch in `action.yml` (the composite's publish steps get `if: inputs.mode == 'publish'`, the teardown step `if: inputs.mode == 'teardown'`; `actionlint` cannot lint composite `action.yml` — `test/action.test.mjs` is the contract check). README: obligation 5, the `preview.yml` recipe, the refusal rule.
- [ ] **Step 4: Verify** — `npm test`; then the live proof is Task 6 Step 4's PR preview: open a PR on `workflow-hello`, confirm `hello-pr-N` appears on the harness Implementations screen, close the PR, confirm the alias, the set and the harness attachment are gone (admin UI / `GET …/aliases`).
- [ ] **Step 5: Commit + release** — `feat: teardown mode` → release-please v1.1.0, `v1` moves; close apps#399.

### Task 7: The monorepo stops shipping hello

**Files:**
- Delete: `apps/workflow/hello/**`, `apps/workflow/.bffless/proxy-rules/hello/**`, `apps/workflow/tsconfig.islands.json`, `apps/workflow/tsconfig.scripts.json`
- Create: `apps/workflow/hello.ref` (one line: the workflow-hello commit sha), `apps/workflow/src/hello-drift.test.ts`
- Modify: `apps/workflow/scripts/stage-hello.mjs`, `apps/workflow/package.json` (`stage` unchanged, drop `vite-plugin-singlefile`), `apps/workflow/src/rules.fence.test.ts` (one set), `apps/workflow/src/hello-stage.test.ts` (asserts shape, not counts — apps#380), `apps/workflow/src/hello-scripts.test.ts` (reads `hello-src/scripts/*.js`), `.github/workflows/deploy-workflow.yml` (drop the hello rule set path and the hello upload step; `proxy-rule-set-names: workflow` only — the attach of `hello` to the harness alias is `publish-workflow`'s job now), `.github/workflows/workflow-app.yml` (unchanged steps; note), `.gitignore` (`apps/workflow/hello-src/`), `apps/workflow/bffless/README.md` (one set; the "hello" rows point at the repo), `apps/workflow/docs/writing-an-implementation.md` (steps 4–5 become "use `bffless/publish-workflow`"; the prefix note flips to "author `rules/echo/post/`"), `apps/workflow/docs/spec/06-discovery-publishing-files.md` (step 4 wording → the shipped semantics; the forwarder line "generated by publish-workflow" now true), `docs/spec/00-overview.md` (topology comment: `workflow-studio`, Decision 9)

- [ ] **Step 1: Failing test — drift**

```ts
// apps/workflow/src/hello-drift.test.ts
import { readFileSync, existsSync } from 'node:fs'
const src = new URL('../hello-src/.bffless/workflows/', import.meta.url)
const examples = new URL('../docs/spec/examples/', import.meta.url)
describe.skipIf(!existsSync(src))('spec examples mirror bffless/workflow-hello at hello.ref', () => {
  for (const file of ['hello.workflow.yaml', 'interactive.workflow.yaml']) {
    it(file, () => { expect(readFileSync(new URL(file, examples), 'utf8')).toBe(readFileSync(new URL(file, src), 'utf8')) })
  }
})
```
(runs under `test:stage`, after `pnpm stage` populated `hello-src/`).

- [ ] **Step 2: `stage-hello.mjs` becomes a checkout + build**

```js
// apps/workflow/scripts/stage-hello.mjs — clone bffless/workflow-hello at hello.ref, build it, land dist/ in hello-dist/
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const ref = readFileSync(join(appDir, 'hello.ref'), 'utf8').trim()
const src = join(appDir, 'hello-src')
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(appDir, 'hello-dist')
const repo = process.env.WORKFLOW_HELLO_REPO ?? 'https://github.com/bffless/workflow-hello.git'
if (!existsSync(src) || execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim() !== ref) {
  rmSync(src, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', repo, src], { stdio: 'inherit' })
  execFileSync('git', ['-C', src, 'checkout', '--quiet', ref], { stdio: 'inherit' })
}
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: src, stdio: 'inherit' })
execFileSync('pnpm', ['build'], { cwd: src, stdio: 'inherit' })
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
cpSync(join(src, 'dist'), out, { recursive: true })
console.log('staged', join(out, '.bffless/workflows/index.json'), 'from', repo, '@', ref)
```
`WORKFLOW_HELLO_REPO` lets a local path stand in (`file:///…/workflow-hello`) when iterating on both repos.

- [ ] **Step 3: Update the fences and the deploy** — `rules.fence.test.ts` lists only `workflow`; `hello-stage.test.ts` asserts `index.json` has `impl: 'hello'`, ≥2 workflows, every listed island/script file exists; `deploy-workflow.yml` per the file list; the MSW island route (`import.meta.glob('../../hello-dist/islands/*.html')`) is unchanged — `hello-dist/` has the same shape.
- [ ] **Step 4: Verify** — `pnpm --filter workflow stage && pnpm --filter workflow build && pnpm --filter workflow test:run && pnpm --filter workflow test:stage && pnpm --filter workflow test:e2e` (the hello + interactive smokes pass against the mock backend exactly as before), `pnpm apps:check`, `bffless rules validate apps/workflow/.bffless/proxy-rules/workflow`.
- [ ] **Step 5: Commit + PR** — `refactor(workflow): hello lives in bffless/workflow-hello`. After merge the deploy no longer touches hello; confirm `workflow.j5s.dev` still lists hello (published by Task 6) and a hello run succeeds as `workflow-ci`. Write the M1 Decision 2 closure into the epic comment.

---

# Phase 3a — Sandboxed script Workers, interactive-step clocks, `workflow.sign`

> **As shipped (2026-08-28, epic #359 Phase 3a).** Built in worktree `workflow-m3-3a` on branch
> `feat/workflow-m3-sandbox-clocks-sign` (not the names below); apps#408 merged as `d8a9131`, with
> `bffless/workflow-hello#3` and the `hello.ref` follow-up apps#409 (`f389504`). The tasks below are
> the plan as written; these came out differently, and later phases must use the shipped values:
>
> - **The sign rule ships at `order: 19`, not 22.** `order: 22` collides with
>   `/api/uploads/workflows/[...path]`: `bffless rules validate` warns, and CE picks the first match
>   by `order`, so the clash is a real ambiguity rather than a cosmetic one (R56).
> - **"Local-FS cannot presign (501)" is DISPROVED** (R57). CE's `LocalStorageAdapter.getUrl` *does*
>   presign — an HMAC `/api/storage/presigned/local?key=…&exp=…&sig=…`; no 501 path exists anywhere.
>   The real caveat is that that URL is **relative unless `PUBLIC_ORIGIN` is set**, and a relative
>   `src` has nothing to resolve against inside an opaque-origin `srcdoc` frame. So a local-storage
>   install must set `PUBLIC_ORIGIN` for island media to load; bucket storage (GCS/S3 — j5s.dev is
>   GCS) needs nothing. Spec 06, `apps/workflow/bffless/README.md` and the rule's own description
>   say this now.
> - **`hello.ref` moved twice:** `1b7f460` → `9bea638` (the *unmerged* head of workflow-hello#3,
>   taken deliberately so the staged bundle carried the new island) → **`195b5a2`**, workflow-hello's
>   `main` after that PR merged — the value in the tree. A ref that names a PR head is reachable only
>   while that branch lives: never delete a branch `hello.ref` still points at.
> - **hello gained a second viewer output, `poster_view`** (R51): a `render: island` output over
>   `islands/line-viewer.html` that signs an `image/*` File ref and renders it, JSON otherwise. It is
>   what proves `workflow.sign` with a real image. Live proof on `workflow.j5s.dev`: the viewer's
>   `<img src>` is a `storage.googleapis.com` presigned URL (`X-Goog-Expires=3600`) that decodes
>   640×360 and fetches credential-less. The `island-sign-error` testid lives in **hello's** DOM, not
>   the harness's (R52).
> - **The bootstrap frame keeps the page's port** (R42/R43). The plan's frame transfers `e.ports[0]`
>   to the Worker and then uses the same port for `w.onerror` — but a transferred port is neutered,
>   so nothing would ever arrive. As built, the frame hands the port to the Worker and reports spawn
>   failures and `worker.onerror` to the page with
>   `parent.postMessage({ t: 'sandbox-error', message }, '*')`; `createSandboxWorker` listens on
>   `window`, filtered on `event.source === frame.contentWindow` and removed on dispose. The data
>   path is still one hop. A frame-reported worker error carries no code, so `ScriptHost` maps it
>   `progressed ? 'SCRIPT' : 'SCRIPT_LOAD'` exactly as `worker.onerror` did.
> - **The spawn seam is async and crosses source text, not URLs** (R44):
>   `ScriptHostDeps.spawn = (a: { shimSource; moduleSource; signal }) => Promise<WorkerLike>`, with
>   `createSandboxWorker` re-exported as `DEFAULT_SPAWN` so the "default spawn by name" test asserts
>   identity. Both `data:` URLs are minted **inside** the frame. A second `AbortController` guards
>   the spawn itself (an abort mid-spawn leaked the frame), and the error taxonomy moved into
>   `src/scripts/errors.ts` to break an import cycle.
> - **`headless.ts` shipped `headlessMode`, `budgetMs`, `waitBudgetMs` and
>   `HEADLESS_AUTO_DEFAULT_MS` only** — `skipOutputs` was deliberately deferred to Phase 3b, where it
>   lands as `evaluateSkipOutputs` alongside `step.skipped.outputs` (R47).
> - **No `store/formLaunch.ts`, and no `clock` on `IslandLaunchDeps`** (R45/R46): the `form` branch
>   stays inline in `runnerMiddleware.ts` and the wait clock arms from the `runEvent` listener for
>   both interactive kinds. The form-clock tests are `src/store/runnerMiddleware.form.test.ts`.
> - **Replay keeps a form's `queued → waiting` shape** (R48/R49): a `waiting` row replays as
>   `step.waiting { at: startedAt }` and never emits `step.started`, and the `step.waiting` row write
>   always carries the reduced step's `startedAt`. Accepted consequence (R55): a submitted form now
>   shows a wait duration — how long the person took — which is what Decision 10's `startedAt` means.
>   No testid moved.
> - **The `sign` dep is built once and shared** (R50): `islands/hostDeps.ts` `signFile(http)` (POST
>   `/api/workflow/files/sign`, client-gated to `workflows/`), passed by both `islandLaunch` **and**
>   `IslandView`, so a `render: island` viewer signs through the same path a step's island does. The
>   MSW mock answers an **absolute** URL and the e2e asserts the `<img src>` carries `?signed=mock`
>   rather than that the image decoded — MSW's service worker cannot serve an opaque-origin frame
>   (R53).
> - **`hostContext.bffless.headless` is delivered in the `ui/initialize` *result*.** The View's
>   `tool-input` zod schema strips unknown keys, so a flag cannot ride `_meta` there; `hostContext`
>   is `.passthrough()` on both `McpUiHostContextSchema` and the initialize result. `tool-input`
>   carries no `_meta` at all, and `ui/notifications/initialized` has empty params — it can carry
>   nothing. Later changes go out as `ui/notifications/host-context-changed`.
> - **Gotcha that cost a process slip:** a fresh `apps` worktree must run
>   `pnpm --filter @bffless/workflow-lint build` before any workflow test — otherwise the workflow
>   suite reports "no tests" and a verify chain that greps for failures reads that as green.

Harness-only, no UI-contract change. Worktree `workflow-m3-harness-a`, branch `feat/workflow-sandbox-clocks-sign`.

### Task 8: The script Worker runs inside a sandboxed iframe (Decision 4)

**Files:**
- Create: `apps/workflow/src/scripts/sandbox-frame.ts` (the bootstrap HTML text + `createSandboxWorker`), `apps/workflow/src/scripts/sandbox-frame.test.ts`
- Modify: `apps/workflow/src/scripts/ScriptHost.ts:129-134,319-336` (spawn seam), `apps/workflow/src/scripts/worker-shim.ts` (port handshake), `apps/workflow/src/scripts/rpc.ts` (`ToWorker` gains `{ t: 'port' }`), `apps/workflow/src/scripts/rpc.test.ts` (shim rules), `apps/workflow/docs/spec/03-step-kinds.md:129-156` (the open item closes), `apps/workflow/bffless/README.md` (Scripts section)
- Test: `apps/workflow/src/scripts/ScriptHost.test.ts` (existing fakes keep working through the `spawn` seam), `apps/workflow/e2e/interactive.spec.ts` (the poster script still runs in real Chromium)

**Interfaces:**
- Produces: `createSandboxWorker(a: { shimSource: string; moduleSource: string; signal: AbortSignal }): Promise<{ port: MessagePort; dispose(): void }>` — mounts a hidden `<iframe sandbox="allow-scripts" srcdoc=…>`, posts `{ shim, module }` as `data:` URLs plus `port2` of a `MessageChannel`; the frame spawns `new Worker(shimDataUrl, { type: 'module' })` and forwards the port; resolves once the Worker acknowledges on the port. `ScriptHostDeps.spawn` becomes `(a: { shimSource, moduleSource, signal }) => Promise<WorkerLike>` where the returned `WorkerLike` wraps the port (`postMessage`/`onmessage`/`terminate` = dispose the frame).

- [ ] **Step 1: Failing tests** — `sandbox-frame.test.ts` (jsdom): `bootstrapHtml()` contains no external URL and no `allow-same-origin`; `createSandboxWorker` rejects with `SCRIPT_LOAD` when the frame posts `{ t: 'error' }`; `rpc.test.ts` gains "the shim listens on a port after `{ t: 'port' }` and never reads `self.onmessage` for `run`". `ScriptHost.test.ts`: the default `spawn` is `createSandboxWorker` (assert the deps default by name).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement**

```ts
// apps/workflow/src/scripts/sandbox-frame.ts
/**
 * The script step's sandbox (plan Decision 4): a hidden `sandbox="allow-scripts"` iframe — an
 * opaque origin, exactly what islands get (04) — that spawns the step's Worker from `data:` URLs.
 * Spiked 2026-08-27: a `data:` module Worker created *there* has origin `null` in Chromium and
 * Firefox (relative fetch throws, absolute fetch is CORS-refused, no cookies); created from the
 * page, Chromium would give it the page's origin. The page and the Worker share one
 * `MessageChannel`, so the `ctx.files.fetch` relay is still one hop.
 */
export const BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', (e) => {
  if (!e.data || e.data.t !== 'spawn' || !e.ports[0]) return
  let w
  try { w = new Worker(e.data.shim, { type: 'module' }) }
  catch (err) { e.ports[0].postMessage({ t: 'error', code: 'SCRIPT_LOAD', message: String(err) }); return }
  w.onerror = (ev) => e.ports[0].postMessage({ t: 'error', code: 'SCRIPT_LOAD', message: ev.message || 'worker error' })
  w.postMessage({ t: 'port', moduleUrl: e.data.module }, [e.ports[0]])
})
</script>`

const dataUrl = (js: string) => 'data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(js)))

export function createSandboxWorker(a: { shimSource: string; moduleSource: string; signal: AbortSignal }): Promise<WorkerLike> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true'); frame.style.display = 'none'
    const channel = new MessageChannel()
    const dispose = () => { channel.port1.close(); frame.remove() }
    frame.onload = () => {
      frame.contentWindow?.postMessage({ t: 'spawn', shim: dataUrl(a.shimSource), module: dataUrl(a.moduleSource) }, '*', [channel.port2])
    }
    frame.srcdoc = BOOTSTRAP_HTML
    document.body.append(frame)
    // The shim answers { t: 'ready' } on the port once it has the module URL; until then nothing else may arrive.
    channel.port1.onmessage = (e) => {
      if (e.data?.t === 'ready') resolve(portWorker(channel.port1, dispose))
      else if (e.data?.t === 'error') { dispose(); reject(new ScriptError('SCRIPT_LOAD', e.data.message)) }
    }
    a.signal.addEventListener('abort', () => { dispose(); reject(abortError('script: cancelled while spawning')) }, { once: true })
  })
}
```
`portWorker(port, dispose): WorkerLike` maps `postMessage` → `port.postMessage`, `onmessage` → `port.onmessage`, `terminate` → `dispose()`. The shim (`worker-shim.ts`): `self.onmessage = (e) => { if (e.data?.t === 'port') { port = e.ports[0]; moduleUrl = e.data.moduleUrl; port.onmessage = (ev) => handle(ev.data); post({ t: 'ready' }) } }` where `post` now writes to `port`; `run(msg)` imports `moduleUrl` (the `data:` URL — `import()` of a `data:` module works in both browsers, spike). `ScriptHost.run` no longer mints Blob URLs: it fetches the module text as today and calls `spawn({ shimSource: SHIM_SOURCE, moduleSource: module.text, signal })`, then posts `{ t: 'run', inputs }`. `fetchBytes` stays on the page (cookies), unchanged.

Spec 03's `script` section replaces its last two bullets: "The Worker has an **opaque origin** (spawned from `data:` URLs inside a sandboxed iframe, the same sandbox islands get): no cookies, a relative `fetch` throws, an absolute one is refused by CORS — `ctx.files.fetch` is the only way to bytes. COOP/COEP stays undecided; nothing in M3 needs threads."

- [ ] **Step 4: Verify** — unit suite; `pnpm --filter workflow stage && pnpm --filter workflow test:e2e` (real Chromium runs hello's `poster-card.js` through the sandbox); in devtools on `localhost:4680/?mocks=on` a script step shows exactly one hidden iframe that is removed on completion.
- [ ] **Step 5: Commit** — `feat(workflow): script Workers run in an opaque-origin sandbox`.

### Task 9: Clocks for `island` and `form` steps (Decision 10)

**Files:**
- Create: `apps/workflow/src/lib/runner/headless.ts` (`headlessMode`, `budgetMs`, `HEADLESS_AUTO_DEFAULT_MS = 300_000`), `apps/workflow/src/store/waitClock.ts` (`armWaitClock`), tests for both
- Modify: `apps/workflow/src/lib/runner/reducer.ts` (`step.waiting` sets `startedAt ??= at`), `apps/workflow/src/lib/runner/rows.ts` (`step.waiting` write includes `startedAt` when newly set), `apps/workflow/src/store/islandLaunch.ts:64-68` (`IslandLaunchDeps.clock: Clock`), `apps/workflow/src/store/runnerMiddleware.ts:80-86,786-830` (pass the clock; arm on `step.waiting` for both kinds; re-arm in the `runReplaced` resume path), `apps/workflow/src/components/graph/StepChip.tsx:36-45` (import `headlessMode` from the lib)
- Test: `apps/workflow/src/lib/runner/reducer.test.ts`, `apps/workflow/src/store/runnerMiddleware.island.test.ts`, `…form.test.ts` (new cases), `src/lib/runner/headless.test.ts`

**Interfaces:**
- Produces: `armWaitClock(a: { step, key, state, clock, headless, scoped, now, getRunState }): () => void` — returns the disarm; fires `step.failed` with `TIMEOUT` (interactive) or `HEADLESS_TIMEOUT` (headless), via the scoped dispatch, only while the step is still `waiting`; the budget is `budgetMs(step) ?? (headless ? HEADLESS_AUTO_DEFAULT_MS : undefined)` minus `now - startedAt`.

- [ ] **Step 1: Failing tests**

```ts
// reducer.test.ts
it('step.waiting stamps startedAt when the step never ran (a form)', () => {
  const s = reduce([queued('confirm/0/review', 'form'), { type: 'step.waiting', key: 'confirm/0/review', inputs: {}, at: 1_000 }])
  expect(s.steps['confirm/0/review'].startedAt).toBe(1_000)
})
// runnerMiddleware.form.test.ts
it('a form with timeout-minutes fails TIMEOUT when nobody submits', async () => {
  const { store, clock } = harness(withForm({ 'timeout-minutes': 1 }))
  await driveTo('confirm/0/review', 'waiting')
  clock.advance(60_000)
  expect(stepState('confirm/0/review')).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } })
})
it('a headless auto island with no timeout-minutes gets the 5-minute default and HEADLESS_TIMEOUT', …)
it('a submitted form disarms the clock (no failure after advance)', …)
it('resume re-arms from startedAt: a budget spent while the tab was away fails at once', …)
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `headless.ts`:

```ts
export type HeadlessMode = 'skip' | 'auto'
export function headlessMode(step: Step): HeadlessMode | undefined { /* StepChip.tsx:36-45 moved verbatim */ }
export function skipOutputs(step: Step): Record<string, unknown> { const h = step.raw?.headless as unknown; return h !== null && typeof h === 'object' && isPlainObject((h as { outputs?: unknown }).outputs) ? (h as { outputs: Record<string, unknown> }).outputs : {} }
export function budgetMs(step: Step): number | undefined { const m = (step.raw ?? {})['timeout-minutes']; return typeof m === 'number' ? m * 60_000 : undefined }
export const HEADLESS_AUTO_DEFAULT_MS = 5 * 60_000
export function waitBudgetMs(step: Step, headless: boolean): number | undefined { return budgetMs(step) ?? (headless ? HEADLESS_AUTO_DEFAULT_MS : undefined) }
```
`waitClock.ts` mirrors `scriptLaunch.ts:229-243` (a `deps.clock.sleep(remaining, timer.signal)` whose resolution checks `getRunState()?.steps[key]?.status === 'waiting'` before dispatching `step.failed { code: headless ? 'HEADLESS_TIMEOUT' : 'TIMEOUT', message: 'the step exceeded its `timeout-minutes` budget' }`). The middleware arms it in the `runEvent` listener on every `step.waiting` for `form`/`island` steps (and in `runReplaced` for rows that replay to `waiting`), disarms on the step's terminal event (`TERMINAL_STEP_EVENTS`) and in `finishRunCleanup`. `IslandLaunchDeps` gains `clock: Clock` (`islandDeps()` passes `deps.clock`); nothing else in `islandLaunch` changes — the clock is armed by the middleware, not the launcher, so a resumed island and a fresh one share one path.
- [ ] **Step 4: Verify** — unit suite green; hello's interactive smoke unchanged (no `timeout-minutes` on its interactive steps).
- [ ] **Step 5: Commit** — `feat(workflow): timeout-minutes for island and form steps`.

### Task 10: `workflow.sign` — signed media URLs for islands (Decision 6)

**Files:**
- Create: `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/files/sign/post/{rule.yaml,confine.fn.js}`
- Modify: `apps/workflow/src/lib/runner/adapters/island.ts` (`HOST_TOOLS` + `'workflow.sign'`/`'workflow/sign'`), `apps/workflow/src/islands/IslandHost.ts:435-447` (route the host tool to `deps.sign`), `IslandHostDeps` (`sign: (path: string) => Promise<{ url: string; expiresIn: number }>`), `apps/workflow/src/store/islandLaunch.ts` (`sign` = `POST /api/workflow/files/sign` through `http`, gated: the path must start with `workflows/`), `apps/workflow/src/mocks/handlers.ts` (mock answers `{ url: '/api/uploads/' + path + '?signed=mock', expiresIn: 3600 }`), `apps/workflow/docs/spec/04-islands.md` (mapping table row + tool list), `docs/spec/06-…md` (files trio → "files quartet": `sign`), `docs/adr/0002-…md` (host tools list), `apps/workflow/bffless/README.md` (rule row; local-FS note), `apps/workflow/src/rules.fence.test.ts` (count)
- Test: `island.test.ts` (`resolveToolName('x', 'workflow.sign')` → host tool), `IslandHost.test.ts` (a `tools/call workflow.sign` returns `structuredContent.url`; a path outside `workflows/` is a tool error), `hello`'s `line-viewer` island (workflow-hello repo, small follow-up PR: when the value is a File ref with `image/*`, call `workflow.sign` and render `<img>` — the live proof)

- [ ] **Step 1: Failing tests** per the list above.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — the rule:

```yaml
# rules/api/workflow/files/sign/post/rule.yaml
targetUrl: pipeline
order: 22
pipeline:
  name: Sign workflow file
  description: "POST { path } -> { url, expiresIn }: a presigned GET for an object under the harness prefix (workflows/…), so a sandboxed island (opaque origin, no cookie) can play media (plan Decision 6). Range on the presigned URL is the bucket's; local-FS storage cannot presign (501)."
  steps:
    - id: confine
      name: confine
      handler: function_handler
      code: ./confine.fn.js
    - id: refuse
      name: refuse
      handler: response_handler
      config:
        condition: steps.confine.notOk
        body: '{"error":"path must be an uploads-relative key under workflows/ with no traversal"}'
        status: 400
        contentType: application/json
    - id: sign
      name: sign
      handler: signed_url
      config:
        condition: steps.confine.ok
        path: steps.confine.storagePath
        expiresIn: 3600
    - id: respond
      name: respond
      handler: response_handler
      config:
        condition: steps.confine.ok
        body: '{"url":"{{{steps.sign.url}}}","expiresIn":3600}'
        status: 200
        headers: { Cache-Control: no-store }
        contentType: application/json
  validators:
    - type: auth_required
      config: { allowApiKey: true }
description: "Files quartet 4/4: sign a run/inputs object for a sandboxed island's <video>/<audio>/<img>."
```
```js
// confine.fn.js — mirrors Studio's uploads/sign/resolvePath.fn.js, narrowed to the harness prefix
function handler({ request, deployment }) {
  var body = (request && request.body) || {}
  var path = typeof body.path === 'string' ? body.path.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0] : ''
  var ok = path.indexOf('workflows/') === 0 && path.indexOf('..') === -1 && path.indexOf('//') === -1
  return { ok: ok, notOk: !ok, storagePath: ok ? deployment.owner + '/' + deployment.repo + '/uploads/' + path : '' }
}
```
(M2 Phase 3 established that a `response_handler.status` must be a literal and that multi-branch rules need `condition:` per step — this rule follows the delete rule's shape.) Host side: `HOST_TOOLS` maps `workflow.sign`/`workflow/sign` → `{ kind: 'host', tool: 'sign' }`; `IslandHost` answers `tools/call` for it with `{ structuredContent: { url, expiresIn }, content: [{ type: 'text', text: url }] }`, or `isError` with the rule's 400 text. Viewer sessions may call it too (a `render: island` viewer showing a video needs it).
- [ ] **Step 4: Verify** — unit suite; `bffless rules validate apps/workflow/.bffless/proxy-rules/workflow`; in the mock, the interactive smoke's `line-viewer` still renders (the mock signs); `pnpm apps:check`.
- [ ] **Step 5: Commit** — `feat(workflow): workflow.sign host tool and the files sign rule`.

### Task 11: The headless channel — `hostContext.bffless` (Decision 7)

**Files:**
- Modify: `apps/workflow/src/islands/IslandHost.ts:26-29,583-589,729-734` (add `bffless: { headless }` to `hostContext`; delete the `_meta` stamp and the header note), `apps/workflow/docs/spec/04-islands.md:22,100-110`, `docs/spec/07-headless.md:38-49`, `docs/adr/0002-…md:26-27`
- Test: `apps/workflow/src/islands/IslandHost.test.ts` (the fake island's `getHostContext().bffless.headless` is `true` when mounted headless; `tool-input` carries no `_meta.bffless`)

- [ ] **Step 1: Failing test** — via `fakeIsland.ts`: mount with `headless: true`, after `connect` assert `app.getHostContext()` has `bffless: { headless: true }`; assert the captured `tool-input` params have no `_meta`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** —

```ts
      const hostContext = {
        theme: currentTheme(), displayMode: 'inline', availableDisplayModes: [...DISPLAY_MODES], platform: 'web',
        containerDimensions: containerDimensions(iframe),
        // Plan Decision 7: the View's tool-input schema strips `_meta`, but hostContext is passthrough.
        bffless: { headless: a.headless },
      } as McpUiHostContext & { bffless: { headless: boolean } }
```
`sendToolInput` sends `{ arguments: args }` only. Spec 04 Headless paragraph becomes: "When `run.headless`, the host sets `hostContext.bffless.headless = true` (delivered on `ui/initialize`, readable as `app.getHostContext().bffless`); a `headless: auto` island must `workflow.submit` on its own within its budget (Decision 10) or fails `HEADLESS_TIMEOUT`." 07's note is replaced by the same sentence; ADR-0002's `_meta.bffless.headless` sentence is corrected.
- [ ] **Step 4: Verify** — unit suite.
- [ ] **Step 5: Commit, then the Phase 3a gate + PR** — `pnpm --filter workflow lint && pnpm --filter workflow build && pnpm --filter workflow test:run && pnpm --filter workflow stage && pnpm --filter workflow test:stage && pnpm --filter workflow test:e2e && pnpm apps:check && bffless rules validate apps/workflow/.bffless/proxy-rules/workflow`; PR `feat(workflow): sandboxed script Worker, interactive-step clocks and workflow.sign`. After the merge/deploy: a hello interactive run on `workflow.j5s.dev` still completes (the poster script now runs sandboxed — the **Cloudflare `no-transform` header rule for `**/scripts/*.js` is still required**: the page fetches the module text).

---

# Phase 3b — Headless execution and the driver CLI

> **As shipped (2026-08-28, epic #359 Phase 3b).** Built in worktree `workflow-m3-3b` on branch
> `feat/workflow-m3-headless` off `f389504` — Tasks 12–16 in one monorepo PR. The tasks below are
> the plan as written; these came out differently, and Phase 4 must use the shipped values:
>
> - **No `src/store/formLaunch.ts`** (R59, following 3a's R45): the `form` branch stayed inline in
>   `runnerMiddleware.ts` and gained the headless auto-submit there. Three helpers sit above
>   `handleNextAction` — `joinFieldErrors`, `headlessDecision(scope)` (`{act:'run'|'skip'|'fail'}`,
>   returning `run` immediately for an interactive run and for every kind that is not
>   `form`/`island`, so interactive behaviour never touches any of it) and `autoSubmitForm` (one
>   microtask after `step.waiting`, re-reading run state, through `completeFormStep` — the same path
>   a person's click takes). `evaluateSkipOutputs` takes **one** argument, the `StepScope`. A
>   `HEADLESS_REQUIRED` run annotation is dispatched **before** `step.failed`, so `run.finished`
>   rolls it into the run row's annotation counts.
> - **A skip's outputs are validated per kind** (R60): a `form`'s declared map is its *evaluated*
>   fields (`formFieldDefs`, untyped ⇒ `string`), an `island`'s is `outputDecls(step)` (untyped ⇒
>   `json`). Every declared name is evaluated even if an earlier one throws, so all bad names are
>   reported at once; a throwing expression is reported as that name's field error.
> - **A `choice` over File refs is picked by *path*** (R61), so a skip value that *is* a ref is
>   normalised to its `path` before validation and upgraded back to the ref afterwards. Without it
>   hello's live `review/confirm` skip (`cover: ${{ needs.card.outputs.posters[0] }}`) fails
>   `HEADLESS_SKIP`. The validate+upgrade was extracted out of `completeFormStep` as
>   `validateFormOutputs` / `withOptionPaths` in `adapters/form.ts`, so a submit and a skip accept
>   and record identically.
> - **A `skipped` step that CARRIES outputs is a *producing* step** (R66): `jobOutcome` returns
>   `skipped` only when every step is skipped **and none carried outputs**. Without this hello's
>   one-step `review` job read `skipped`, `jobRef` nulled it, and a headless run's `outputs.cover`
>   was `null` where the interactive run's was the File ref — a headless/interactive difference the
>   spec forbids. Scheduling follows: such a job satisfies `needs` as `success`. An `if:`-skipped
>   step still carries nothing and still nulls its job, unchanged.
> - **A skip's outputs take the same `{"$file"}` offload path as a succeeded step's**, which
>   required moving the step's `AbortController` registration **above** the skip dispatch:
>   `offloadController` hands back an already-aborted stand-in for an unregistered key, so without
>   the move every oversized skip's row would have been dropped silently as `{ ok: 'stale' }`.
> - **`invalid` covers six causes; only two render `kickoff-invalid`** — values that do not validate
>   and an `inputs` parameter that does not decode. A workflow that does not lint, a file that could
>   not be fetched, an unknown implementation/workflow and a failed discovery are **global-only**
>   and keep their existing screens. So a driver waits on `window.__workflow`, never on the testid
>   or on `run-status`: those four global-only causes are the likeliest ways a CI run goes wrong (a
>   typo'd alias, an unreachable instance). There is also a **publish seam** — between the kickoff
>   page's navigate and the run page's first publish there is one commit with no global at all, so a
>   driver polls for `runId` to appear rather than reading the global the instant navigation lands.
> - **`file` inputs are whole File refs, not paths.** Where the plan text says a `file` input is an
>   already-stored path, it is **wrong**: `validateValue('file', …)` → `isFileRef` requires all five
>   of `{ path, name, contentType, size, url }`, run inputs are stored verbatim, and nothing
>   materialises a path into a ref — a bare string fails validation like any other wrong-shaped
>   value. The driver uploads (`prepare` → PUT → `register`) and puts the registered ref in the URL.
>   `https://` values stay refused; the page fetches nothing a caller handed it.
> - **Headless island mounting is a *second* `RunPage` effect** (R65) guarded on
>   `sliceState.headless && isLive`: it selects the oldest `running|waiting` island whenever nothing
>   is selected or the selection has finished. The interactive claim-once effect (apps#370) is
>   byte-identical, so interactive behaviour is unchanged. The two effects' declaration order is
>   load-bearing in headless.
> - **Headless runs do not resume, and the harness leans on that.** A `headless: auto` **form** that
>   was `waiting` replays as `waiting` and nothing re-fires its auto-submit; because the wait clock
>   measures from the recorded `startedAt` rather than from when it was armed, a run adopted after
>   its budget has passed fails `HEADLESS_TIMEOUT` immediately. An **island** is the exception — the
>   resume path re-mounts a `waiting`/`running` island on its recorded inputs, so it reads
>   `hostContext.bffless.headless` again and submits itself. Re-running the workflow is the supported
>   answer either way; a person can still open the row and finish the step by hand.
> - **The driver's exit codes as shipped:** `0` succeeded · `1` the run `failed` or was `cancelled` ·
>   **`2` any driver-side fault** (usage, an unreadable `--inputs`, a refused login, a failed upload,
>   an unreadable API read, an unexpected exception) — deliberately never `1` · `3` the page refused
>   the start (`status: 'invalid'`) · `4` the driver timed out · `130` SIGINT, after Cancel was
>   clicked and the run reached `cancelled`. A **SIGTERM'd driver exits 2**, not 1 and not 130
>   (measured): Playwright's SIGTERM/SIGHUP handlers close the browser without exiting the process,
>   so the in-flight call rejects into the driver-fault branch and the run is left `running` — hence
>   `cancel-in-progress: false` on the dispatch workflow. Playwright's own SIGINT handler is
>   **disabled at launch** (`handleSIGINT: false`); it exits 130 before Cancel can be clicked. There
>   is no `--token` flag: a credential on a command line lands in process listings and CI logs.
> - **Every HTTP call is an in-page `fetch`, not `page.request`** — `page.request` bypasses the
>   service worker, and in `--mocks` mode the entire backend is MSW running as one. Bytes cross the
>   Node↔page bridge as base64. The one exception to `credentials: 'include'` is the
>   direct-to-bucket PUT, sent `same-origin` exactly as the harness's own upload does (`include`
>   cross-origin additionally needs `Access-Control-Allow-Credentials`, which typical S3/GCS CORS
>   does not set). `WORKFLOW_TOKEN` rides only on `/api/workflow/*` **GETs** — never a write,
>   because a CE API key is pinned to role `user` whoever owns it. `yaml` is a second runtime
>   dependency: the driver reads `on.manual.inputs` to learn which inputs are `file`.
> - **`run.json` is `{ run, steps }`** — the `/api/workflow/run?id=` record verbatim — so the status
>   is `run.json.run.status`, and the per-step verdicts read off `run.json.steps[].status` rather
>   than off the 1 s `steps.log` sampler. An output is downloaded when its **value** is a File ref
>   (there is no type information at that point), which is why `poster_view` is saved beside
>   `poster`. In a headless run `pick/0/choose` reaches **`succeeded`**, never `skipped` — it is
>   `headless: auto`, so the island really mounts and submits.
> - **The release wiring needed a THIRD file** beyond R63's two. `release-please-config.json` +
>   `.release-please-manifest.json` (seeded `0.0.0` ⇒ first release 1.0.0) + `release.yml`'s
>   `WORKFLOW_HEADLESS_TAG` env entry and jq map were not enough: `publish-workflow-lint.yml` carries
>   a hard-coded package allow-list, and its Build/Test steps were gated to `workflow-lint` by an
>   `if:` equality — a case-line-only fix would have published an **empty tarball whose `bin` points
>   at a missing `dist/cli.js`**. As shipped those steps ask the checked-out `package.json` whether
>   it has a `build` / `test:run` script (an `if:` expression cannot read a file, so the decision
>   moved into the shell), and a package-agnostic **"Verify every bin target exists"** step sits
>   between Build and Test (R69) — closing the failure *class*, not just its instance. The file keeps
>   its `publish-workflow-lint` name because `release.yml` calls it by path.
> - **The dispatch workflow uses the repo's existing secrets** `WORKFLOW_EMAIL` / `WORKFLOW_PASSWORD`
>   (member `workflow-ci@bffless.app`), not the plan's `WORKFLOW_CI_*` (R62).
>   `.github/workflows/workflow-headless-run.yml` is `workflow_dispatch`-only; every input reaches
>   the shell through `env:`, never interpolated into a `run:` string; `timeout_minutes` is a
>   **string** input (digits only) so `fromJSON` is defined, and the job ceiling is
>   `fromJSON(inputs.timeout_minutes) + 10`.
> - **There is no `bffless/run-workflow` GitHub Action.** Spec 07 promised one; what shipped is the
>   repo-local dispatch workflow above plus `apps/workflow/e2e/headless.spec.ts` — the built driver
>   spawned with `execFile` against Playwright's own `webServer` in `--mocks` mode, with no `page`
>   fixture. It **fails loudly** (never skips) when `packages/workflow-headless/dist/cli.js` is
>   missing (R64). From M3 the headless CLI *is* the e2e. The Action remains a follow-up.
> - **CI order** (R64): install → workflow-lint build → workflow lint → stage → build → **driver
>   build** → driver lint + `test:run` → `test:run` → `test:stage` → playwright install chromium →
>   `test:e2e`.
> - **`pnpm --filter workflow build` (`tsc -b`) belongs in every verify chain** (R70): vitest
>   transpiles without typechecking, so a red `tsc -b` sat on committed Task-12/13 code for two
>   tasks and was only found when Task 15 wired the CI that runs it.

Worktree `workflow-m3-harness-b`, branch `feat/workflow-headless`.

### Task 12: `headless: skip | auto | none` at run time (Decision 11)

**Files:**
- Modify: `apps/workflow/src/lib/runner/types.ts` (`step.skipped` gains `outputs?`; `StepState.outputs` already exists), `reducer.ts` (`step.skipped` stores `outputs`), `rows.ts` (`eventToWrites` writes `outputs` on skip), `replay.ts` (a `skipped` row with outputs yields them), `apps/workflow/src/store/runnerMiddleware.ts:786-830` (the branches), `apps/workflow/src/store/formLaunch.ts` (new: `launchFormStep` = the form branch + headless auto-submit), `apps/workflow/src/lib/runner/headless.ts` (`evaluateSkipOutputs(step, scope): { ok: true; outputs } | { ok: false; errors }` using `validateDeclared`)
- Test: `reducer.test.ts`, `rows.test.ts`, `replay.test.ts`, `runnerMiddleware.headless.test.ts` (new)

- [ ] **Step 1: Failing tests**

```ts
// runnerMiddleware.headless.test.ts
it('headless skip: the step is skipped with its literal outputs and downstream expressions see them', …)
it('headless skip with a value that fails the declared map fails HEADLESS_SKIP', …)
it('headless auto form submits its defaults without a pane', …)  // step goes waiting → succeeded with formInitialValues
it('headless with no headless: fails HEADLESS_REQUIRED and annotates the run', …)
it('interactive runs ignore headless: entirely', …)
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — in `handleNextAction`'s `start` case, before the per-kind branches:

```ts
      if ((step.uses === 'form' || step.uses === 'island') && runState.headless) {
        const mode = headlessMode(step)
        const at = deps.clock.now()
        if (mode === undefined) {
          dispatch(runEvent({ type: 'step.started', key: a.key, inputs: {}, at }))
          dispatch(runEvent({ type: 'step.failed', key: a.key, error: { code: 'HEADLESS_REQUIRED', message: `step ${a.key} needs a person; declare headless:` }, at }))
          dispatch(runEvent({ type: 'run.annotation', annotation: { level: 'error', message: `step ${a.key} needs a person; declare headless:`, stepKey: a.key }, at }))
          return
        }
        if (mode === 'skip') {
          const scope = { step, key: a.key, job: a.job, index: a.index, def, state: runState }
          const skip = evaluateSkipOutputs(step, scope)
          if (!skip.ok) { /* started + failed HEADLESS_SKIP with the joined errors */ return }
          dispatch(runEvent({ type: 'step.skipped', key: a.key, job: a.job, index: a.index, stepId: a.stepId, kind: step.uses, outputs: skip.outputs, at }))
          return
        }
        // mode === 'auto': fall through — the step runs as when interactive; the clock (Task 9) bounds it.
      }
```
`step.skipped` for a headless skip is dispatched **instead of** `step.queued` (the reducer's `assertNewStep` holds — a skip is a creation event). The form branch moves to `formLaunch.ts`: after `step.waiting`, when `runState.headless && headlessMode(step) === 'auto'`, `void Promise.resolve().then(() => { const r = completeFormStep({ …scope, values: formInitialValues(scope), at: now() }); scoped(runEvent(r.ok ? r.event : failed('HEADLESS_FORM', Object.entries(r.errors).map(([f, m]) => `${f}: ${m}`).join('; ')))) })`. Islands in `auto` need no change here (Task 11 + 13).
- [ ] **Step 4: Verify** — unit suite (`replay` round-trips a skipped-with-outputs row).
- [ ] **Step 5: Commit** — `feat(workflow): headless skip/auto/required at run time`.

### Task 13: `?auto=1&inputs=`, `window.__workflow`, headless island mounting (Decision 12)

**Files:**
- Create: `apps/workflow/src/lib/autoStart.ts` (`decodeInputs(param): { ok: true; values } | { ok: false; error }`, `validateInputs(inputs, values): Record<string, string>` — the loop from `KickoffForm.tsx:71-86` extracted so both share it), `apps/workflow/src/lib/workflowGlobal.ts` (`publishWorkflowGlobal(snapshot | null)`, the `WorkflowGlobal` type), `apps/workflow/src/pages/KickoffPage.auto.test.tsx`, `apps/workflow/src/lib/autoStart.test.ts`, `apps/workflow/src/lib/workflowGlobal.test.ts`
- Modify: `apps/workflow/src/pages/KickoffPage.tsx` (auto mode), `apps/workflow/src/components/kickoff/KickoffForm.tsx:68-92` (use `validateInputs`), `apps/workflow/src/store/runnerActions.ts:24-33,54` (`StartRunArgs.headless?: boolean`), `apps/workflow/src/pages/RunPage.tsx` (the global effect; headless auto-select), `apps/workflow/docs/spec/07-headless.md` (Page contract rewritten to the shipped shape), `docs/spec/08-harness-ui.md:16`
- Test: `e2e/headless.spec.ts` (added in Task 15 — it needs the driver)

**Interfaces:**
- Produces: `window.__workflow: { runId: string; status: RunStatus | 'invalid'; currentSteps: string[]; outputs: Record<string, unknown>; steps: Record<string, StepStatus>; errors?: Record<string, string> } | undefined`.

- [ ] **Step 1: Failing tests** — `autoStart.test.ts`: `decodeInputs(base64url('{"greeting":"Hi"}'))` → ok; bad base64 / non-object → error. `KickoffPage.auto.test.tsx` (RTL + MSW): `?auto=1&inputs=<valid>` dispatches `startRun` with `headless: true` and navigates; `<invalid>` renders `kickoff-invalid` with the field errors and sets `window.__workflow.status === 'invalid'`. `workflowGlobal.test.ts`: `publishWorkflowGlobal` writes/clears `window.__workflow`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `KickoffPage`: `const auto = searchParams.get('auto') === '1'`; when `auto && loaded?.ok`, a `useEffect` (guarded by a `startedRef`) decodes `inputs`, runs `validateInputs(loaded.def.inputs, values)`; on errors → `setInvalid(errors)` + `publishWorkflowGlobal({ runId: '', status: 'invalid', currentSteps: [], outputs: {}, steps: {}, errors })`; else `handleStart(values, { headless: true })`. Rendering in auto mode: a `kickoff-auto` note ("Starting…") instead of the form, or the `kickoff-invalid` list. `startRun` passes `headless: a.headless ?? false`. `RunPage`: one `useEffect` on `[sliceState, mode]` calling `publishWorkflowGlobal(snapshotOf(sliceState))` (`currentSteps` = keys whose status ∈ `running|polling|waiting`), cleared on unmount; and, when `sliceState.headless && isLive`, an effect that sets `?step=` to the oldest `running|waiting` island key when none is selected or the selected one is terminal (replace, not push). 07 "Page contract" is rewritten: the start URL, `file` inputs = stored paths (the driver uploads), `invalid` = `kickoff-invalid` + the global, the global's exact shape, the three testids.
- [ ] **Step 4: Verify** — unit suite; manual: `localhost:4680/hello/interactive/run?auto=1&inputs=e30&mocks=on` (`e30` = `{}`) starts a run, the island auto-submits (workflow-hello's Task 6 code), the form is skipped, the run succeeds; `window.__workflow.status === 'succeeded'` in devtools.
- [ ] **Step 5: Commit** — `feat(workflow): auto-start page contract and window.__workflow`.

### Task 14: `packages/workflow-headless` — the driver CLI (Decision 13)

**Files:**
- Create: `packages/workflow-headless/package.json`, `tsconfig.json`, `src/cli.ts` (argv, exit codes), `src/args.ts` (parse + `usage`), `src/login.ts` (the relay login from `localdev-tools/workflow-live.mjs:49-63`), `src/upload.ts` (files trio for `file` inputs: prepare → PUT → register; values become File refs), `src/run.ts` (`runWorkflow(opts): Promise<RunReport>`), `src/observe.ts` (`waitForTerminal(page, { timeoutMs, onTransition })` polling `window.__workflow` every 1 s + `data-state`), `src/artifacts.ts` (write `run.json`, download outputs via `page.request`, `steps.log`, screenshots), `src/runs.ts` (`GET /api/workflow/runs?impl=&workflow=` → table), `test/{args,upload,observe,artifacts}.test.ts` (vitest; Playwright mocked through a `PageLike` seam), `README.md`
- Modify: root `package.json` (`workflow-headless:*` scripts), `pnpm-workspace.yaml` (already `packages/*`), `.github/workflows/workflow-app.yml` (build + test the package)

**Interfaces:**
- CLI: `workflow-headless run <harness-url> <impl>/<workflow> --inputs <file.json> [--out <dir>] [--timeout <60m>] [--mocks] [--headed]`; env `WORKFLOW_EMAIL`/`WORKFLOW_PASSWORD` (required unless `--mocks`), `WORKFLOW_TOKEN` (optional `X-API-Key` for `/api/workflow/*` reads). `workflow-headless runs <harness-url> <impl>/<workflow> [--last 10]`. Exit codes per Decision 13.

- [ ] **Step 1: Failing tests** — `args.test.ts` (parses the two commands, `--timeout 90m` → ms, missing inputs file → usage error 2); `upload.test.ts` (a `file` input string `./clip.mp4` is uploaded through a fake `request` and replaced by the returned File ref; a `list: true` file input maps each); `observe.test.ts` (a fake page whose `evaluate` returns successive `__workflow` snapshots: transitions are logged once each, terminal resolves, timeout rejects with code 4); `artifacts.test.ts` (`run.json` written, `file` outputs saved as `outputs/<name>.<ext>` from `contentType`).
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `run.ts`:

```ts
export async function runWorkflow(o: RunOptions, deps: { browser: BrowserLike; log: (l: string) => void }): Promise<RunReport> {
  const page = await deps.browser.newPage({ viewport: { width: 1280, height: 900 } })
  const base = o.harnessUrl.replace(/\/$/, '')
  if (!o.mocks) await loginViaRelay(page, base, o.credentials)          // login.ts
  const def = await fetchDefinition(page, base, o.impl, o.workflow)      // GET /w/<impl>/.bffless/workflows/<file> via page.request → inputs decls
  const values = await uploadFileInputs(page, base, o.impl, o.workflow, def.inputs, o.inputs)   // upload.ts
  const url = `${base}/${o.impl}/${o.workflow}/run?auto=1&inputs=${base64url(JSON.stringify(values))}${o.mocks ? '&mocks=on' : ''}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const started = await waitForStart(page)                              // __workflow.status running | invalid (→ exit 3 with errors)
  const terminal = await waitForTerminal(page, { timeoutMs: o.timeoutMs, onTransition: deps.log, onSigint: () => page.getByTestId('run-cancel').click() })
  return writeArtifacts(page, base, { runId: started.runId, status: terminal.status, out: o.out })
}
```
`cli.ts` maps `RunReport.status` → exit code; SIGINT handler triggers the Cancel click then exits 130 once `cancelled`. `package.json`: `"bin": { "workflow-headless": "dist/cli.js" }`, deps `playwright` (`^1.61`, uses `~/.cache/ms-playwright` Chromium; `--headed` for debugging), no other runtime deps.
- [ ] **Step 4: Verify** — `pnpm --filter workflow-headless test:run && pnpm --filter workflow-headless build`; then against the local mock harness: `pnpm --filter workflow dev --port 4680 &` and `node packages/workflow-headless/dist/cli.js run http://localhost:4680 hello/interactive --inputs <(echo '{}') --mocks --out /tmp/claude-1000/…/hl` → exit 0, `run.json` present, `outputs/poster.svg` saved.
- [ ] **Step 5: Commit** — `feat(workflow-headless): the Playwright driver CLI`.

### Task 15: The headless smoke is the e2e; CI + the dispatch workflow

**Files:**
- Create: `apps/workflow/e2e/headless.spec.ts`, `.github/workflows/workflow-headless-run.yml`
- Modify: `.github/workflows/workflow-app.yml` (build the driver; run the headless smoke), `apps/workflow/bffless/README.md` (M3 rows: headless contract, `workflow-ci` credentials as repo secrets), `apps/workflow/docs/spec/09-state-management.md` (already says it), `apps/workflow/package.json` (`test:e2e` includes the new spec)

- [ ] **Step 1: The smoke** — `headless.spec.ts` spawns the built CLI (`execFile('node', [cli, 'run', baseURL, 'hello/interactive', '--inputs', fixture, '--mocks', '--out', tmp])`), asserts exit 0, `run.json.status === 'succeeded'`, `steps.log` mentions `pick/0/choose → skipped|succeeded` and `review/0/confirm → skipped`, and `outputs/poster.svg` exists; a second case passes an invalid `inputs` (`{"greeting": 5}`) and asserts exit 3.
- [ ] **Step 2: `workflow-headless-run.yml`** (dispatch-only):

```yaml
name: Workflow headless run
on:
  workflow_dispatch:
    inputs:
      workflow: { description: '<impl>/<workflow>', required: true, default: 'hello/interactive' }
      inputs: { description: 'JSON inputs', required: true, default: '{}' }
      harness_url: { description: 'Harness origin', required: false, default: 'https://workflow.j5s.dev' }
      timeout_minutes: { description: 'Driver ceiling', required: false, default: '60' }
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: ${{ fromJSON(inputs.timeout_minutes) + 10 }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @bffless/workflow-lint build && pnpm --filter workflow-headless build
      - run: pnpm --filter workflow-headless exec playwright install chromium --with-deps
      - run: echo '${{ inputs.inputs }}' > inputs.json
      - run: node packages/workflow-headless/dist/cli.js run "${{ inputs.harness_url }}" "${{ inputs.workflow }}" --inputs inputs.json --out output --timeout "${{ inputs.timeout_minutes }}m"
        env: { WORKFLOW_EMAIL: ${{ secrets.WORKFLOW_CI_EMAIL }}, WORKFLOW_PASSWORD: ${{ secrets.WORKFLOW_CI_PASSWORD }} }
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: workflow-run-output, path: output/ }
```
Repo secrets `WORKFLOW_CI_EMAIL` / `WORKFLOW_CI_PASSWORD` — **ask the user** (the values live in `~/.config/bffless/workflow-ci.env` locally; `gh secret set` from there once they say yes).
- [ ] **Step 3: Gate + PR** — the Phase 3a gate plus `pnpm --filter workflow-headless test:run`; PR `feat(workflow): headless execution and the driver CLI`. After merge/deploy: dispatch `workflow-headless-run.yml` for `hello/interactive` on j5s → green, artifact has `run.json`; record the run URL in the README checklist.

### Task 16: Spec and docs sweep for Phase 3

**Files:** `apps/workflow/docs/spec/{03,04,05,07}.md`, `docs/adr/0002`, `apps/workflow/docs/writing-an-implementation.md` (a "Headless" section: declare `headless:` on every island/form, read `hostContext.bffless.headless`), `packages/workflow-headless/README.md`, `apps/workflow/README.md` (driver mention), `apps/workflow/CONTEXT.md` (glossary: sandbox, signed URL, driver).

- [ ] **Step 1:** Apply every amendment named in Tasks 8, 10, 11, 12, 13 that is not yet in the tree (grep the spec for `_meta.bffless`, `Blob URL`, `decide at M3`, `resume: poll-only` — each must be gone or rewritten). 05 Resume: replace the open `resume:` question with Decision 15's sentence.
- [ ] **Step 2:** Commit `docs(workflow): M3 headless, sandbox and sign amendments` (folds into the 3b PR if it is still open, else its own PR).

---

# Phase 4 — The Studio port: `apps/workflow-studio`

> **As shipped (2026-08-29, Phase 4a = Task 17 only).** Built in `repos/ce/.claude/worktrees/ffmpeg-frames-ops`,
> branch `feat/ffmpeg-frames-ops`, PR **bffless/ce#706**; docs **bffless/docs#72**, skills **bffless/skills#58**.
> Task 17 shipped `frames` + `contact_sheet` first, then was REWORKED when the user rejected `contact_sheet` as an
> operation (Decision 2). Later tasks must use these values:
>
> - **One op, `frames`.** `contact_sheet` does not exist. `FFMPEG_OPS` is five names. A contact sheet is
>   `draw` + `tile`; a title on a screenshot is one `time`, a `draw`, no `tile`.
> - **The caller computes `times` and the label text.** `planContactSheet`, its constants and `clockLabel` are NOT
>   in CE — `apps/workflow-studio/scripts/frame-times.ts` (Task 22) imports them from Studio through the workspace
>   dep. There is no `duration` field and no ffprobe job, so the source is downloaded once.
> - **`draw.text` syntax has three cases** and they bite: a bare path (`steps.plan.labels`) resolves; `{{…}}` does
>   NOT (it comes back a literal and fails); and a literal that *looks* like a path (`metadata.json` — `metadata`
>   really is an expression root) must be written as a **one-element array** to be drawn verbatim. An authored
>   array is always literals; a string is expression-or-literal by shape.
> - **`drawn` is the outcome, not the request** — false when the draw was off OR the ffmpeg had no `drawtext`.
>   The local `-filters` probe may only SUPPRESS a draw, and only for the `local` executor; a remote-only instance
>   still attempts it, with a one-shot retry on a `drawtext` failure.
> - **`-abort_on empty_output` is on the still command.** A `time` past the end used to write nothing silently,
>   which in tile mode produced a sheet of padding squares reported as success. Measured: ffmpeg 7.0.2 exit 0 → 234;
>   Alpine 8.1.2 (CE's image and the Worker) already exits 234. **Caveat:** the reported duration is not the last
>   frame's PTS — on a 5.000 s / 10 fps clip `-ss 4.9` captures and `-ss 4.99` aborts, so keep the last sample a
>   frame-interval clear of the end.
> - **`MAX_STILLS_PER_JOB = 200`** on `times.length`; a tiled step is up to 400 commands, each taking the local
>   runner's single slot — `postSteps` + a job row, always.
> - **No Worker redeploy** (envelope stays `v: 1`; scratch cells are bare relative names the Worker already passes
>   through with `cwd = scratch`). Neither executor nor `workers/ffmpeg/` was touched.
> - **Phase 4b is blocked** until ce#706 is merged, released, and j5s runs that release (`probe.ops` lists them).
>
> Two Phase 4b decisions settled here (user, 2026-08-29):
>
> - **The port is SERVER-ONLY** — no browser/wasm fallback. `studio.workflow.yaml`'s `executor` input is three
>   *server* placements. So the port must FAIL CLEARLY at kickoff when server video ops are off, rather than dying
>   mid-run; and the cut-editor island only PLAYS media through signed URLs, never captures to a canvas, so there
>   is no `crossOrigin`/bucket-CORS-for-canvas requirement.
> - **`auto` maps to OMITTING `executor`.** CE treats an unknown name as fatal (`unknown executor 'auto'`), so
>   `prep.fn.js` must not pass the choice value through. Note `auto` does NOT fail over: `defaultExecutor()` picks
>   `FFMPEG_EXECUTOR` if enabled else the first enabled (local before remote), and an unready one is
>   `FFMPEG_EXECUTOR_UNAVAILABLE` — a cold Cloud Run Worker is a failed step, not a quiet fall back to local.

CE first (Task 17, its own repo/PR/release), then the app. Worktrees `repos/ce/.claude/worktrees/ffmpeg-frames` (branch `feat/ffmpeg-frames-ops`) and `repos/apps/.claude/worktrees/workflow-studio` (branch `feat/workflow-studio`). The port's own e2e proof is Task 25 (Decision 22).

### Task 17: CE `ffmpeg_handler` op `frames`, with `draw` and `tile` (Decision 2)

**Files (repos/ce):** `pipelines/ffmpeg/ffmpeg-args.ts` (+ `buildFrameArgs` with a `FrameOverlay`, `buildTileArgs`), `pipelines/handlers/ffmpeg.handler.ts` (+ `runFrames`, `resolveTimes`, knob validation), `pipelines/execution/step-handler.interface.ts` (`FfmpegOperation`, `FfmpegDrawConfig`, `FfmpegTileConfig`, TSDoc), `pipelines/ffmpeg/ffmpeg-capability.service.ts` (`FFMPEG_OPS` + a `drawtext` filter probe), `pipelines/execution/expression-evaluator.ts` (export `EXPRESSION_ROOTS`), `mcp/tools/proxy-rules.tools.ts`, and the frontend `handlers/{types.ts,FfmpegHandlerConfig.tsx,HandlerConfigWrapper.tsx}` + a mirror-drift spec. Docs: `repos/docs docs/features/server-video-ops.md`; `repos/skills …/pipelines/SKILL.md`.

**Interface (as shipped):** `frames` — `input`, `times` (array or a BARE expression; the caller computes them), `outputPrefix`, `height?` (720), `quality?` (3), `draw?` `{ text (string | string[] | bare expression), position? (7-value enum), size? ([0.005,1], default 1/12), color?, background? }`, `tile?` `{ perSheet, columns? (3) }`, `executor?`. Output without `tile`: `{ frames: [{ time, storage_path, content_type, size }], count, drawn, …telemetry }`; with `tile`: `{ sheets: [{ storage_path, content_type, size, times, index, total, cols, rows }], count, drawn, …telemetry }`.

**Read the shipped code, not this summary, when authoring against it** — `step-handler.interface.ts`'s TSDoc is the authoritative reference.

### Task 18: `apps/studio` exports its pure libs; `apps/workflow-studio` scaffold

**Files:**
- Modify: `apps/studio/package.json` (`"exports": { "./lib/*": "./src/lib/*.ts", "./components/Studio/CutEditor": "./src/components/Studio/CutEditor.tsx", "./components/Studio/clipPlayer": "./src/components/Studio/clipPlayer.ts" }`), `apps/studio/CLAUDE.md` (a "consumed by workflow-studio" note: `lib/*` and `CutEditor` are a public surface now — keep them store-free)
- Create: `apps/workflow-studio/package.json`, `README.md`, `CLAUDE.md`, `CONTEXT.md` (short), `bffless/README.md` (both required headings; the manual list: domain `workflow-studio.<domain>` → alias with path `/`, no SPA fallback; `HF_TOKEN` + Replicate + Anthropic tokens on project `bffless/workflow`; server video ops enabled; the two `no-transform` header rules; bucket CORS; member role), `tsconfig.json`, `tsconfig.islands.json`, `tsconfig.scripts.json`, `vite.islands.config.ts` (hello's, re-rooted, React plugin added), `vite.scripts.config.ts` (lib mode: `build.lib = { entry: process.env.WORKFLOW_SCRIPT, formats: ['es'], fileName: () => '<name>.js' }`, `rollupOptions.output.inlineDynamicImports: true`, `target: 'es2022'`), `.bffless/proxy-rules/workflow-studio/ruleset.yaml`, `.bffless/proxy-rules/workflow-studio/schemas/workflow_studio_jobs.schema.yaml` (Studio's `studio_jobs` fields, new name, no `id:` — derived), `eslint.config.js`, `vitest.config.ts`
- Modify: root `package.json` (`workflow-studio:*` scripts), `.bffless/config.json` — **not** touched (rule-set isolation: the set lives in project `bffless/workflow`)

- [ ] **Step 1:** Scaffold; `package.json`:

```json
{ "name": "workflow-studio", "private": true, "version": "0.0.0", "type": "module",
  "scripts": { "stage": "node scripts/stage.mjs", "build": "node scripts/stage.mjs", "lint": "eslint .", "test": "vitest", "test:run": "vitest run", "typecheck": "tsc -p tsconfig.islands.json && tsc -p tsconfig.scripts.json" },
  "dependencies": { "@modelcontextprotocol/ext-apps": "^1.7.5", "@modelcontextprotocol/sdk": "^1.30.0", "zod": "^4.4.3", "react": "^19.2.6", "react-dom": "^19.2.6", "fflate": "^0.8.3", "studio": "workspace:*" },
  "devDependencies": { "@bffless/workflow-lint": "workspace:*", "@bffless/workflow-script": "workspace:*", "@vitejs/plugin-react": "^6.0.1", "vite": "^8.0.12", "vite-plugin-singlefile": "^2.3.3", "typescript": "~6.0.2", "vitest": "^4.1.7", "@types/react": "^19.2.14", "@types/react-dom": "^19.2.3", "@types/node": "^24.12.3", "eslint": "^10.3.0", "@eslint/js": "^10.0.1", "typescript-eslint": "^8.59.2", "globals": "^17.6.0" } }
```
- [ ] **Step 2:** `pnpm install`; `pnpm apps:check` passes with the README headings; `bffless rules validate apps/workflow-studio/.bffless/proxy-rules/workflow-studio` passes on the empty set (`ruleset.yaml` = `name: workflow-studio` + description).
- [ ] **Step 3: Commit** — `chore(workflow-studio): scaffold and Studio lib exports`.

### Task 19: `studio.workflow.yaml` — the port, as shipped

**Files:**
- Create: `apps/workflow-studio/.bffless/workflows/studio.workflow.yaml`
- Delete: `apps/workflow/docs/spec/examples/studio.workflow.yaml`; Modify: `.github/workflows/workflow-lint.yml:52-55` (lint the app's file with `--rules apps/workflow-studio/.bffless/proxy-rules/workflow-studio --path-prefix /api/workflow-studio`), `apps/workflow/docs/spec/00-overview.md:60` + `01-workflow-yaml.md` (Worked examples pointer), `packages/workflow-lint/test/examples.test.ts` (path)

- [ ] **Step 1: Write the YAML** (every `path` is served by a Task 20/21 rule; `rule-missing` enforces it):

```yaml
spec: 1
name: Long recording to published short
description: >
  Turn one or more long screen recordings into a short in your own recorded voice — cut-first,
  never re-voiced — plus a companion blog post and a cover image. The reference port of Studio.

on:
  manual:
    inputs:
      recordings: { type: file, accept: "video/*", list: true, required: true, maxSize: 5GB, label: Recordings }
      direction:  { type: string, format: textarea, label: Note to the director }
      write_blog: { type: boolean, default: true, label: Write a blog post }
      cover:      { type: boolean, default: true, label: Draw a cover }
      executor:   { type: choice, options: [auto, local, remote], default: auto, label: Video backend }

jobs:
  per-video:
    name: For each video
    strategy: { matrix: { video: "${{ inputs.recordings }}" }, max-parallel: 2 }
    steps:
      - id: audio
        name: Pull the audio out
        uses: pipeline
        with:
          path: video/extract-audio
          body: { source: "${{ matrix.video.path }}", outPrefix: "${{ step.prefix }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          wav: { type: file, value: "${{ response.result.path }}" }
      - id: transcribe
        name: Write the transcript
        uses: pipeline
        with: { path: transcribe, body: { audio: "${{ steps.audio.outputs.wav.path }}", diarize: false } }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 5s, timeout: 30m }
        outputs:
          words: { type: json, value: "${{ response.result.words }}", render: transcript }
          text:  { type: string, value: "${{ response.result.text }}" }
          timed: { type: string, value: "${{ response.result.timed }}" }
          duration: { type: number, value: "${{ response.result.duration }}" }
        summary: "Transcribed **${{ matrix.video.name }}** — ${{ length(steps.transcribe.outputs.words) }} words."
        annotations:
          - { level: warning, if: "${{ length(steps.transcribe.outputs.words) < 50 }}", message: "Very short transcript for ${{ matrix.video.name }} — is the audio silent?" }
      - id: sheets
        name: Grab still frames
        uses: pipeline
        with:
          path: video/contact-sheet
          body: { source: "${{ matrix.video.path }}", outPrefix: "${{ step.prefix }}", duration: "${{ steps.transcribe.outputs.duration }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          sheets: { type: file, list: true, value: "${{ response.result.paths }}", render: images }
          times:  { type: json, value: "${{ response.result.times }}" }
    outputs:
      source: { type: file, value: "${{ matrix.video }}" }
      words:  ${{ steps.transcribe.outputs.words }}
      timed:  ${{ steps.transcribe.outputs.timed }}
      duration: ${{ steps.transcribe.outputs.duration }}
      sheets: ${{ steps.sheets.outputs.sheets }}

  director:
    name: Director's take
    needs: per-video
    steps:
      - id: scenes
        uses: pipeline
        with:
          path: scenes
          body:
            timed:     ${{ needs.per-video.outputs.timed }}
            sheets:    ${{ pluck(needs.per-video.outputs.sheets, 'path') }}
            durations: ${{ needs.per-video.outputs.duration }}
            sources:   ${{ pluck(needs.per-video.outputs.source, 'path') }}
            direction: ${{ inputs.direction }}
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 5s, timeout: 15m }
        outputs:
          synopsis: { type: markdown, value: "${{ response.result.synopsis }}" }
          scenes:   { type: table, value: "${{ response.result.scenes }}", columns: [{key: title}, {key: source}, {key: start, type: number}, {key: end, type: number}] }
        summary: |
          ### Director's take
          ${{ steps.scenes.outputs.synopsis }}

          ${{ length(steps.scenes.outputs.scenes.rows) }} scenes proposed.
    outputs:
      synopsis: ${{ steps.scenes.outputs.synopsis }}
      scenes:   { type: json, list: true, value: "${{ steps.scenes.outputs.scenes.rows }}" }

  per-scene:
    name: For each scene
    needs: director
    strategy: { matrix: { scene: "${{ needs.director.outputs.scenes }}" }, max-parallel: 3, fail-fast: false }
    steps:
      - id: cut
        name: Cut the scene
        uses: pipeline
        with:
          path: video/slice
          body: { source: "${{ matrix.scene.source }}", spans: "${{ matrix.scene.spans }}", wantAudio: true, outPrefix: "${{ step.prefix }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          clip: { type: file, value: "${{ response.result.path }}" }
          wav:  { type: file, value: "${{ response.result.audioPath }}" }
          duration: { type: number, value: "${{ response.result.duration }}" }
      - id: inputs
        name: Scene inputs
        uses: script
        with:
          src: scripts/scene-inputs.js
          scene: ${{ matrix.scene }}
          words: ${{ needs.per-video.outputs.words[matrix.scene.sourceIndex] }}
          scenes: ${{ needs.director.outputs.scenes }}
        outputs:
          wordTimings: { type: string }
          previousContext: { type: string }
          sceneWords: { type: json }
      - id: refine
        name: Refine the cuts
        uses: pipeline
        with:
          path: refine-scene
          body:
            start: ${{ matrix.scene.start }}
            end: ${{ matrix.scene.end }}
            audio: ${{ steps.cut.outputs.wav.path }}
            sheets: ${{ pluck(needs.per-video.outputs.sheets[matrix.scene.sourceIndex], 'path') }}
            wordTimings: ${{ steps.inputs.outputs.wordTimings }}
            brief: ${{ matrix.scene.brief }}
            direction: ${{ inputs.direction }}
            sceneNumber: ${{ matrix.scene.number }}
            sceneCount: ${{ length(needs.director.outputs.scenes) }}
            previousContext: ${{ steps.inputs.outputs.previousContext }}
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 5s, timeout: 15m }
        outputs:
          cuts: { type: json, value: "${{ response.result.cuts }}" }
          heardAudio: { type: boolean, value: "${{ response.result.heardAudio }}" }
      - id: trim
        name: Trim to the screen
        uses: island
        with:
          src: islands/cut-editor.html
          title: "Trim: ${{ matrix.scene.title }}"
          display: fullscreen
          clip:  ${{ steps.cut.outputs.clip }}
          wav:   ${{ steps.cut.outputs.wav }}
          scene: ${{ matrix.scene }}
          words: ${{ steps.inputs.outputs.sceneWords }}
          cuts:  ${{ steps.refine.outputs.cuts }}
          sheets: ${{ needs.per-video.outputs.sheets[matrix.scene.sourceIndex] }}
        outputs:
          cuts: { type: json, schema: { type: array, items: { type: object, required: [start, end] } } }
          keep: { type: json, schema: { type: array, items: { type: object, required: [start, end] } } }
        headless: auto
        timeout-minutes: 240
        summary: "Kept ${{ length(steps.trim.outputs.keep) }} spans in *${{ matrix.scene.title }}*."
      - id: assemble
        name: Assemble
        uses: pipeline
        with:
          path: video/slice
          body: { source: "${{ steps.cut.outputs.clip.path }}", spans: "${{ steps.trim.outputs.keep }}", wantAudio: false, audioFades: true, outPrefix: "${{ step.prefix }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          clip: { type: file, value: "${{ response.result.path }}" }
    outputs:
      clips: ${{ steps.assemble.outputs.clip }}
      keep:  ${{ steps.trim.outputs.keep }}
      words: ${{ steps.inputs.outputs.sceneWords }}

  stitch:
    name: Stitch it together
    needs: per-scene
    steps:
      - id: concat
        uses: pipeline
        with:
          path: video/concat
          body: { clips: "${{ pluck(needs.per-scene.outputs.clips, 'path') }}", outPrefix: "${{ step.prefix }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 30m }
        outputs:
          short: { type: file, value: "${{ response.result.path }}" }
      - id: script
        name: The final script
        uses: script
        with: { src: scripts/final-script.js, scenes: "${{ needs.director.outputs.scenes }}", keep: "${{ needs.per-scene.outputs.keep }}", words: "${{ needs.per-scene.outputs.words }}" }
        outputs:
          script: { type: string }
          chapters: { type: string }
        summary: |
          ### The short
          ${{ length(needs.per-scene.outputs.clips) }} scenes joined — [download](${{ steps.concat.outputs.short.url }}).
    outputs:
      short:  ${{ steps.concat.outputs.short }}
      script: ${{ steps.script.outputs.script }}
      chapters: ${{ steps.script.outputs.chapters }}

  describe:
    name: Title and description
    needs: [stitch, director]
    steps:
      - id: describe
        uses: pipeline
        with: { path: describe, body: { script: "${{ needs.stitch.outputs.script }}", synopsis: "${{ needs.director.outputs.synopsis }}" } }
        outputs:
          title:   { type: string, value: "${{ response.title }}" }
          summary: { type: string, format: textarea, value: "${{ response.summary }}" }
    outputs:
      title: ${{ steps.describe.outputs.title }}
      summary: ${{ steps.describe.outputs.summary }}

  blog:
    name: Blog post
    needs: [stitch, describe, per-video, director]
    if: ${{ inputs.write_blog }}
    steps:
      - id: write
        uses: pipeline
        with:
          path: blog
          body:
            timed: ${{ needs.per-video.outputs.timed }}
            script: ${{ needs.stitch.outputs.script }}
            title: ${{ needs.describe.outputs.title }}
            summary: ${{ needs.describe.outputs.summary }}
            synopsis: ${{ needs.director.outputs.synopsis }}
            scenes: ${{ needs.director.outputs.scenes }}
            sheets: ${{ pluck(needs.per-video.outputs.sheets, 'path') }}
            direction: ${{ inputs.direction }}
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 5s, timeout: 15m }
        outputs:
          post: { type: markdown, value: "${{ response.result.markdown }}" }
      - id: edit
        uses: form
        with:
          title: Edit the post
          fields:
            post: { type: markdown, default: "${{ steps.write.outputs.post }}", required: true }
          submit: Looks good
        headless: { mode: skip, outputs: { post: "${{ steps.write.outputs.post }}" } }
      - id: times
        name: Frames to capture
        uses: script
        with: { src: scripts/frame-times.js, markdown: "${{ steps.edit.outputs.post }}", sources: "${{ needs.per-video.outputs.source }}", durations: "${{ needs.per-video.outputs.duration }}" }
        outputs:
          captures: { type: json }
      - id: frames
        uses: pipeline
        with:
          path: video/frames
          body: { captures: "${{ steps.times.outputs.captures }}", outPrefix: "${{ step.prefix }}", executor: "${{ inputs.executor }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 10m }
        outputs:
          frames: { type: file, list: true, value: "${{ response.result.paths }}", render: images }
          byTime: { type: json, value: "${{ response.result.byTime }}" }
      - id: bundle
        uses: script
        with: { src: scripts/blog-bundle.js, markdown: "${{ steps.edit.outputs.post }}", title: "${{ needs.describe.outputs.title }}", frames: "${{ steps.frames.outputs.frames }}", byTime: "${{ steps.frames.outputs.byTime }}" }
        outputs:
          zip: { type: file }
          post: { type: markdown }
        summary: "Blog bundle **${{ steps.bundle.outputs.zip.name }}** (${{ steps.bundle.outputs.zip.size }} bytes) — [download](${{ steps.bundle.outputs.zip.url }})"
    outputs:
      post: ${{ steps.bundle.outputs.post }}
      zip:  ${{ steps.bundle.outputs.zip }}

  cover:
    name: Cover
    needs: [describe, stitch]
    if: ${{ inputs.cover }}
    steps:
      - id: brief
        uses: pipeline
        with: { path: thumbnail/draft, body: { title: "${{ needs.describe.outputs.title }}", description: "${{ needs.describe.outputs.summary }}", script: "${{ needs.stitch.outputs.script }}", notes: "${{ inputs.direction }}" } }
        outputs:
          prompt: { type: string, format: textarea, value: "${{ response.prompt }}" }
    outputs:
      prompt: ${{ steps.brief.outputs.prompt }}

  covers:
    name: Draw two covers
    needs: cover
    if: ${{ inputs.cover }}
    strategy: { matrix: { take: [1, 2] } }
    steps:
      - id: draw
        uses: pipeline
        with: { path: thumbnail/render, body: { prompt: "${{ needs.cover.outputs.prompt }}", outPrefix: "${{ step.prefix }}" } }
        timeout-minutes: 5
        outputs:
          image: { type: file, value: "${{ response.path }}" }
    outputs:
      images: ${{ steps.draw.outputs.image }}

  pick:
    name: Pick a cover
    needs: covers
    if: ${{ inputs.cover }}
    steps:
      - id: pick
        uses: form
        with:
          title: Pick a cover
          fields:
            cover: { type: choice, options: "${{ needs.covers.outputs.images }}", required: true }
          submit: Use this cover
        headless: { mode: skip, outputs: { cover: "${{ needs.covers.outputs.images[0] }}" } }
    outputs:
      cover: { type: file, value: "${{ steps.pick.outputs.cover }}" }

outputs:
  short: ${{ jobs.stitch.outputs.short }}
  title: ${{ jobs.describe.outputs.title }}
  summary: ${{ jobs.describe.outputs.summary }}
  chapters: ${{ jobs.stitch.outputs.chapters }}
  blog:  ${{ jobs.blog.outputs.zip }}
  cover: ${{ jobs.pick.outputs.cover }}
```

Notes the tasks below implement: `scenes` rows carry `source` (the source's uploads-relative path), `sourceIndex`, `number`, `spans: [{start,end}]` (the scene's own span, ready for `video/slice`), `title`, `brief`, `start`, `end` — the `scenes` rule's `parse.fn.js` adds them (Studio's `toScenes` tiling, server-side, per source). `pluck` and `length` are the M0 expression deviations. `words[matrix.scene.sourceIndex]` indexes the collected matrix output by the scene's source.
- [ ] **Step 2: Lint it** — `node packages/workflow-lint/dist/cli.js lint apps/workflow-studio/.bffless/workflows/studio.workflow.yaml --rules apps/workflow-studio/.bffless/proxy-rules/workflow-studio --path-prefix /api/workflow-studio` → every `rule-missing` error names a rule Tasks 20–21 create; no other errors/warnings (the `interactive-headless` notice is gone: every island/form declares `headless`).
- [ ] **Step 3: Commit** — `feat(workflow-studio): the studio workflow`.

### Task 20: Pipelines, batch 1 — job poll, extract-audio, contact-sheet, frames, transcribe, scenes

**Files:** under `apps/workflow-studio/.bffless/proxy-rules/workflow-studio/rules/`: `job/get/{rule.yaml,shape.fn.js}`, `video/extract-audio/post/{rule.yaml,prep.fn.js,check.fn.js}`, `video/contact-sheet/post/{rule.yaml,prep.fn.js,check.fn.js}`, `video/frames/post/{rule.yaml,prep.fn.js,check.fn.js}`, `transcribe/post/{rule.yaml,prep.fn.js,flatten.fn.js,check.fn.js}`, `scenes/post/{rule.yaml,prep.fn.js,collect.fn.js,parse.fn.js}` (+ `*.fn.test.yaml` fixtures for every `.fn.js` — `bffless rules test` runs them)

Common shape (from Studio's rules, kept): `prep` → `createJob` (`data_create` into `$schema:workflow_studio_jobs`) → `respond { jobId, status: 'pending' }`; `postSteps`: `setRunning` → work → `check`/`parse` → `finishOk` / `finishErr` (conditions `steps.check.ok` / `.notOk`). Every rule: `validators: [{ type: auth_required, config: { allowApiKey: true } }]`, `timeout: 120000`, **no `order:`** (derived — let specificity decide; the set has no wildcard rules except none). Every path-out result carries **uploads-relative `path`s** (the harness registers bare paths where a `file` is declared — 02); `check.fn.js` strips `deployment.owner + '/' + deployment.repo + '/uploads/'` from `storage_path` exactly as Studio's does but returns `path`, not `url`.

- [ ] **Step 1:** `job/get` = Studio's `studio/job/get` verbatim with the schema renamed. `video/extract-audio`: `prep.fn.js` returns `{ input: body.source, outPrefix: cleanPrefix(body.outPrefix), executor }` where `cleanPrefix` strips leading `/`, rejects `..`, requires the `workflows/` prefix (`ok/notOk`), and the `extract` step's `output: "{{steps.prep.outPrefix}}/audio.wav"`. `video/contact-sheet`: the `frames` op with `draw` + `tile` (Decision 2 as reworked) — `input`, `outputPrefix`, `times` and the per-cell clock `draw.text` both supplied by the CALLER (the workflow's `scripts/frame-times.ts`, which imports Studio's `planContactSheet`/`clockLabel` through the workspace dep), `tile: { perSheet, columns }`, `executor`; `check` returns `{ paths: sheets.map(s => rel(s.storage_path)), times: sheets.map(s => s.times), interval }`. **No `duration` is sent** — CE no longer plans the sampling. `video/frames`: body `captures: [{ source, time, name }]` — **one `frames` op call per distinct `source`** is not expressible in a static rule, so the rule handles **up to 3 sources** with three conditional `frames` steps (`condition: steps.prep.has0` …), mirroring Studio's `sign0…9` fan-out; `check` merges into `{ paths, byTime: { "<time>": path } }`. `transcribe`: Studio's rule with `prep` taking `body.audio` (uploads-relative path → storagePath) and `flatten.fn.js` additionally computing `timed` (port `timedTranscript` from `director.ts:74-114` into the function body — plain ES5, 8-second buckets, `[m:ss]` labels) and `duration` (last word's `end`, rounded up). `scenes`: `prep.fn.js` builds the transcript text from `body.timed[]` with Studio's `--- VIDEO n: … (starts m:ss) ---` headers (`combinedTimedTranscript`, offsets from `body.durations`), signs up to 10 sheets from `body.sheets` (flattened list of lists), keeps Studio's system/prompt text verbatim; `parse.fn.js` = Studio's tiling, then **assign each global scene to a source** (Studio's `toScenes` step 2/3, `director.ts:146-235`, ported) so every row gets `source` (= `body.sources[i]`), `sourceIndex`, local `start`/`end`, `spans: [{ start, end }]`, `number` (1-based), `title`, `brief`, `cuts`.
- [ ] **Step 2:** Fixtures: each `*.fn.test.yaml` covers the happy path and one refusal (bad prefix, empty result). `bffless rules test apps/workflow-studio/.bffless/proxy-rules/workflow-studio` green.
- [ ] **Step 3:** `bffless rules validate …` green; re-run the Task 19 lint → the batch-1 paths no longer report `rule-missing`. Commit `feat(workflow-studio): prep pipelines`.

### Task 21: Pipelines, batch 2 — slice, refine-scene, concat, describe, thumbnail draft/render, blog

**Files:** `rules/video/slice/post/**`, `rules/refine-scene/post/**`, `rules/video/concat/post/**`, `rules/describe/post/**`, `rules/thumbnail/draft/post/**`, `rules/thumbnail/render/post/**`, `rules/blog/post/**` (+ fixtures)

- [ ] **Step 1:** `video/slice`: Studio's, with `prep` taking `source` (path), `spans`, `wantAudio`, `audioFades`, `outPrefix`; the two conditional `slice` steps write `{{steps.prep.outPrefix}}/clip.mp4` (+ `/clip.wav`); `check` returns `{ path, audioPath, duration }`. `refine-scene`: Studio's prompt verbatim; `prep` takes `audio` (path), `sheets` (paths, ≤10), `wordTimings`, `brief`, `direction`, `sceneNumber`, `sceneCount`, `previousContext`, `start`, `end` — `deadSpace` absent (Decision 17); `parse` unchanged. `video/concat`: `clips` (paths) → `{{outPrefix}}/short.mp4`, `{ path }`. `describe`: Studio's, sync, `{ script, synopsis }` → `{ title, summary }`. `thumbnail/draft`: Studio's rule (system prompt verbatim), sync, `{ title, description, script, notes }` → `{ prompt }`. `thumbnail/render`: Studio's, sync, `store` step `subDir: "{{steps.prep.outPrefix}}"` (uploads-relative — `file_upload_handler.subDir` is under the uploads root, like `presigned_upload`'s), `schemaId: $schema:workflow_studio_jobs`? — no: `file_upload_handler` needs an upload schema; add `schemas/workflow_studio_uploads.schema.yaml` (Studio's `youtube_thumbnail` fields, `kind: upload`) and use it; response `{ path }` (strip the uploads root from `steps.store.storage_path`). `blog`: Studio's `studio-blog` rule verbatim (Claude writer on, Gemini off), `prep` taking `timed[]` (joined with the VIDEO headers), `script`, `title`, `summary`, `synopsis`, `scenes` (rows → `{ title, transcript }` where `transcript` = the scene's words joined — computed by `scripts/final-script.js`? No: the blog prep only needs titles; pass `scenes` rows and let `prep` use `title` only), `sheets`, `direction`.
- [ ] **Step 2:** Fixtures + `bffless rules test`; the Task 19 lint is now clean (`✔ … 0 error(s), 0 warning(s)`).
- [ ] **Step 3:** Commit `feat(workflow-studio): build and export pipelines`. `pnpm apps:check` (the README lists every secret/token the rules reference: `secrets.HF_TOKEN`, Replicate + Anthropic provider tokens).

### Task 22: Scripts — `scene-inputs`, `final-script`, `frame-times`, `blog-bundle` (Decisions 16/18)

**Files:**
- Create: `apps/workflow-studio/scripts/{scene-inputs,final-script,frame-times,blog-bundle}.ts`, `apps/workflow-studio/scripts/*.test.ts`, `apps/workflow-studio/vite.scripts.config.ts` (Task 18)
- Test: unit tests run the module's `default(ctx)` with a fake `ctx` (`{ inputs, files: { fetch }, log, annotate, signal }`), like `apps/workflow/src/hello-scripts.test.ts`

- [ ] **Step 1: Failing tests** — `scene-inputs`: given `scene {start: 10, end: 40, number: 2}`, `words` (a 60-second word list) and `scenes`, returns `wordTimings` = Studio's `sceneWordTimings(words in window)` lines, `previousContext` = the last ~30 kept words of scene 1 (Studio's `sceneTail` from `refiner.ts`), `sceneWords` = the window's words. `final-script`: given `scenes`, `keep` (per scene, clip-relative) and `words` (per scene), returns `script` (kept words joined, blank line between scenes — Studio's `videoScript` with `keptWords` over `keep` mapped back to source time by `+ scene.start`) and `chapters` (`0:00 Title` lines from cumulative kept durations — `videoChapters`/`formatChapters`). `frame-times`: given markdown with `![a](frame:83.5)` tokens, `sources` (File refs) and `durations`, returns `captures: [{ source: path, time: localTime, name: 'frame-01.jpg' }]` (Studio's `parseFrameTokens` + `planBlogCaptures` with `globalToLocal` over cumulative durations). `blog-bundle`: given `markdown`, `title`, `frames` (File refs) and `byTime`, rewrites tokens (`rewriteFrameTokens` → `images/frame-NN.jpg` via `planBlogBundle`), fetches each frame through `ctx.files.fetch(ref)`, zips with `fflate.zipSync` (`post.md` + `images/*`), returns `{ zip: new File([bytes], '<slug>.zip', { type: 'application/zip' }), post: rewrittenMarkdown }`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — each script imports from `studio/lib/*` (`director`, `refiner`, `describe`, `blog`, `sources`) and is typed against `@bffless/workflow-script`. `scripts/stage.mjs` (Task 24) builds each with `vite build -c vite.scripts.config.ts` (`WORKFLOW_SCRIPT=<name>`) into `dist/scripts/<name>.js`.
- [ ] **Step 4: Verify** — `pnpm --filter workflow-studio test:run`; a built script is a single ES module with no `import` statements left (assert in `stage.test`).
- [ ] **Step 5: Commit** — `feat(workflow-studio): the four scripts`.

### Task 23: The cut-editor island

**Files:**
- Create: `apps/workflow-studio/islands/cut-editor/{index.html,main.tsx,App.tsx,useSigned.ts,styles.css}`, `apps/workflow-studio/islands/cut-editor/App.test.tsx`
- Test: RTL over a fake bridge (`fakeIsland` pattern from `apps/workflow/src/islands/fakeIsland.ts`, copied into the app's test utils)

**Interfaces:** tool-input `arguments` = `{ clip: FileRef, wav: FileRef, scene, words: TWord[], cuts: Cut[], sheets: FileRef[] }`; on mount the island calls `workflow.sign` for `clip.path` and `wav.path` (and each sheet); renders Studio's `CutEditor` (`studio/components/Studio/CutEditor`) with `words`, `cuts` (state, initialised from the refiner's), `windowStart/End` = `scene.start/end`, `duration` = `scene.end`, `originalAudioUrl` = the signed WAV, `frames` = filmstrip frames built from the signed sheets (`buildFilmstrip` over `ContactSheet`-shaped objects assembled from `sheets` + `times`), `video` = its own `<video src={signedClip}>` with `offset: scene.start`, `onEditCut` updating local cuts; a **Done** button submits `{ cuts, keep }` where `keep` = complement of `normalizeCuts(cuts)` inside `[scene.start, scene.end]` **shifted to clip time** (`- scene.start`) — the shape `video/slice` takes for `assemble`. Headless: when `app.getHostContext().bffless?.headless`, submit the refiner's cuts immediately after tool-input. Errors from `workflow.sign` render under `data-testid="island-sign-error"`.

- [ ] **Step 1: Failing tests** — `App.test.tsx`: renders the editor with the fake bridge's tool-input; clicking Done calls `workflow.submit` with `keep` = `[{start:0,end:30}]` for a 30-second scene with no cuts; with cuts `[{10,12}]` → `keep` = `[{0,10},{12,30}]`; headless host context → an immediate submit; a sign failure shows `island-sign-error`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — `main.tsx`: `new App({ name: 'cut-editor', version })`, `app.ontoolinput = ({ arguments: a }) => root.render(<Editor args={a} bridge={app} />)`, `app.onteardown = async () => ({})`, `await app.connect()`. `useSigned(ref)` → `bridge.callServerTool({ name: 'workflow.sign', arguments: { path: ref.path } })` → `structuredContent.url`. Keep it plain: no router, no Redux (CutEditor is store-free — Task 18 verified). `index.html` inlines the CSS the editor's Tailwind classes need? CutEditor uses Tailwind utility classes (`border rule bg-surface …`) — the island build must include Studio's Tailwind: add `@tailwindcss/postcss` + Studio's `src/index.css` import to the island entry so the single-file build carries the generated CSS (`postcss.config.js` in the app, `tailwindcss ^4.3`). Verify the built HTML is self-contained (no external URL) — the single-file plugin inlines it.
- [ ] **Step 4: Verify** — `pnpm --filter workflow-studio test:run`; `WORKFLOW_ISLAND=cut-editor pnpm exec vite build -c vite.islands.config.ts` produces one `dist/islands/cut-editor.html`; open it standalone in headless Chromium via `localdev-tools/shot.mjs` (renders the "waiting for the workflow" shell without console errors).
- [ ] **Step 5: Commit** — `feat(workflow-studio): the cut-editor island`.

### Task 24: Stage, CI, deploy

**Files:**
- Create: `apps/workflow-studio/scripts/stage.mjs` (type-check → build each island → build each script → `workflow index .bffless/workflows --out dist --impl workflow-studio --name Studio --description … --rules .bffless/proxy-rules/workflow-studio --path-prefix /api/workflow-studio`), `apps/workflow-studio/src/stage.test.ts` (runs the stager; asserts `dist/.bffless/workflows/index.json` lists `islands/cut-editor.html` + the four scripts), `.github/workflows/workflow-studio.yml` (PR: install → build lint pkg → `pnpm --filter workflow-studio typecheck lint test:run stage` → `bffless rules validate` + `rules test`), `.github/workflows/deploy-workflow-studio.yml` (push `main` on `apps/workflow-studio/**` + dispatch: stage → `bffless/publish-workflow@v1` with `alias: workflow-studio`, `repository: bffless/workflow`, `target-url: https://workflow-studio.j5s.dev`, `path: apps/workflow-studio/dist`, `workflows: apps/workflow-studio/.bffless/workflows`, `rules: apps/workflow-studio/.bffless/proxy-rules/workflow-studio`)
- Modify: `apps/workflow-studio/bffless/README.md` ("First-success checkpoint" = Task 25's short-clip run), `apps/workflow/docs/writing-an-implementation.md` (link workflow-studio as the full example)

- [ ] **Step 1:** Stager + test; CI workflow; deploy workflow (dispatch first).
- [ ] **Step 2: Manual setup on j5s (record in the README, do via MCP where possible):** domain `workflow-studio.j5s.dev` → alias `workflow-studio`, path `/`, no SPA fallback (`create_domain` after the first publish creates the alias); project `bffless/workflow` secrets: `HF_TOKEN` (`set_secret`, value from the user), Replicate + Anthropic provider tokens (instance-level on j5s — confirm with `get_project`/admin); server video ops enabled on j5s (Admin → Features) and the CE release from Task 17 deployed; bucket CORS already lists `workflow.j5s.dev`.
- [ ] **Step 3: Gate + PR** — `pnpm --filter workflow-studio typecheck && pnpm --filter workflow-studio lint && pnpm --filter workflow-studio test:run && pnpm --filter workflow-studio stage && bffless rules validate apps/workflow-studio/.bffless/proxy-rules/workflow-studio && bffless rules test apps/workflow-studio/.bffless/proxy-rules/workflow-studio && pnpm apps:check && pnpm --filter @bffless/workflow-lint test:run`; PR `feat(workflow-studio): the Studio port`. Dispatch `deploy-workflow-studio.yml` after merge; `workflow.j5s.dev` lists **Studio** with one workflow, headless-safe.

---

# Phase 5 — The live walk

### Task 25: hello (published), headless hello, Studio on a short clip

**Files:**
- Modify: `/home/rico/bffless/localdev-tools/workflow-live.mjs` (outside the repo: `--headless` runs the driver against j5s and asserts `run.json`; `--studio` kicks off the Studio workflow with a fixture clip through the driver, then opens the cut-editor island by hand-walk instructions), `apps/workflow/bffless/README.md` + `apps/workflow-studio/bffless/README.md` (checklist results), epic #359 (tick the M3 boxes), memory note

- [ ] **Step 1: hello via workflow-hello** — after Phase 2's deploy: discovery lists hello from `/w/hello/` (the generated forwarder), `interactive` runs by hand as `workflow-ci` (Decision 5 proven live), `line-viewer` shows the signed poster image (Decision 6), a script step runs sandboxed (Decision 4: in devtools the Worker's `self.origin` is `null` — add a `ctx.log(String(self.origin))` line to `poster-card.js` in workflow-hello for this walk).
- [ ] **Step 2: headless hello** — `workflow-headless run https://workflow.j5s.dev hello/interactive --inputs '{}' --out …` as `workflow-ci` → exit 0; `run.json` shows `pick/0/choose` succeeded by the island's own submit under `hostContext.bffless.headless` (Decision 7), `review/0/confirm` skipped with outputs (Decision 11), the run row `headless: true`; then the same through `workflow-headless-run.yml` (the artifact). Negative: an `inputs` with a wrong type → exit 3.
- [ ] **Step 3: Studio, 3-minute clip, interactive** — kick off with one short recording (real credits: WhisperX, Gemini director + refiner, Claude describe/blog, nano-banana ×2 — note the cost in the README). Checks, each a Decision: `video/contact-sheet` returns drawn sheets (Decision 2; `drawn: true` in the job result — else the drawtext degrade fired, record it), `scenes` rows carry `source`/`sourceIndex`/`spans`, the cut-editor island plays the clip and WAV through signed URLs (Decision 6) and its Done submits `keep`, `assemble` → `concat` → `short.mp4` downloads, `describe`/`blog`/`frames`/`bundle` produce `post.md` + `zip` with `images/frame-NN.jpg`, two covers → `pick` → `cover` File ref. `words` for the clip is under 256 KB (no offload) — note that a 1-hour source would offload (Decision 16).
- [ ] **Step 4: Studio, headless** — same clip through the driver with `--timeout 90m`: `trim` auto-submits the refiner's cuts (`headless: auto`, its 240-minute declared budget irrelevant), `edit`/`pick` skip, exit 0, `outputs/short.mp4` + `outputs/blog.zip` + `outputs/cover.png` saved. Compare `run.json` outputs with Step 3's.
- [ ] **Step 5: Record** — README checklists (PASS/FAIL + evidence per Decision), a `fix(…)` PR for anything disproved (M1/M2 precedent), issues for the deferred list (`silence` op; `bffless/run-workflow`; workflow-studio mocks; `https://` inputs), tick the epic, write the memory note (what the walk disproved; the Studio port's per-run cost).

---

## Self-review (writing-plans checklist, applied)

**Spec coverage.** Every #359 M3 checkbox maps to tasks (traceability table). 06 Implementation CI obligations → 1–5 (steps 1–4; step 5 deferred by Decision 3, dated); D15/D17 → 5–7; 03 `script` sandbox/COOP item → 8; 04 Headless + `_meta` note → 11; island `timeout-minutes` (04) + `HEADLESS_TIMEOUT` (07) → 9; 07 page contract/`window.__workflow`/`headless` table/driver/exit codes/artifacts → 12–15; 09 "the headless CLI is the e2e" → 15; 05 Resume `resume:` question → Decision 15 + 16; M2 "Deferred out of M2" → each line either lands (COOP: Decision 4 closes it as not needed; headless: 12–15; island clock: 9) or moves to "Deferred out of M3" with a reason (cancel semantics, `alias://`, previews); 00 M3 bullet (workflow-studio pipelines/island/script, publish-workflow, headless CLI) → 17–24, 5, 14; 02 File ref + bare-path registration → the port's `path` outputs (20–21); apps#388's coupling note ("read the prefix from the same place the publisher does") → 4 (`--path-prefix` on the lint) + 5 (the action passes it to both).

**Placeholder scan.** No "TBD"/"similar to Task N": every rule, script, action step and test is written out or names the exact Studio/hello file it is derived from with the exact edits. Two items are deliberately *asks* (secrets and the `v1` tag moves), marked "ask the user".

**Type consistency.** `headlessMode`/`skipOutputs`/`budgetMs`/`waitBudgetMs` live in `src/lib/runner/headless.ts` and are used by Tasks 9, 12, 13 and `StepChip`; `RuleSetIndex.layout` (Task 4) is what `expectedRuleFile` reads and what `prepare-rules.mjs` never touches; `createSandboxWorker` returns the `WorkerLike` of `rpc.ts` (Task 8) and `ScriptHostDeps.spawn` is typed to it; `publishWorkflowGlobal` (Task 13) writes the `WorkflowGlobal` shape Task 14's `observe.ts` reads; the `scenes` row shape written by Task 20's `parse.fn.js` (`source`, `sourceIndex`, `spans`, `number`, `title`, `brief`, `start`, `end`, `cuts`) is what Task 19's YAML indexes and Task 22's `scene-inputs` consumes; the `keep` shape submitted by Task 23 is what `video/slice` (Task 21) takes as `spans`.

## Execution handoff

Plan complete. Execute per phase — 1 (three repos + the new action) → 2 (new repo, then the monorepo) → 3a → 3b → 4 (CE, then the app) → 5 — each PR in its own worktree as Global Constraints say. Two execution options: **1. Subagent-Driven** (superpowers:subagent-driven-development — fresh subagent per task, review between tasks) or **2. Inline** (superpowers:executing-plans — batch with checkpoints). The nine ⚑ decisions were confirmed by the user on 2026-08-27 (two with the adjustments recorded above); the remaining decisions are planner calls to be challenged in this plan's PR review. **Do not start Phase 1 in the planning session** (epic #359: one checkbox ≈ one session).
