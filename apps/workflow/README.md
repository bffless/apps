# Workflow

A browser-driven, GitHub-Actions-inspired workflow runner for BFFless. **Spec phase** — no
code yet.

- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Writing an implementation: [`docs/writing-an-implementation.md`](docs/writing-an-implementation.md)
  (the workflow YAML + the rule set, the naming link between them, build, deploy)
- Design: [`docs/spec/00-overview.md`](docs/spec/00-overview.md) (start here) → 01…09,
  [`docs/spec/workflow.schema.json`](docs/spec/workflow.schema.json),
  [`docs/spec/examples/`](docs/spec/examples/)
- Decisions: [`docs/adr/`](docs/adr/)

Milestones M0–M4 are in the overview; each gets its own implementation plan and session.

## Development

`pnpm --filter workflow stage` clones `bffless/workflow-hello` at the commit pinned in
`hello.ref` and builds it into `hello-dist/` + `hello-src/` — run it once before
`pnpm --filter workflow test:run` (or `dev`/`build`) for the **full** suite: a handful of
mock-backed tests skip cleanly without it (see `vite.config.ts`), so `test:run` alone on a
fresh checkout is still green, just not complete. `pnpm --filter workflow test:stage` (its
own script) exercises the stager itself and needs the same network access.
