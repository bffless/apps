# @bffless/workflow-lint

The **M0 `workflow lint` prototype** from the Workflow app spec
([`apps/workflow/docs/spec/00-overview.md`](../../apps/workflow/docs/spec/00-overview.md)):
YAML → JSON Schema validation (ajv, draft 2020-12) → `${{ }}` expression
parsing → static checks. Pure TypeScript ESM — **no React, no network, no
`eval`** — so it runs in CI, in the future `bffless workflows lint` CLI verb
(which wraps `lintFile`), and in the M1 harness's "View workflow file" screen
alike (spec 09).

This package lives in `packages/` (not `apps/`) deliberately: `apps/workflow/`
stays spec-only until M1 builds the harness, and spec 07 already plans
`packages/workflow-headless` alongside it.

## CLI

```
workflow lint <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>]
```

Inside the monorepo: `pnpm --filter @bffless/workflow-lint build`, then
`node packages/workflow-lint/dist/cli.js lint <file...>`.

- `--json` — machine-readable `{ version, files: [{ file, findings, counts }], summary }`
- `--quiet` — hide notices
- `--rules <dir>` — the implementation's proxy-rule set, so `rule-missing` can
  check every relative `with.path` against the rule that serves it
- `--alias <alias>` — which set under `.bffless/proxy-rules/` to use; only
  needed when the search finds several
- Exit codes: **0** clean (notices allowed) · **1** any error or warning · **2** usage/IO error

### Checking paths against the rule set

A `pipeline` step names its endpoint relative to the implementation
(`with: { path: echo }` → `POST /api/<alias>/echo`, 01) while the endpoint is a
directory in the implementation's rule set
(`rules/api/<alias>/echo/post/rule.yaml`). Nothing else links the two, so
`rule-missing` does: given a rule set it resolves each relative path and fails
when no rule would serve it.

Without `--rules`, the nearest `.bffless/proxy-rules/` **above the file** is
used — the real implementation layout (`.bffless/workflows/x.yaml` beside
`.bffless/proxy-rules/<alias>/`) resolves with no flags at all. When no set is
found, or several are, the check is skipped with a **notice**: the harness lints
in the browser with no repo in sight (09) and must keep working.

The prefix comes off the set itself — `/api/<alias>` while implementations
author it by hand, `/api` once `publish-workflow` rewrites it at sync time (06)
— so the check follows the layout instead of dictating it.

## Severity policy

`error` and `warning` fail the lint (exit 1); `notice` is informational. The
spec's own examples define "clean": `studio.workflow.yaml` lints with zero
findings, `hello.workflow.yaml` with exactly one notice (its `boom` step
deliberately omits `outputs`, which 03 says the linter flags) — asserted in
`test/examples.test.ts`.

## Rules

| rule | severity | what it catches | spec |
|---|---|---|---|
| `yaml-parse` | error | YAML syntax errors; adds the quoting hint when `${{` sits unquoted in a flow mapping | 01 |
| `schema` | error | workflow.schema.json violations, re-reported against the step's own kind instead of the 4-way oneOf storm | schema |
| `expr-parse` | error | invalid `${{ }}` expressions | 01 |
| `duplicate-step-id` | error | step ids reused within a job | 01 |
| `needs-unknown` / `needs-cycle` | error | `needs` referencing missing jobs / dependency cycles | 01 |
| `unknown-context` / `context-position` | error | unknown context roots; known contexts used where unavailable (e.g. `response` outside a pipeline step) | 01 |
| `unknown-function` | error | calls outside the closed function set | 01 |
| `status-fn-position` | error | `success()` & co. outside an `if` | 01 |
| `upstream-reference` | error | `steps.<id>` reading later/self steps (self ok in own summary/annotations); `needs.<job>` not listed; `jobs.<id>` missing | 01 |
| `unknown-output` | warning | referencing an output name the target step/job doesn't declare | 01 |
| `unknown-render` / `island-render-src` | error | render names outside `transcript · chart · images · code · island`; `render: island` without `src` | 02 |
| `island-src-ext` | error | `island` steps' `with.src` (and any `render: island` declaration's `src`) not ending `.html` | 02 |
| `script-src-ext` | error | `script` steps' `with.src` not ending `.js`/`.mjs` | 02 |
| `island-reserved-with` | error | an island step's `with` has a key named `arguments`, which collides with the tool-input envelope | Decision 1 |
| `cross-impl-path` | warning | absolute `/api/…` paths that aren't the harness (`/api/workflow/…`) | 01 |
| `file-ref-in-body` | warning | a whole File ref (or list) in a pipeline body — pass `ref.path` / `pluck(list, 'path')` | 03 |
| `render-mapping` | warning | `render: chart` without `mapping.x`/`mapping.y`; `render: code` without `mapping.language` | 02 |
| `headless-skip-outputs` | error | `headless: skip` giving no value to an output a later expression references | 07 |
| `interactive-headless` | notice | island/form steps with no `headless` (not headless-safe) | 07 |
| `outputs-omitted` | notice | pipeline steps with no `outputs` map (exposes only `outputs.response`) | 03 |
| `untyped-job-output` | notice | computed job outputs that will type as `json` — suggest `{ type, value }` | 01 |
| `rule-missing` | error | a relative `with.path`/`poll.path` with no rule behind it in the implementation's rule set (a run-time 404); a **notice** when no rule set could be resolved | 06 |
| `tool-name-dot` | notice | a pipeline `with.path` containing `.`, in a workflow with ≥1 island step — only reachable by its slash-form tool name | Decision 1 |

## Programmatic API

```ts
import { lintSource, lintFile, resolveRuleSet, scanRuleSet } from '@bffless/workflow-lint'

const { findings, counts } = lintSource(yamlText, { file: 'x.workflow.yaml' })

// repo-aware: also check every relative path against the rule that serves it
lintSource(yamlText, { file, rules: scanRuleSet('.bffless/proxy-rules/hello') })
lintFile(file, { rules: resolveRuleSet({ file }) })   // what the CLI does
```

`scanRuleSet`/`resolveRuleSet` are the only filesystem-touching exports and
live on the package root; `@bffless/workflow-lint/lint` stays importable from
the browser.

Findings carry `rule`, `severity`, `message`, a JSON-pointer `path`, a 1-based
`pos` (line/col) and an optional `hint`.

### M1 reuse (spec 09: "one parser shared by the harness and the linter")

- `@bffless/workflow-lint/expressions` — lexer, parser, template scanner and the
  full evaluator (GitHub semantics: null propagation, loose comparison,
  operand-returning `&&`/`||`, plus the `length()` / `pluck()` deviations).
- `@bffless/workflow-lint/definition` — the typed `Definition`/`Job`/`Step`
  model over schema-valid data.

## Schema copy

`schema/workflow.schema.json` is a byte-identical copy of the source of truth
at `apps/workflow/docs/spec/workflow.schema.json`, fenced by
`test/schema-drift.test.ts` — edit the spec file and re-copy, never this one
alone.
