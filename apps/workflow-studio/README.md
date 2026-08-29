# Workflow Studio

A Workflow-harness implementation of Studio's video-cutting pipeline — see
[`CONTEXT.md`](CONTEXT.md) for what that means and how it relates to `apps/studio` and
`apps/workflow`.

Status: **scaffold** (M3 Task 18). There is no workflow YAML, no proxy rules, no island and
no script yet — `pnpm build` currently only type-checks. See `CONTEXT.md` for what's still
to come and [`bffless/README.md`](bffless/README.md) for the backend / admin-panel setup.

## Development (run from repo root or with `--filter workflow-studio`)

- `pnpm --filter workflow-studio typecheck` — `tsc -p tsconfig.islands.json && tsc -p tsconfig.scripts.json && tsc -p tsconfig.node.json`
- `pnpm --filter workflow-studio lint` — ESLint (flat config)
- `pnpm --filter workflow-studio test:run` — single Vitest run (CI mode); `test` for watch
- `pnpm --filter workflow-studio build` — currently an alias for `typecheck`; Task 24 replaces
  it with the stager that builds the islands (`vite.islands.config.ts`) and scripts
  (`vite.scripts.config.ts`) into a publishable bundle
- `pnpm --filter workflow-studio rules:validate` / `rules:test` — validate / run the fixtures
  for the `.bffless/proxy-rules/workflow-studio` rule set (empty until Tasks 20–21)

## Backend (`/api/*`)

Like every app in this monorepo, the backend is an **authored** BFFless proxy rule set under
`.bffless/proxy-rules/workflow-studio/` — currently just a name + description, no rules.
Unlike the other apps, it is not standalone: it lives in project `bffless/workflow` alongside
the harness and `bffless/workflow-hello`, per `apps/workflow/bffless/README.md`'s
"Rule-set isolation" note, and is never listed in `.bffless/config.json`.
