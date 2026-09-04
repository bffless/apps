# Workflow

A browser-driven, GitHub-Actions-inspired workflow runner for BFFless. The harness app lives
here; each **implementation** (its workflows, pipelines, islands and scripts) is a package in
[`bffless/workflow-implementations`](https://github.com/bffless/workflow-implementations) that
deploys to its own alias — `hello/` in that repo is the reference one.

Unattended runs use the same page: [`@bffless/workflow-headless`](../../packages/workflow-headless/README.md)
is the Playwright **driver** that opens `?auto=1&inputs=…`, follows `window.__workflow` and
writes the run's artifacts down. Its exit code is the contract CI reads.

- Vocabulary: [`CONTEXT.md`](CONTEXT.md)
- Writing an implementation: [`docs/writing-an-implementation.md`](docs/writing-an-implementation.md)
  (the workflow YAML + the rule set, the naming link between them, build, deploy)
- Design: [`docs/spec/00-overview.md`](docs/spec/00-overview.md) (start here) → 01…09,
  [`docs/spec/workflow.schema.json`](docs/spec/workflow.schema.json),
  [`docs/spec/examples/`](docs/spec/examples/)
- Decisions: [`docs/adr/`](docs/adr/)

Milestones M0–M5 are in the overview; each gets its own implementation plan and session.
M5 — agent embedding — is [`docs/spec/10-agent-embedding.md`](docs/spec/10-agent-embedding.md):
the page's tool catalog on `document.modelContext` (WebMCP), the same catalog served as an
MCP endpoint at `POST /api/workflow/mcp` (a rule in the harness's rule set, fronted by app
tokens), and a waiting island or form completed inside an agent host through the step view
(`ui://bffless/workflow/step-view.<rev>.html`). Runs are driven on the harness page — a person,
or an agent through the page tools; an agent host reports back and takes one input.

## Development

`pnpm --filter workflow stage` clones `bffless/workflow-implementations` at the commit pinned
in `hello.ref` and builds its `workflows/hello` package into `hello-dist/` + `hello-src/` — run it once before
`pnpm --filter workflow test:run` (or `dev`/`build`) for the **full** suite: a handful of
mock-backed tests skip cleanly without it (see `vite.config.ts`), so `test:run` alone on a
fresh checkout is still green, just not complete. `pnpm --filter workflow test:stage` (its
own script) exercises the stager itself and needs the same network access.

`pnpm --filter workflow test:e2e` needs one more thing first:
`pnpm --filter @bffless/workflow-headless build`. From M3 the headless driver *is* the e2e
(`e2e/headless.spec.ts` spawns the built `dist/cli.js` in `--mocks` mode), and it **fails**
rather than skips when the driver is not built — a silently skipped end-to-end proof is worse
than a red one.
