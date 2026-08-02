# Per-app releases with release-please, and a single registry publish

**Date:** 2026-08-02
**Status:** design approved, plan pending
**Repo:** `bffless/apps`

## Problem

Two things are wrong, and they share a cause.

**App versions are hand-maintained.** `apps/<app>/bffless-app.json` carries a `version` that nothing generates. It is the number the app catalog reads to decide what to install and whether an update is available, and it is edited by hand. `apps/<app>/package.json` carries a second version, `0.0.0` in every app, that nothing reads. A third pair lives in `.claude-plugin/marketplace.json` and `plugins/bffless-apps/.claude-plugin/plugin.json`, kept in sync by the conventions check.

The number that drives installs is the only one with no machinery behind it.

**The registry is published once per app release.** `app-bundles.yml` fires on a tag push. It builds *one* app's bundle, cuts *one* release — and then rebuilds the *entire* registry and republishes the *entire* composite artifact. `deploy-store.yml` publishes the same artifact again on store or manifest changes.

So releasing two apps means two publishes of the same global artifact, from the same commit, seconds apart.

### What that cost us on 2026-08-02

Releasing reader v1.0.1 and handoff v1.0.2 from commit `cb98ed4` produced a registry listing reader only, and it stayed that way.

Two distinct failures stacked:

1. **A visible-but-correct omission.** The manifests were bumped by hand and merged *before* the tags existed. `build-registry.mjs` omits any app whose declared version has no published release, so when reader's run rebuilt the registry, handoff — declaring an as-yet-untagged `1.0.2` — dropped out. The registry went from 2 apps to 1. The rule behaved as designed; the window between "manifest bumped" and "tag cut" is what should not have existed.

2. **A silent lost write.** Handoff's run, 42 seconds later, correctly built `2 app(s), 0 omitted` and published last. The deployment holding the `app-registry` alias merged handoff's *new* asset files (13 → 20) and updated `registry.json`'s record to 6393 bytes — but the bytes served are still the previous 3441-byte one-app body. Both the public domain and the admin file viewer show it, and `cf-cache-status: DYNAMIC` rules out the CDN. CE derives a storage key as `owner/repo/commits/<commitSha>/<publicPath>` (`deployments.service.ts:1733`), so the second publish targeted a key the first had already written. Adding new files works; replacing an existing file's content does not.

Failure 2 is a CE bug and is **out of scope here** — it needs its own investigation on CE's upload-finalize path. This design removes the condition that triggers it: two publishes from one commit.

## Approach

Let release-please own per-app versions, and give the registry exactly one publisher.

The two halves reinforce each other. release-please bumps the manifest and cuts the tag **in the same commit**, which closes the window that caused failure 1. And because that release commit is a new SHA, and only one workflow publishes, no two registry publishes ever share a storage key — which sidesteps failure 2 without depending on the CE fix.

## 1. Versioning

Each **catalog** app — one shipping a `bffless-app.json` — becomes a release-please component in manifest mode, scoped to its own directory. Today that is `reader` and `handoff`. Studio ships no manifest, is not installable from the catalog, and gets no component; adding one would mean an `extra-files` entry pointing at a file that does not exist.

| File | Role |
| --- | --- |
| `release-please-config.json` | one `packages` entry per app, keyed on `apps/<app>` |
| `.release-please-manifest.json` | current version per component |

Configuration per app:

```json
"apps/reader": {
  "release-type": "node",
  "component": "reader",
  "include-component-in-tag": true,
  "extra-files": [
    { "type": "json", "path": "bffless-app.json", "jsonpath": "$.version" }
  ]
}
```

- **Tag format** is `reader-v1.0.1` — the convention already in use, so existing releases, `build-registry.mjs`'s tag lookup, and `app-bundles.yml`'s `TAG%-v*` parsing all keep working against unchanged inputs.
- **Change detection** is by commit path: a conventional commit touching `apps/reader/**` bumps reader and nothing else. An untouched app is not released and does not need to be — see "Unchanged apps" below.
- **One aggregated release PR**, not one per app (release-please's default in manifest mode). One PR merge produces one commit, one set of tags, one publish.

### package.json stops being a lie

`release-type: node` bumps `apps/<app>/package.json`, and `extra-files` mirrors that version into `bffless-app.json`.

This is a deliberate reversal of an earlier position in this conversation, which was to leave `package.json` at `0.0.0` to avoid introducing a fourth version number. On inspection that is the wrong trade: leaving a real file declaring a false version is worse than having two files declaring the same true one. `package.json` becomes the source, `bffless-app.json` a generated mirror, and neither is edited by hand.

### What stays manual

**`requires.ceMin`** is a judgement about which CE release an app depends on. It cannot be derived from commit history — the current value of `0.4.8` was reasoned from a CE feature landing in `bffless/ce#621`, not computed. It stays hand-set, and the authoring docs already introduced in `.claude/skills/publish-app/SKILL.md` should say so explicitly.

**`.claude-plugin/marketplace.json` / `plugin.json`** keep their existing version pair and the conventions check that keeps them in sync. They version the Claude plugin, not an app, and folding them in would conflate two release cadences.

## 2. One workflow

`.github/workflows/release.yml`, on push to `main` plus `workflow_dispatch`. Three jobs, ordered by `needs`:

```
release          release-please: maintain the Release PR;
                 on a Release PR merge, bump versions + cut tags/releases
                 outputs: releases_created, paths_released
      │
      ▼
bundles          matrix over paths_released
                 build each released app's bundle, attach to its release
      │
      ▼
publish-registry full snapshot of every app → registry.json + site + assets
                 → the app-registry alias
```

**Why one workflow rather than three chained.** `publish-registry` must not run until every bundle is attached, because the registry omits an app whose release has no bundle asset. Expressed as `needs`, that ordering is a guarantee. Expressed as cross-workflow events, it is a race — the same class of timing problem that produced this incident.

**`publish-registry` is the sole publisher of the registry.** That is the property that matters; everything else is mechanism.

It runs when either:
- `releases_created == 'true'`, or
- the push changed `store/**`, `apps/*/catalog/**`, `apps/*/bffless-app.json`, or `scripts/build-*.mjs` / `scripts/fetch-sidecars.mjs`, or
- the run was dispatched manually.

The path condition is evaluated with `git diff --name-only` against the previous commit rather than a workflow-level `paths:` filter, because the `release` job must see *every* push to keep the Release PR current.

### Unchanged apps

`build-registry.mjs` walks all apps on every run and includes any whose declared version has a published release. An app nobody touched keeps pointing at the release it already had. Only `bundles` is scoped to what changed; `publish-registry` is always a full snapshot.

### The composite artifact stays

Site, `registry.json` and assets continue to publish as one artifact to one alias. Splitting the registry onto its own domain was considered and declined: the registry references its own assets by absolute URL (`https://apps.bffless.dev/assets/reader/icon.png`), so shipping them together is what guarantees an entry never points at an asset that has not been uploaded. Splitting converts that guarantee back into an ordering problem.

The cost is republishing ~1.6 MB across 20 files per publish, which measured at roughly 1 second of upload inside a ~90 second job. Storage accumulates per commit prefix rather than overwriting; CE has a prefix-cleanup path, and whether it runs automatically here is worth confirming but does not block this work.

## 3. What is retired

| Workflow | Change |
| --- | --- |
| `app-bundles.yml` | Bundle building moves into `release.yml`'s `bundles` job. Kept only as a `workflow_dispatch` for rebuilding a single bundle by hand; **its registry publish is deleted**. |
| `deploy-store.yml` | Folded into `publish-registry`. **Deleted**. |

`deploy-store.yml` is the subject of open PR #281, which adds a `workflow_dispatch` to it so a stale registry can be republished by hand. That PR is a stopgap for the incident above and this design supersedes it: `release.yml` carries its own dispatch. Either merge #281 first and delete the file here, or close it unmerged — but do not leave both a dispatchable `deploy-store.yml` and `release.yml` in place, because that restores two registry publishers and with them the bug this design exists to remove.

Both currently publish the registry. That is the root of the incident, and after this change neither does.

## Error handling

- **A bundle build fails.** Its matrix leg fails, `publish-registry` does not run, and the registry keeps serving the previous good snapshot. The tag and GitHub Release still exist, so re-running `app-bundles.yml` by dispatch for that app, then dispatching `release.yml`, recovers without a new commit.
- **An app is released but its bundle upload fails silently.** `build-registry.mjs` omits it and emits its existing `::warning` plus a step-summary line. The registry is short an app rather than serving a broken entry — the current behaviour, retained deliberately.
- **`publish-registry` runs twice on one commit** (a merge, then a manual dispatch). This is the CE lost-write condition. It is no longer reachable through normal operation, but a manual dispatch on an already-published commit can still reach it. Documented as a known sharp edge until the CE bug is fixed; the workaround is to dispatch after a new commit.

## Testing

- `release-please-config.json` and `.release-please-manifest.json` parse, and their component set matches the app directories carrying a `bffless-app.json`.
- A dry-run release-please invocation on a branch with a `feat(reader):` commit proposes a reader bump and no handoff bump.
- `pnpm apps:check` continues to pass, including the conventions check's existing manifest validation.
- `node --test scripts/*.test.mjs` continues to pass; `build-registry.test.mjs` already covers the omit-when-no-release rule that failure 1 exercised.
- Workflow YAML validates, and the `needs` chain is asserted by inspection: `publish-registry` names both `release` and `bundles`.

Verifying the end-to-end release path requires a real merge to `main`; the first live run is the acceptance test, and the recovery path above is what makes that acceptable.

## Out of scope

- **The CE lost-write bug.** Separate investigation in `bffless/ce`, on the upload-finalize path. This design removes the trigger, not the defect.
- **`registry.bffless.dev`.** Considered and declined above.
- **Backfilling `.release-please-manifest.json`** beyond the versions currently declared in each `bffless-app.json` (`reader` 1.0.1, `handoff` 1.0.2). Studio ships no manifest and is not a catalog app.
