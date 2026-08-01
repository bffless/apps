# App Store Frontend for apps.bffless.dev — Design

**Date:** 2026-08-01
**Status:** Approved (design), pending implementation plan
**Context:** CE v0.4.0 shipped the app catalog + 1-click install (bffless/ce#567). `apps.bffless.dev`
currently serves only `registry.json` (alias `app-registry`, domain path `/registry-staging`). This
design adds a public store frontend on the same domain and a metadata pipeline (descriptions,
thumbnails, screenshots) usable by every registry consumer, including CE's Admin → Apps page.

## Decisions made during brainstorming

1. **Showcase only** — the store's CTA is static "open Admin → Apps on your CE instance"
   instructions plus a get-CE link. No deep-linking to the visitor's instance, no install-from-store.
2. **Metadata source of truth is each app's directory** (`apps/<app>/catalog/`), published by CI
   into `registry.json` + hosted assets so any consumer (store, CE admin) reads one artifact.
3. **Registry only** — the store lists exactly the apps present in `registry.json`. Unpublished
   monorepo apps (Studio, Reader today) appear by publishing them, not via a second metadata path.
4. **Approach A** — store lives in this monorepo; one composite deployment artifact carries the
   site, `registry.json`, and assets. (Rationale: deployments merge per commit SHA, so two
   independent workflows cannot reliably co-write one alias; a single artifact avoids layering and
   ordering races entirely.)

## 1. Repo layout & store site

- New top-level pnpm workspace package **`store/`** (added to `pnpm-workspace.yaml`). Deliberately
  **not** under `apps/` — it is not a give-away app; app conventions and `bffless-app.json` rules
  must not apply to it.
- **Astro 5 + Tailwind, static output** (same stack as `repos/deployment-docs`). React islands only
  if a genuinely interactive widget appears (none expected in v1).
- Pages, prerendered from `registry.json` at build time:
  - `/` — grid of app cards: thumbnail, name, summary, category badge, version.
  - `/apps/<id>/` — screenshot gallery, rendered `description` markdown, version, requirements
    (`presignedStorage`, `ceMin`), docs/source links, and the install how-to section.
  - Astro 404 page.
- Per-page `<title>` + OpenGraph meta using the app's thumbnail (the reason SSG was chosen over an
  SPA).
- Brand assets copied in from `repos/assets` as needed.

## 2. Per-app metadata convention

Any app with a `bffless-app.json` must also ship **`apps/<app>/catalog/`**:

| File                  | Required | Purpose                                        |
| --------------------- | -------- | ---------------------------------------------- |
| `description.md`      | yes      | Long-form markdown shown on the detail page    |
| `thumbnail.png`       | yes      | Card image; later usable by CE Admin → Apps    |
| `icon.png`            | no       | Small icon (feeds existing `iconUrl` field)    |
| `screenshots/*.png`   | no       | Detail-page gallery, ordered by filename       |

- `bffless-app.json` gains one optional structured field: **`category`** (string).
- Asset URLs are **never hand-written** — CI derives them from the files present.
- `scripts/check-app-conventions.mjs` is extended: manifest present → `catalog/description.md` and
  `catalog/thumbnail.png` required. Handoff's assets are authored as part of this work.

## 3. Registry schema extension

`registry.json` stays **`schemaVersion: 1`** — additive only. Deployed CE 0.4.0's
`validateRegistry` checks only known fields, so extra fields are safe (verified against
`apps/backend/src/app-catalog/app-manifest.util.ts` on CE `origin/main`).

Each registry entry gains:

| Field          | Type       | Source                                                       |
| -------------- | ---------- | ------------------------------------------------------------ |
| `description`  | string     | Contents of `catalog/description.md`                         |
| `category`     | string     | `bffless-app.json` `category`                                |
| `thumbnailUrl` | string     | `https://apps.bffless.dev/assets/<app>/thumbnail.png`        |
| `screenshots`  | string[]   | `https://apps.bffless.dev/assets/<app>/screenshots/<file>`   |

- Asset URLs are **unversioned** so they stay stable for registry consumers and never dangle when
  an app's version bumps.
- Existing `iconUrl` becomes CI-derived from `catalog/icon.png` when present; an explicit manifest
  `iconUrl` wins if both exist.
- **CE follow-up (out of scope):** file a CE issue for Admin → Apps to render `thumbnailUrl` /
  `description` when present.

## 4. Build pipeline

Extract the inline registry-builder heredoc from `.github/workflows/app-bundles.yml` into
**`scripts/build-registry.mjs`** (now also folds in catalog metadata + derived asset URLs, keeping
the existing loud `::warning` + step-summary behavior for omitted apps).

New orchestrator **`scripts/build-store-artifact.mjs`**:

1. Build `registry.json` (manifests + fetched sha256 sidecars — sidecar fetching stays `gh release
   download`, run by the workflow before this script).
2. Copy each **published** app's `catalog/` assets → `registry-staging/assets/<app>/…`.
3. `astro build` the store, consuming the registry JSON → `registry-staging/` (site at root).
4. Write `registry.json` to `registry-staging/registry.json`.
5. Smoke-assert the artifact: `index.html` and `registry.json` present, and for every registry
   entry `<id>`: `apps/<id>/index.html` and `assets/<id>/thumbnail.png` present.

Two callers, serialized by the existing `app-bundles` concurrency group (`cancel-in-progress:
false`):

- **`app-bundles.yml`** (existing) — after bundle build + GitHub release publish, runs the
  composite build and deploys `registry-staging/` — the same dir name as today's registry-only
  upload, kept deliberately so its publicPaths keep matching the live domain mapping's path.
- **`deploy-store.yml`** (new) — on push to `main` touching `store/**`, `apps/*/catalog/**`,
  `apps/*/bffless-app.json`, or the build scripts: fetch all published apps' sidecars, run the same
  composite build, deploy.

Deploys use `bffless/upload-artifact@v1` with the existing `app-registry` alias,
`vars.BFFLESS_REGISTRY_URL`, and `secrets.BFFLESS_REGISTRY_API_KEY` (the bffless.dev instance —
deliberately not the demo instance). PRs touching `store/**` get a CI build check; no preview alias
in v1 (possible follow-up, mirroring the per-app preview workflows).

## 5. Serving changes (operator/MCP steps at rollout)

- The domain mapping path never needs to change. `bffless/upload-artifact` prefixes every zip
  entry with its `path` input, and CE stores those entry names verbatim as each file's
  `publicPath`, matched against the domain mapping's path at serve time. The composite artifact's
  output dir is named `registry-staging` (see `scripts/build-store-artifact.mjs`) specifically to
  match the live `apps.bffless.dev` mapping's existing path (`/registry-staging`) — so the site,
  `registry.json`, and assets all serve immediately on first deploy, with zero operator action and
  zero 404 window. The public URL `https://apps.bffless.dev/registry.json` is unchanged (CE's
  built-in default — must not break).
- Add cache rules: ~1h on `/registry.json` (originally on the ce#567 PR checklist, never applied),
  longer (e.g. 24h) on `/assets/*`.
- `isSpa` stays `false`; `isPublic` stays `true`.

## 6. Known trade-offs & edge cases

- **Registry publish depends on the store build.** A broken store build blocks a registry update.
  Mitigated: CI builds the store on every PR touching it; a main-branch failure is loud in Actions.
  Registry generation itself runs before the site build, so a failure is never a half-published
  artifact — the previous deployment keeps serving.
- **HEAD-vs-published drift.** Catalog assets/description come from `main` at build time; registry
  entries are published versions. A screenshot can be slightly newer than the published bundle —
  cosmetic, accepted.
- **Published app missing `catalog/`** (pre-convention releases): registry build emits a
  `::warning`, metadata fields stay absent, store renders a placeholder card. The conventions check
  prevents new occurrences.
- **Registry availability:** CE's `AppsRegistryService` is stale-while-error with a 1h TTL, so a
  bad deploy window degrades gracefully for installed CEs.

## 7. Testing

- **Vitest** for `build-registry.mjs`: metadata folding, asset-URL derivation, iconUrl precedence,
  omission warnings.
- **Smoke assertion** inside `build-store-artifact.mjs` (step 5 above) — fails the workflow if the
  artifact is structurally wrong for any registry entry.
- **Visual validation** during development: `localdev-tools/shot.mjs` against `astro dev`.
- **Post-deploy checks:** curl `https://apps.bffless.dev/registry.json` (unchanged shape + new
  fields) and the store root; confirm a CE instance's Admin → Apps still lists Handoff.
