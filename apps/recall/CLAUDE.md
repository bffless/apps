# CLAUDE.md — Recall

Guidance for Claude Code when working in the Recall app. Recall is video transcript RAG search &
chat: a sibling app to Studio and Reader in this pnpm monorepo. This task (bffless/apps Task 2)
only scaffolds the app shell and repo wiring — no features yet; later tasks build the real
search/chat UI and the `/api/*` pipelines.

## Commands (run from repo root or with `--filter recall`)

- `pnpm --filter recall dev` — Vite dev server with HMR
- `pnpm --filter recall build` — type-check (`tsc -b`) then `vite build` into `apps/recall/dist/`
- `pnpm --filter recall lint` — ESLint (flat config)
- `pnpm --filter recall test:run` — single Vitest run (CI mode); `test` for watch

Root aliases exist too: `pnpm recall:dev|build|lint|test`.

## Backend (`/api/*`)

There is no app server. The `/api/*` endpoints are a BFFless proxy rule set, **authored** under
`.bffless/proxy-rules/recall/` — see `bffless/README.md` for import steps. Locally, unhandled
`/api/*` falls through the Vite proxy to `j5s.dev`. No rules exist yet (Task 12 adds them).
