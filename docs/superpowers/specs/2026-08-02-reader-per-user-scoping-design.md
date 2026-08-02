# Rivulet — per-user data scoping (copy-per-user)

**Date:** 2026-08-02
**App:** `apps/reader` (Rivulet)
**Status:** design approved, ready for planning

## Problem

Rivulet is single-user by design — CONTEXT.md **D1**: *"Personal reader, single-user per deploy. No accounts/follow-graph."* Sharing it with other people breaks against two independent limits:

1. **The access gate requires admin.** `reader.j5s.dev` resolves `requiredRole` to `admin`, so a project Viewer gets an Access Denied page. This is alias/project configuration, not app code (`ce: proxy.middleware.ts:642`).
2. **All data is project-scoped.** Neither `reader_feeds` nor `reader_items` carries an identity column, and no rule filters on one. Every authenticated user sees, mutates, and deletes the same rows.

These are independent, and fixing only the first makes things **worse**: the admin gate is currently the only thing preventing a second user from mutating the owner's data. Lowering it while data stays shared would drop a new user directly into the owner's feed list with full write access, including the hard-delete endpoint.

This spec supersedes D1 for the deployed instance: Rivulet becomes multi-user, with each account owning its own feeds and items.

## Decision: copy-per-user

Each user gets their own `reader_feeds` and `reader_items` rows. Rejected alternative: shared feed/item rows plus a per-user state join table — cheaper at scale, but needs a third schema and a join `data_query` cannot express in one step, pushing assembly into a function step. At give-away-app scale, copy-per-user is the simpler correct thing.

**This is cheap now and expensive to unwind later.** It is recorded here as a deliberate decision rather than a drift.

## Access control

Two alias-level overrides; nothing changes at project level.

| Alias | `requiredRole` |
|---|---|
| `reader` | `guest` |
| `reader-preview` | `guest` |

`handoff`, `handoff-preview`, `studio`, `studio-preview` keep their current gate.

**Why `guest`.** The gate is two sequential checks (`proxy.middleware.ts:606-640`): a session must exist, then `getUserProjectRole` must meet the bar. Every role except `authenticated` requires *both* — `authenticated` is the special case that short-circuits the membership check (`permissions.service.ts:232`). So `guest`, `viewer` and `contributor` all satisfy "logged in **and** explicitly added to the project"; they differ only in what else the person gains:

- `guest` — nothing. CE filters guest memberships out of the admin backend (`projects.service.ts:473`, with the same `role != 'guest'` exclusion at 614/664/669), so they never see `bffless/apps`, its deployments, rule sets or secrets.
- `viewer` — can browse the project in `admin.j5s.dev`, including handoff and studio.
- `contributor` — **can upload deployments to `bffless/apps`** (`assets.service.ts:94`), i.e. overwrite handoff, studio or reader.

CE's project ladder governs *managing the BFFless project*, not app-data CRUD. App writes are gated by the pipeline's own `auth_required` validator, which only checks that a user exists and never consults the project role — so a `guest` can add feeds and star items normally.

**Onboarding** is a `project_invite_links` link, which already defaults to `guest` (`project-invite-links.controller.ts:60`).

## Identity

`user.id` is the stable BFFless user id and is available to pipeline expressions — `user` is a valid expression root (`expression-evaluator.ts:67`). It resolves for every inbound path:

| Path | `context.user` |
|---|---|
| SuperTokens session | real user id (`proxy.middleware.ts:1315`) |
| Custom-domain JWT | user id |
| API key (`X-API-Key`) | **the key owner's** user id (`proxy.middleware.ts:1459`) |
| Scheduler system run | **absent** |

API-key access therefore scopes to the key owner automatically — no special handling. The scheduler is the only gap, and it is exactly where new item rows are created. See *Refresh*.

## Schema changes

Both additive. Existing rows simply lack the new fields until backfilled.

**`reader_feeds`**

| Field | Type | Notes |
|---|---|---|
| `userId` | string, optional | owner |
| `scopedUrl` | string, optional | `${userId}::${url}` — dedup column for add-feed and OPML import |

**`reader_items`**

| Field | Type | Notes |
|---|---|---|
| `userId` | string, optional | owner |
| `scopedGuid` | string, optional | `${userId}::${guid \|\| link \|\| hash}` — dedup column |

**Why optional rather than required.** These columns land on schemas that already hold live rows. A required field would make CE's write validation reject updates to any not-yet-backfilled row (`data-update.handler.ts:178` throws `Data validation failed`), breaking the app in the window between deploying the schema and finishing the backfill. The loudness that `required` would have bought is recovered at test time instead, by the structural ratchet asserting every write path sets them.

`guid` keeps holding the feed's real guid. The synthetic columns exist only because `dedupField` names a single column; `data_upsert_many` writes the resolved dedup value straight into that column (`data-upsert-many.handler.ts:227`) and requires it to be a real schema field (line 190), so they self-populate on insert.

**Why they are necessary.** `data_upsert_many` dedups globally on one field. Without a per-user dedup column, the second user to subscribe to a shared feed has their entire ingest silently skipped as duplicate and sees an empty reader. That is data loss, not a performance issue, and it only manifests once a second user exists.

## Rule scoping

Every rule gains `userId: {op: eq, value: user.id}`.

Two mechanical traps run through all of them:

- **`filterLogic: and` is easy to miss.** Several steps currently carry a single filter and no `filterLogic`. Adding a second filter without it silently changes the step's meaning.
- **The filter belongs on the lookup, not the update.** On query → pick → update rules, `data_update` **ignores filters when `recordId` is set** (`data-update.handler.ts:91`), so a `userId` filter on the update step is dead code.

| Rule | Change |
|---|---|
| `GET /api/feeds` | filter the single `data_query` |
| `POST /api/feeds` | map `userId`; `dedupField` → `scopedUrl` |
| `POST /api/feeds/remove` | filter `query` **and** the `delItems` cascade |
| `POST /api/feeds/folder` | filter `query` (+ `filterLogic`) |
| `GET /api/items` | filter **12 steps** — 5 count/page branch pairs, plus `folderFeeds` and `pageGuid` |
| `GET /api/counts` | filter all 3 aggregates |
| `POST /api/items/read` | filter `query` (+ `filterLogic`) |
| `POST /api/items/star` | filter `query` (+ `filterLogic`) |
| `POST /api/items/archive` | filter `query` (+ `filterLogic`) |
| `POST /api/items/read-all` | filter every `data_update` branch (+ `filterLogic`) |
| `POST /api/items/delete` | filter the `data_delete` (+ `filterLogic`) |
| `POST /api/refresh` | fan-out — see below |
| `POST /api/prune` | **no change** |
| `POST /api/discover` | no change (no data access) |
| `/api/auth/*` | no change (reverse proxy) |

**`POST /api/items/delete` is the highest-risk line in this change.** It is the only rule that mutates by raw filter with no ownership lookup — `data_delete` where `guid eq body.guid`. The admin gate currently hides that. The moment a second user exists it hard-deletes across everyone.

**Query-by-`guid` becomes ambiguous.** Because `guid` stays pure, the same guid legitimately exists once per subscriber. Every `guid eq X` lookup must pair with `userId`, or star/read/archive will act on an arbitrary user's row.

**`prune` needs no identity.** It filters on each row's own `read` / `starred` / `archived` / `fetchedAt`, which is already correct per-user. This is why its userless system run stays valid.

## Refresh

Three of eight steps change.

| Step | Change |
|---|---|
| `feeds` | stays **unscoped** (see below); raise `limit` 500 → 2000 |
| `urls.fn.js` | emit **distinct** URLs |
| `parse` | unchanged — now fetches each distinct URL once regardless of subscriber count |
| `stamp` | unchanged |
| `enrich.fn.js` | build a `url → subscribers[]` index from `steps.feeds`; fan each parsed entry out to one record per subscriber, stamping `userId` and `scopedGuid`. The `guid \|\| link \|\| hash` fallback chain moves here |
| `upsert` | `map` gains `userId`; `dedupField: scopedGuid`; `dedupKey` collapses to `steps.item.scopedGuid` |
| `summary`, `respond` | unchanged |

**Why `feeds` stays unscoped.** The cron needs every user's feeds, and `user.id` is null in a system run — a `userId` filter would resolve to `userId eq null` and ingest nothing.

**The fan-out is forced, not chosen.** `xml_feed_parse` keys entries by `source` (the feed URL), so one URL mapping to N feed rows must be resolved in enrich either way. Deduping the URL list first means each feed is fetched once no matter how many subscribers — cheaper than the naive path.

**Known ceiling:** `limit: 2000` on the `feeds` query is now shared across all users. Pagination is a follow-up, not v1.

**Deliberate oddity:** the UI's "Refresh now" button runs the same global refresh, so one user's manual refresh does ingest work for everyone. It is idempotent and each user still sees only their own items, so this is acceptable at this scale — recorded as a choice, not an oversight.

## Migration

The order is load-bearing on a live app.

1. **Add the schema fields.** Additive; no rule references them yet.
2. **Backfill every existing row** — `userId` = the owner's user id, plus `scopedUrl` / `scopedGuid`.

   All existing feeds and items belong to **`james.charlesworth@gmail.com`**; resolve the id via `list_users` at implementation time. The other account that can currently reach the app (`j5s-demo-admin-v1@bffless.app`) has no data of its own — it was only ever seeing the shared project rows — and correctly starts empty after the migration.
3. **Deploy the scoped rules** (rules-as-code: build → prune → import).
4. **Flip `requiredRole` to `guest`** on `reader` and `reader-preview`.
5. **Invite a second account and verify isolation.**

Step 4 before step 3 drops a guest into the owner's data. Step 3 before step 2 blanks the owner's reader.

**Backfill mechanism:** a script over the MCP tools (`query_pipeline_data` to page rows, `update_pipeline_record` per row), dry-run first. Not a pipeline — `data_update` can set a constant across rows, but `scopedGuid` is a per-row derived value and the executor has no row loop.

**`scopedGuid` must be backfilled, not skipped.** Dedup matches on it, so a still-live item whose row lacks it will not match on the next poll and will insert a duplicate — one per active item.

## Frontend

**No changes.** The API returns only the caller's rows; the header already shows the signed-in email; a new user's empty state is the existing "Add a feed or site URL" box. `shapeFeed` / `shapeItem` ignore unknown fields, so the new columns pass through harmlessly.

**Deliberate non-feature:** new users start empty — no seeded feeds, no onboarding flow. Import OPML already covers bringing a subscription list in.

## Testing

The existing harness (`src/lib/enrich.test.ts`) reads `.fn.js` sources and rule YAML out of `.bffless/` and asserts both behaviour and wiring. Follow that pattern; no new machinery.

- **Unit** — enrich fan-out (1 entry × 2 subscribers → 2 records, distinct `scopedGuid`, correct `userId`); `urls.fn.js` dedupe (3 feed rows sharing a URL → 1 URL); prep functions computing `scopedUrl`.
- **Structural** — assert every read/write step in the rule set carries a `userId` filter. This is the test that actually protects the change: the risk is a *missed* step, not a wrong one, and there are 25+ data-access steps across the 12 changing rules (12 in `GET /api/items` alone).
- **Live two-account isolation** — including the sharp case: user B calls `POST /api/items/delete` with a guid from user A's feed → `{deleted: 0}` and A's row survives.

## CE follow-ups

Filed separately; none block this work.

1. **Composite `dedupField` on `data_upsert_many` (ce#613)** — accept an array of columns. Would remove `scopedGuid` / `scopedUrl` entirely. The next multi-user BFFless app will hit this too. https://github.com/bffless/ce/issues/613
2. **Run-as identity for `pipeline_schedules` (ce#614).** Scheduled runs could then carry a user and use `auth_required` + `user.id`, removing the special-casing in `refresh` and `prune`. https://github.com/bffless/ce/issues/614
3. **`allowApiKey` is dead config (ce#615)** — declared at `types.ts:22`, set by the upload-schema generator, read by nothing. `AuthRequiredValidator.validate` only checks `context.user` and `config.roles`. https://github.com/bffless/ce/issues/615

## Out of scope

- Sharing feeds or items between users
- Any cross-user or owner-wide admin view
- Per-user refresh cadence
- Pagination of the global `feeds` query in refresh
- Migrating Rivulet to its own BFFless project
