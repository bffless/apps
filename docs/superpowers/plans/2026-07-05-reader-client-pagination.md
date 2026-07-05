# Reader Client (Rivulet) — server-side pagination refactor — Plan 3 of 3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Work in the worktree `/home/rico/bffless/repos/apps-reader-refactor` on branch `reader-pagination-refactor`.

**Goal:** Rewrite the reader client to consume Plan 2's server-side endpoints — each view fetches exactly one filtered, paginated page (`/api/items?view=…&page=…`), badges come from `/api/counts`, and "mark all read" calls `/api/items/read-all` — replacing the "load every item once and derive views/counts in the browser" model.

**Architecture:** A pure `lib/itemsQuery.ts` builds the request params for a `Selection` + page (and translates oldest-first into a newest-first server offset). `lib/api.ts` gains a paginated `listItems`, `getCounts`, `markAllRead`, `getItem`. `ReaderApp` holds an `ItemsPage` for the current `(selection, page, order)` plus a `counts` object, fetched on change, instead of a full `items` array. A numbered `Pager` drives `page`, which is carried in the URL.

**Tech Stack:** React 18 + Vite + react-router + TypeScript, Vitest + @testing-library/react. Commands from `apps/reader/`: `pnpm test` (vitest), `pnpm build` (`tsc -b && vite build`), `pnpm lint`.

## Global Constraints

- Backend contract (LIVE, verified — Plan 2):
  - `GET /api/items?view=all|river|starred|feed|folder&feedId=<url>&folder=<name>&page=<n>&limit=<n>` → `{ items: RawItem[], total, page, pageSize, totalPages }`. **Server orders newest-first only** and ignores `order`. A **no-param** call returns the full set (legacy) — do not rely on that in the new client; always send `view`+`page`.
  - `GET /api/counts` → `{ unreadByFeed: Record<feedIdUrl, number>, starred: number }`.
  - `POST /api/items/read-all` `{ view, feedId?, folder? }` → `{ updated: number }`.
  - `GET /api/items?guid=<guid>` is **not** a backend feature yet — `getItem` is implemented by querying the item's own feed/view page set is overkill; instead add a `guid` branch (Task 0) OR fetch page-by-page. This plan adds a tiny backend `guid` branch in Task 0 so `getItem` is one request.
- **Oldest-first** is a client concern: the server has no `order`. `lib/itemsQuery.ts` translates an oldest request into the equivalent newest-first page and the component reverses that page's items. Needs `total` (fetched first). Keep this math in the pure, tested helper.
- Preserve existing behavior where not explicitly changed: `session.ts` reauth, feeds list, add/remove/folder, discover, optimistic read/star writes (`setItemRead`/`setItemStar` per-guid), the URL-is-source-of-truth routing (#144), keyboard nav, auto-mark-read on scroll-past.
- `lib/api.ts` is the transport seam (not unit-tested); put testable logic in pure `lib/*` modules with Vitest specs mirroring the existing `lib/*.test.ts` style.
- Item shaping stays in `lib/items.ts` (`shapeItem`), feed shaping in `lib/feeds.ts`.

---

### Task 0: Backend — single-item `guid` branch on `/api/items` (MCP + JSON)

**Rationale:** deep-linking to an item not on the current page needs a one-shot fetch. Add a `guid` branch to the live `/api/items` pipeline (rule `518181a2`) and mirror the JSON. This is a controller MCP task, not client code.

- [ ] **Step 1:** In `prep` (of `/api/items`), also read `var guid = (typeof q.guid === 'string') ? q.guid : ''` and return `guid: guid, hasGuid: !!guid`. When `hasGuid`, force `isAll/isRiver/...` all false so no view branch runs.
- [ ] **Step 2:** Add `pageGuid` (`data_query`, `filters: { guid: { op:'eq', value:'steps.prep.guid' } }`, `limit: 1`, `condition: steps.prep.hasGuid`) and include it first in `assemble`'s `rows(...)` chain; set `total` to `items.length` for the guid case.
- [ ] **Step 3:** Apply via `mcp__j5s-dev__update_proxy_rule` (id `518181a2`), verify `GET /api/items?guid=<a real guid>` returns that one item, and re-sync `apps/reader/bffless/reader.proxy-rules.json` (regenerate `rules` from the live set, as in Plan 2's sync).
- [ ] **Step 4:** Commit: `feat(reader): single-item guid branch on /api/items backend`.

*(If the controller prefers, `getItem` can instead page through client-side and Task 0 is skipped — but the guid branch is cleaner and cheap.)*

---

### Task 1: `lib/itemsQuery.ts` — pure request/paging math

**Files:**
- Create: `apps/reader/src/lib/itemsQuery.ts`
- Create: `apps/reader/src/lib/itemsQuery.test.ts`

**Interfaces (Produces):**
- `type SortOrder = 'newest' | 'oldest'`
- `type ItemsQuery = { params: URLSearchParams; reverse: boolean }`
- `viewOf(sel: Selection): 'all'|'river'|'starred'|'feed'|'folder'`
- `buildItemsQuery(sel: Selection, page: number, limit: number, order: SortOrder, total: number | null): ItemsQuery` — for `newest`, `params` = `{view, feedId?, folder?, page, limit}`, `reverse=false`. For `oldest` with a known `total`, compute `totalPages = max(1, ceil(total/limit))`, `serverPage = totalPages - page + 1` (clamped to `[1, totalPages]`), `params` uses `serverPage`, `reverse=true`. For `oldest` with `total===null` (first load), fall back to `serverPage=page, reverse=false` (a follow-up fetch re-issues once total is known).
- `PAGE_SIZE = 20` constant.

- [ ] **Step 1: Write failing tests** (`itemsQuery.test.ts`): assert `buildItemsQuery({kind:'feed',url:'u'}, 1, 20, 'newest', null).params.get('view')==='feed'` and `get('feedId')==='u'`, `get('page')==='1'`; folder sets `folder`; river/starred/all set only `view`; oldest with `total=45,limit=20,page=1` → `serverPage=3`(=ceil(45/20)=3), `reverse=true`; oldest `page=3` → `serverPage=1`; oldest with `total=null` → `serverPage=page, reverse=false`.
- [ ] **Step 2:** Run `pnpm test -- itemsQuery` → FAIL (no module).
- [ ] **Step 3: Implement** `itemsQuery.ts` per the interfaces above (pure; no imports beyond `Selection` type from `./river`).
- [ ] **Step 4:** Run `pnpm test -- itemsQuery` → PASS.
- [ ] **Step 5:** Commit `feat(reader): pure itemsQuery paging/order helper`.

---

### Task 2: `lib/api.ts` — paginated `listItems`, `getCounts`, `markAllRead`, `getItem`

**Files:** Modify `apps/reader/src/lib/api.ts` (replace `listItems` at lines 148-153; add three functions).

**Interfaces (Produces):**
- `type ItemsPage = { items: Item[]; total: number; page: number; pageSize: number; totalPages: number }`
- `type Counts = { unreadByFeed: Record<string, number>; starred: number }`
- `listItems(sel: Selection, opts?: { page?: number; limit?: number; order?: SortOrder; total?: number | null }): Promise<ItemsPage>` — builds the path from `buildItemsQuery`, fetches, shapes items via `shapeItem`, reverses the page when `reverse` is true, returns the envelope (numbers coerced, defaults sane).
- `getCounts(): Promise<Counts>`
- `markAllRead(sel: Selection): Promise<number>` — POST `/api/items/read-all` with `{ view, feedId?, folder? }`, returns `updated`.
- `getItem(guid: string): Promise<Item | null>` — GET `/api/items?guid=…`, returns the single shaped item or null.

- [ ] **Step 1:** Add imports: `buildItemsQuery, viewOf, type SortOrder, PAGE_SIZE` from `./itemsQuery`; `type Selection` from `./river`.
- [ ] **Step 2:** Replace `listItems`:
```ts
export type ItemsPage = { items: Item[]; total: number; page: number; pageSize: number; totalPages: number }

/** Fetch one filtered, paginated page for a selection (see lib/itemsQuery). */
export async function listItems(
  sel: Selection,
  opts: { page?: number; limit?: number; order?: SortOrder; total?: number | null } = {},
): Promise<ItemsPage> {
  const page = opts.page ?? 1
  const limit = opts.limit ?? PAGE_SIZE
  const { params, reverse } = buildItemsQuery(sel, page, limit, opts.order ?? 'newest', opts.total ?? null)
  const body = await readJson(await fetchWithReauth(`/api/items?${params.toString()}`))
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && !Number.isNaN(v) ? v : d)
  const items = asArray(body, 'items').map((r) => shapeItem(r as RawItem))
  if (reverse) items.reverse()
  return {
    items,
    total: num(b.total, items.length),
    page: num(b.page, page),
    pageSize: num(b.pageSize, limit),
    totalPages: num(b.totalPages, 1),
  }
}
```
- [ ] **Step 3:** Add `getCounts`, `markAllRead`, `getItem` (POST/GET via `fetchWithReauth`, using `viewOf(sel)` and `sel.url`/`sel.name`). Shape counts defensively (`unreadByFeed` object, `starred` number).
- [ ] **Step 4:** `pnpm build` (typecheck) → the old `listItems(feedId)` call site in `ReaderApp` will now error; that's expected (Task 3 fixes it). Confirm the error is only there. Commit `feat(reader): paginated listItems + counts + read-all + getItem api`.

---

### Task 3: `ReaderApp` — paged fetch state (replaces load-everything)

**Files:** Modify `apps/reader/src/ReaderApp.tsx`.

**Interfaces (Consumes):** `api.listItems(sel, {page, order, total})`, `api.getCounts()`.

Replace the single `items` array + `visible`/`itemsForSelection` derivation with:
- `page` (from URL, Task 5) and `order` (`'newest'|'oldest'`, existing toggle state) drive the fetch.
- state: `pageData: ItemsPage | null`, `counts: Counts`, `loading`, `error`.
- An effect keyed on `(selectionKey(selection), page, order)` calls `api.listItems(selection, { page, order, total: pageData?.total ?? null })` and sets `pageData`. For `oldest`, if `total` was null on the first fetch, re-issue once `total` is known (or accept page-1 fallback then correct).
- `visible` items = `pageData?.items ?? []` (already server-ordered/reversed). Remove `itemsForSelection`, `unreadCountsByFeed`, `totalUnread`, `totalStarred` usage over a full set.
- `counts` fetched via `api.getCounts()` on mount, after refresh, and after any read/star/mark-all mutation.

- [ ] **Step 1:** Write/adjust a component test (`ReaderApp.test.tsx` if present, else a focused new one) that mocks `api.listItems`/`api.getCounts` and asserts: selecting a feed fetches with that selection+page; changing page refetches; a counts refetch happens after `markAllRead`. (Mirror existing component-test style.)
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Implement the state rework. Keep optimistic read/star patching the CURRENT `pageData.items` (via `setRead`/`setStarred` over `pageData.items`), then fire the per-guid `api.setItemRead/Star`, and refetch counts. Keep the scroll-past auto-mark-read observer, operating on the loaded page.
- [ ] **Step 4:** Run test → PASS; `pnpm build` clean.
- [ ] **Step 5:** Commit `feat(reader): paged per-view fetch + counts state`.

---

### Task 4: Counts-driven sidebar badges

**Files:** Modify `apps/reader/src/components/FeedSidebar.tsx`, `FeedRail.tsx`, and wherever badges read counts; `lib/folders.ts` `folderUnread` stays (sums per-feed counts) but now consumes the `counts.unreadByFeed` map.

- [ ] **Step 1:** Pass `counts.unreadByFeed`, `counts.starred`, and the river total (`sum(unreadByFeed)`) into the sidebar; render per-feed, per-folder (via `folderUnread`), river, and starred badges from these. Add/adjust a test asserting a folder badge equals the sum of its feeds' counts from a mock `unreadByFeed`.
- [ ] **Step 2:** Run tests → PASS; `pnpm build` clean.
- [ ] **Step 3:** Commit `feat(reader): counts-endpoint-driven badges`.

---

### Task 5: URL-addressable page + `Pager`

**Files:** Modify `apps/reader/src/lib/route.ts` (+ `route.test.ts`); create `apps/reader/src/components/Pager.tsx`; wire into `ReaderApp` / `ItemList`.

Design: page is a **query param** `?page=n` (kept off the path so it doesn't collide with the `/…/item/:itemId` nesting). `page=1`/absent are equivalent.

- [ ] **Step 1 (route):** Add `pageFromSearch(search: string): number` (parse `?page`, default 1, min 1) and `withPage(path: string, page: number): string` (append/replace `?page`, omit for page 1) to `route.ts`, with tests. Run `pnpm test -- route` RED→GREEN.
- [ ] **Step 2 (Pager):** Create `Pager.tsx` — props `{ page: number; totalPages: number; onPage: (p: number) => void }`; renders numbered buttons `[1][2]…[n]` (windowed if large) + prev/next; no-op/hide when `totalPages <= 1`. Add a render test.
- [ ] **Step 3:** Wire `ReaderApp` to read `page` from the location search, pass `totalPages` from `pageData`, and `onPage` navigates via `navigate(withPage(pathForSelection(selection), p))`. Reset to page 1 when the selection changes.
- [ ] **Step 4:** `pnpm build` clean; commit `feat(reader): url-addressable numbered pager`.

---

### Task 6: Mark-all-read via the server primitive

**Files:** Modify `ReaderApp.tsx` (the `markAllRead` handler).

- [ ] **Step 1:** Replace the fan-out (`unreadGuids(visible)` → N parallel `setItemRead`) with `await api.markAllRead(selection)`, then refetch the current page + `getCounts()`. Keep an optimistic local patch of the current page (mark its unread rows read) for snappy UX, reconciled by the refetch. Adjust the test from Task 3 accordingly.
- [ ] **Step 2:** `pnpm build` clean; commit `feat(reader): server-side mark-all-read`.

---

### Task 7: Deep-link `getItem` + empty/"caught up" states

**Files:** Modify `ReaderApp.tsx` (`selectedItem` resolution; empty states).

- [ ] **Step 1:** `selectedItem` = the open guid found in `pageData.items`, else `await api.getItem(guid)` (Task 0/2) cached in a small `openItem` state, so a deep-linked item off the current page still opens.
- [ ] **Step 2:** Empty state driven by `pageData.total === 0` (not the loaded page); "all caught up" for river when `total === 0`. Mark-all-read button gated on `counts`/`total`, not a full in-memory scan.
- [ ] **Step 3:** `pnpm build` clean; commit `feat(reader): deep-link getItem + total-driven empty states`.

---

### Task 8: Prune dead code + full gate

**Files:** `lib/river.ts` (remove now-unused `itemsForSelection`, `unreadCountsByFeed`, `totalUnread`, `totalStarred` **only if** no longer imported anywhere — keep `setRead`/`setStarred`/`markGuidsRead`/`selectionKey`/`selectionEquals`/`Selection`); delete their dead tests; update any stale imports.

- [ ] **Step 1:** `grep -rn` each removed symbol to confirm no remaining importers before deleting; update `river.test.ts`.
- [ ] **Step 2:** Full gate from `apps/reader/`: `pnpm test` (all green), `pnpm build` (clean), `pnpm lint` (clean).
- [ ] **Step 3:** Validate against the LIVE reader with a seeded session or the deployed alias (headless via `localdev-tools`, or the reader alias): each view shows a bounded page, the pager moves between pages, badges match `/api/counts`, mark-all-read works, and the originally-empty feeds paginate correctly with HN present.
- [ ] **Step 4:** Commit `chore(reader): remove pre-pagination dead code`.

---

## Self-Review

**Spec coverage:** api layer (Task 2), pure paging/order math incl. oldest (Task 1), paged state (Task 3), counts badges (Task 4), pager + URL (Task 5), mark-all-read (Task 6), deep-link + empty states (Task 7), cleanup/gate (Task 8), plus the enabling backend `guid` branch (Task 0). Covers every "client casualty" from the design's inventory.

**Placeholder scan:** the ReaderApp tasks are interface+instruction level (not full line-by-line) because it's a large existing file the implementer edits in place following existing patterns — each names the exact functions, state, and behavior to change. The new pure/contract files (itemsQuery, api additions, Pager, route additions) carry concrete code.

**Type consistency:** `ItemsPage`/`Counts`/`SortOrder`/`ItemsQuery`/`buildItemsQuery`/`viewOf`/`PAGE_SIZE` names are used consistently across Tasks 1–7.

## Rollout

All on the `reader-pagination-refactor` worktree branch, bundled with Plan 2's synced `reader.proxy-rules.json` into **one PR** to `bffless/apps`. The backend is already live, so merging the client is what finishes the migration; until then the deployed client keeps working via the legacy no-param path.
