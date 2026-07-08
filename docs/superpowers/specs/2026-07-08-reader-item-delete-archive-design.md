# Reader — item Delete + Archive

> **Status:** design approved (brainstorming). Ready for an implementation plan.
> **App:** `apps/reader` (Rivulet). **Scope:** one slice — per-item Delete and Archive.

## Problem

The Reader ingests feed entries into `reader_items` with an **insert-only, dedup-by-`guid`**
pipeline (`data_upsert_many`). Nothing ever removes an item because it left its source feed
(see `CONTEXT.md` D4/D8; the only deletion is the 30-day retention prune of read+unstarred
items). So when a post is **deleted at the source** — e.g. a Handoff feed item the user
removed — it stays in the Reader's DB forever and keeps showing in `/api/items`, even though
the source feed no longer lists it. The user has no way to get rid of it.

We deliberately reject **auto-reconciliation** (deleting stored items absent from the fetched
feed): RSS feeds only carry the latest N entries (often 10–50), so "absent from the feed" is
the normal fate of any older item, not a signal it was deleted. Auto-pruning on absence would
silently destroy the user's older, unstarred history — which they explicitly want to keep.
Instead we give the user two manual, per-item actions.

## The two actions

| Action      | Mechanism                          | Comes back on refresh?                                   | Visible?                              |
| ----------- | ---------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| **Delete**  | hard-delete the row by `guid`      | Yes — **if still in the source feed** (re-inserted fresh, unstarred). Source-deleted items are gone for good. | No — the row is gone.                 |
| **Archive** | set an `archived=true` flag on the row | **Never** — the row persists, so insert-only dedup skips its `guid`. | Hidden by default; shown when "Show archived" is on. |

Design intents, confirmed with the user:

- **Delete is for cleanup of dead/invalid posts** (the source-deleted case). It removes the DB
  row *entirely, including a star if the item had one* — no confirmation, no starred guard.
  Because these posts are gone from the source, they will not re-appear. (A delete of an item
  that happens to still be live in the feed will re-appear on the next refresh, unstarred —
  that is not what delete is for, and is acceptable.)
- **Archive is the durable "get it out of my normal views but don't lose it" action.** Archived
  items never resurrect (the elegant payoff of insert-only dedup — no tombstone table needed)
  and are **prune-exempt** (like starred).
- **Archived visibility is a global toggle, not a separate view.** By default archived items are
  hidden from *every* view (river / all / starred / feed / folder). A single **"Show archived"**
  toggle sets `includeArchived=true`, and archived items re-appear **in place within whatever
  view is being browsed** — an archived *starred* item shows back up in **Starred**, an archived
  regular item shows back up in **All/regular**. There is no dedicated "Archived" view.

## Data model change

Add one field to the `reader_items` schema (`96a1b5e7-96f0-43a4-baa8-2e19b539d07c`), mirroring
`starred`:

```json
{ "name": "archived", "type": "boolean", "required": false }
```

Semantics identical to `starred`: default effectively `false`. `archived` and `starred` are
orthogonal — an item can be neither, either, or both. No change to `reader_feeds`.

## Backend (proxy rule set `e454596b-fd15-4b20-ac95-4f5612d8181c`)

The Reader backend is a live BFFless proxy-rule-set (no server code). Changes:

### New rule — `POST /api/items/archive`

A near-exact clone of the existing `POST /api/items/star` rule (order 7). Body `{ guid, archived }`:
`prep` coerces `guid` + boolean `archived` → `query` finds the `reader_items` row by `guid` →
`pick` extracts `recordId` → `data_update` writes `{ archived }` (conditional on found) →
`respond { ok, updated }`, with the `respondNoGuid` 400 branch. `auth_required` (`allowApiKey`).

### New rule — `POST /api/items/delete`

`prep` coerces `guid` → `data_delete` on `reader_items` **by filter** `{ guid: { op: "eq",
value: "steps.prep.guid" } }` (conditional on `hasGuid`) → `respond { ok, deleted: <count> }`,
with a `respondNoGuid` 400 branch. `data_delete`'s by-filter form removes the query+pick dance
the update rules need. `auth_required` (`allowApiKey`). (Path follows the existing
`POST /api/items/<action>` convention used by `read`/`star`.)

### Edit — `GET /api/items` (order 4)

Every list branch (`all` / `river` / `starred` / `feed` / `folder`, both the `db_aggregate`
count and the `data_query` page) gains an **`archived` filter that the `includeArchived`
request flag relaxes**:

- Default (`includeArchived` absent/false): each branch filters out archived rows (`archived`
  is not true), `AND`-combined with any existing per-view filter (e.g. river's `read=false`,
  feed's `feedId=…`).
- `includeArchived=true`: the archived clause is a no-op, so archived rows appear in-place.

`prep` parses `includeArchived` into a boolean and the branches consume it. **Recommended
encoding** (avoids doubling ~10 branch steps): an expression-valued filter
`{ archived: { op: "ne", value: "steps.prep.archivedNe" } }` where `prep` returns
`archivedNe = includeArchived ? "__never__" : "true"` — `ne "true"` excludes archived,
`ne "__never__"` matches every row (no row equals the sentinel) so archived is included.
Expression-valued filters are already used in this rule (`countFolder`/`pageFolder` use
`value: "steps.folderUrls.urls"` with `op: "in"`), so this is a supported pattern. The exact
encoding (this sentinel trick vs. paired archived-in / archived-out branches) is an
implementation-plan detail; behavior is what matters. The **single-item `?guid=` deep-link
branch ignores the archived filter** so deep links resolve regardless of archive state.

### Edit — `GET /api/counts` (order 11)

Add the `archived`-excluding clause to the three counts (`unread`, `starred`, `unreadStarred`),
`AND`-combined, so archived items don't inflate the sidebar badges. Counts always reflect the
default (archived-hidden) view; the toggle does not change badge numbers.

### Edit — `POST /api/prune` (order 9)

Add `archived != true` to the retention delete filter (alongside the existing
`read=true AND starred!=true AND fetchedAt<cutoff`). This makes archived items **prune-exempt**,
matching star — otherwise a read, archived, 30-day-old item would be silently pruned, defeating
"keep it."

### No change — `POST /api/refresh` (ingest)

This is the payoff of the flag-not-tombstone design. `data_upsert_many` is insert-only and
skips any `guid` that already exists, so an archived row is never re-inserted or un-archived.
Archive sticks with zero ingest changes. (Deleted rows, having no row, *are* eligible for
re-insert — hence the "delete may resurrect if still in feed" behavior above.)

## Client (`apps/reader/src/`)

- **`lib/items.ts`** — add `archived: boolean` to the `Item` type; `shapeItem` reads it via the
  existing `bool()` coercion (`archived: bool(raw.archived)`).
- **`lib/river.ts`** — add a pure `setArchived(items, guid, archived)` immutable transition
  (twin of `setStarred`), and a `removeItem(items, guid)` helper (drops the row) for delete.
  `Selection` is **unchanged** — archived visibility is a global toggle, not a selection kind.
- **`lib/itemsQuery.ts`** — `buildItemsQuery` gains an `includeArchived` input that appends
  `includeArchived=true` when set. `viewOf` unchanged.
- **`lib/api.ts`** — add `setItemArchived(guid, archived)` → `POST /api/items/archive` and
  `deleteItem(guid)` → `POST /api/items/delete` (both mirroring `setItemStar`'s
  fire-and-confirm shape). `listItems` threads `includeArchived` through to `buildItemsQuery`.
- **`ReaderApp.tsx`** — per-item **Archive** and **Delete** controls on each item (row and/or
  reading pane), with optimistic updates: archive/delete remove the item from the current
  (archived-hidden) list immediately and revert on failure; a **"Show archived"** toggle in the
  toolbar flips `includeArchived` and re-fetches the current view.
- **Concurrency guard:** archive uses `data_update` (whole-record read-modify-write). Do **not**
  fire archive together with a read/star write on the **same `guid`** in parallel
  (`Promise.all`) — field-disjoint concurrent updates to one record clobber each other. Sequence
  same-item writes. (This matches the known CE `data_update` behavior.)

## Edge cases

- **Delete a starred item** → the row (and its star) is removed entirely. Intended.
- **Archive + starred item** → appears in Starred *only* when "Show archived" is on; hidden by
  default like any archived item. The star is preserved.
- **`includeArchived` is global** → it reveals archived items across *all* views (river / all /
  starred / feed / folder) in-place, not in a separate list.
- **Deep link to an archived item** (`?guid=`) → still resolves (guid branch ignores the filter).
- **Delete of an item still live in the feed** → re-appears on the next refresh, unstarred. Not
  delete's purpose; acceptable.

## Rollout

The Reader's `/api/*` is a live BFFless rule set, not shipped by the app build:

1. Add the `archived` boolean field to the **live** `reader_items` schema.
2. Apply the rule changes (2 new rules; edits to `/api/items`, `/api/counts`, `/api/prune`) to
   the live set `e454596b-…` via the BFFless MCP. That set is attached to **both** the `reader`
   and `reader-preview` aliases, so one edit covers both environments.
3. Keep the repo source-of-truth in sync: `apps/reader/bffless/reader.proxy-rules.json` (rules +
   the `reader_items` schema block) and the `CONTEXT.md` data-model/decision notes.

## Testing

- **Vitest (`src/test`)**: `shapeItem` reads `archived`; `buildItemsQuery` appends
  `includeArchived`; `river.setArchived` / `removeItem` transitions; `api.setItemArchived` /
  `deleteItem` request assembly (mocked transport).
- **Live/preview verification** (rules can't run locally): against `reader-preview`, confirm
  delete removes an item and it does not return on refresh (source-deleted case); archive hides
  an item from default views, shows it under the toggle, and survives a refresh; archived items
  don't appear in unread badge counts; prune leaves archived items intact.

## Out of scope

- Auto-reconciliation of items absent from the fetched feed (rejected above).
- Bulk delete/archive (single-item actions only; mark-all-read already covers the bulk-read need).
- A tombstone table (unnecessary — archive is a flag; delete is intentionally resurrectable).
- Any change to feeds, folders, OPML, discovery, or the refresh/prune schedules themselves.
