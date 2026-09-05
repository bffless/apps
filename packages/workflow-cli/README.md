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

Every verb — `init`, `rename`, `add`, `lint`, `index` and `publish` — is
implemented (Phases 1–3 of the [authoring CLI
plan](../../docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md)).

## Install

```bash
npx @bffless/workflow --version
```

Inside the monorepo: `pnpm --filter @bffless/workflow build`, then
`node packages/workflow-cli/dist/cli.js <verb> ...` (or `pnpm workflow:cli`).

## CLI

```
workflow --version
workflow init   <alias> --from <owner>/<repo>|<path> [--path <dir>] [--ref <ref>] [options]
workflow rename <old> <new> [--dry-run]
workflow add    <name> [--step <path>]…
workflow lint   <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
workflow index  <workflows-dir> --out <dir> --impl <alias> --name <display> [options]
workflow publish [--api-url <url>] [--project <owner/name>] [--alias <alias>]
                 [--harness-alias <alias>] [--path <dir>] [--workflows <dir>]
                 [--rules <dir>] [--name <display name>] [--description <text>] [--dry-run]
```

Exit codes: **0** clean/success · **1** lint errors/warnings · **2**
usage/config/IO error. Every error goes to stderr as `workflow: <message>`.
Every write is preflighted — a fatal precondition is checked and reported
before anything touches disk, so a refused command never leaves a partial
result behind.

### `init` — start a new implementation from any source repo

```
workflow init <alias> --from <owner>/<repo>|<path> [--path <dir>] [--ref <ref>] [options]
```

Clones `--from` (an `<owner>/<repo>` GitHub spec, shallow by default; a
`--ref` that isn't a branch/tag falls back to a full clone + checkout) —
or, for local testing, reads an existing local directory in place with no
clone. Inside that source, `.bffless/workflow.json` is the discovery
contract: `--path` names where the package lives, or — if omitted — the
conventional default (`workflows/hello`) is tried first, then the whole
source tree is searched for candidates.

The found package is staged in a disposable temp directory, run through the
boundary-aware rename engine there (old alias → `<alias>`), and only that
already-renamed result is copied into `--dest`. Staging first — rather than
copying straight into the destination and renaming in place — means the
rename pass only ever sees the files this command actually copies: it never
walks (and therefore never rewrites) anything already sitting in a
populated destination, which matters most for `--dest .` landing a package
inside an existing host repo.

On top of the copy, `init` generates the host repo's `deploy-<alias>.yml` /
`preview-<alias>.yml` GitHub Actions workflows (skipped only when a
repo-root package is copied into a repo-root destination — forking a whole
single-implementation repo verbatim, whose own top-level CI travels with
it). Generating them requires `--project <owner/name>`, the BFFless project
this implementation deploys to (often not the same as the GitHub repo it
lives in) — a required flag exactly when generation would happen. Existing
hand-edited workflow files at those paths are never clobbered; they're
reported as skipped.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--from <owner>/<repo>\|<path>` | `bffless/workflow-implementations` | Source repo or local path |
| `--path <dir>` | searched | The package's location within the source repo |
| `--ref <ref>` | default branch | Branch, tag, or commit SHA to clone |
| `--dest <dir>` | `./<alias>` | Where to copy the package; `.` for a repo-root implementation |
| `--project <owner/name>` | — | The BFFless project this deploys to (required to generate `.github/workflows`) |
| `--harness-alias <alias>` | `workflow` | Which harness alias it deploys under |
| `--skip-existing` | off | On a path collision with the destination, keep the host's version and proceed instead of refusing — colliding paths are reported under a "skipped (already exists) — merge by hand" section, never copied. Refused (exit 2, nothing written) when a collision is a load-bearing file — `package.json`, `tsconfig.json`, a lockfile, `vite.config.*` — since skipping those orphans the copy or breaks the host's build; use `--dest <subdir>` instead |
| `--dry-run` | off | Print the copy/rename/generate plan; write nothing |

Without `--skip-existing`, any path the copy would overwrite at `--dest`
refuses the whole command up front (exit 2, every colliding path listed) —
the error also names `--skip-existing` as the way past it.

The report (real run and `--dry-run` alike) also lists every pre-existing
destination directory the copy merges files into (e.g. `merged into
existing scripts/ (1 file added)`) — directory-level merges never show up
as file conflicts, so this is the only trace they leave.

If the destination isn't `.`, `init` prints a reminder to add it to
`pnpm-workspace.yaml` (creating the file if the host repo doesn't have one
yet) and re-run `pnpm install`: the generated workflow builds with `pnpm
--filter ./<dest> run build`, which only resolves once the workspace covers
it.

### `rename` — rename an implementation's alias in place

```
workflow rename <old> <new> [--dry-run]
```

Run from inside an already-`init`ed implementation directory. `<old>` must
match what `.bffless/workflow.json` actually declares, or the command
refuses rather than guessing which tree was meant. Renames the
`.bffless/proxy-rules/<old>/` directory and rewrites every non-binary,
non-vendored file's text content wherever `<old>` appears with a word
boundary on both sides (so `hello-pr-1`/`hello_jobs` are rewritten while
`othello` is left alone).

### `add` — scaffold a new workflow + rule stub

```
workflow add <name> [--step <path>]…
```

Run from inside an already-`init`ed implementation directory (the alias —
and therefore the rule-set directory it scaffolds into — is read from
`.bffless/workflow.json`). Writes `.bffless/workflows/<name>.workflow.yaml`
(one job, one `uses: pipeline` step per `--step`, defaulting to a single
step named `<name>` when `--step` is omitted) plus a matching rule stub
(`rule.yaml` + `.fn.js` + `.fn.test.yaml`) per step path — so `workflow
lint` reports zero `rule-missing` findings immediately after `add`, no
hand-authoring required first.

### `lint` / `index`

```
workflow lint  <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
workflow index <workflows-dir> --out <dir> --impl <alias> --name <display> [options]
```

Same flags and the same exit-code contract as `@bffless/workflow-lint`'s own
`workflow` CLI — see [its README](../workflow-lint/README.md#cli) for the
full flag reference. `index` here also accepts one flag `workflow-lint`'s own
CLI doesn't have:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--driver-repo <owner/name>` | `GITHUB_REPOSITORY` when set, else omitted | ADR-0006: the GitHub repo whose `workflow-drive.yml` a `repository_dispatch` reaches; written onto the index as `driver.repo` |

### `publish` — index, prepare, sync, deploy, attach

```
workflow publish [--api-url <url>] [--project <owner/name>] [--alias <alias>]
                 [--harness-alias <alias>] [--path <dir>] [--workflows <dir>]
                 [--rules <dir>] [--name <display name>] [--description <text>] [--dry-run]
```

Run from inside an already-`init`ed implementation directory. Drives the
same four moves `bffless/publish-workflow`'s GitHub Action makes, in
process, against a live BFFless instance:

1. **index** — `buildIndex` (the same machinery `workflow index` uses)
   builds `<path>/.bffless/workflows/index.json` from `--workflows`,
   checked against `--rules`.
2. **prepare** — an alias-named copy of the rule set is staged under a
   disposable temp dir, plus a generated `/w/<alias>/*` forwarder rule
   (`forwardCookies: true`, `order: 5`, and a `headerConfig` that forwards
   `cookie` and `authorization` — the CE backend strips a caller's
   credential from an in-process sibling call unless the rule lists it, so
   an app token reaches the alias) pointing at the alias served
   in-process by the CE backend — never written into the source tree.
3. **rules push** — spawns `npx --yes bffless@0.3.3 rules push` against the
   staged copy, syncing it under `/api/<alias>/` on `--project`.
4. **upload + attach** — zips `--path` and deploys it to the `--alias`
   (`base-path: /`, its own rule set attached by name), then unions the
   synced rule set's id into `--harness-alias`'s own `proxyRuleSetIds` —
   idempotent, so publishing the same implementation twice is a no-op.

The API key comes from `BFFLESS_API_KEY` **only** — never a flag (it would
otherwise land in the process list). A missing key exits 2 before any
network call. `--dry-run` prints every move with fully resolved values
(URLs, alias, rule-set names, paths) and performs none of them.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--api-url <url>` | `BFFLESS_API_URL` | Base URL of the BFFless instance |
| `--project <owner/name>` | — | The BFFless project the alias + rule set live on (required) |
| `--alias <alias>` | the identity file's alias | The implementation alias |
| `--harness-alias <alias>` | `workflow` | The harness alias carrying the union of implementation rule sets |
| `--path <dir>` | `dist` | Built bundle directory, also `index`'s `--out` |
| `--workflows <dir>` | `.bffless/workflows` | Directory of authored workflow YAML |
| `--rules <dir>` | `.bffless/proxy-rules/<alias>` | The implementation rule-set directory |
| `--name <display name>` | the alias | Display name shown on the Implementations screen (move 1's `index.json`) |
| `--description <text>` | none | One line about the bundle, shown on the Implementations screen (move 1's `index.json`) |
| `--driver-repo <owner/name>` | `GITHUB_REPOSITORY` when set, else omitted | ADR-0006: the GitHub repo whose `workflow-drive.yml` a `repository_dispatch` reaches; passed through to move 1's `index.json` as `driver.repo` |
| `--dry-run` | off | Print the four resolved moves; write nothing, call no network |

## Both packages ship a `workflow` bin

`@bffless/workflow-lint` cannot drop its `bin: workflow` (a breaking change
under `bffless/publish-workflow`'s `^1.0.0` npx pin); this package claims the
same bin name — the intended end state for `npx @bffless/workflow`. If both
are installed as dependencies of the same project, whichever installs last
wins the shared `node_modules/.bin/workflow` shim; invoke this package
explicitly (`npx @bffless/workflow`, or this monorepo's `pnpm workflow:cli`)
when that matters.
