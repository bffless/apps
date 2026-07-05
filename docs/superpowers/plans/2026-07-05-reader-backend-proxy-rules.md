# Reader Backend (proxy rules) Implementation Plan — Plan 2 of 3

> Executed by the controller directly via the BFFless MCP against the **live** `reader` proxy rule set (`e454596b-fd15-4b20-ac95-4f5612d8181c`) — Sandcastle cannot deploy live proxy rules. Not TDD/code; each increment is applied to the live set, **verified against live data/endpoint**, and mirrored into the checked-in `apps/reader/bffless/reader.proxy-rules.json`. Every increment is independently reversible.

**Goal:** Move `/api/items` from "return an unfiltered dump (capped at 100)" to precise, filtered, paginated, counted queries, and add `/api/counts` + `/api/items/read-all` — so the client (Plan 3) can request exactly one view's page and correct badges. Depends on the CE `in` operator (deployed).

**Schemas:** items `96a1b5e7-96f0-43a4-baa8-2e19b539d07c` (`reader_items`), feeds `d1216df3-9776-4de2-81b0-0343d758f83d` (`reader_feeds`).

## Global constraints

- **Never break the live client.** The currently-deployed reader reads `body.items` and ignores everything else, and calls `GET /api/items` with **no params**. So (a) adding fields to the response envelope is safe, and (b) `/api/items` with no new params MUST keep returning the full (now uncapped) item set. New behavior activates only when new params are present.
- **`in` value must be an array** (a prior step's URL list) — the deployed CE `in` operator handles this; do not stringify.
- Handler reality (from CE source): `data_query`/`db_aggregate`/`data_update` read **`limit`/`offset`** (NOT `pageSize` — that key is ignored → default limit 100, which is the original bug); default sort `createdAt DESC`; `db_aggregate count` returns `{operation:'count', result:N}`, and grouped returns `{operation:'count', groupBy, results:[{key,value}]}`.
- Ordering key: a new **`sortTs`** (ISO-8601 string) written at ingest = `publishedAt` if parseable else ISO of `fetchedAt`. ISO strings sort correctly under `data->>'sortTs'` text ordering, and it's always present (avoids the NULL-ordering hazard of ordering by `publishedAt`, which Postgres puts NULLS FIRST on DESC).
- Keep every existing pipeline's `auth_required`/validators and `Cache-Control: no-store` exactly as they are. `/api/refresh` and `/api/prune` intentionally have NO `auth_required` (system/scheduler runs) — do not add one.
- After each increment: re-fetch the rule via MCP to confirm it saved, verify behavior against live data, and update the checked-in JSON.

---

## Increment 1 — Restore feeds now (raise the item-query limit)

**The user's original bug fix, minimal and reversible.** In `/api/items` (rule `518181a2`), the `queryFeed` and `queryAll` steps use the ignored `pageSize: 500` → they fall back to the handler default of **100**, and with newest-first insertion order the Hacker News firehose crowds other feeds out. Just switch to a real `limit`.

- Edit `queryFeed.config`: remove `pageSize`, add `limit: 2000`.
- Edit `queryAll.config`: remove `pageSize`, add `limit: 2000`.
- Leave everything else (prep/merge/respond, condition, auth) unchanged.

**Why 2000:** comfortably above the ~189 current total and the 30-day retained volume; the current client still filters/sorts in-browser, so this simply gives it the full set back.

**Verify:** the current deployed reader (or a seeded-session/API-key `GET /api/items`) returns all ~189 items; the two previously-empty feeds (`onceinaspecies`, `visserlabs`) show their items again. Also fix the same latent `pageSize`→`limit` on `GET /api/feeds` (`4719b1d8`) and the refresh feed-load step so they don't silently cap at 100 feeds later.

> After Increment 1 the reported bug is resolved for the live app. Increments 2–5 build the server-side foundation the new client (Plan 3) needs; none of them regress Increment 1.

---

## Increment 2 — `sortTs` at ingest + one-time backfill

**Ingest (`/api/refresh`, rule `0444e89c`):** insert an `enrich` `function_handler` after `stamp`, before `upsert`:

```js
function handler({ steps }) {
  var entries = (steps && steps.parse && steps.parse.entries) || []
  var nowMs = (steps && steps.stamp && steps.stamp.ms) || 0
  var nowIso = new Date(nowMs).toISOString()
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i] || {}
    var ts = ''
    if (e.publishedAt) { var d = new Date(e.publishedAt); if (!isNaN(d.getTime())) ts = d.toISOString() }
    if (!ts) ts = nowIso
    e.sortTs = ts
    out.push(e)
  }
  return { entries: out }
}
```

Then in `upsert`: change `items` from `steps.parse.entries` → `steps.enrich.entries`, and add `sortTs: steps.item.sortTs` to `map`. (Dedup/condition unchanged.)

**Backfill** the existing rows (dedup means a refresh won't touch them): dispatch a subagent to loop `query_pipeline_data` (items schema, pageSize 200) → for each row compute `sortTs = ISO(publishedAt) || ISO(fetchedAt)` → `update_pipeline_record` writing `sortTs` into its data. Offloaded to a subagent because it's ~189 individual MCP writes.

**Verify:** trigger a refresh; new rows have `sortTs`; spot-check backfilled rows have `sortTs`; `query_pipeline_data ... sortBy=sortTs` orders sensibly.

---

## Increment 3 — Rewrite `/api/items` (view + filter + page + count)

Replace the `queryFeed`/`queryAll`/`merge` trio. New param surface: `view` (`all|river|starred|feed|folder`), `feedId?`, `folder?`, `page` (default 1), `limit` (default **20** when `page`/`view` present; **2000** for the legacy no-param call), `order` (`newest|oldest`, default newest).

Steps:
1. `prep` (`function_handler`) — normalize params; compute `offset=(page-1)*limit`; set booleans `isAll/isRiver/isStarred/isFeed/isFolder` and `legacy` (true when no `view` and no `page` — preserves the Increment-1 behavior).
2. `folderFeeds` (`data_query` on `reader_feeds`, `filters: { folder: { op:'eq', value: steps.prep.folder } }`, `limit: 500`, `condition: steps.prep.isFolder`) → then `folderUrls` (`function_handler`, condition isFolder) extracts a plain `urls` string[] from those rows.
3. One **page** `data_query` + one **count** `db_aggregate` per view, each gated by its `condition` and sharing the view's filter, `orderBy:{field:'sortTs',direction: newest?'desc':'asc'}`, `limit`, `offset`:
   - all: no filter
   - river: `read = 'false'`
   - starred: `starred = 'true'`
   - feed: `feedId eq steps.prep.feedId`
   - folder: `feedId in steps.folderUrls.urls`
   - legacy: no filter, `limit: steps.prep.limit` (2000), `offset:0` — count optional.
4. `assemble` (`function_handler`) — pick whichever page/count ran; compute `total`, `pageSize`, `totalPages=ceil(total/pageSize)`, `page`.
5. `respond` — `{"items":{{{steps.assemble.items}}},"total":{{steps.assemble.total}},"page":{{steps.assemble.page}},"pageSize":{{steps.assemble.pageSize}},"totalPages":{{steps.assemble.totalPages}}}`.

**Compatibility:** legacy no-param call → `legacy` branch → full set (like Increment 1). The extra envelope fields are ignored by the current client.

**Verify (live, API key / seeded session):** `?view=feed&feedId=<onceinaspecies>&page=1&limit=20` returns only that feed's page + correct `total`/`totalPages`; `?view=folder&folder=macro` returns items across the folder's feeds (exercises the deployed `in` operator); `?view=river` returns unread only; no-param call still returns everything.

---

## Increment 4 — `GET /api/counts`

New rule (method GET, `/api/counts`, `auth_required` allowApiKey, `Cache-Control: no-store`):
- `unread` (`db_aggregate`, `operation:'count'`, `groupBy:'feedId'`, `filters:{ read:{op:'eq',value:'false'} }`) → grouped `results:[{key:feedId,value:count}]`.
- `starred` (`db_aggregate`, `operation:'count'`, `filters:{ starred:{op:'eq',value:'true'} }`) → `result:N`.
- `shape` (`function_handler`) → `{ unreadByFeed: { <feedId>: <count> }, starred: <N> }` from the two.
- `respond` → that JSON.

**Verify:** `unreadByFeed` sums to the river total; `starred` matches the starred count.

---

## Increment 5 — `POST /api/items/read-all`

New rule (method POST, `/api/items/read-all`, `auth_required` allowApiKey):
- `prep` (`function_handler`) — read `{ view, feedId?, folder? }` from body; booleans per view.
- `folderFeeds`/`folderUrls` (as Increment 3) when `isFolder`.
- One `data_update` per view (condition-gated), `fields:{ read: 'true' }`, filter = view filter **AND** `read eq 'false'`:
   - all/river: `read eq 'false'`
   - starred: n/a (skip)
   - feed: `feedId eq feedId` + `read eq 'false'`
   - folder: `feedId in urls` + `read eq 'false'` (uses the deployed `in` operator on `data_update`)
- `respond` → `{ "updated": <sum of the update counts> }`.

**Verify:** marking a feed read zeroes that feed's unread in `/api/counts`; other feeds unaffected.

---

## Sync + rollout

- After each increment, mirror the change into `apps/reader/bffless/reader.proxy-rules.json` (in the worktree) and commit. This is the source of truth for a fresh install; the live set and the JSON must not drift.
- Rollout: Increment 1 ships the user-visible fix immediately. Increments 2–5 are prerequisites for Plan 3 (client); they don't change what the current client sees.
