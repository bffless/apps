# Workflow — overview

_Spec set written 2026-08-19 from the grilling session. These documents are the big picture;
implementation plans are written per milestone afterwards, each in a fresh session. Read
[`../../CONTEXT.md`](../../CONTEXT.md) for the vocabulary first — every term in bold below is
defined there._

## What it is

**Workflow** is a BFFless app, inspired by GitHub Actions, that renders and runs workflows
declared in YAML. It turns what Studio does with bespoke UI — stitch a chain of pipelines
together with inputs, outputs and custom editors between them — into a declarative
definition any repo can ship. The **harness** (this app) is generic: it owns the UI, the
runner, run history, summaries/annotations, file storage and the headless driver, and
carries no workflow of its own. **Implementations** are separate repos that ship
`.bffless/workflows/*.yaml`, the pipelines those workflows call, and any custom **islands**
or **scripts**.

Unlike GitHub Actions the runner is **the browser**: the harness page dispatches pipeline
calls to BFFless (which run server-side), waits on the user where a step is interactive,
and records every transition server-side so runs are durable, listable and resumable. The
harness is never executed server-side; unattended use is a headless browser (Playwright).

## Topology

```
project  bffless/workflow                     (one BFFless project; phase 1 on j5s.dev)
│
├── alias  workflow          ← the harness app              https://workflow.<domain>
│     rule set  workflow            /api/workflow/*  (runs, files, discovery)
│
├── alias  workflow-studio   ← implementation workflow-studio  (domain optional, cosmetic)
│     files: /.bffless/workflows/{index.json,*.yaml}, /islands/*.html, /scripts/*.js
│     rule set  workflow-studio     /api/workflow-studio/*  — attached to BOTH aliases
│                                   `workflow-studio` and `workflow`
│                             + GET /w/workflow-studio/[...path]
│                                   → backend /public/<owner>/<repo>/alias/workflow-studio/dist/[...path]
│
└── alias  workflow-studio-pr-12 … (previews are just more aliases)
```

The browser only ever talks to the harness host (ADR-0001): implementation pipelines are
reachable at `workflow.<domain>/api/<impl>/...` because the implementation attaches its rule
set to the harness alias too, and implementation files are reachable same-origin at
`/w/<impl>/...` through a forwarding rule — which targets the CE backend's alias serve route
in-process, so an implementation (or a preview) needs no domain of its own (ADR-0001
amendment, 2026-08-28). Discovery is file-based (ADR-0004): the harness
lists the project's aliases and probes `/w/<alias>/.bffless/workflows/index.json`; a deploy
*is* the publish.

## The pieces

| Piece | Spec | Summary |
|---|---|---|
| Workflow YAML | [01-workflow-yaml.md](01-workflow-yaml.md) | GitHub-faithful `on.manual.inputs` + `jobs.<id>` (`needs`, `strategy.matrix`, sequential `steps`, `outputs`), expressions, control flow. JSON Schema in [`workflow.schema.json`](workflow.schema.json). |
| Types & renderers | [02-types-and-renderers.md](02-types-and-renderers.md) | One closed vocabulary for inputs and outputs (`string number boolean choice file table markdown json`, `list: true`); renderer by type, `render:` override incl. `render: island`. |
| Step kinds | [03-step-kinds.md](03-step-kinds.md) | `pipeline` (+ `poll`, `retry`), `island`, `form`, `script`. |
| Islands | [04-islands.md](04-islands.md) | Islands are MCP Apps (`text/html;profile=mcp-app`); the harness is the host via `@modelcontextprotocol/ext-apps`; host tools `workflow.submit`, `workflow.annotate`. |
| Runs & persistence | [05-runs-and-persistence.md](05-runs-and-persistence.md) | `workflow_runs` + `workflow_run_steps`, event-sourced; Resume with lease; summaries & annotations; definition snapshot. |
| Discovery, publishing, files | [06-discovery-publishing-files.md](06-discovery-publishing-files.md) | Alias probing, `index.json`, implementation CI obligations, `publish-workflow` action/CLI, harness-owned run storage (`/api/workflow/files/{prepare,register}` + `/api/uploads/workflows/*`), the reusable `files` rule-set template. |
| Headless | [07-headless.md](07-headless.md) | `?auto=1&inputs=` contract, `window.__workflow`, `headless: skip\|auto`, the Playwright CLI. |
| Harness UI | [08-harness-ui.md](08-harness-ui.md) | Screens derived from the prototype: implementations, workflow graph, kickoff form, run page with Input/Output panes, past runs. |
| State management | [09-state-management.md](09-state-management.md) | Redux Toolkit + RTK Query; the run engine as a pure event-sourced reducer (ADR-0003). |
| Examples | [`examples/`](examples/) | `hello.workflow.yaml` (M1 test implementation). The reference port, `studio.workflow.yaml`, ships with its implementation: [`workflows/workflow-studio/.bffless/workflows/studio.workflow.yaml` in `bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations/blob/main/workflows/workflow-studio/.bffless/workflows/studio.workflow.yaml). |

## Milestones

Each shippable on j5s.dev (phase 1: regular repo; phase 2: catalog app).

- **M0 — Spec** (this set) + `bffless workflows lint` prototype (schema + expression parse +
  upstream-reference check).
- **M1 — Harness core.** Discovery, parse/validate, graph view, kickoff form, `pipeline`
  steps with `poll`/`retry`, run persistence + Resume, run page, summaries/annotations. Test
  implementation `workflow-hello` (3 pipelines).
- **M2 — Interactive steps.** `island` (AppBridge), `form`, `script` + file outputs,
  `render: island`.
- **M3 — Studio port + headless.** `workflow-studio` (pipelines path-in/path-out, cut-editor
  island, blog-bundle script), `publish-workflow` action/CLI, `headless/` Playwright CLI.
- **M4 — Catalog packaging** (phase 2) — **done 2026-08-31.** Implementations externalized
  to the [`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations)
  monorepo (`workflows/hello`, `workflows/workflow-studio`; `bffless/workflow-hello` archived;
  Studio's libs frozen into `vendor/studio/` — divergence deliberate from here), deploy-neutral
  on the live instance (walks green, `rules diff` empty). Runtime project self-discovery
  (#363): `GET /api/workflow/project` reads CE's `deployment` provenance, `VITE_BFFLESS_PROJECT`
  demoted to an override. The harness ships as a catalog app: `bffless-app.json` + release
  component (apps#546, bundle-build fix apps#548), registry entry live on `apps.bffless.dev`
  (workflow v1.0.0, ceMin 0.4.37, sha-verified), 1-click install proven on a scratch project
  (spec 06 *Phase 1 → phase 2*; `bffless/README.md` M4 blocks). Follow-ups: CE
  `targetUrl: alias://<name>` (optional
  since 2026-08-28 — a declarative spelling of the in-process forwarder, not a dependency),
  WebMCP on the harness page, attestations, guest/public runs, reusable workflows,
  deployment-pinned `/w/<alias>@<deployment>/`.
- **Authoring CLI** — **done 2026-09-01** (#420). `@bffless/workflow` (`packages/workflow-cli`):
  `init` (portable `--from` any repo via the identity file) / `rename` (boundary-aware
  identity pass, schema filenames included) / `add` (`rule-missing` green from first lint) /
  `lint`+`index` (workflow-lint delegation) / `publish` (index → rules push → upload →
  attach, live-proven on j5s and the bffless.dev harness install). The `bffless:workflow`
  skill ships from `bffless/skills`. Field notes and follow-ups (#559, #560, #561,
  publish-workflow#4) on #420's closing comment.

## Decisions at a glance

| # | Decision | Where |
|---|---|---|
| D1 | File-based discovery; a deploy is the publish | 06, ADR-0004 |
| D2 | Single origin via the harness host; impl rule set attached to harness alias; `/api/<impl>/`, `/w/<impl>/` | 06, ADR-0001 |
| D3 | GitHub-faithful `jobs`/`needs`/`matrix`/`steps`; `on.manual.inputs`; matrix outputs collect into arrays | 01 |
| D4 | Step kinds: `pipeline`, `island`, `form`, `script`; upload is a property of `file` | 03 |
| D5 | Islands = MCP Apps; harness = host; `workflow.submit`; single sandboxed srcdoc iframe v1 | 04, ADR-0002 |
| D6 | Closed type vocabulary + `list` + `render:` | 02 |
| D7 | Harness-owned run storage; pipelines path-in/path-out; reusable `files` trio | 06 |
| D8 | Server-side run rows per transition; Resume with lease | 05 |
| D9 | `summary:`/`annotations:` templates on steps; files as `file` outputs with Download; no attestations v1 | 05, 01 |
| D10 | Redux + pure event-sourced runner; XState not adopted | 09, ADR-0003 |
| D11 | `on.manual` only; harness always in a browser; headless = Playwright | 07 |
| D12 | Headless contract; `headless: skip\|auto` (none ⇒ fail fast) | 07 |
| D13 | GitHub expression subset; `if`/`continue-on-error`/`timeout-minutes`/`fail-fast`/`max-parallel`; `retry` deviation | 01 |
| D14 | Members-only; `/auth` reverse proxy preferred | 06 |
| D15 | Names: `workflow` singular; `.bffless/workflows/` plural; `workflow-<impl>` repos | 06 |
| D16 | Definition snapshot per run; previews are aliases | 05 |
| D17 | Implementation paths are **relative** (`path: transcribe` → `/api/<alias>/transcribe`, `src: islands/x.html` → `/w/<alias>/…`), namespaced by **alias**, so previews (`studio-pr-12`) coexist on the harness alias; `publish-workflow` rewrites rule path prefixes per alias | 01, 06 |
| D18 | Kickoff/form uploads go to a per-workflow `inputs/` area (not run-scoped); runs reference them; run deletion removes only the run prefix | 06 |

## What this is not

- Not a server-side engine: no `on.schedule`/`on.webhook` without a browser; no secrets in
  the browser (secrets live in pipelines).
- Not a pipeline builder: pipelines are authored as rules-as-code in the implementation.
- Not a replacement for bespoke apps: Studio keeps existing; `workflow-studio` is the
  proof that its pipelines are reusable by a generic harness.
