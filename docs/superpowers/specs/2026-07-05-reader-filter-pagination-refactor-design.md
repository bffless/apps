# Rivulet (Reader) — server-side filter + pagination refactor

- **Date:** 2026-07-05
- **App:** `repos/apps/apps/reader` (Rivulet), backed by the `reader` BFFless proxy rule set (`e454596b-fd15-4b20-ac95-4f5612d8181c`)
- **Also touches:** CE (`repos/ce`) — two pipeline-handler enhancements
- **Status:** design approved; ready for implementation plan

## Problem

Two feeds that had items yesterday (`https://www.onceinaspecies.com/feed`,
`https://visserlabs.substack.com/feed`) showed "Nothing here" after the morning
Hacker News refresh, despite their items being correctly stored.

Root cause, confirmed end-to-end:

1. **The client filters on the client.** `ReaderApp` calls `api.listItems()` once
   on mount with no scope, loads the full item set into one array, and derives
   every view (river / all / starred / feed / folder) plus all unread badges via
   in-browser `.filter()` (`ReaderApp.tsx:133`, `lib/river.ts:50`). Selecting a
   feed never re-queries the server.
2. **The single fetch is silently capped at 100.** The `GET /api/items` pipeline's
   `queryAll` step is configured with `pageSize: 500`, but the CE `data_query`
   handler has no `pageSize` key — it reads `limit`. The unknown key is ignored and
   the handler falls back to its **default limit of 100**
   (`data-query.handler.ts:189`). So 100 of 173 rows come back.
3. **Sorted newest-first, so the firehose wins.** Default sort is `createdAt DESC`.
   The morning HN batch (`created 2026-07-05`) took the top 100 slots and pushed
   yesterday's substack items (`created 2026-07-04`, rows 101–173) out of the
   response entirely. The client then filtered an incomplete set → empty views.

This is an architecture problem, not a one-line cap fix: the whole app is built on
"load everything once, reconcile in the browser," and the `/api/items` pipeline
compounds it with a `queryFeed` + `queryAll` + `merge` trio that fetches broadly
and stitches results together. The fix is to make the **frontend instruct the
backend precisely** — one filtered, sorted, paginated query per view.

## Goals

- Each view is **exactly one paged item request + one counts request**. No
  client-side filtering of a full dump; no multi-query-then-merge in pipelines.
- Server-side **pagination** on every view (numbered pages, 20/page).
- Correct, complete unread/starred badges without loading all items.
- "Mark all read" affects the **entire matching view**, not just the loaded page.
- Remove the `queryAll`/`queryFeed`/`merge` antipattern from `/api/items`.

## Non-goals

- Infinite scroll / cursor pagination (chose numbered offset pages — see Decisions).
- Reworking auth, ingest scheduling, retention/prune, discovery, or OPML.
- Combined views (e.g. "unread within a folder") — each view stays a single-field filter.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Pagination model | **Numbered pages** (`limit` + `offset`, `total` via count) | Matches requested "click to page 2" UX; drift on top-inserts acceptable at personal scale |
| Folder view | **Add an `in` operator to CE** | One clean `feedId IN (...)` query; benefits all apps; keeps items normalized |
| Sidebar badges | **Keep exact, via `/api/counts`** | `db_aggregate` already supports `groupBy` → per-feed unread in one query |
| Mark all read | **CE bulk update-by-filter** | One call marks the whole view correctly at any size |
| Folder read state | **Folder shows read + unread** (only river is unread-only) | Preserves current behavior |

## Architecture

The five selections each map to a **single-field filter** (so CE's flat AND/OR
limitation never bites):

| View | Item filter | Count |
|------|-------------|-------|
| All | *(none)* | total items |
| River | `read = "false"` | total unread |
| Starred | `starred = "true"` | total starred |
| Feed | `feedId = <url>` | items in feed |
| Folder | `feedId IN (<folder feed urls>)` | items in folder |

All ordered by a new `sortTs` field, `DESC` (newest) / `ASC` (oldest toggle),
`limit = 20`, `offset = (page-1)*20`. `total` from a `db_aggregate` count sharing
the identical filter → `totalPages = ceil(total / 20)`.

## Backend — `reader` proxy rule set

Applied to the **live** set via MCP **and** mirrored in the checked-in
`apps/reader/bffless/reader.proxy-rules.json` (Sandcastle does not deploy live
proxy rules; the two must be kept in sync by hand).

### `GET /api/items` (rewrite)

- **Params:** `view` (`all|river|starred|feed|folder`), `feedId?`, `folder?`,
  `page` (default 1), `limit` (default 20), `order` (`newest|oldest`, default newest).
- **Steps:**
  1. `prep` (`function_handler`) — normalize params; compute `offset`; build the
     filter descriptor for the view. For `folder`, this step (or a preceding
     `data_query` on `reader_feeds where folder=<name>`) resolves the folder's feed
     URLs into an array for the `in` filter.
  2. `count` (`db_aggregate`, `operation: count`) — same filter → `total`.
  3. `page` (`data_query`) — same filter, `orderBy: { field: sortTs, direction }`,
     `limit`, `offset`.
  4. `respond` — `{ items, total, page, pageSize, totalPages }`.
- **Removes** the `queryFeed` / `queryAll` / `merge` steps. Uses `limit` (not the
  ignored `pageSize`), which also eliminates the 100-row default-cap bug.

### `GET /api/counts` (new)

- `unread` (`db_aggregate`, count, `groupBy: feedId`, filter `read = "false"`) →
  `unreadByFeed` map.
- `starred` (`db_aggregate`, count, filter `starred = "true"`) → `starred` total.
- `respond` — `{ unreadByFeed, starred }`.

### `POST /api/items/read-all` (new)

- **Body:** `{ view, feedId?, folder? }`.
- Builds the same filter as `/api/items` (folder resolves to a feed-URL `in`),
  then **CE bulk update-by-filter** sets `read = true` where the filter matches and
  `read = "false"`. Respond `{ updated }`.

### `POST /api/refresh` (ingest) — add `sortTs`

Add `sortTs` to the `data_upsert_many` map: `publishedAt` (ISO 8601) when
parseable, else the ISO string of `fetchedAt`. ISO strings sort correctly
lexicographically under `data_query`'s `->>` text ordering, and this collapses the
current `publishedAt || fetchedAt || 0` fallback into one stable sort key that
handles null `publishedAt`. Existing rows get `sortTs` on their next refresh; a
one-time backfill (or a tolerant `orderBy` fallback) covers the interim.

### Latent fixes

The list-feeds (`GET /api/feeds`) and refresh feed-load steps also use the ignored
`pageSize` and silently cap at 100 feeds. Switch them to `limit` while here.

## CE enhancements (`repos/ce`) — land first, in-loop

**Single enhancement: add an `in` / array-membership operator** to the filter
operator set, applied to `data_query`, `db_aggregate`, and `data_update`.

- Add `'in'` to each handler's operator whitelist (`validateConfig`) and to the
  `op` unions in `step-handler.interface.ts`.
- In each handler's filter switch, add a `case 'in'` that treats the
  expression-resolved value as an **array** (bypassing the scalar `String(value)` /
  `Number(value)` coercion the other ops apply) and emits a parameterized
  `<field> IN (v1, v2, …)`, with an empty array compiling to a match-nothing
  predicate (`sql\`false\``) rather than invalid `IN ()`.
- Files: `pipelines/handlers/data-query.handler.ts` (op switch ~131–153, whitelist
  ~60), `pipelines/handlers/db-aggregate.handler.ts` (op switch ~105–127, whitelist
  ~55), `pipelines/handlers/data-update.handler.ts` (op switch ~111–118, whitelist
  ~51 — currently `eq`/`ne` only), and `pipelines/execution/step-handler.interface.ts`.
  Optionally `data-delete.handler.ts` for symmetry (not required by the reader).

**No other CE change is required:**

- **Update-by-filter already exists.** `data_update` accepts `filters` and, unless
  `single` is set, updates *every* matching record (`data-update.handler.ts:139-186`).
  So `/api/items/read-all` is a plain `data_update` with `fields: { read: "true" }`:
  for feed/river/all views its `eq` filters suffice today; only the **folder** view
  needs the new `in` operator on `data_update` (feedId ∈ folder urls).
- **Counts** need no change — `db_aggregate` already supports `groupBy`
  (`db-aggregate.handler.ts:141–194`).

## Client — `apps/reader/src`

- **`lib/api.ts`:**
  - `listItems(selection, { page, order })` → `{ items, total, page, pageSize, totalPages }`.
  - `getCounts()` → `{ unreadByFeed, starred }`.
  - `markAllRead(selection)` → `{ updated }`.
  - `getItem(guid)` → single item (deep-link fallback for items off the current page).
  - Remove the bare load-everything `listItems()` call site.
- **`ReaderApp.tsx` state:** drop the single in-memory `items` array and the
  `itemsForSelection` derivation; fetch the current view's page when
  `(selection, page, order)` changes. `Selection` type and `lib/route.ts` stay.
- **Badges:** from `getCounts()`; per-folder badge rolls up `unreadByFeed`
  (`folders.ts` `folderUnread`); refetch after read / star / refresh.
- **Pager:** numbered `[1][2]…[n]` from `totalPages`; page is URL-addressable
  (extend `lib/route.ts`).
- **Mark-all-read:** call `markAllRead(selection)`, then refetch page + counts.
- **Optimistic read/star:** patch the current page; refetch counts.
- **Empty / "caught up" states:** driven by `total === 0`, not the loaded page.

### Client casualties to handle (from the current full-set assumption)

- `unreadCountsByFeed` / `totalUnread` / `totalStarred` (`lib/river.ts`) → replaced
  by `getCounts()`.
- `markAllRead` fan-out over `visible` → replaced by the server primitive.
- `selectedItem` full-set fallback (`ReaderApp.tsx:201`) → `getItem(guid)`.
- Keyboard `j/k` nav is bounded by the loaded page (acceptable; documents a limit).
- Auto-mark-read `IntersectionObserver` must re-observe rows on page change.

## Testing

- **CE:** unit tests for the `in` operator (`data_query` + `db_aggregate`, incl.
  array value bypassing coercion) and update-by-filter; keep existing handler tests green.
- **App:** api-layer param building + response shaping; view→request mapping; pager
  math; counts rollup (folder = sum of member feeds).
- **Regression (the original bug):** with HN present, `onceinaspecies` and
  `visserlabs` each paginate independently and show their items again.
- **Validation:** exercise against the live/deployed reader (headless via
  `localdev-tools`, or the deployed alias) — each view returns a bounded page with a
  correct `total`, and no view is crowded out by another feed's volume.

## Rollout order

1. CE enhancement (`in` operator across data_query / db_aggregate / data_update) — PR, merge, deploy.
2. Backend `reader` proxy rules — update the **live** set via MCP and the checked-in
   JSON together.
3. Client — PR via Sandcastle.

Each layer is independently testable; the client can ship behind the new endpoints
once (1) and (2) are live.
