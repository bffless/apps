# CLAUDE.md — Workflow Studio

Guidance for Claude Code when working in `apps/workflow-studio`.

## What this app is

A re-authoring of `apps/studio`'s video-cutting pipeline as a **Workflow-harness
implementation** (`apps/workflow`) — see [`CONTEXT.md`](CONTEXT.md) for the vocabulary and
[`README.md`](README.md) for commands. It is not a standalone SPA: it ships a workflow YAML,
islands and scripts that the harness fetches and runs, plus the pipelines they call. Read
`apps/workflow/docs/spec/` (start at `00-overview.md`) and
`apps/workflow/docs/writing-an-implementation.md` before adding any of those — this app
follows the same contract `bffless/workflow-hello` does.

## Source of truth

This is the first task of the port; there is no design doc of its own yet beyond
`CONTEXT.md` and this file. Later tasks (19–24, tracked in the M3 plan under
`.superpowers/sdd/2026-08-27-workflow-m3-publish-headless-studio/`) add the workflow YAML,
the rule set, the built scripts, the cut-editor island and the stager/CI/deploy. Don't
invent structure ahead of them — extend what a later task actually adds.

## Reusing Studio

Depend on `apps/studio`'s pure logic through the workspace package rather than copying files:

```ts
import { planAutoTrim } from 'studio/lib/autoTrim'
import { CutEditor } from 'studio/components/Studio/CutEditor'
import 'studio/index.css'
```

`studio`'s `package.json` `exports` is the contract (`./lib/*`, `./components/Studio/CutEditor`,
`./components/Studio/clipPlayer`, `./index.css`) — see `apps/studio/CLAUDE.md` → "Public
surface (consumed by workflow-studio)". If a lib module workflow-studio needs isn't exported
yet, add it to that map (and keep it store-free) rather than reaching into `studio/src/...`
directly, which the `exports` map blocks.

## Layout

- `islands/` — React micro-UIs (MCP Apps format) rendered by the harness in a sandboxed
  `srcdoc` iframe. Built one-per-island by `vite.islands.config.ts` (`WORKFLOW_ISLAND` env),
  type-checked under `tsconfig.islands.json` (DOM + `react-jsx`, no Node types).
- `scripts/` — `script`-step ES modules that run in a Worker on an opaque origin (no DOM, no
  Node). Built one-per-script by `vite.scripts.config.ts` (`WORKFLOW_SCRIPT` env, lib mode,
  `inlineDynamicImports: true`), type-checked under `tsconfig.scripts.json` (`WebWorker` lib
  only — no DOM, no Node types).
- The two Vite build configs are Node-side tooling, not browser code — they're checked
  separately under `tsconfig.node.json` so neither browser project's types leak `process`/
  `Buffer`/`node:*` into a `scripts/**` or `islands/**` module (apps/studio's own
  `tsconfig.node.json` is the same split, for the same reason).
- `.bffless/proxy-rules/workflow-studio/` — the authored rule set (backend), isolated in
  project `bffless/workflow` (never in `.bffless/config.json`'s `ruleSets` globs — see
  `apps/workflow/bffless/README.md` → "Rule-set isolation").

Neither `islands/` nor `scripts/` exists yet (Tasks 22/23); both Vite configs and both
`vitest.config.ts` projects are wired to run against them once they do.

## Testing

`vitest.config.ts` splits by directory via `test.projects`: `scripts/**` runs under `node`
(closest to the Worker's no-DOM environment), `islands/**` runs under `jsdom` with the React
plugin (Task 23's island tests use React Testing Library). Both currently match zero files —
`test:run` passing with 0 tests is expected until those directories exist.
