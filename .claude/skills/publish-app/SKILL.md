---
name: publish-app
description: Add a bffless-apps monorepo app to the CE app catalog — author its bffless-app.json manifest, build and verify the install bundle, and publish it via GitHub release + registry.json so self-hosted CE (>= 0.4.0) can 1-click install it from Admin -> Apps.
---

# publish-app

Turns an app already living under `apps/<app>/` in this monorepo (with the required
authored rule set(s) + `bffless/README.md` — see `docs/app-pipelines-convention.md` and
`pnpm apps:check`) into a **catalog entry**: a versioned, signed, downloadable bundle that
CE's Admin → Apps page can 1-click install. Handoff (`apps/handoff/bffless-app.json`) is
the only app that has done this so far and is the worked example throughout.

This is a "document what exists" skill — the manifest shape is **owned by CE**
(`apps/backend/src/app-catalog/app-manifest.types.ts` / `app-manifest.util.ts`), not by
this repo. When in doubt, cross-check against a real CE checkout rather than trusting a
stale copy of this skill.

## 1. What a catalog bundle is, and the trust story

A bundle is a zip — `bffless-app.json` + `rulesets/*.json` + `dist/**` — built by
`scripts/build-app-bundle.mjs`, uploaded as a GitHub release asset, and indexed by
`registry.json` (published to `apps.bffless.dev`, a **different** BFFless instance than
where apps themselves deploy — see `.github/workflows/app-bundles.yml`).

**This is a one-way, first-party-only trust relationship, deliberately.** There is no
arbitrary-URL "install from anywhere" field in CE's UI — only entries CI put in
`registry.json`. That's not incidental caution: a rule set's handler steps carry real
**server-side executable code** (`.fn.js` bodies, run by CE's pipeline engine on every
matching request). Installing a bundle means CE downloads it, verifies its `sha256`, and
then *runs code from it on the user's data plane*. A manifest is a **security artifact**,
not just install metadata — treat authoring one with the same care as adding a new backend
dependency, not like editing a README. Concretely:

- Never add a `bffless-app.json` for an app whose rule set you haven't read end to end.
- Never hand-edit `registry.json` or point `APPS_REGISTRY_URL` at anything other than the
  real `bffless/apps` releases — that config knob exists for air-gapped/self-published
  catalogs, not as a way to skip review.
- The `sha256` in `registry.json` is what CE checks after download; a mismatch aborts
  before anything is written. Never publish a registry entry whose sha wasn't produced by
  `build-app-bundle.mjs`'s own sidecar.

## 2. Authoring `bffless-app.json`

Create `apps/<app-id>/bffless-app.json`. Use `apps/handoff/bffless-app.json` as the
template — copy it, then change every field deliberately; don't leave Handoff's values in
by accident.

```json
{
  "schemaVersion": 1,
  "id": "handoff",
  "name": "Handoff",
  "version": "1.0.0",
  "summary": "Share files, folders, and Sites with per-folder access control, share links, and live comments.",
  "docsUrl": "https://github.com/bffless/apps/blob/main/apps/handoff/bffless/README.md",
  "sourceUrl": "https://github.com/bffless/apps/tree/main/apps/handoff",
  "requires": { "presignedStorage": true, "ceMin": "0.3.15" },
  "install": { "...": "see below" },
  "eject": { "...": "see below" }
}
```

- **`id`** — must equal the `apps/<id>` directory name (both `check-app-conventions.mjs`
  and CE's `validateAppManifest` enforce this), and match `/^[a-z0-9-]+$/`.
- **`name`** — display name, any non-empty string.
- **`version`** — semver. **This file is the app's version of record.** There is no
  release-please, no `package.json` version bump, no changelog automation in this repo for
  catalog purposes — you bump `version` by hand in the PR that changes the app (or just to
  cut a new catalog release), and that bump is what drives the release tag (§5). Forgetting
  to bump it means `node scripts/build-app-bundle.mjs` re-produces the *same* version —
  harmless but pointless; the registry entry won't change.
- **`summary`** — one line, shown in the catalog list.
- **`iconUrl`, `docsUrl`, `sourceUrl`** — all optional strings, no format validation beyond
  "is a string". Point `docsUrl` at the app's `bffless/README.md` on GitHub and `sourceUrl`
  at its `apps/<id>/` tree, as Handoff does.
- **`requires`**:
  - `presignedStorage: true|false` — does the app's upload flow need presigned PUT
    support? This is **not** "needs a bucket" — CE ≥ 0.3.15 supports presigned uploads on
    local filesystem storage too (`spec/local-fs-presigned-uploads`), so this flag really
    means "needs presigned uploads at all," and CE's preflight is what decides whether the
    *target* storage backend can serve them.
  - `ceMin` — a minimum CE version, checked by CE's own preflight before install. **Pick it
    honestly**: the lowest version where the app actually works end to end, not the version
    you happen to be developing against. Work backward from what the app's rule set or
    manual steps actually depend on. Handoff's `0.3.15` is not arbitrary — it's the tag
    where local-FS presigned uploads landed, because without it Handoff's uploads are
    hard-gated behind a real bucket. If your app needs a CE API/feature that landed in a
    specific release, find that tag (`git log --oneline -- <path>` in a CE checkout, or
    `git tag --contains <commit>`) and use it. Getting this wrong either blocks installs
    that would have worked, or — worse — lets an install proceed that then breaks at
    runtime because the CE feature it needs isn't there yet.
- **`install.alias`** — the alias the app deploys to (matches `/^[a-zA-Z0-9_-]+$/`, same
  rule as `CreateAliasDto`/`CreateDeploymentZipDto`).
- **`install.deployment.path`** — relative to the app dir, almost always `"dist"` (Vite's
  build output).
- **`install.deployment.basePath`** — where the bundle is served from, e.g.
  `/apps/handoff/dist`. Must match `/^\/[a-zA-Z0-9/_-]*$/` (leading slash, no `..`).
- **`install.ruleSets`** — one entry per **authored** set the app ships under
  `.bffless/proxy-rules/<name>/` (§1 of `docs/app-pipelines-convention.md`):
  `{ "file": "rulesets/<name>.json", "attachToAlias": true }`. `file` must match
  `/^rulesets\/[a-zA-Z0-9._-]+\.json$/` with no `..`, and there must be a matching
  `apps/<id>/.bffless/proxy-rules/<name>/ruleset.yaml` — `build-app-bundle.mjs` builds each
  one from that source. Ship every set the app has (Handoff ships two: `handoff` +
  `handoff-rss-feed`; missing one leaves part of the app 404ing, same trap as manual
  install — see `install-app`'s step 2).
- **`install.domain`** — `{ "subdomain": "<id>", "isPublic": true, "isSpa": true }` for a
  typical SPA. `subdomain` must match `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` and must **not**
  be a reserved name (`www`, `api`, `admin`, `mail`, `ftp`, `smtp`, `pop`, `imap`, `dns`,
  `ns`, `mx`, `localhost`, `staging`, `dev`, `test`, `prod`, `production`, `minio` — CE's
  `RESERVED_SUBDOMAINS`, mirrored from `domains.service.ts`). An app that's private/login-
  gated (like `reader`) would set `isPublic: false` instead.
- **`install.schedules`** — background pipeline schedules the app needs (Reader's
  `/api/refresh` + `/api/prune` are the model, see `install-app` step 4). Each entry is
  `{ name, cronExpression, timezone?, targetRulePath, targetRuleMethod? }` —
  `targetRulePath`/`targetRuleMethod` let CE locate the synced rule by
  `(pathPattern, method)` after import, since the rule's id isn't known until sync runs.
  Handoff ships none (`"schedules": []`).
- **`install.manualSteps`** — anything a human still has to do in the admin panel after
  install (mirrors the app's README "Manual setup (admin panel)" section, but structured).
  Each entry: `{ id, title, body, deepLink?, appliesWhen? }`.

  **`appliesWhen` is a closed enum CE evaluates against the *target instance's real
  context* — not a hint, not free text:**

  | Value | Shown when | Handoff example |
  | --- | --- | --- |
  | `always` (default if omitted) | unconditionally | the iframe/COOP-COEP step — every install could hit it |
  | `bucketStorage` | the target project's storage backend is a real bucket (S3/GCS/Spaces/MinIO) | the bucket-CORS step — meaningless on local-FS, where there's no cross-origin PUT to allow |
  | `localStorage` | the target is local filesystem storage | the inverse — a step only relevant without a bucket |
  | `platformMode` | installing into a Platform (multi-tenant) workspace | e.g. a step about Control-Plane-managed SSL |
  | `selfHosted` | installing into a self-hosted (non-platform) CE | the inverse |

  This is *why* Handoff's bucket-CORS step is tagged `bucketStorage` and not `always`: on a
  fresh local-FS install (CE ≥ 0.3.15) there is no bucket to configure CORS on, so showing
  that step there would be actively wrong guidance, not just noise. Get the tag wrong and
  either a needed step goes unshown, or a stale/irrelevant step is presented as required —
  both erode trust in the checklist. There is **no expression language** here on purpose
  (see the design spec's rationale) — if a step's condition doesn't map to one of these five
  values, split it into multiple steps or don't gate it.
- **`eject`** — optional, but fill it in: it's what keeps the catalog from being a dead
  end. Publishing an app to the catalog does **not** replace the fork-and-own route
  (`install-app`) — the two are different trades, easy-start versus customizable, and
  neither supersedes the other. `eject` is the bridge between them: it tells CE how an
  installed app maps back to "take ownership" by forking this monorepo, and because the
  fork's first deploy lands on the same alias the install created, a user can start on the
  catalog and move to a fork without starting over. Shape:
  `{ repo, appPath, deployWorkflow, variables, secrets }`.
  Handoff: `repo: "bffless/apps"`, `appPath: "apps/handoff"`,
  `deployWorkflow: "deploy-handoff.yml"`, `variables: ["BFFLESS_URL", "BFFLESS_PROJECT"]`,
  `secrets: ["BFFLESS_API_KEY"]` — read straight off what `.github/workflows/deploy-<app>.yml`
  actually consumes; don't guess.

## 3. The validation contract (know this before you write the manifest, not after)

Two validators exist and must both pass, but they are **not equivalent** — treat CE's as
authoritative:

- **`scripts/check-app-conventions.mjs`** (`pnpm apps:check`) — a fast, dependency-free
  **local mirror** of CE's shape checks. It's what CI in this repo runs; passing it is
  necessary but not sufficient.
- **CE's real `validateAppManifest`** (`apps/backend/src/app-catalog/app-manifest.util.ts`
  in `bffless/ce`) — the actual gate at install time. This repo's copy can drift from it
  (e.g. the reserved-subdomain list is a hand-maintained copy, marked as such in CE's own
  source). If the two disagree, CE wins and your app fails to install even though
  `pnpm apps:check` was green.

The regexes/rules CE enforces, as of the `app-catalog` feature (CE 0.4.0):

| Field | Pattern / rule |
| --- | --- |
| `id` (manifest + registry entry) | `/^[a-z0-9-]+$/` |
| `install.alias` | `/^[a-zA-Z0-9_-]+$/` |
| `install.deployment.basePath` | `/^\/[a-zA-Z0-9/_-]*$/` |
| `install.domain.subdomain` | `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, and not in `RESERVED_SUBDOMAINS` |
| `install.ruleSets[].file` | `/^rulesets\/[a-zA-Z0-9._-]+\.json$/`, no `..` |
| `version` / `requires.ceMin` / registry `version` | must parse as semver (`compareSemver`) |
| registry entry `bundleUrl` | required, must start `https://` |
| registry entry `sha256` | required, `/^[a-f0-9]{64}$/i` |
| `install.manualSteps[].appliesWhen` | one of `always`, `bucketStorage`, `localStorage`, `platformMode`, `selfHosted` |

**A subtler, high-consequence gate: CE's `ValidationPipe` runs with
`forbidNonWhitelisted`.** The rule-set sync endpoint's DTO (`SyncProxyRuleSetDto`)
explicitly whitelists the envelope fields (`version`, `exportedAt`, `kind`, `ruleSet`,
`rules`, `schemas`, …) that `bffless rules build` produces today — but if a *newer* CLI or
schema version ever adds a field CE's DTO doesn't know about yet, the whole sync payload is
**rejected**, not silently stripped. That means a bundle built with a CLI/schema ahead of
the target CE's DTO doesn't degrade gracefully into "installs with fewer fields" — the
install **aborts outright**. Build bundles with a CLI version your floor `ceMin` is known to
accept, and re-verify (§4) against an actual CE checkout when you bump either the CLI or
`ceMin`.

## 4. Verify before publish

Run these in order, on every manifest change, before pushing a release tag:

1. **Build the bundle:**
   ```bash
   node scripts/build-app-bundle.mjs <app-id>
   ```
   This builds the frontend (`pnpm --filter <app-id> build`), builds every declared rule
   set from its authored source (`npx bffless@latest rules build <dir> -o ...`), and zips
   `bffless-app.json` + `rulesets/*.json` + `dist/**` into
   `dist-bundles/<app-id>-v<version>.bundle.zip` with a `.sha256` sidecar. It already fails
   loudly on the structural problems (missing manifest fields, `install.ruleSets` empty,
   no matching authored set dir) — treat any failure here as blocking, not a warning.

2. **Run the local convention check:**
   ```bash
   pnpm apps:check
   ```
   Confirms `schemaVersion`, `id`, `version`, `install.alias`/`install.domain.subdomain`,
   and every `ruleSets[].file` → authored-set mapping. Remember: passing this is necessary,
   not sufficient (§3).

3. **Unzip and eyeball the layout:**
   ```bash
   cd /tmp && rm -rf bundle-check && mkdir bundle-check && cd bundle-check
   unzip -l /path/to/repo/dist-bundles/<app-id>-v<version>.bundle.zip | head -30
   unzip /path/to/repo/dist-bundles/<app-id>-v<version>.bundle.zip -d .
   ```
   Confirm: `bffless-app.json` at the root, `rulesets/<name>.json` per declared set (open
   one — it should be the full `bffless rules build` envelope, not hand-trimmed), and
   `dist/` matching `install.deployment.path` with the app's real built assets (an
   `index.html`, hashed JS/CSS, not a stale/empty dir from a prior build).

4. **The high-value check: round-trip the built rule-set JSON through CE's real loader, if
   a CE checkout is available** (e.g. one of the `repos/ce/.claude/worktrees/*` worktrees
   that has the `app-catalog` feature). This is the only step that exercises the *actual*
   gate (§3) rather than this repo's mirror of it. Two ways to do it, cheapest first:
   - Point a running CE dev instance's `PUT /api/proxy-rule-sets/project/:id/sync` at the
     built `rulesets/<name>.json` directly (same payload shape CE's app installer sends) and
     confirm it's accepted (200, sensible change plan under `options.dryRun`), not rejected
     for unknown fields.
   - Or, if the app-catalog feature's `AppBundleService`/`app-installer.service.ts` is
     available in the checkout, feed the whole zip through `loadFromBuffer` (or the
     equivalent test helper in `app-catalog.e2e-ish.spec.ts`) and confirm it parses and the
     preflight verdicts look sane for your `requires`.
   Skipping this step is acceptable for a low-risk manifest-only edit (e.g. fixing a typo in
   `summary`); it is not optional before a first publish of a new app, or after bumping the
   CLI/schema version used to build rule sets.

## 5. Publish

1. Bump `version` in `apps/<app-id>/bffless-app.json` (§2) if you haven't already, and get
   it merged to `main` via a normal PR.
2. Cut the release **one of two ways**:
   - **Tag push (normal case):** `git tag <app-id>-v<version> && git push origin <app-id>-v<version>`
     — e.g. `handoff-v1.1.0`. The tag `push` trigger in
     `.github/workflows/app-bundles.yml` resolves the app id from the tag (`handoff-v1.1.0`
     → `handoff`), builds, and publishes.
   - **`workflow_dispatch` (manual re-publish without a new tag):** Actions tab → "App
     bundles — build + publish" → Run workflow → `app: <app-id>`. Useful for re-running
     after a registry-only fix; it re-resolves `version` from the manifest that's currently
     on the branch you dispatch from and **re-uses the existing tag** (`gh release upload
     --clobber` if the tag/release already exists, `gh release create` if not) — it does
     **not** cut a new tag itself.
3. **What the workflow does after that** (you don't have to do any of this by hand):
   - builds the bundle (same `build-app-bundle.mjs` you ran locally);
   - creates (or re-uses, with `--clobber`) the GitHub release `<app-id>-v<version>` and
     uploads the zip + sha256 sidecar as release assets;
   - re-fetches the already-published sha256 sidecar for **every other** manifested app
     (best-effort — an app with a manifest but no release yet is *omitted* from the
     registry with a loud `::warning::` annotation + job-summary line, not a failed run);
   - rebuilds `registry.json` from every manifest that now has a published release, and
     publishes it to the `app-registry` alias on the `vars.BFFLESS_REGISTRY_URL` /
     `secrets.BFFLESS_REGISTRY_API_KEY` instance (**admin.bffless.dev** — deliberately a
     different instance than where apps themselves deploy, so resetting the demo box can
     never take the catalog down).
4. **Operator steps the workflow deliberately does NOT do** (see the workflow's own header
   comment and the PR checklist it came with):
   - mapping `apps.bffless.dev` → the `app-registry` alias on the target instance;
   - adding a ~1h TTL cache rule on that alias.
   Confirm these are already in place before assuming a fresh publish is externally
   reachable — a successful workflow run does not by itself mean `registry.json` is live at
   `apps.bffless.dev`.

## 6. Troubleshooting

- **App is missing from `registry.json` after a run that looked green.** Check the run's
  job summary / `::warning::` annotations for "no published release for `<app>-v<version>`
  yet — omitting from registry.json". This means that app's manifest declares a version
  whose tag/release doesn't exist yet — either the tag was never pushed, or it was pushed
  under a different version than the one currently in `bffless-app.json`. Fix by cutting the
  matching tag (§5) or aligning the manifest's `version` back to a version that has one.
- **Install fails CE's preflight on `ceMin` or storage.** Either the target CE is genuinely
  older than the floor you declared (expected — that's the preflight working), or `ceMin`
  is wrong (§2) — verify against the CE tag history, don't just bump it until the error goes
  away on your own dev instance.
- **A manual step shows on instances where it doesn't apply (or is missing where it
  does).** Wrong `appliesWhen` (§2/§3) — re-derive it from what the step is actually
  conditioned on (bucket vs. local storage? platform vs. self-hosted?), not from what was
  convenient to test against.
- **Bundle builds locally but CE rejects the rule-set payload on install.** Almost always
  the `forbidNonWhitelisted` gap in §3 — the CLI/schema used to build `rulesets/*.json` is
  ahead of the target CE's DTO. Rebuild with an older/pinned `bffless` CLI version, or wait
  for the target CE to update.
