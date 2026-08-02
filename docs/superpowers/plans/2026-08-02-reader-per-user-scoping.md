# Rivulet Per-User Data Scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Rivulet user their own feeds and items, so the app can be shared with people who are not project admins.

**Architecture:** Copy-per-user. Both data-table schemas gain a `userId` column plus a synthetic per-user dedup column; every data-access step in the proxy rule set filters on `user.id`; the userless cron refresh fans each parsed feed entry out to one row per subscriber. No CE changes required.

**Tech Stack:** BFFless proxy rule set (YAML rules + ES5 `function_handler` snippets) under `apps/reader/.bffless/proxy-rules/reader/`. Tests are Vitest in `apps/reader/src/lib/`, run from `apps/reader`. No app server exists — "the backend" is the rule set.

**Spec:** `docs/superpowers/specs/2026-08-02-reader-per-user-scoping-design.md`

## Global Constraints

- **`.fn.js` files are sandboxed ES5.** No `const`/`let`, no arrow functions, no template literals, no `Array.prototype.includes`, no optional chaining. Match the existing style: `var`, `function`, string concatenation.
- **A `.fn.js` handler receives `{ user, request, steps, deployment }`.** `user` is `{ id, email, role, groups }` **or `undefined`** when the pipeline runs as a userless system run (`ce: function.handler.ts:72-80`). Never assume `user` exists.
- **The scoping expression is exactly `user.id`** — a string, as a filter `value`. `user` is a valid expression root (`ce: expression-evaluator.ts:67`).
- **Any step with two or more filters MUST declare `filterLogic: and`.** Omitting it silently changes the step's meaning. This is the single most likely defect in this change.
- **On query → pick → update rules the `userId` filter goes on the `query` step, never the `update` step.** `data_update` ignores `filters` entirely when `recordId` is set (`ce: data-update.handler.ts:91`).
- **`data_upsert_many` writes the resolved dedup value into the `dedupField` column itself** (`ce: data-upsert-many.handler.ts:227`) and requires that column to exist on the schema (line 190). Do not also list the dedup column in `map`.
- **`updateFields` may never include the `dedupField`** (`ce: data-upsert-many.handler.ts:156`).
- Run tests from `apps/reader` with `pnpm test:run`. Vitest's cwd is the app root, which is what the existing tests resolve `.bffless/` against.
- Do not push, deploy, or change any live alias during Tasks 1–10. Task 11 is the live runbook and is operator-driven.

---

### Task 1: Add the identity and dedup columns to both schemas

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/schemas/reader_feeds.schema.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/schemas/reader_items.schema.yaml`
- Test: `apps/reader/src/lib/scoping.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `reader_feeds.userId`, `reader_feeds.scopedUrl`, `reader_items.userId`, `reader_items.scopedGuid` — all `type: string`, `required: false`. Every later task depends on these field names.

**Why `required: false`:** these columns are added to a schema that already has live rows. A `required: true` field would make CE's write validation reject updates to any not-yet-backfilled row (`ce: data-update.handler.ts:178` throws `Data validation failed`), which would break the app in the window between deploying the schema and finishing the backfill. Loudness is recovered by the structural test in Task 2, which fails at test time if a write path forgets to set them.

- [ ] **Step 1: Write the failing test**

Create `apps/reader/src/lib/scoping.test.ts`:

```ts
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')

type Schema = { name: string; fields: Array<{ name: string; type: string; required?: boolean }> }

function schema(file: string): Schema {
  return parse(readFileSync(resolve(setRoot, 'schemas/' + file), 'utf8')) as Schema
}

function field(s: Schema, name: string) {
  const f = s.fields.find((x) => x.name === name)
  if (!f) throw new Error('missing field ' + name + ' on ' + s.name)
  return f
}

describe('per-user schema columns', () => {
  it('reader_feeds carries an owner and a per-user dedup column', () => {
    const s = schema('reader_feeds.schema.yaml')
    expect(field(s, 'userId').type).toBe('string')
    expect(field(s, 'scopedUrl').type).toBe('string')
  })

  it('reader_items carries an owner and a per-user dedup column', () => {
    const s = schema('reader_items.schema.yaml')
    expect(field(s, 'userId').type).toBe('string')
    expect(field(s, 'scopedGuid').type).toBe('string')
  })

  it('the new columns are optional so live rows stay writable pre-backfill', () => {
    const feeds = schema('reader_feeds.schema.yaml')
    const items = schema('reader_items.schema.yaml')
    expect(field(feeds, 'userId').required).toBeFalsy()
    expect(field(feeds, 'scopedUrl').required).toBeFalsy()
    expect(field(items, 'userId').required).toBeFalsy()
    expect(field(items, 'scopedGuid').required).toBeFalsy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: FAIL with `missing field userId on reader_feeds`

- [ ] **Step 3: Add the fields**

Append to `schemas/reader_feeds.schema.yaml` (after the existing `addedAt` entry, same indentation):

```yaml
  - name: userId
    type: string
    required: false
  - name: scopedUrl
    type: string
    required: false
```

Append to `schemas/reader_items.schema.yaml` (after the existing `enclosureUrl` entry):

```yaml
  - name: userId
    type: string
    required: false
  - name: scopedGuid
    type: string
    required: false
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader/schemas apps/reader/src/lib/scoping.test.ts
git commit -m "feat(reader): add userId + per-user dedup columns to both schemas"
```

---

### Task 2: Structural scoping ratchet

This task adds no scoping. It adds the test that makes every later task's omission impossible, seeded with the current debt so it is green on commit. Each later task deletes its own entries from `EXPECTED_UNSCOPED`; when the list is down to the two documented system-run steps, the change is provably complete.

**Files:**
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: schema columns from Task 1.
- Produces: `EXPECTED_UNSCOPED: Set<string>` keyed `"<rule dir>:<step id>"`, e.g. `"api/items/get:pageRiver"`. Later tasks remove keys from this set; they must not change the key format or the helper names `isScoped` / `dataSteps`.

- [ ] **Step 1: Write the failing test**

Append to `apps/reader/src/lib/scoping.test.ts`:

```ts
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const rulesRoot = resolve(setRoot, 'rules')

// Handlers that read or write reader data, and therefore must be scoped to the caller.
const DATA_HANDLERS = new Set([
  'data_query',
  'db_aggregate',
  'data_update',
  'data_delete',
  'data_upsert_many',
])

// Steps that legitimately run with no userId filter. Both are fired by a
// pipeline_schedule as a USERLESS system run, where `user.id` resolves to null:
//   api/refresh/post:feeds — the cron must read EVERY user's feeds to ingest for them
//   api/prune/post:del     — retention filters each row's own read/starred/archived/
//                            fetchedAt, which is already correct per-user
// Everything else in this list is debt this change removes, one task at a time.
// When only the two entries above remain, per-user scoping is complete.
const EXPECTED_UNSCOPED = new Set<string>([
  'api/refresh/post:feeds',
  'api/prune/post:del',

  // Task 3
  'api/feeds:query',
  'api/counts/get:unread',
  'api/counts/get:starred',
  'api/counts/get:unreadStarred',

  // Task 4
  'api/items/get:folderFeeds',
  'api/items/get:countAll',
  'api/items/get:pageAll',
  'api/items/get:countRiver',
  'api/items/get:pageRiver',
  'api/items/get:countStarred',
  'api/items/get:pageStarred',
  'api/items/get:countFeed',
  'api/items/get:pageFeed',
  'api/items/get:countFolder',
  'api/items/get:pageFolder',
  'api/items/get:pageGuid',

  // Task 5
  'api/items/read/post:query',
  'api/items/star/post:query',
  'api/items/archive/post:query',

  // Task 6
  'api/items/delete/post:del',
  'api/items/read-all/post:folderFeeds',
  'api/items/read-all/post:updAll',
  'api/items/read-all/post:updStarred',
  'api/items/read-all/post:updFeed',
  'api/items/read-all/post:updFolder',

  // Task 7
  'api/feeds/post:upsert',
  'api/feeds/remove/post:query',
  'api/feeds/remove/post:delItems',
  'api/feeds/folder/post:query',

  // Task 8
  'api/refresh/post:upsert',
])

type Step = { id: string; handler?: string; code?: string; config?: Record<string, unknown> }
type Rule = { pipeline?: { steps?: Step[] } }
type FoundStep = { key: string; handler: string; config: Record<string, unknown> }

function ruleFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) ruleFiles(full, out)
    else if (entry.endsWith('.rule.yaml') || entry === 'rule.yaml') out.push(full)
  }
  return out
}

// "rules/api/items/get/rule.yaml" -> "api/items/get"
// "rules/api/feeds/get.rule.yaml" -> "api/feeds"
function ruleKey(file: string): string {
  const rel = relative(rulesRoot, file).split('\\').join('/')
  const base = rel.substring(0, rel.lastIndexOf('/'))
  return base === '' ? rel.replace(/\.rule\.yaml$/, '') : base
}

function dataSteps(): FoundStep[] {
  const found: FoundStep[] = []
  for (const file of ruleFiles(rulesRoot)) {
    const rule = parse(readFileSync(file, 'utf8')) as Rule
    for (const step of rule.pipeline?.steps ?? []) {
      if (!step.handler || !DATA_HANDLERS.has(step.handler)) continue
      found.push({
        key: ruleKey(file) + ':' + step.id,
        handler: step.handler,
        config: step.config ?? {},
      })
    }
  }
  return found
}

function isScoped(step: FoundStep): boolean {
  if (step.handler === 'data_upsert_many') {
    const map = step.config.map as Record<string, unknown> | undefined
    return typeof map?.userId === 'string' && map.userId.length > 0
  }
  // A step acting on a single recordId inherits its scoping from the query that
  // produced that id — data_update/data_delete ignore `filters` entirely when
  // `recordId` is set (ce: data-update.handler.ts:91), so a userId filter here
  // would be dead code. The paired `query` step is what must carry the filter,
  // and it is listed separately below.
  if (typeof step.config.recordId === 'string' && step.config.recordId.length > 0) return true
  const filters = step.config.filters as
    | Record<string, { op?: string; value?: unknown }>
    | undefined
  const f = filters?.userId
  return f?.op === 'eq' && f?.value === 'user.id'
}

describe('rule set scoping ratchet', () => {
  it('finds every data-access step in the set', () => {
    // Guards the walker itself: if a rule file stops being discovered, the
    // scoping assertions below would pass vacuously. 37 = 32 filter/aggregate/
    // upsert steps + 5 recordId steps.
    expect(dataSteps().length).toBe(37)
  })

  it('only the expected steps are unscoped', () => {
    const unscoped = dataSteps()
      .filter((s) => !isScoped(s))
      .map((s) => s.key)
      .sort()
    expect(unscoped).toEqual([...EXPECTED_UNSCOPED].sort())
  })

  it('every multi-filter step declares filterLogic: and', () => {
    const bad = dataSteps()
      .filter((s) => {
        const filters = (s.config.filters ?? {}) as Record<string, unknown>
        return Object.keys(filters).length > 1 && s.config.filterLogic !== 'and'
      })
      .map((s) => s.key)
      .sort()
    expect(bad).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 6 tests.

This task changes no rules, so any failure here is a bug in the test, not in the set — fix the **test**:

- `only the expected steps are unscoped` — the diff names the mismatched step keys. Correct `EXPECTED_UNSCOPED` to match reality.
- `finds every data-access step` — the walker should discover 14 rule files. If the count is lower, `ruleFiles` is missing some; if it merely differs from 37, print the keys and update the constant, since the number is documentation rather than a requirement.
- `every multi-filter step declares filterLogic: and` — expected to pass as-is. If it fails, you have found a pre-existing bug in the rule set; report it before continuing, as it changes that step's meaning today.

- [ ] **Step 3: Commit**

```bash
git add apps/reader/src/lib/scoping.test.ts
git commit -m "test(reader): add scoping ratchet over the proxy rule set"
```

---

### Task 3: Scope the two simple read rules

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/feeds/get.rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/counts/get/rule.yaml`
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: `EXPECTED_UNSCOPED` from Task 2.
- Produces: the canonical filter block every later task repeats verbatim:

```yaml
          userId:
            op: eq
            value: user.id
```

- [ ] **Step 1: Remove this task's entries from the ratchet**

In `scoping.test.ts`, delete these four lines and the `// Task 3` comment from `EXPECTED_UNSCOPED`:

```ts
  'api/feeds:query',
  'api/counts/get:unread',
  'api/counts/get:starred',
  'api/counts/get:unreadStarred',
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: FAIL — `only the expected steps are unscoped` reports the four keys as extra.

- [ ] **Step 3: Scope `GET /api/feeds`**

In `rules/api/feeds/get.rule.yaml`, replace the `query` step's config:

```yaml
      config:
        limit: 500
        filters:
          userId:
            op: eq
            value: user.id
        schemaId: $schema:reader_feeds
```

- [ ] **Step 4: Scope `GET /api/counts`**

In `rules/api/counts/get/rule.yaml`, add the `userId` filter to all three `db_aggregate` steps. They already declare `filterLogic: and`, so only the filter block is added. `unread`:

```yaml
      config:
        filters:
          read:
            op: eq
            value: false
          archived:
            op: ne
            value: true
          userId:
            op: eq
            value: user.id
        groupBy: feedId
        filterLogic: and
        schemaId: $schema:reader_items
        operation: count
```

`starred`:

```yaml
      config:
        filters:
          starred:
            op: eq
            value: true
          archived:
            op: ne
            value: true
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        operation: count
```

`unreadStarred`:

```yaml
      config:
        filters:
          read:
            op: eq
            value: false
          starred:
            op: eq
            value: true
          archived:
            op: ne
            value: true
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        operation: count
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib/scoping.test.ts
git commit -m "feat(reader): scope GET /api/feeds and GET /api/counts to the caller"
```

---

### Task 4: Scope `GET /api/items` (12 steps)

The largest single rule. `folderFeeds` reads `reader_feeds`; the other eleven read `reader_items`.

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/get/rule.yaml`
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: the filter block from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Remove this task's entries from the ratchet**

Delete the twelve `'api/items/get:…'` lines and the `// Task 4` comment from `EXPECTED_UNSCOPED`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: FAIL listing twelve extra unscoped keys.

- [ ] **Step 3: Add the filter to all twelve steps**

In `rules/api/items/get/rule.yaml` add this block inside `config.filters` of **every** one of: `folderFeeds`, `countAll`, `pageAll`, `countRiver`, `pageRiver`, `countStarred`, `pageStarred`, `countFeed`, `pageFeed`, `countFolder`, `pageFolder`, `pageGuid`.

```yaml
          userId:
            op: eq
            value: user.id
```

`folderFeeds` and `pageGuid` need a `filters` key created and `filterLogic: and` added, because `folderFeeds` currently has none and `pageGuid` has exactly one. Their full configs become:

```yaml
    - id: folderFeeds
      name: folderFeeds
      handler: data_query
      config:
        limit: 500
        filters:
          userId:
            op: eq
            value: user.id
        schemaId: $schema:reader_feeds
        condition: steps.prep.hasFolder
```

```yaml
    - id: pageGuid
      name: pageGuid
      handler: data_query
      config:
        limit: 2
        filters:
          guid:
            op: eq
            value: steps.prep.guid
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        condition: steps.prep.hasGuid
```

`countAll` and `pageAll` currently have a single `archived` filter and no `filterLogic`; adding `userId` makes them multi-filter, so both also need `filterLogic: and`. The remaining seven already declare it.

> `pageGuid` is the reason this matters: `guid` is no longer unique across users, so an unscoped single-guid lookup can return a different user's row.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 6 tests. The `filterLogic` test catches any of the four steps you forgot to update.

- [ ] **Step 5: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib/scoping.test.ts
git commit -m "feat(reader): scope GET /api/items to the caller across all view branches"
```

---

### Task 5: Scope the three item-state mutations

`read`, `star` and `archive` are structurally identical: `prep` → `query` (by guid) → `pick` (recordId) → `update`. The filter goes on `query`.

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/read/post/rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/star/post/rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/archive/post/rule.yaml`
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: the filter block from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Remove this task's entries from the ratchet**

Delete the three `'api/items/{read,star,archive}/post:query'` lines and the `// Task 5` comment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: FAIL listing three extra unscoped keys.

- [ ] **Step 3: Scope the `query` step in each of the three rules**

Identical edit in all three files — the `query` step's config becomes:

```yaml
      config:
        filters:
          guid:
            op: eq
            value: steps.prep.guid
          userId:
            op: eq
            value: user.id
        filterLogic: and
        pageSize: 1
        schemaId: $schema:reader_items
        condition: steps.prep.hasGuid
```

Leave the `update` steps untouched. They set `recordId`, and `data_update` ignores `filters` when `recordId` is present — a `userId` filter there would be dead code that reads as protection.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib/scoping.test.ts
git commit -m "feat(reader): scope item read/star/archive lookups to the caller"
```

---

### Task 6: Scope the two filter-based mutations

`POST /api/items/delete` is the highest-risk rule in the change: it hard-deletes by raw `guid` filter with no ownership lookup at all. `POST /api/items/read-all` has four `data_update` branches plus a feed lookup.

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/delete/post/rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/items/read-all/post/rule.yaml`
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: the filter block from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Remove this task's entries from the ratchet**

Delete the six `'api/items/delete/post:del'` and `'api/items/read-all/post:…'` lines and the `// Task 6` comment.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: FAIL listing six extra unscoped keys.

- [ ] **Step 3: Scope `POST /api/items/delete`**

The `del` step's config becomes:

```yaml
      config:
        filters:
          guid:
            op: eq
            value: steps.prep.guid
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        condition: steps.prep.hasGuid
```

- [ ] **Step 4: Scope `POST /api/items/read-all`**

`folderFeeds` gains a `filters` block (it currently has none):

```yaml
    - id: folderFeeds
      name: folderFeeds
      handler: data_query
      config:
        limit: 500
        filters:
          userId:
            op: eq
            value: user.id
        schemaId: $schema:reader_feeds
        condition: steps.prep.hasFolder
```

`updAll` currently has one filter and no `filterLogic`, so it needs both:

```yaml
      config:
        fields:
          read: steps.prep.yes
        filters:
          read:
            op: eq
            value: false
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        condition: steps.prep.isAllOrRiver
```

`updStarred`, `updFeed` and `updFolder` already declare `filterLogic: and`; add only the filter block to each:

```yaml
          userId:
            op: eq
            value: user.id
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/reader && pnpm test:run src/lib/scoping.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib/scoping.test.ts
git commit -m "feat(reader): scope item delete and mark-all-read to the caller"
```

---

### Task 7: Scope the feed mutations and switch add-feed dedup

`POST /api/feeds` moves its dedup from the globally-unique `url` to the per-user `scopedUrl`, so two users can subscribe to the same feed.

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/feeds/post/prep.fn.js`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/feeds/post/rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/feeds/remove/post/rule.yaml`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/feeds/folder/post/rule.yaml`
- Test: `apps/reader/src/lib/feedPrep.test.ts` (create)
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: `reader_feeds.userId` / `scopedUrl` from Task 1.
- Produces: `prep.fn.js` returns `{ feeds: [{ userId, scopedUrl, url, title, siteUrl, folder, addedAt }], hasUrl, noUrl }`. The scoped-key format `userId + '::' + value` is reused verbatim by Task 8.

- [ ] **Step 1: Write the failing test**

Create `apps/reader/src/lib/feedPrep.test.ts`:

```ts
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')
const prepSource = readFileSync(resolve(setRoot, 'rules/api/feeds/post/prep.fn.js'), 'utf8')
const addRule = parse(
  readFileSync(resolve(setRoot, 'rules/api/feeds/post/rule.yaml'), 'utf8'),
) as { pipeline?: { steps?: Array<{ id: string; config?: Record<string, unknown> }> } }

type PrepOut = {
  feeds: Array<{ userId: string; scopedUrl: string; url: string; folder: string | null }>
  hasUrl: boolean
  noUrl: boolean
}
type PrepHandler = (arg: {
  user?: { id: string }
  request: { body: Record<string, unknown> }
}) => PrepOut

const prep = new Function('return (' + prepSource + ')')() as PrepHandler

describe('add-feed prep — per-user scoping', () => {
  it('stamps the caller as owner and builds a per-user dedup key', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: { url: 'https://a.com/f.xml' } } })
    expect(out.feeds[0].userId).toBe('u1')
    expect(out.feeds[0].scopedUrl).toBe('u1::https://a.com/f.xml')
    expect(out.feeds[0].url).toBe('https://a.com/f.xml')
    expect(out.hasUrl).toBe(true)
  })

  it('gives two users distinct dedup keys for the same feed', () => {
    const a = prep({ user: { id: 'u1' }, request: { body: { url: 'https://a.com/f.xml' } } })
    const b = prep({ user: { id: 'u2' }, request: { body: { url: 'https://a.com/f.xml' } } })
    expect(a.feeds[0].scopedUrl).not.toBe(b.feeds[0].scopedUrl)
  })

  it('rejects a userless call rather than writing an unowned row', () => {
    const out = prep({ request: { body: { url: 'https://a.com/f.xml' } } })
    expect(out.hasUrl).toBe(false)
    expect(out.noUrl).toBe(true)
  })

  it('still rejects a missing url', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: {} } })
    expect(out.hasUrl).toBe(false)
    expect(out.noUrl).toBe(true)
  })

  it('preserves existing folder normalisation', () => {
    const out = prep({ user: { id: 'u1' }, request: { body: { url: 'u', folder: '' } } })
    expect(out.feeds[0].folder).toBeNull()
  })

  it('the upsert step dedups on scopedUrl, not url', () => {
    const upsert = addRule.pipeline?.steps?.find((s) => s.id === 'upsert')
    expect(upsert?.config?.dedupField).toBe('scopedUrl')
    expect(upsert?.config?.dedupKey).toBe('steps.item.scopedUrl')
    expect((upsert?.config?.map as Record<string, unknown>).userId).toBe('steps.item.userId')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/reader && pnpm test:run src/lib/feedPrep.test.ts`
Expected: FAIL — `expected undefined to be 'u1'`

- [ ] **Step 3: Rewrite `feeds/post/prep.fn.js`**

```js
function handler({ user, request }) {
  var b = (request && request.body) || {}
  var uid = (user && user.id) ? String(user.id) : ''
  var url = (typeof b.url === 'string') ? b.url.trim() : ''
  var ok = !!(url && uid)
  var feed = {
    userId: uid,
    scopedUrl: uid + '::' + url,
    url: url,
    title: (typeof b.title === 'string') ? b.title : '',
    siteUrl: (typeof b.siteUrl === 'string') ? b.siteUrl : '',
    folder: (b.folder != null && b.folder !== '') ? String(b.folder) : null,
    addedAt: Number(b.addedAt) || 0
  }
  return {
    feeds: [feed],
    hasUrl: ok,
    noUrl: !ok
  }
}
```

- [ ] **Step 4: Rewire the `upsert` step in `feeds/post/rule.yaml`**

```yaml
      config:
        map:
          url: steps.item.url
          title: steps.item.title
          folder: steps.item.folder
          userId: steps.item.userId
          addedAt: steps.item.addedAt
          siteUrl: steps.item.siteUrl
        items: steps.prep.feeds
        dedupKey: steps.item.scopedUrl
        schemaId: $schema:reader_feeds
        condition: steps.prep.hasUrl
        dedupField: scopedUrl
```

`scopedUrl` is deliberately absent from `map` — `data_upsert_many` writes the resolved dedup value into that column itself.

- [ ] **Step 5: Scope `POST /api/feeds/remove`**

Two steps. `query`:

```yaml
      config:
        filters:
          url:
            op: eq
            value: request.body.url
          userId:
            op: eq
            value: user.id
        filterLogic: and
        pageSize: 1
        schemaId: $schema:reader_feeds
```

`delItems` (already has `filterLogic: and`, add the filter):

```yaml
      config:
        filters:
          feedId:
            op: eq
            value: request.body.url
          starred:
            op: ne
            value: true
          userId:
            op: eq
            value: user.id
        filterLogic: and
        schemaId: $schema:reader_items
        condition: steps.pick.found
```

- [ ] **Step 6: Scope `POST /api/feeds/folder`**

The `query` step:

```yaml
      config:
        filters:
          url:
            op: eq
            value: steps.prep.url
          userId:
            op: eq
            value: user.id
        filterLogic: and
        pageSize: 1
        schemaId: $schema:reader_feeds
        condition: steps.prep.hasUrl
```

- [ ] **Step 7: Remove this task's entries from the ratchet**

Delete the four `'api/feeds/…'` lines and the `// Task 7` comment from `EXPECTED_UNSCOPED`.

- [ ] **Step 8: Run all tests to verify they pass**

Run: `cd apps/reader && pnpm test:run`
Expected: PASS. `scoping.test.ts` 6 tests, `feedPrep.test.ts` 6 tests, existing suites unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib
git commit -m "feat(reader): scope feed add/remove/folder and dedup feeds per user"
```

---

### Task 8: Fan the cron refresh out to every subscriber

The refresh runs userless, so ownership comes from the feed rows. `urls.fn.js` dedupes so each feed is fetched once; `enrich.fn.js` fans each parsed entry out to one record per subscriber.

**Files:**
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/refresh/post/urls.fn.js`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/refresh/post/enrich.fn.js`
- Modify: `apps/reader/.bffless/proxy-rules/reader/rules/api/refresh/post/rule.yaml`
- Test: `apps/reader/src/lib/refreshFanout.test.ts` (create)
- Modify: `apps/reader/src/lib/enrich.test.ts`
- Modify: `apps/reader/src/lib/scoping.test.ts`

**Interfaces:**
- Consumes: `reader_feeds.userId` (Task 1), the `userId + '::' + value` key format (Task 7).
- Produces: `enrich.fn.js` returns `{ entries: [...] }` where each entry additionally carries `userId: string` and `scopedGuid: string`. `urls.fn.js` keeps returning `{ urls: string[], count: number }`, now deduped.

**Note on the existing `enrich.test.ts`:** its `run()` helper calls `enrich({ steps: { parse, stamp } })` with no `feeds`. After this change an entry with no matching subscriber produces **no** output rows, so every existing assertion would see an empty array. Step 5 updates that helper; do not skip it.

- [ ] **Step 1: Write the failing test**

Create `apps/reader/src/lib/refreshFanout.test.ts`:

```ts
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const setRoot = resolve(process.cwd(), '.bffless/proxy-rules/reader')
const urlsSource = readFileSync(resolve(setRoot, 'rules/api/refresh/post/urls.fn.js'), 'utf8')
const enrichSource = readFileSync(resolve(setRoot, 'rules/api/refresh/post/enrich.fn.js'), 'utf8')
const refreshRule = parse(
  readFileSync(resolve(setRoot, 'rules/api/refresh/post/rule.yaml'), 'utf8'),
) as { pipeline?: { steps?: Array<{ id: string; config?: Record<string, unknown> }> } }

type Feed = { url?: string; userId?: string }
type Entry = { source?: string; guid?: string; link?: string; title?: string; publishedAt?: string }
type Enriched = { userId: string; scopedGuid: string; guid?: string; source?: string }

const urls = new Function('return (' + urlsSource + ')')() as (a: {
  steps: { feeds: Feed[] }
}) => { urls: string[]; count: number }

const enrich = new Function('return (' + enrichSource + ')')() as (a: {
  steps: { feeds: Feed[]; parse: { entries: Entry[] }; stamp: { ms: number } }
}) => { entries: Enriched[] }

function fanout(feeds: Feed[], entries: Entry[]) {
  return enrich({ steps: { feeds, parse: { entries }, stamp: { ms: 0 } } }).entries
}

describe('urls handler — dedupe', () => {
  it('fetches a shared feed once no matter how many subscribers', () => {
    const out = urls({
      steps: {
        feeds: [
          { url: 'https://a.com/f.xml', userId: 'u1' },
          { url: 'https://a.com/f.xml', userId: 'u2' },
          { url: 'https://b.com/f.xml', userId: 'u2' },
        ],
      },
    })
    expect(out.urls).toEqual(['https://a.com/f.xml', 'https://b.com/f.xml'])
    expect(out.count).toBe(2)
  })

  it('skips rows with no url', () => {
    const out = urls({ steps: { feeds: [{ userId: 'u1' }, { url: '', userId: 'u1' }] } })
    expect(out.urls).toEqual([])
    expect(out.count).toBe(0)
  })
})

describe('enrich handler — per-subscriber fan-out', () => {
  it('emits one row per subscriber of the entry source', () => {
    const out = fanout(
      [
        { url: 'https://a.com/f.xml', userId: 'u1' },
        { url: 'https://a.com/f.xml', userId: 'u2' },
      ],
      [{ source: 'https://a.com/f.xml', guid: 'g1' }],
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.userId).sort()).toEqual(['u1', 'u2'])
  })

  it('gives each subscriber a distinct dedup key for the same entry', () => {
    const out = fanout(
      [
        { url: 'https://a.com/f.xml', userId: 'u1' },
        { url: 'https://a.com/f.xml', userId: 'u2' },
      ],
      [{ source: 'https://a.com/f.xml', guid: 'g1' }],
    )
    expect(out[0].scopedGuid).not.toBe(out[1].scopedGuid)
    expect(out.map((r) => r.scopedGuid).sort()).toEqual(['u1::g1', 'u2::g1'])
  })

  it('keeps the raw guid intact alongside the scoped key', () => {
    const out = fanout([{ url: 'f', userId: 'u1' }], [{ source: 'f', guid: 'g1' }])
    expect(out[0].guid).toBe('g1')
  })

  it('falls back to link, then to a synthesised key, when guid is absent', () => {
    const byLink = fanout([{ url: 'f', userId: 'u1' }], [{ source: 'f', link: 'L' }])
    expect(byLink[0].scopedGuid).toBe('u1::L')
    const byHash = fanout(
      [{ url: 'f', userId: 'u1' }],
      [{ source: 'f', title: 'T', publishedAt: '2026-01-01T00:00:00.000Z' }],
    )
    expect(byHash[0].scopedGuid).toBe('u1::f|T|2026-01-01T00:00:00.000Z')
  })

  it('drops entries whose feed has no subscriber', () => {
    const out = fanout([{ url: 'https://a.com/f.xml', userId: 'u1' }], [{ source: 'https://other.com/f.xml', guid: 'g' }])
    expect(out).toEqual([])
  })

  it('ignores feed rows with no owner', () => {
    const out = fanout([{ url: 'f' }], [{ source: 'f', guid: 'g' }])
    expect(out).toEqual([])
  })

  it('the upsert step dedups on scopedGuid and maps the owner', () => {
    const upsert = refreshRule.pipeline?.steps?.find((s) => s.id === 'upsert')
    expect(upsert?.config?.dedupField).toBe('scopedGuid')
    expect(upsert?.config?.dedupKey).toBe('steps.item.scopedGuid')
    expect((upsert?.config?.map as Record<string, unknown>).userId).toBe('steps.item.userId')
    expect(upsert?.config?.updateFields).not.toContain('scopedGuid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/reader && pnpm test:run src/lib/refreshFanout.test.ts`
Expected: FAIL — the dedupe test reports three urls, the fan-out tests report `undefined` userIds.

- [ ] **Step 3: Rewrite `urls.fn.js`**

```js
function handler({ steps }) {
  var rows = (steps && steps.feeds) || []
  var out = []
  // '#'-prefixed keys keep feed URLs off Object.prototype (ES5 sandbox: no Set/Map).
  var seen = {}
  for (var i = 0; i < rows.length; i++) {
    var u = rows[i] && rows[i].url
    if (typeof u !== 'string' || !u) continue
    if (seen['#' + u]) continue
    seen['#' + u] = true
    out.push(u)
  }
  return { urls: out, count: out.length }
}
```

- [ ] **Step 4: Rewrite `enrich.fn.js`**

```js
function handler({ steps }) {
  var feeds = (steps && steps.feeds) || []
  var entries = (steps && steps.parse && steps.parse.entries) || []
  var nowMs = (steps && steps.stamp && steps.stamp.ms) || 0
  var nowIso = new Date(nowMs).toISOString()

  // feed url -> owning userIds. One parsed entry becomes one row per subscriber,
  // because the cron runs userless and ownership can only come from the feed rows.
  // '#'-prefixed keys keep feed URLs off Object.prototype (ES5 sandbox: no Map).
  var subs = {}
  for (var f = 0; f < feeds.length; f++) {
    var row = feeds[f] || {}
    var fu = row.url
    var owner = row.userId
    if (typeof fu !== 'string' || !fu) continue
    if (typeof owner !== 'string' || !owner) continue
    var k = '#' + fu
    if (!subs[k]) subs[k] = []
    if (subs[k].indexOf(owner) === -1) subs[k].push(owner)
  }

  var out = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i] || {}
    var pub = e.publishedAt
    if (pub) { var d = new Date(pub); if (isNaN(d.getTime())) pub = '' }
    if (!pub) pub = nowIso
    var encType = null
    var encUrl = null
    var encs = e.enclosures
    if (encs && encs.length) {
      for (var j = 0; j < encs.length; j++) {
        var en = encs[j]
        if (en && typeof en.type === 'string' && en.type.indexOf('text/') === 0) {
          encType = en.type
          encUrl = (en.url != null) ? en.url : null
          break
        }
      }
    }
    // D8's dedup chain, resolved here now that the key must also carry the owner.
    var key = e.guid || e.link || (String(e.source) + '|' + String(e.title) + '|' + pub)
    var owners = subs['#' + e.source] || []
    for (var o = 0; o < owners.length; o++) {
      out.push({
        userId: owners[o],
        scopedGuid: owners[o] + '::' + key,
        source: e.source,
        guid: e.guid,
        title: e.title,
        link: e.link,
        author: e.author,
        content: e.content,
        summary: e.summary,
        publishedAt: pub,
        enclosureType: encType,
        enclosureUrl: encUrl
      })
    }
  }
  return { entries: out }
}
```

- [ ] **Step 5: Update the existing `enrich.test.ts` helper**

In `apps/reader/src/lib/enrich.test.ts`, the `run()` helper must supply a subscriber, or every existing assertion sees an empty array. Replace the `EnrichHandler` type and `run` function with:

```ts
type EnrichHandler = (arg: {
  steps: {
    feeds: Array<{ url?: string; userId?: string }>
    parse: { entries: Entry[] }
    stamp: { ms: number }
  }
}) => EnrichOut

const enrich = new Function('return (' + enrichSource + ')')() as EnrichHandler

// Every entry these tests feed in uses the default source below, owned by one
// user, so the fan-out is 1:1 and the original enclosure assertions still hold.
function run(entries: Entry[], nowMs = 0): EnrichOut {
  const sources = entries.map((e) => e.source ?? 'https://feed.test/f.xml')
  const withSource = entries.map((e, i) => ({ ...e, source: sources[i] }))
  const feeds = sources.map((url) => ({ url, userId: 'u1' }))
  return enrich({ steps: { feeds, parse: { entries: withSource }, stamp: { ms: nowMs } } })
}
```

- [ ] **Step 6: Rewire the `upsert` step in `refresh/post/rule.yaml`**

```yaml
      config:
        map:
          guid: steps.item.guid
          link: steps.item.link
          read: false
          userId: steps.item.userId
          archived: false
          title: steps.item.title
          author: steps.item.author
          feedId: steps.item.source
          content: steps.item.content
          starred: false
          summary: steps.item.summary
          fetchedAt: steps.stamp.ms
          publishedAt: steps.item.publishedAt
          enclosureType: steps.item.enclosureType
          enclosureUrl: steps.item.enclosureUrl
        items: steps.enrich.entries
        dedupKey: steps.item.scopedGuid
        schemaId: $schema:reader_items
        condition: steps.urls.count
        dedupField: scopedGuid
        updateFields:
          - enclosureType
          - enclosureUrl
```

- [ ] **Step 7: Raise the feeds ceiling**

In the same file, the `feeds` step's `limit` becomes a ceiling shared across all users. Change `limit: 500` to `limit: 2000`. Leave the step unscoped — the cron must read every user's feeds, and `user.id` is null here.

- [ ] **Step 8: Remove this task's entry from the ratchet**

Delete `'api/refresh/post:upsert',` and the `// Task 8` comment. `EXPECTED_UNSCOPED` now contains exactly the two system-run steps.

- [ ] **Step 9: Run the whole suite**

Run: `cd apps/reader && pnpm test:run`
Expected: PASS across all files. `scoping.test.ts` now asserts only `api/refresh/post:feeds` and `api/prune/post:del` are unscoped — the scoping work is provably complete.

- [ ] **Step 10: Commit**

```bash
git add apps/reader/.bffless/proxy-rules/reader apps/reader/src/lib
git commit -m "feat(reader): fan cron refresh out to every subscriber, dedup items per user"
```

---

### Task 9: Verify the built rule set

`npx bffless rules build` compiles the authored tree into the import JSON. If a `$schema:` reference or a `.fn.js` path broke, this is where it surfaces — before anything touches the live project.

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the complete rule set from Tasks 1–8.
- Produces: a verified build; nothing committed.

- [ ] **Step 1: Build the set**

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/reader-per-user-scoping
npx bffless rules build apps/reader/.bffless/proxy-rules/reader -o /tmp/reader.proxy-rules.json
```
Expected: exits 0.

- [ ] **Step 2: Confirm the new columns and dedup fields made it into the build**

```bash
grep -c '"userId"' /tmp/reader.proxy-rules.json
grep -o '"dedupField":"[^"]*"' /tmp/reader.proxy-rules.json | sort | uniq -c
```
Expected: `userId` appears many times; `dedupField` shows only `scopedUrl` and `scopedGuid` — no remaining `url` or `guid`.

- [ ] **Step 3: Diff against live to preview the deploy**

```bash
npx bffless rules diff
```
Expected: a diff limited to the reader set — the four new schema fields, the added `userId` filters, and the two `dedupField` changes. **Read it.** Anything touching handoff or studio means the wrong set was edited; stop and investigate.

- [ ] **Step 4: Record the result**

No commit. Report the `dedupField` counts and a summary of the diff in the task handoff.

---

### Task 10: Update the docs

**Files:**
- Modify: `apps/reader/bffless/README.md`
- Modify: `apps/reader/CONTEXT.md`

**Interfaces:**
- Consumes: the finished implementation.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the Data tables section of `apps/reader/bffless/README.md`**

Replace the two schema bullets with:

```markdown
- **`reader_feeds`** — `userId` (owner), `scopedUrl` (dedup key, `userId::url`), `url`, `title`,
  `siteUrl`, `folder` (nullable), `iconUrl`, `lastFetchedAt`, `lastError`, `addedAt`.
- **`reader_items`** — `userId` (owner), `scopedGuid` (dedup key, `userId::guid`), `guid` (the feed's
  own guid), `feedId` (the owning feed's `url`, = `xml_feed_parse` `entry.source`), `title`, `link`,
  `author`, `publishedAt` (feed timestamp, ISO string), `summary`, `content`, `enclosureType` /
  `enclosureUrl`, `read`, `starred`, `archived`, `fetchedAt` (numeric epoch-ms).
```

Then add this subsection immediately after the Data tables section:

```markdown
### Multi-user

Rivulet is multi-user: every row carries the owning `userId`, and every data-access step in the rule
set filters on `user.id`. Two exceptions run as *userless* system context, fired by a
`pipeline_schedule`:

- `/api/refresh` step `feeds` reads **every** user's feeds — the cron ingests on everyone's behalf.
  `enrich.fn.js` then fans each parsed entry out to one row per subscriber of that feed URL, so a feed
  shared by N users is fetched once and stored N times.
- `/api/prune` step `del` filters each row's own `read` / `starred` / `archived` / `fetchedAt`, which
  is already correct per-user.

Dedup is per-user by construction: `data_upsert_many` dedups on a single column, so the synthetic
`scopedUrl` / `scopedGuid` columns carry `userId::<natural key>`. Without them the second user to
subscribe to a shared feed would have their whole ingest skipped as duplicate.

Access is gated at the alias: `requiredRole: guest` on the `reader` and `reader-preview` aliases means
a user must be signed in **and** explicitly added to the project, while CE keeps `guest` memberships
out of the admin backend.

`apps/reader/src/lib/scoping.test.ts` is the guard — it walks every rule and fails if any data-access
step loses its `userId` filter, or if a multi-filter step forgets `filterLogic: and`.
```

- [ ] **Step 2: Supersede D1 in `apps/reader/CONTEXT.md`**

Change the D1 bullet to:

```markdown
- **D1** — ~~Personal reader, **single-user per deploy**. No accounts/follow-graph.~~ **Superseded by
  D15.** Social/follow-graph remains deferred.
```

Add to the end of the decisions log:

```markdown
- **D15** — **Multi-user via copy-per-user** (supersedes D1). Every `reader_feeds` / `reader_items`
  row carries a `userId`; every data-access step filters `userId eq user.id`; the userless cron
  refresh derives ownership from the feed row and fans each entry out to one row per subscriber.
  Dedup moves to synthetic `scopedUrl` / `scopedGuid` columns (`userId::<natural key>`) because
  `data_upsert_many` dedups on a single column — without this the second subscriber to a shared feed
  gets an empty reader. Access is `requiredRole: guest` on the reader aliases: signed in **and**
  explicitly added to the project, with no admin-backend visibility. Rejected: shared feed/item rows
  with a per-user state join table — cheaper at scale, but needs a third schema and a join
  `data_query` can't express in one step. Chosen for give-away-app scale; cheap now, expensive to
  unwind later. Design: `docs/superpowers/specs/2026-08-02-reader-per-user-scoping-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add apps/reader/bffless/README.md apps/reader/CONTEXT.md
git commit -m "docs(reader): document per-user scoping, supersede D1 with D15"
```

---

### Task 11: Live rollout runbook — OPERATOR ONLY

**Do not execute any part of this task autonomously.** It mutates live data and live access control on `reader.j5s.dev`. Per the workspace rules, irreversible or high-stakes actions get confirmed first. Present this runbook, get explicit go-ahead per step, and run the steps in order.

**The order is load-bearing.** Step 4 before step 3 drops a guest into the owner's data. Step 3 before step 2 blanks the owner's reader.

- [ ] **Step 1: Deploy the schema fields only**

The four new columns are additive and no live rule references them yet, so this is safe on its own and makes the backfill possible. Push the schemas ahead of the rules, or accept that steps 1–3 land together and run the backfill immediately after (the window where the owner's reader looks empty is the gap between rule deploy and backfill completion — keep it short).

- [ ] **Step 2: Resolve the owner's user id and count the rows**

Using the BFFless MCP against `bffless/apps`:

```
list_users                          -> id for james.charlesworth@gmail.com
query_pipeline_data(reader_feeds)   -> row count
query_pipeline_data(reader_items)   -> row count
```

Record all three. The item count decides whether the backfill is a handful of calls or needs batching.

- [ ] **Step 3: Backfill every existing row**

For each `reader_feeds` row: set `userId = <owner id>` and `scopedUrl = "<owner id>::" + url`.
For each `reader_items` row: set `userId = <owner id>` and `scopedGuid = "<owner id>::" + (guid || link)`.

Use `update_pipeline_record` per row. **Do one row of each schema first and re-read it** before doing the rest.

`scopedGuid` cannot be skipped: dedup matches on it, so any still-live item whose row lacks it will not match on the next poll and will insert a duplicate — one per active item.

- [ ] **Step 4: Deploy the scoped rule set**

```bash
npx bffless rules diff    # re-read it; it should match Task 9's diff
npx bffless rules push apps/reader/.bffless/proxy-rules/reader
```

- [ ] **Step 5: Verify as the owner before opening the gate**

Load `reader.j5s.dev` signed in as the owner. Every feed, folder, unread count and starred item must look exactly as before. If anything is missing, the backfill is incomplete — fix it before step 6. The gate is still admin-only at this point, so there is no exposure while you debug.

- [ ] **Step 6: Lower the gate**

In `admin.j5s.dev` → project `bffless/apps` → Aliases → `reader` → Update Alias → **Required Role: Guest**. Repeat for `reader-preview`. Leave `handoff`, `handoff-preview`, `studio`, `studio-preview` untouched.

- [ ] **Step 7: Verify isolation with a second account**

Add a second account to the project as `guest` (a `project_invite_links` link defaults to that role). Then, signed in as that account:

1. The reader loads and is **empty** — no feeds, no items.
2. Add a feed the owner also has. It appears, and ingests items on the next refresh (or via "Refresh now"). The owner's copy is unaffected. *This is the test that proves the dedup fix works — before this change the second subscriber would have got nothing.*
3. Star and mark-read items. Confirm as the owner that their own read/star state did not move.
4. **The sharp case:** as the second user, `POST /api/items/delete` with a `guid` taken from a feed only the owner subscribes to. Expect `{"ok":true,"deleted":0}` and confirm the owner's row survives.

- [ ] **Step 8: Confirm the cron**

Wait for one 15-minute refresh cycle (or trigger it), then confirm both accounts received new items and that no duplicates appeared for the owner.

---

### Task 12: File the CE follow-ups

Three CE gaps this change worked around. None block anything; filing them is the "enhancing CE is first-class" step.

**Files:**
- No repo changes. Issues in `bffless/ce`.

- [ ] **Step 1: File composite dedup keys**

```bash
gh issue create --repo bffless/ce \
  --title "data_upsert_many: support a composite dedupField" \
  --body "\`dedupField\` takes a single column, so multi-tenant callers must invent a synthetic column holding \`ownerId::naturalKey\`. Rivulet does exactly this (\`scopedUrl\`, \`scopedGuid\`) for its per-user scoping work in bffless/apps. Accepting an array of columns would remove the synthetic column and the string-concat in the enrich step. The next multi-user BFFless app hits the same wall."
```

- [ ] **Step 2: File run-as identity for schedules**

```bash
gh issue create --repo bffless/ce \
  --title "pipeline_schedules: allow a run-as user for scheduled runs" \
  --body "A schedule fires its target as a userless system run, so \`context.user\` is absent: \`auth_required\` rejects it and \`user.id\` is null in expressions. Rivulet's /api/refresh and /api/prune therefore drop \`auth_required\` and derive ownership from feed rows instead. An optional run-as user on the schedule would let scheduled pipelines use the same validators and expressions as HTTP ones."
```

- [ ] **Step 3: File the dead flag**

```bash
gh issue create --repo bffless/ce \
  --title "auth_required: allowApiKey is declared but never read" \
  --body "\`AuthRequiredConfig.allowApiKey\` is declared at apps/backend/src/pipelines/types.ts:22 and set by upload-schema-generator.service.ts:252, but nothing reads it — \`AuthRequiredValidator.validate\` only checks \`context.user\` and \`config.roles\`. API-key requests already authenticate via \`getOptionalUser\` -> \`tryApiKeyAuth\` regardless of the flag. Either honour it or drop it; as-is it reads as protection that isn't there."
```

- [ ] **Step 4: Record the issue numbers**

Add them to the CE follow-ups section of the design spec and commit.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Access control (`guest` on both aliases) | 11 step 6 |
| Schema changes | 1 |
| Rule scoping (12 rules) | 3, 4, 5, 6, 7 |
| Refresh fan-out + dedupe + limit | 8 |
| Migration order + backfill | 11 steps 1–5 |
| Frontend (no changes) | none needed — verified in 11 step 5 |
| Testing (unit / structural / live isolation) | 7, 8 / 2 / 11 step 7 |
| CE follow-ups | 12 |
| Out of scope | not implemented |

**Placeholder scan:** none. Every code step carries the actual file content; every test step carries runnable assertions.

**Type consistency:** `EXPECTED_UNSCOPED`, `isScoped`, `dataSteps` and the `"<rule dir>:<step id>"` key format are defined in Task 2 and used unchanged in 3–8. The `userId + '::' + value` key format is defined in Task 7 (`scopedUrl`) and reused in Task 8 (`scopedGuid`). `enrich.fn.js`'s output gains `userId` and `scopedGuid`, which Task 8's rule wiring consumes as `steps.item.userId` / `steps.item.scopedGuid`.

**Known ordering hazard:** Task 8 step 5 must update the existing `enrich.test.ts` helper. Skipping it leaves that file failing with empty-array assertions that look like a fan-out bug rather than a stale test.

**Ratchet arithmetic:** the set has 37 data-access steps — 32 that must gain a `userId` filter or map entry, plus 5 that act on a `recordId` and are scoped by their paired `query`. `EXPECTED_UNSCOPED` therefore starts at 32 entries and ends at 2 (`api/refresh/post:feeds`, `api/prune/post:del`). If the arithmetic stops adding up mid-plan, a step was scoped without being removed from the list, or vice versa.
