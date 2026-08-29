# `bffless/apps` PR checklist

The house rules a PR against this monorepo is judged by. `apps-implement` writes
against this file; a human reviewer reads it. It covers the surfaces that are
expensive to get wrong here — the ones that reach a live BFFless instance, a
published package, or a release tag. Ordinary code quality is not in scope.

## 1. A PR can be a live write — know which app you are in

CI here is not inert. Merging always deploys; **opening a PR** deploys for some
apps and not others, and the difference matters:

| App | On `pull_request` | On merge to `main` |
| --- | --- | --- |
| `reader` | **Writes live rule sets** with a `pr-<N>` name suffix and mints a `reader-pr-<N>` alias (`preview-reader.yml`) | Writes the live `reader` rules + alias |
| `studio` | Dry-run rule report only; deploys to the **shared** `studio-preview` alias, which runs against the **LIVE** `studio` / `studio-blog` rule sets | Writes the live `studio` rules + alias |
| `recall` | Dry-run rule report only; deploys to the **shared** `recall-preview` alias | Writes the live `recall` rules + alias |
| `workflow` | Lint/test gates only (`workflow-app.yml`) — no preview deploy | Writes the live `workflow` rules + alias |
| `handoff` | No deploy or preview — it ships via catalog install | — |

Consequences to check before you push:

- **A `reader` rule change reaches the live instance the moment the PR opens.**
  It is scoped to `pr-<N>` sets, but it is a real write. Say so in the PR body.
- **A `studio` or `recall` rule change is *not* exercised by its preview.** The
  preview alias is wired to the live sets, so the rule diff only takes effect on
  merge. The dry-run report in the checks is the only review it gets — read it.
- **Shared preview aliases are single-tenant.** `studio-preview` and
  `recall-preview` are reused, newest build wins. Two open PRs on the same app
  fight over the alias. Note it rather than minting a new alias: a new alias is a
  new origin needing its own bucket CORS entry and rule-set wiring.
- Rule sets are pruned to what the authored layout declares. Adding a rule is
  safe; deleting or renaming one removes it from the live instance on merge.

## 2. `$schema` in a preview resolves against LIVE schemas

Pipeline rule JSON that references a schema resolves it on the **live** instance,
not against anything in the branch. A PR that adds a rule depending on a schema
that does not exist live yet will deploy and fail at runtime. Land the schema
first, or say explicitly in the PR body that the rule is inert until it exists.

## 3. The PR title is the release commit

This repo squash-merges and runs release-please. **The PR title becomes the
commit subject and the release note.** A non-conventional title does not just
look untidy — it blocks the version bump, the tag, the image build and the
deploy that follow from it.

- `type(scope): subject`, `!` for breaking. Scope is the app or package
  (`workflow`, `studio`, `reader`, `workflow-lint`, …).
- One PR title says one thing. If it needs "and", the summary must justify why
  the two belong in one change.
- **Never edit `CHANGELOG.md`** — release-please owns every one of them.

## 4. `build` is part of verification, not an extra

Vitest does not typecheck. A green `pnpm <app>:test` says nothing about types;
`tsc -b` has been red while the suite passed. Every verify chain ends with the
build:

```
pnpm <app>:lint
pnpm <app>:test
pnpm <app>:build
```

Where an app splits staging from tests (`test:stage`), `pnpm stage` runs first —
CI order is stage → build → test. `@bffless/workflow-lint` must be **built**
before its own tests run.

## 5. Repo-wide gates the change must not break

These run in CI on the paths they watch; run them locally when you touch those
paths rather than discovering them in the checks:

- `pnpm apps:check` — per-app pipelines convention (`app-conventions.yml`, also
  runs `pnpm scripts:test`).
- `pnpm skills:check` — skills parity between `.claude/skills/**` and
  `.agents/skills/**` (`skills-parity.yml`). A skill must be **committed** to be
  visible from a worktree.
- `workflow-lint` — the spec gate for `apps/workflow` and its schema.

## 6. `packages/` changes have monorepo blast radius

`packages/workflow-lint`, `workflow-headless` and `workflow-script` are consumed
by apps and, for the published ones, by CI outside this repo. A change there is
an interface change: name the consumers in the PR body and verify at least the
in-repo ones build. Published packages pin versions in consumers — bumping is a
deliberate act, not a side effect.

## 7. Behaviour changes need tests, and the report must be honest

Match the surrounding style (Vitest per app). Paste real command output with real
counts in the PR body — not "passed". If something fails and you cannot fix it
honestly, say so. Never `.skip`, weaken or delete a test to reach green.
