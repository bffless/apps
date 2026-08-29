# Workflow Studio

A Workflow-harness implementation of Studio's video-cutting pipeline — see
[`CONTEXT.md`](CONTEXT.md) for what that means and how it relates to `apps/studio` and
`apps/workflow`.

The app is the workflow (`.bffless/workflows/studio.workflow.yaml`), the 13-rule backend it
calls (`.bffless/proxy-rules/workflow-studio/`, over 2 data schemas), the five `script`
modules (`scripts/`), the two islands (`islands/cut-editor/`, `islands/blog-editor/`), the
three AI skills the rules load (`.bffless/skills/`, a verbatim copy of Studio's) and the stager that bundles
them (`scripts/stage.mjs`). See `CONTEXT.md` for how those fit together and
[`bffless/README.md`](bffless/README.md) for the backend / admin-panel setup — including
the one-time project setup that has to happen before the first run.

## Development (run from repo root or with `--filter workflow-studio`)

- `pnpm --filter workflow-studio typecheck` — `tsc -p tsconfig.islands.json && tsc -p tsconfig.scripts.json && tsc -p tsconfig.node.json`
- `pnpm --filter workflow-studio lint` — ESLint (flat config)
- `pnpm --filter workflow-studio stage` — the stager (`node scripts/stage.mjs`): type-check,
  build the islands (`vite.islands.config.ts`) and the five scripts (`vite.scripts.config.ts`),
  copy `.bffless/skills/` in, then `workflow index` the bundle into `dist/`. `build` is the
  same command.
- `pnpm --filter workflow-studio test:run` — single Vitest run (CI mode); `test` for watch.
  Run **after** `stage`: the `build.test.ts` suites inspect the built artefacts and skip
  themselves when `dist/` is absent, which is why CI stages first.
- `pnpm --filter workflow-studio rules:validate` / `rules:test` — validate / run the fixtures
  for the `.bffless/proxy-rules/workflow-studio` rule set

## Backend (`/api/*`)

Like every app in this monorepo, the backend is an **authored** BFFless proxy rule set under
`.bffless/proxy-rules/workflow-studio/` — one rule per `uses: pipeline` step in the workflow.
Unlike the other apps, it is not standalone: it lives in project `bffless/workflow` alongside
the harness and `bffless/workflow-hello`, per `apps/workflow/bffless/README.md`'s
"Rule-set isolation" note, and is never listed in `.bffless/config.json`.
