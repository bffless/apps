# Reader item Delete + Archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Reader users two manual per-item actions — **Delete** (hard-remove a dead/source-deleted post) and **Archive** (hide-but-keep, revealed by a global toggle, never resurrects) — so source-deleted feed items stop lingering forever.

**Architecture:** Client is a Vite SPA; the `/api/*` backend is a live BFFless proxy-rule-set (no server code). Archive is a new `archived` boolean flag on `reader_items` — hidden from views by default, and (because ingest is insert-only, deduped by `guid`) never re-inserted or un-archived by refresh. Delete is a plain `data_delete` by `guid`. Client work (pure logic + api transport) is TDD'd with Vitest; the backend rule/schema changes are precise edits to the repo's source-of-truth JSON, then applied live via the BFFless MCP and verified against `reader-preview`.

**Tech Stack:** React 18 + Vite + TypeScript, Vitest + @testing-library/react, BFFless proxy pipelines (`data_query`/`data_update`/`data_delete`/`db_aggregate`/`function_handler`), BFFless MCP (`j5s-dev`).

## Global Constraints

- **Worktree:** all work happens in `/home/rico/bffless/repos/apps-reader-item-delete-archive` on branch `reader-item-delete-archive`. App dir: `apps/reader/`.
- **Test command (from `apps/reader/`):** `pnpm test:run` (or a single file: `pnpm test:run src/lib/items.test.ts`). Run `pnpm install` at the repo root once before the first test run (fresh worktree).
- **`reader_items` schema id:** `96a1b5e7-96f0-43a4-baa8-2e19b539d07c`. **`reader_feeds`:** `d1216df3-9776-4de2-81b0-0343d758f83d`.
- **Live proxy rule set id:** `e454596b-fd15-4b20-ac95-4f5612d8181c` — attached to **both** the `reader` and `reader-preview` aliases (one edit covers both; changes reach prod, so keep them additive/backward-compatible).
- **Dedup key is `guid`.** Archive is a flag on the existing row so insert-only dedup skips it. Never add a tombstone table.
- **Concurrency:** archive/star/read all use `data_update` (whole-record read-modify-write). Never fire two writes for the **same `guid`** in parallel (`Promise.all`) — they clobber each other. Sequence same-item writes.
- **Backward-compatible defaults:** `archived` absent/false ⇒ current behavior. The `includeArchived` request flag defaults off. Existing endpoints keep working unchanged.
- **Keep in sync:** every backend change lands in both the live set (via MCP) *and* `apps/reader/bffless/reader.proxy-rules.json` + `apps/reader/CONTEXT.md`.

---

### Task 1: `archived` on the Item type + shaper

**Files:**
- Modify: `apps/reader/src/lib/items.ts` (type `Item`, fn `shapeItem`)
- Test: `apps/reader/src/lib/items.test.ts`
- Modify (compile fix): `apps/reader/src/ReaderApp.test.tsx` (the literal `makeItem` factory)

**Interfaces:**
- Produces: `Item` gains `archived: boolean`; `shapeItem(raw)` sets `archived: bool(raw.archived)` (missing ⇒ `false`).

- [ ] **Step 1: Write the failing tests** — append to `items.test.ts` inside the existing `describe('shapeItem', …)`:

```ts
it('reads the archived flag (legacy encodings included)', () => {
  expect(shapeItem({ guid: 'g', feedId: 'f', archived: true }).archived).toBe(true)
  expect(shapeItem({ guid: 'g', feedId: 'f', archived: 'true' }).archived).toBe(true)
  expect(shapeItem({ guid: 'g', feedId: 'f', archived: 1 }).archived).toBe(true)
})

it('defaults archived to false when absent', () => {
  expect(shapeItem({ guid: 'g', feedId: 'f' }).archived).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/lib/items.test.ts`
Expected: FAIL — `archived` does not exist on type `Item` (TS) / property undefined.

- [ ] **Step 3: Implement** — in `items.ts`, add to the `Item` type (after `starred: boolean`):

```ts
  starred: boolean
  archived: boolean
  fetchedAt: number | null
```

and in `shapeItem` (after the `starred:` line):

```ts
    starred: bool(raw.starred),
    archived: bool(raw.archived),
    fetchedAt: num(raw.fetchedAt),
```

- [ ] **Step 4: Fix the one literal `Item` construction** — in `ReaderApp.test.tsx`, `makeItem` builds an `Item` literal; add `archived: false` next to `starred: false`:

```ts
    read: false,
    starred: false,
    archived: false,
    fetchedAt: 1,
```

Confirm there are no other literal `Item` constructions to fix:

Run: `cd apps/reader && grep -rn "starred: false" src | grep -v shapeItem`
Expected: only `ReaderApp.test.tsx` (river/items tests build items via `shapeItem`, which now defaults `archived`).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test:run src/lib/items.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/reader/src/lib/items.ts apps/reader/src/lib/items.test.ts apps/reader/src/ReaderApp.test.tsx
git commit -m "feat(reader): add archived flag to Item type + shaper"
```

---

### Task 2: `river` transitions — `setArchived` + `removeItem`

**Files:**
- Modify: `apps/reader/src/lib/river.ts`
- Test: `apps/reader/src/lib/river.test.ts`

**Interfaces:**
- Produces: `setArchived(items: Item[], guid: string, archived: boolean): Item[]` (immutable, mirrors `setStarred`); `removeItem(items: Item[], guid: string): Item[]` (drops the matching row; identity of others preserved).

- [ ] **Step 1: Write the failing tests** — append to `river.test.ts` (the file already has an `item()` factory built on `shapeItem`, and a `sample` array):

```ts
describe('setArchived', () => {
  it('sets archived on the target, leaving other rows referentially stable', () => {
    const out = setArchived(sample, 'a1', true)
    const a1 = out.find((i) => i.guid === 'a1')!
    expect(a1.archived).toBe(true)
    expect(out.find((i) => i.guid === 'b1')).toBe(sample.find((i) => i.guid === 'b1'))
  })
  it('is a no-op (same references) when the flag already matches or guid is unknown', () => {
    expect(setArchived(sample, 'a1', false)).toEqual(sample)
    expect(setArchived(sample, 'nope', true)).toEqual(sample)
  })
})

describe('removeItem', () => {
  it('drops the matching row and keeps the rest in order', () => {
    const out = removeItem(sample, 'a1')
    expect(out.map((i) => i.guid)).toEqual(['a2', 'b1', 'b2'])
  })
  it('returns the list unchanged when guid is unknown', () => {
    expect(removeItem(sample, 'nope')).toEqual(sample)
  })
})
```

Add `setArchived, removeItem` to the existing import from `./river` at the top of the test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/lib/river.test.ts`
Expected: FAIL — `setArchived`/`removeItem` not exported.

- [ ] **Step 3: Implement** — append to `river.ts`:

```ts
/**
 * Set the `archived` flag on the item with `guid`, returning a new array (only
 * the one item's identity changes). Same optimistic, non-mutating shape as
 * {@link setStarred}. Archived items are hidden from views by default and are
 * prune-exempt; the flag survives refresh (insert-only dedup skips the guid).
 */
export function setArchived(items: Item[], guid: string, archived: boolean): Item[] {
  return items.map((item) =>
    item.guid === guid && item.archived !== archived ? { ...item, archived } : item,
  )
}

/**
 * Drop the item with `guid` from the array (what a hard delete commits locally),
 * returning a new array. An unknown guid leaves the array contents untouched.
 */
export function removeItem(items: Item[], guid: string): Item[] {
  return items.filter((item) => item.guid !== guid)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run src/lib/river.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/reader/src/lib/river.ts apps/reader/src/lib/river.test.ts
git commit -m "feat(reader): setArchived + removeItem list transitions"
```

---

### Task 3: `itemsQuery` — `includeArchived` param

**Files:**
- Modify: `apps/reader/src/lib/itemsQuery.ts` (`buildItemsQuery`)
- Test: `apps/reader/src/lib/itemsQuery.test.ts`

**Interfaces:**
- Produces: `buildItemsQuery(sel, page, limit, order, total, includeArchived = false)` — appends `includeArchived=true` to `params` only when `includeArchived` is true.

- [ ] **Step 1: Write the failing tests** — append to `itemsQuery.test.ts`:

```ts
describe('buildItemsQuery — includeArchived', () => {
  it('omits includeArchived by default', () => {
    const { params } = buildItemsQuery({ kind: 'all' }, 1, 20, 'newest', null)
    expect(params.has('includeArchived')).toBe(false)
  })
  it('appends includeArchived=true when requested', () => {
    const { params } = buildItemsQuery({ kind: 'all' }, 1, 20, 'newest', null, true)
    expect(params.get('includeArchived')).toBe('true')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/lib/itemsQuery.test.ts`
Expected: FAIL — extra arg ignored / `includeArchived` never set.

- [ ] **Step 3: Implement** — change the `buildItemsQuery` signature and add the param before `return`:

```ts
export function buildItemsQuery(
  sel: Selection,
  page: number,
  limit: number,
  order: SortOrder,
  total: number | null,
  includeArchived = false,
): ItemsQuery {
```

and just before `return { params, reverse }`:

```ts
  if (includeArchived) params.set('includeArchived', 'true')

  return { params, reverse }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run src/lib/itemsQuery.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/reader/src/lib/itemsQuery.ts apps/reader/src/lib/itemsQuery.test.ts
git commit -m "feat(reader): includeArchived param on buildItemsQuery"
```

---

### Task 4: `api` — `setItemArchived`, `deleteItem`, `listItems` passthrough

**Files:**
- Modify: `apps/reader/src/lib/api.ts` (`listItems`, plus two new exports)
- Test: `apps/reader/src/lib/api.test.ts`

**Interfaces:**
- Consumes: `buildItemsQuery(..., includeArchived)` (Task 3).
- Produces:
  - `setItemArchived(guid: string, archived: boolean): Promise<void>` → `POST /api/items/archive` `{ guid, archived }`.
  - `deleteItem(guid: string): Promise<void>` → `POST /api/items/delete` `{ guid }`.
  - `listItems(sel, opts)` — `opts` gains `includeArchived?: boolean`, threaded into `buildItemsQuery`.

- [ ] **Step 1: Write the failing tests** — append to `api.test.ts` (reuse its `jsonOk` helper; import the new fns):

```ts
describe('setItemArchived', () => {
  it('POSTs guid + archived to /api/items/archive', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true, updated: true }))
    vi.stubGlobal('fetch', fetchMock)
    await setItemArchived('g1', true)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/items/archive')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ guid: 'g1', archived: true })
  })
  it('throws before the network on an empty guid', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(setItemArchived('', true)).rejects.toThrow(/guid is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('deleteItem', () => {
  it('POSTs guid to /api/items/delete', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true, deleted: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await deleteItem('g1')
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/items/delete')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ guid: 'g1' })
  })
  it('throws before the network on an empty guid', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(deleteItem('')).rejects.toThrow(/guid is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('listItems — includeArchived', () => {
  it('adds includeArchived=true to the request when opted in', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await listItems({ kind: 'all' }, { includeArchived: true })
    const [path] = fetchMock.mock.calls[0] as unknown as [string]
    expect(path).toContain('includeArchived=true')
  })
  it('omits includeArchived by default', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await listItems({ kind: 'all' }, {})
    const [path] = fetchMock.mock.calls[0] as unknown as [string]
    expect(path).not.toContain('includeArchived')
  })
})
```

Update the top import: `import { setFeedFolder, setItemArchived, deleteItem, listItems } from './api'`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/lib/api.test.ts`
Expected: FAIL — `setItemArchived`/`deleteItem` not exported; `includeArchived` not in URL.

- [ ] **Step 3: Implement** — in `api.ts`:

Thread the flag through `listItems`. Change its `opts` type and the `buildItemsQuery` call:

```ts
export async function listItems(
  sel: Selection,
  opts: { page?: number; limit?: number; order?: SortOrder; total?: number | null; includeArchived?: boolean } = {},
): Promise<ItemsPage> {
  const page = opts.page ?? 1
  const limit = opts.limit ?? PAGE_SIZE
  const { params, reverse } = buildItemsQuery(sel, page, limit, opts.order ?? 'newest', opts.total ?? null, opts.includeArchived ?? false)
```

Add the two mutations after `setItemStar`:

```ts
/**
 * Persist an item's `archived` flag via `data_update` (looked up by `guid`) — the
 * `/api/items/archive` twin of {@link setItemStar}. Archived items are hidden
 * from views by default and are prune-exempt; the flag survives refresh
 * (insert-only dedup skips the existing guid). Fire-and-confirm: resolves on
 * success, throws on failure so the caller can revert an optimistic update.
 */
export async function setItemArchived(guid: string, archived: boolean): Promise<void> {
  if (!guid) throw new Error('guid is required')
  await readJson(
    await fetchWithReauth('/api/items/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid, archived }),
    }),
  )
}

/**
 * Hard-delete an item by `guid` via `/api/items/delete` (`data_delete`). For
 * cleaning up dead/source-deleted posts — removes the row entirely (star
 * included). A still-live feed item may re-appear on the next refresh; that is
 * not delete's purpose. Throws on failure so the caller can revert.
 */
export async function deleteItem(guid: string): Promise<void> {
  if (!guid) throw new Error('guid is required')
  await readJson(
    await fetchWithReauth('/api/items/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid }),
    }),
  )
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/reader/src/lib/api.ts apps/reader/src/lib/api.test.ts
git commit -m "feat(reader): setItemArchived + deleteItem + listItems includeArchived"
```

---

### Task 5: Wire actions + "Show archived" toggle into the UI

**Files:**
- Modify: `apps/reader/src/ReaderApp.tsx` (state, handlers, both `api.listItems` calls, toolbar toggle, prop passthrough)
- Modify: `apps/reader/src/components/ItemList.tsx` (props + buttons)
- Modify: `apps/reader/src/components/ReadingPane.tsx` (props + buttons)
- Test: `apps/reader/src/ReaderApp.test.tsx`

**Interfaces:**
- Consumes: `api.setItemArchived`, `api.deleteItem`, `api.listItems({ includeArchived })` (Task 4); `setArchived`, `removeItem` (Task 2).
- Produces: `ItemList` / `ReadingPane` gain optional props `onToggleArchive?: (item: Item) => void` and `onDelete?: (item: Item) => void`.

- [ ] **Step 1: Write the failing test** — append to `ReaderApp.test.tsx`. (`vi.mock('./lib/api')` auto-mocks the module; add default resolutions in the existing `beforeEach`, then assert.) First, in the `beforeEach` block (after the existing `vi.mocked(...)` lines), add:

```ts
  vi.mocked(api.setItemArchived).mockResolvedValue(undefined)
  vi.mocked(api.deleteItem).mockResolvedValue(undefined)
```

Then add a test:

```ts
describe('archived toggle', () => {
  it('re-requests the current view with includeArchived when the toggle is turned on', async () => {
    renderAt('/all')
    await waitFor(() => expect(api.listItems).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /show archived/i }))
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(
        { kind: 'all' },
        expect.objectContaining({ includeArchived: true }),
      ),
    )
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/ReaderApp.test.tsx`
Expected: FAIL — no "Show archived" button; `listItems` never called with `includeArchived: true`.

- [ ] **Step 3: Implement — ReaderApp state + list calls.** Add state near the other `useState`s (e.g. by `sortOrder`):

```ts
  const [showArchived, setShowArchived] = useState(false)
```

In **both** `api.listItems(selection, { … })` calls (around lines 248 and 254), add `includeArchived: showArchived` to the opts object. Add `showArchived` to the dependency array of the effect that performs the load (the same effect that reads `selection`, `page`, `sortOrder`, `reloadSeq`) so flipping it refetches.

- [ ] **Step 4: Implement — ReaderApp handlers.** Add after `toggleStar`:

```ts
  // Archive mirrors star: optimistic flag flip, persist, refetch counts, revert
  // on failure. In the default (archived-hidden) view the row stays in the
  // loaded snapshot until the next fetch, so it doesn't vanish under the cursor.
  const toggleArchive = useCallback(
    (item: Item) => {
      const next = !item.archived
      setPageData((prev) => (prev ? { ...prev, items: setArchived(prev.items, item.guid, next) } : prev))
      void api
        .setItemArchived(item.guid, next)
        .then(() => refreshCounts())
        .catch((e) => {
          setPageData((prev) => (prev ? { ...prev, items: setArchived(prev.items, item.guid, !next) } : prev))
          setError(e instanceof Error ? e.message : 'Could not save archived state')
        })
    },
    [refreshCounts],
  )

  // Hard delete: drop the row optimistically, then persist. On failure, reload
  // the view to restore the true server state (we can't cheaply re-insert it).
  const deleteItemAction = useCallback(
    (item: Item) => {
      setPageData((prev) => (prev ? { ...prev, items: removeItem(prev.items, item.guid) } : prev))
      void api
        .deleteItem(item.guid)
        .then(() => refreshCounts())
        .catch((e) => {
          setError(e instanceof Error ? e.message : 'Could not delete item')
          setReloadSeq((n) => n + 1)
        })
    },
    [refreshCounts],
  )
```

Add `setArchived, removeItem` to the existing import from `./lib/river` (alongside `setRead, setStarred`).

- [ ] **Step 5: Implement — toolbar toggle.** Add next to `sortButton` (around line 698):

```tsx
  const showArchivedButton = (
    <button
      type="button"
      onClick={() => setShowArchived((v) => !v)}
      aria-pressed={showArchived}
      title="Show archived items"
      className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {showArchived ? 'Hide archived' : 'Show archived'}
    </button>
  )
```

Render `{showArchivedButton}` wherever `{sortButton}` is rendered in the toolbar (place it immediately after `{sortButton}`).

- [ ] **Step 6: Implement — pass handlers to list/pane.** On every `<ItemList … />` and `<ReadingPane … />` that already receives `onToggleStar={toggleStar}` (lines ~797, ~822, ~861, ~876), add:

```tsx
                      onToggleArchive={toggleArchive}
                      onDelete={deleteItemAction}
```

- [ ] **Step 7: Implement — ItemList buttons.** In `ItemList.tsx`, extend the props type (after `onToggleStar?`):

```ts
  onToggleStar?: (item: Item) => void
  onToggleArchive?: (item: Item) => void
  onDelete?: (item: Item) => void
```

Destructure `onToggleArchive, onDelete` alongside `onToggleStar`. After the existing star `<button>` block (the `{onToggleStar && ( … )}` at ~110-125), add archive + delete buttons mirroring it:

```tsx
          {onToggleArchive && (
            <button
              type="button"
              onClick={() => onToggleArchive(item)}
              aria-pressed={item.archived}
              aria-label={item.archived ? 'Unarchive' : 'Archive'}
              title={item.archived ? 'Unarchive' : 'Archive'}
              className={item.archived ? 'text-sky-500' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}
            >
              {item.archived ? '🗃' : '📥'}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(item)}
              aria-label="Delete"
              title="Delete"
              className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
            >
              🗑
            </button>
          )}
```

- [ ] **Step 8: Implement — ReadingPane buttons.** In `ReadingPane.tsx`, extend the props type the same way (`onToggleArchive?`, `onDelete?`), destructure them, and inside the actions row (the `{(onToggleRead || onToggleStar) && ( … )}` block at ~53), broaden the guard to include the new handlers and add buttons after the star button:

```tsx
            {onToggleArchive && (
              <button
                type="button"
                onClick={() => onToggleArchive(item)}
                aria-pressed={item.archived}
                className={item.archived ? 'text-sky-500' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}
              >
                {item.archived ? '🗃 Archived' : '📥 Archive'}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(item)}
                className="text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400"
              >
                🗑 Delete
              </button>
            )}
```

Update the wrapping guard to `{(onToggleRead || onToggleStar || onToggleArchive || onDelete) && (`.

- [ ] **Step 9: Run the full reader suite**

Run: `cd apps/reader && pnpm test:run`
Expected: PASS (all suites, including the new archived-toggle test and the unchanged existing `listItems` assertions — those already use `expect.objectContaining`/exact opts; if an existing assertion used an exact opts object without `includeArchived`, update it to include `includeArchived: false`).

- [ ] **Step 10: Typecheck + build**

Run: `cd apps/reader && pnpm build`
Expected: `tsc -b` + `vite build` succeed (no type errors from the new props).

- [ ] **Step 11: Commit**

```bash
git add apps/reader/src/ReaderApp.tsx apps/reader/src/components/ItemList.tsx apps/reader/src/components/ReadingPane.tsx apps/reader/src/ReaderApp.test.tsx
git commit -m "feat(reader): Delete + Archive item actions and Show-archived toggle"
```

---

### Task 6: Backend rules + schema (repo source-of-truth JSON)

**Files:**
- Modify: `apps/reader/bffless/reader.proxy-rules.json` (schema block + rules)
- Modify: `apps/reader/CONTEXT.md` (data model + decisions log)

No unit tests (config); the gate is JSON validity + a self-consistency read.

- [ ] **Step 1: Add the `archived` field** to the `reader_items` schema block (after the `starred` field, ~line 38):

```json
        { "name": "starred", "type": "boolean", "required": false },
        { "name": "archived", "type": "boolean", "required": false },
        { "name": "fetchedAt", "type": "number", "required": false }
```

- [ ] **Step 2: Add the `POST /api/items/archive` rule** — a clone of the `/api/items/star` rule (order 7). Insert as a new rule (order 13). Identical structure, with `starred`→`archived` throughout:

```json
{
  "pathPattern": "/api/items/archive",
  "method": "POST",
  "targetUrl": "pipeline",
  "stripPrefix": true,
  "order": 13,
  "timeout": 30000,
  "preserveHost": false,
  "forwardCookies": false,
  "proxyType": "pipeline",
  "isEnabled": true,
  "description": "Set an item's archived flag: POST { guid, archived } -> prep coerces guid/archived -> query finds the reader_items row by guid -> pick recordId -> data_update writes { archived } (conditional) -> respond { ok, updated }. Archived items are hidden from views by default and prune-exempt; insert-only dedup means refresh never un-archives them. The /api/items/star twin.",
  "pipelineConfig": {
    "name": "Set item archive state",
    "steps": [
      { "id": "prep", "name": "prep", "handlerType": "function_handler", "config": { "code": "function handler({ request }) {\n  var b = (request && request.body) || {}\n  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''\n  var archived = (b.archived === true || b.archived === 'true' || b.archived === 1 || b.archived === '1')\n  return { guid: guid, archived: archived, hasGuid: !!guid, noGuid: !guid }\n}\n" } },
      { "id": "query", "name": "query", "handlerType": "data_query", "config": { "filters": { "guid": { "op": "eq", "value": "steps.prep.guid" } }, "pageSize": 1, "schemaId": "96a1b5e7-96f0-43a4-baa8-2e19b539d07c", "condition": "steps.prep.hasGuid" } },
      { "id": "pick", "name": "pick", "handlerType": "function_handler", "config": { "code": "function handler({ steps }) {\n  var rows = (steps && steps.query) || []\n  var q = (rows && rows.length) ? rows[0] : null\n  var rid = q ? (q.recordId || q.id || q._id) : null\n  return { recordId: rid ? String(rid) : '', found: rid ? true : false }\n}\n" } },
      { "id": "update", "name": "update", "handlerType": "data_update", "config": { "fields": { "archived": "steps.prep.archived" }, "recordId": "steps.pick.recordId", "schemaId": "96a1b5e7-96f0-43a4-baa8-2e19b539d07c", "condition": "steps.pick.found" } },
      { "id": "respond", "name": "respond", "handlerType": "response_handler", "config": { "body": "{\"ok\":true,\"updated\":{{steps.pick.found}}}", "status": 200, "headers": { "Cache-Control": "no-store" }, "condition": "steps.prep.hasGuid", "contentType": "application/json" } },
      { "id": "respondNoGuid", "name": "respondNoGuid", "handlerType": "response_handler", "config": { "body": "{\"error\":\"guid is required\"}", "status": 400, "headers": { "Cache-Control": "no-store" }, "condition": "steps.prep.noGuid", "contentType": "application/json" } }
    ],
    "validators": [{ "type": "auth_required", "config": { "allowApiKey": true } }]
  }
}
```

- [ ] **Step 3: Add the `POST /api/items/delete` rule** (order 14):

```json
{
  "pathPattern": "/api/items/delete",
  "method": "POST",
  "targetUrl": "pipeline",
  "stripPrefix": true,
  "order": 14,
  "timeout": 30000,
  "preserveHost": false,
  "forwardCookies": false,
  "proxyType": "pipeline",
  "isEnabled": true,
  "description": "Hard-delete an item: POST { guid } -> prep coerces guid -> data_delete(reader_items) by filter guid=guid -> respond { ok, deleted:count }. For cleaning up dead/source-deleted posts. Removes the row entirely (star included); a still-in-feed item may re-insert on the next refresh. auth_required (allowApiKey).",
  "pipelineConfig": {
    "name": "Delete item",
    "steps": [
      { "id": "prep", "name": "prep", "handlerType": "function_handler", "config": { "code": "function handler({ request }) {\n  var b = (request && request.body) || {}\n  var guid = (typeof b.guid === 'string') ? b.guid.trim() : ''\n  return { guid: guid, hasGuid: !!guid, noGuid: !guid }\n}\n" } },
      { "id": "del", "name": "del", "handlerType": "data_delete", "config": { "filters": { "guid": { "op": "eq", "value": "steps.prep.guid" } }, "schemaId": "96a1b5e7-96f0-43a4-baa8-2e19b539d07c", "condition": "steps.prep.hasGuid" } },
      { "id": "respond", "name": "respond", "handlerType": "response_handler", "config": { "body": "{\"ok\":true,\"deleted\":{{steps.del.count}}}", "status": 200, "headers": { "Cache-Control": "no-store" }, "condition": "steps.prep.hasGuid", "contentType": "application/json" } },
      { "id": "respondNoGuid", "name": "respondNoGuid", "handlerType": "response_handler", "config": { "body": "{\"error\":\"guid is required\"}", "status": 400, "headers": { "Cache-Control": "no-store" }, "condition": "steps.prep.noGuid", "contentType": "application/json" } }
    ],
    "validators": [{ "type": "auth_required", "config": { "allowApiKey": true } }]
  }
}
```

- [ ] **Step 4: Edit `GET /api/items` — `prep` computes `archivedNe`.** In the `prep` `function_handler` code, parse the flag and return it. Add near the other `q.*` reads:

```js
  var includeArchived = (q.includeArchived === 'true' || q.includeArchived === '1' || q.includeArchived === true)
```

and add to the returned object:

```js
    archivedNe: includeArchived ? '__never__' : 'true',
```

(`ne '__never__'` matches every row → archived included; `ne 'true'` excludes archived.)

- [ ] **Step 5: Edit `GET /api/items` — add the archived clause to each view branch.** For the paired count+page steps of **all, river, starred, feed, folder** (i.e. `countAll`/`pageAll`, `countRiver`/`pageRiver`, `countStarred`/`pageStarred`, `countFeed`/`pageFeed`, `countFolder`/`pageFolder`), add `"archived": { "op": "ne", "value": "steps.prep.archivedNe" }` to `filters` and ensure `"filterLogic": "and"` is present. Examples:

`countAll`/`pageAll` currently have no `filters` — add:
```json
"filters": { "archived": { "op": "ne", "value": "steps.prep.archivedNe" } },
```
`countRiver`/`pageRiver` (has `read`) becomes:
```json
"filters": { "read": { "op": "eq", "value": "false" }, "archived": { "op": "ne", "value": "steps.prep.archivedNe" } },
"filterLogic": "and",
```
Apply the analogous merge to `starred` (has `starred`), `feed` (has `feedId`), `folder` (has `feedId in`). **Do NOT touch `pageGuid`** — the deep-link branch must return an item regardless of archive state.

- [ ] **Step 6: Edit `GET /api/counts`** — add `"archived": { "op": "ne", "value": "true" }` to all three aggregates (`unread`, `starred`, `unreadStarred`) and ensure `"filterLogic": "and"` on each (counts always reflect the default archived-hidden view):

```json
"filters": { "read": { "op": "eq", "value": "false" }, "archived": { "op": "ne", "value": "true" } }, "filterLogic": "and",
```
(and the analogous merge for `starred` and `unreadStarred`).

- [ ] **Step 7: Edit `POST /api/prune`** — add `"archived": { "op": "ne", "value": "true" }` to the `data_delete` filters (it already has `filterLogic: "and"`), making archived items prune-exempt like starred.

- [ ] **Step 8: Update the set description + CONTEXT.md.** In `reader.proxy-rules.json`, extend the top-level rule-set `description` to mention the new archive/delete endpoints and the `archived` flag. In `CONTEXT.md`, add `archived (boolean, default false)` to the items data-model line (#39) and a short decision note (e.g. **D14 — Manual per-item Delete (hard) + Archive (hidden, prune-exempt, insert-only-dedup keeps it from resurrecting); no auto-reconcile — RSS windowing would destroy kept history**).

- [ ] **Step 9: Validate JSON + re-read for consistency**

Run: `cd apps/reader && node -e "JSON.parse(require('fs').readFileSync('bffless/reader.proxy-rules.json','utf8')); console.log('valid JSON')"`
Expected: `valid JSON`. Then re-read the three edited rules to confirm every branch that got an `archived` clause also has `filterLogic: "and"` (except single-filter `all`).

- [ ] **Step 10: Commit**

```bash
git add apps/reader/bffless/reader.proxy-rules.json apps/reader/CONTEXT.md
git commit -m "feat(reader): archive/delete rules + archived filter in items/counts/prune"
```

---

### Task 7: Apply to live BFFless + verify (interactive — pause for go-ahead)

The set `e454596b-…` serves **both** `reader` and `reader-preview`, so these changes reach production. They are additive/backward-compatible, but this touches live infra — **get the user's go-ahead before mutating the live set** (per repo rules). Uses the `j5s-dev` MCP.

- [ ] **Step 1: Add the `archived` field to the live `reader_items` schema.** First inspect the current schema to confirm the exact mechanism/tool:
  - `list_pipeline_schemas` / `get_pipeline_schema` for the reader project to locate `reader_items` (`96a1b5e7-…`) and see its field list.
  - Add the `archived` boolean field via the corresponding update tool (`update_pipeline_schema`) — matching how `starred` is defined. If Data-Table fields are additive-by-write (no migration needed), confirm a `data_update` writing `archived` succeeds on one row before relying on it.

- [ ] **Step 2: Create the two new rules on the live set** via `create_proxy_rule` (`ruleSetId: e454596b-…`), using the exact `pipelineConfig` from Task 6 Steps 2–3 (`/api/items/archive`, then `/api/items/delete`).

- [ ] **Step 3: Update the three edited rules on the live set.** For `/api/items` (rule `518181a2-ac34-4725-ba66-c442c73f5270`), `/api/counts`, and `/api/prune`: `get_proxy_rule` to fetch current config, apply the Task 6 edits (Steps 4–7) to the fetched `pipelineConfig`, and `update_proxy_rule` with the result. Diff-verify each `get_proxy_rule` afterward.

- [ ] **Step 4: Verify against `reader-preview`** (authenticated session or API key):
  - Archive an item → it disappears from the default list; `Show archived` reveals it in-place; a `POST /api/refresh` does **not** un-archive or duplicate it.
  - Delete an item that is gone from its source feed → it disappears and does **not** return after `POST /api/refresh`.
  - `GET /api/counts` unread badge does not include archived items.
  - `POST /api/prune` (or inspect its filter) leaves archived items intact.

- [ ] **Step 5: Confirm repo↔live parity.** The live rules now match `apps/reader/bffless/reader.proxy-rules.json` (Task 6). Note any intentional drift in the commit message if the live apply required an adjustment, and back-port it to the repo JSON.

---

## Self-Review

**Spec coverage:**
- `archived` field on `reader_items` → Task 1 (client type), Task 6 Step 1 (repo schema), Task 7 Step 1 (live). ✅
- `POST /api/items/archive` → Task 6 Step 2 + Task 7 Step 2; client `setItemArchived` Task 4. ✅
- `POST /api/items/delete` → Task 6 Step 3 + Task 7 Step 2; client `deleteItem` Task 4. ✅
- `/api/items` archived filter + `includeArchived` (guid branch exempt) → Task 6 Steps 4–5; client Tasks 3–5. ✅
- `/api/counts` exclude archived → Task 6 Step 6. ✅
- `/api/prune` exempt archived → Task 6 Step 7. ✅
- Refresh untouched → no task modifies `/api/refresh` (by design). ✅
- Client type/api/UI + same-guid concurrency guard → Tasks 1–5 (archive/delete handlers issue one write per guid; the Global Constraint documents the rule). ✅
- Global toggle reveals archived in-place across all views → Task 5 (single `showArchived` state feeding both `listItems` calls). ✅
- Deep-link to archived item resolves → Task 6 Step 5 leaves `pageGuid` untouched. ✅
- Rollout via MCP to shared set + repo/CONTEXT sync → Tasks 6–7. ✅
- Testing (Vitest + live/preview verification) → Tasks 1–5 (unit) + Task 7 Step 4 (live). ✅

**Placeholder scan:** No TBD/TODO; every code step shows the code; commands have expected output. ✅

**Type consistency:** `Item.archived: boolean`, `setArchived`/`removeItem`, `setItemArchived`/`deleteItem`, `buildItemsQuery(..., includeArchived)`, `listItems(sel,{includeArchived})`, `onToggleArchive`/`onDelete` — used identically across Tasks 1→5. ✅
