# Per-app pipelines convention

Every app in this monorepo is installable by the single [`GETTING-STARTED.md`](../GETTING-STARTED.md)
guide. That only stays true if every app ships the same two files in the same place — so the guide's
spine can resolve each app's specifics without being rewritten per app, and so the **per-app manual
admin-panel steps are surfaced to the reader for every app**. This convention is enforced in CI
(`.github/workflows/app-conventions.yml` → `scripts/check-app-conventions.mjs`, i.e. `pnpm apps:check`).

## The rule

Every `apps/<app>/` **must ship**:

1. Its backend pipelines, as an **authored** rule set at **`apps/<app>/.bffless/proxy-rules/<set>/`**
   (`ruleset.yaml` + a `rules/` file per route + schemas + handler bodies as real `.fn.js` files),
   which CI syncs to the project on deploy via `bffless/deploy-proxy-rules` (check drift with
   `npx bffless rules diff`). An app may ship more than one set — Studio has `studio` +
   `studio-blog`, Handoff has `handoff` + `handoff-rss-feed`.

   No secrets baked in — credentials are referenced by name or via the project's auth relay.

   > Apps used to be allowed to ship a raw `apps/<app>/bffless/<app>.proxy-rules.json` export
   > instead. That form is **retired** (Handoff, the last one, converted in bffless/apps#231): a
   > 3,500-line JSON blob can't be reviewed, linted, or tested, and editing it meant writing
   > one-off `patch-*.mjs` scripts against string anchors. Authored rules are code — diffable in a
   > PR, and CI syncs them so the repo and the live project can't silently diverge.
2. **`apps/<app>/bffless/README.md`** — with the two required sections below.

### Required README section: "Manual setup (admin panel)"

Everything the human must configure in the BFFless admin panel that the `install-app` skill
**cannot** do. The guide and the skill both point here. Enumerate, for this app:

- **External connections / AI provider tokens** — which providers, what each powers, and the link to
  obtain the token (these are admin-panel-only; there is no MCP path). E.g. Studio: **Replicate**,
  **Anthropic**. Handoff: none.
- **Secrets** — generic project secrets and where the value comes from. E.g. Studio: `HF_TOKEN` from
  Hugging Face. Handoff: none.
- **Storage backend requirements** — state explicitly if the app won't work on local file storage.
  E.g. **Handoff requires a real bucket backend (S3/GCS/Spaces/MinIO), not local file storage**;
  Studio needs a default bucket for uploads.
- **Response-header rules** — any headers not carried by the rule set. E.g. Studio's COOP/COEP for
  `ffmpeg.wasm` threading. Handoff: none.

### Required README section: "First-success checkpoint"

The concrete end-to-end action the guide ends on for this app. E.g. Studio: upload a recording → see
the transcript; Handoff: upload a file → see it served back.

## Enforcement

`scripts/check-app-conventions.mjs` fails a PR that introduces (or keeps) an `apps/<app>/` directory
missing both backend shapes or the README, or whose README lacks either required section heading.
The headings are matched by wording (any heading level, case-insensitive), so a level change is fine
but the section must be present. Run `pnpm apps:check` locally to reproduce CI.

## App-catalog manifest (`bffless-app.json`) — optional, per app

Any `apps/<app>/` may additionally ship an **`apps/<app>/bffless-app.json`** manifest, which opts the
app into BFFless CE's one-click **app catalog** (self-hosted CE ≥ 0.4.0 fetches
`registry.json`, downloads the app's bundle, verifies its `sha256`, and installs it end to end —
proxy rule sets, static deployment, domain, manual-step checklist). Don't confuse that **0.4.0
catalog-feature floor** with an app's own `requires.ceMin`, which is about what the *app* needs:
Handoff declares `0.3.15` because that's where local-filesystem presigned uploads landed. This is
**opt-in**: an app with no manifest (Studio,
Reader, as of this writing) is unaffected and still passes `pnpm apps:check` — the catalog is an
additional install path alongside the existing manual `GETTING-STARTED.md` flow, not a replacement.

The manifest shape is owned by CE (`apps/backend/src/app-catalog/app-manifest.types.ts` /
`app-manifest.util.ts` in `bffless/ce`) — this repo's copy must satisfy CE's `validateAppManifest` and,
end to end, `AppBundleService.loadFromBuffer`. See `apps/handoff/bffless-app.json` for a worked
example. Fields, in brief:

- `schemaVersion: 1`, `id` (must equal the `apps/<id>` directory name), `name`, `version` (semver —
  since this repo has no release machinery, **the manifest's `version` is the app's version of
  record**, bumped by hand in the PR that changes it), `summary`/`docsUrl`/`sourceUrl`.
- `requires: { presignedStorage?, ceMin? }` — a minimum CE version and whether the app needs presigned
  uploads (works on local file storage or a bucket as of CE v0.3.15 — this is not "needs a bucket").
- `install.alias`, `install.deployment: { path, basePath }` (path is relative to the app dir, e.g.
  `"dist"`; basePath is where the deployed bundle is served from, e.g. `"/apps/handoff/dist"`),
  `install.ruleSets: [{ file: "rulesets/<name>.json", attachToAlias }]` — one entry per **authored**
  set under `.bffless/proxy-rules/<name>/` (§1 above) — `install.domain: { subdomain, isPublic, isSpa }`,
  `install.schedules`, `install.manualSteps: [{ id, title, body, appliesWhen }]` for anything the
  installer can't do for the reader (mirrors this doc's "Manual setup (admin panel)" README section,
  but structured and filterable by `appliesWhen`: `always` / `bucketStorage` / `localStorage` /
  `platformMode` / `selfHosted`).
- `eject: { repo, appPath, deployWorkflow, variables, secrets }` — how an installed app maps back to
  "eject" into this monorepo's own CI (fork the repo, point the listed Actions vars/secrets at your
  instance, the named workflow deploys it from then on).

**Building an install bundle:** `node scripts/build-app-bundle.mjs <app-id>` builds the app
(`pnpm --filter <app-id> build`), builds each declared rule set from its authored source
(`npx bffless rules build <dir> -o rulesets/<name>.json` — the full envelope, unmodified; CE's sync
DTO whitelists the extra envelope fields and resolves schemas by name), and zips
`bffless-app.json` + `rulesets/*.json` + `dist/**` into `dist-bundles/<app-id>-v<version>.bundle.zip`
with a `.sha256` sidecar. `.github/workflows/app-bundles.yml` runs this on a `<app-id>-v<version>` tag
push (or `workflow_dispatch`), publishes the zip as a GitHub release asset, and republishes
`registry.json` (one entry per manifested app that has a published release) to the `app-registry`
alias.

`scripts/check-app-conventions.mjs` validates any `bffless-app.json` it finds — `schemaVersion`, `id`
matches the directory, `version` is semver, `install.alias`/`install.domain.subdomain` are non-empty,
and every `install.ruleSets[].file` maps to an authored set directory. This is a fast, dependency-free
local mirror of CE's shape checks, not a substitute for them — a manifest that passes here can still
be rejected by CE's real `validateAppManifest` if a CE-side rule diverges from this copy (e.g. the
reserved-subdomain list); when in doubt, cross-check against a real CE checkout.

### App-catalog content (`apps/<app>/catalog/`) — required for manifested apps

Any `apps/<app>/` that ships a `bffless-app.json` manifest must also include a `catalog/` directory
with **required** files that populate the app store:

- **`description.md`** (required) — Markdown description of the app, displayed on its store page
- **`thumbnail.png`** (required) — Landscape thumbnail image for the store catalog grid
- **`icon.png`** (optional) — Square icon for UI chrome
- **`screenshots/`** (optional) — Directory of PNG screenshots, alphabetically sorted by filename

These catalog assets are folded into `registry.json` by `scripts/build-registry.mjs` and served from
`https://apps.bffless.dev/assets/<app>/description.md` (and similarly for images). Without catalog
content, the registry entry and store page render half-empty silently — `pnpm apps:check` enforces
that manifested apps include at least `description.md` and `thumbnail.png` to catch this before
deploy.
