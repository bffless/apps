# @bffless/workflow

The **authoring CLI** for BFFless Workflow implementations (apps#420):
`workflow init|rename|add|lint|index|publish`. A thin CLI over
[`@bffless/workflow-lint`](../workflow-lint), which stays the parser/schema/
resolver library — `lint` and `index` delegate straight into its published
API (`lintFile`, `resolveRuleSet`, `buildIndex`) rather than re-implementing
any of the linting logic.

This package lives outside the `bffless` platform CLI deliberately: the
Workflow toolchain co-versions with the spec, which lives in this monorepo
(`apps/workflow/docs/spec/`), not with platform verbs (2026-08-31 ruling on
apps#420).

## Status

Scaffold (Task 1 of the [authoring CLI
plan](../../docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md)):
only `lint` and `index` are implemented. `init`, `rename`, `add` and
`publish` exit 2 with "not implemented" until their own tasks land.

## Install

```bash
npx @bffless/workflow --version
```

Inside the monorepo: `pnpm --filter @bffless/workflow build`, then
`node packages/workflow-cli/dist/cli.js <verb> ...` (or `pnpm workflow:cli`).

## CLI

```
workflow --version
workflow lint  <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
workflow index <workflows-dir> --out <dir> --impl <alias> --name <display> [options]
workflow init | rename | add | publish   # not yet implemented
```

Same flags and the same exit-code contract as `@bffless/workflow-lint`'s own
`workflow` CLI — see [its README](../workflow-lint/README.md#cli) for the
full flag reference. Exit codes: **0** clean · **1** errors/warnings · **2**
usage/IO error.

## Both packages ship a `workflow` bin

`@bffless/workflow-lint` cannot drop its `bin: workflow` (a breaking change
under `bffless/publish-workflow`'s `^1.0.0` npx pin); this package claims the
same bin name — the intended end state for `npx @bffless/workflow`. If both
are installed as dependencies of the same project, whichever installs last
wins the shared `node_modules/.bin/workflow` shim; invoke this package
explicitly (`npx @bffless/workflow`, or this monorepo's `pnpm workflow:cli`)
when that matters.
