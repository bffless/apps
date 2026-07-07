# Content Title & Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Handoff user attach an optional Title + Description to any File/Site from the viewer, and surface both in the RSS feed item's `<title>`/`<description>`.

**Architecture:** Two nullable fields (`title`, `description`) on the leaf node record (schemaless data table — no CE migration). Title is an *additive display override* (feed + viewer only; the filename stays the node's identity). Description is plain text rendered into the feed `<description>`. Writes go through a new `PATCH /api/node/meta` pipeline that reuses the DELETE handler's `edit`-gate; the feed logic is updated in all copies (reference `feed.ts` + the two embedded `/feed.xml` & `/feed/*` pipeline ports), kept in parity by `feedRule.test.ts`.

**Tech Stack:** React 18 + TypeScript + Vite, Redux Toolkit / RTK Query, MSW mocks, Vitest, BFFless proxy-rule pipelines (embedded `function_handler` JS in `bffless/handoff.proxy-rules.json`).

## Global Constraints

- Work in the existing worktree `/home/rico/bffless/repos/apps-handoff-meta` on branch `feat/handoff-content-title-description`. Never switch the shared `repos/apps` checkout's branch.
- All commands run from `apps/handoff/` unless stated. Monorepo test cmd: `pnpm --filter handoff test` (or `pnpm test` inside `apps/handoff`).
- **Mock == real seam:** every client-visible field flows through `toNode()` (`src/lib/nodes.ts`); MSW handlers (`src/mocks/handlers.ts`) and the live pipeline must return the same shape. Any node-field change touches both.
- **Feed logic is quadruplicated** and MUST stay behaviorally identical: `src/lib/feed.ts` (reference), the `select` handler in the `/feed.xml` rule, the `select` handler in the `/feed/*` rule, and the live BFFless rules. The first three live in-repo; `feedRule.test.ts` pins reference↔pipeline parity. Live rules are synced via MCP post-merge (Task 8).
- **`data_update` clobbers concurrent same-record writes** (apps#194): the metadata write is a single isolated update of only the provided fields — never `Promise.all` it with another write to the same node.
- Node data-table schemaId: `1c5d4802-596e-4f50-a08f-c41fb8f9fab0`.
- Field caps: `title` ≤ 200 chars, `description` ≤ 2000 chars. Empty string clears the field to `null`.
- After any edit to `bffless/handoff.proxy-rules.json`, verify it still parses: `node -e "JSON.parse(require('fs').readFileSync('bffless/handoff.proxy-rules.json','utf8'));console.log('ok')"`.

---

### Task 1: Data model — `title`/`description` on `HandoffNode`

**Files:**
- Modify: `src/lib/nodes.ts`
- Test: `src/lib/nodes.test.ts`

**Interfaces:**
- Produces: `HandoffNode.title: string | null`, `HandoffNode.description: string | null`. `toNode()` coerces both (string-or-null; `title` trimmed to `null` when blank; `description` kept as-is when a string, else `null`).

- [ ] **Step 1: Write the failing test.** Add to `src/lib/nodes.test.ts`:

```ts
describe('toNode title/description', () => {
  it('coerces title and description from strings', () => {
    const n = toNode({ id: 'x', type: 'file', title: 'My Deck', description: 'line1\nline2' })
    expect(n.title).toBe('My Deck')
    expect(n.description).toBe('line1\nline2')
  })

  it('defaults missing/blank title and missing description to null', () => {
    expect(toNode({ id: 'x' }).title).toBeNull()
    expect(toNode({ id: 'x' }).description).toBeNull()
    expect(toNode({ id: 'x', title: '   ' }).title).toBeNull()
  })

  it('ignores non-string title/description', () => {
    const n = toNode({ id: 'x', title: 42, description: { bad: true } })
    expect(n.title).toBeNull()
    expect(n.description).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/lib/nodes.test.ts`
Expected: FAIL — `title`/`description` are not on the returned object.

- [ ] **Step 3: Add the fields to the interface.** In `src/lib/nodes.ts`, in `interface HandoffNode`, after the `mode` field (line ~33) add:

```ts
  /** Display-title override; null → fall back to the filename (`name`). */
  title: string | null
  /** Plain-text, multi-line note; null → none. Surfaced in the feed <description>. */
  description: string | null
```

- [ ] **Step 4: Coerce in `toNode`.** In `toNode()`, just before the final `return { ... }` (line ~139), add:

```ts
  // title: trimmed string, else null
  const rawTitle = obj['title']
  const trimmedTitle = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  const title = trimmedTitle || null

  // description: string, else null
  const rawDescription = obj['description']
  const description = typeof rawDescription === 'string' ? rawDescription : null
```

Then add `title, description` to the returned object literal:

```ts
  return { id, type, name, mime, size, url, storageKey, path, parentId, createdAt, ownerId, grants, mode, title, description }
```

- [ ] **Step 5: Run test to verify it passes.**

Run: `pnpm test -- src/lib/nodes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/nodes.ts src/lib/nodes.test.ts
git commit -m "feat(handoff): title/description fields on HandoffNode"
```

---

### Task 2: Feed reference impl — title override + description body

**Files:**
- Modify: `src/lib/feed.ts`
- Test: `src/lib/feed.test.ts`

**Interfaces:**
- Consumes: `HandoffNode.title`, `HandoffNode.description` (Task 1).
- Produces: `FeedItem.title: string | null`, `FeedItem.description: string | null`; `renderFeedXml` uses `title || name` for `<item><title>` and renders `description` as a leading `<p>` (newlines → `<br>`) inside the `<description>`.

- [ ] **Step 1: Write the failing tests.** Add to `src/lib/feed.test.ts`:

```ts
import { selectFeedItems, renderFeedXml } from './feed'
import type { HandoffNode } from './nodes'

function fileNode(over: Partial<HandoffNode>): HandoffNode {
  return {
    id: 'id1', type: 'file', name: 'a.png', mime: 'image/png', size: 10,
    url: null, storageKey: null, path: 'a.png', parentId: 'root', createdAt: 1,
    ownerId: null, grants: [], mode: 'inheriting', title: null, description: null, ...over,
  }
}
const ctx = { origin: 'https://h.test', title: 'My Files', description: 'd', folderPath: '' }

describe('feed title/description', () => {
  it('carries title/description onto items', () => {
    const [it] = selectFeedItems([fileNode({ title: 'T', description: 'D' })])
    expect(it.title).toBe('T')
    expect(it.description).toBe('D')
  })

  it('item <title> uses title, falling back to filename', () => {
    const withT = renderFeedXml(selectFeedItems([fileNode({ title: 'My Deck' })]), ctx)
    expect(withT).toContain('<title>My Deck</title>')
    const noT = renderFeedXml(selectFeedItems([fileNode({ name: 'a.png' })]), ctx)
    expect(noT).toContain('<title>a.png</title>')
  })

  it('image description renders above the inline img, escaped, newlines to <br>', () => {
    const xml = renderFeedXml(selectFeedItems([fileNode({ description: 'a & b\nc' })]), ctx)
    expect(xml).toContain('<description><![CDATA[<p>a &amp; b<br>c</p><p><img')
    expect(xml).toContain('<media:thumbnail')
  })

  it('non-image with description uses a CDATA note; without one keeps name (size)', () => {
    const withD = renderFeedXml(selectFeedItems([fileNode({ mime: 'text/plain', name: 'n.txt', size: 2048, description: 'note' })]), ctx)
    expect(withD).toContain('<description><![CDATA[<p>note</p>]]></description>')
    const noD = renderFeedXml(selectFeedItems([fileNode({ mime: 'text/plain', name: 'n.txt', size: 2048 })]), ctx)
    expect(noD).toContain('<description>n.txt (2.0 KB)</description>')
  })

  it('site with description uses a CDATA note; without one keeps the name', () => {
    const s = fileNode({ type: 'site', mime: null, name: 'Site', description: 'hello' })
    expect(renderFeedXml(selectFeedItems([s]), ctx)).toContain('<description><![CDATA[<p>hello</p>]]></description>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/lib/feed.test.ts`
Expected: FAIL — `it.title`/`it.description` undefined; XML lacks the note.

- [ ] **Step 3: Extend `FeedItem`.** In `src/lib/feed.ts`, in `interface FeedItem`, after `size` add:

```ts
  /** Display-title override; null → use `name`. */
  title: string | null
  /** Plain-text note rendered into the item <description>; null → none. */
  description: string | null
```

- [ ] **Step 4: Carry the fields in `selectFeedItems`.** In the `.map((n) => ({ ... }))` block, after `size: n.size,` add:

```ts
      title: n.title,
      description: n.description,
```

- [ ] **Step 5: Add a description helper.** In `src/lib/feed.ts`, after the `htmlAttr` function, add:

```ts
/**
 * Escape user plain text for an HTML/CDATA feed <description> body and turn
 * newlines into <br>. The caller wraps the result in a <p>.
 */
function descHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n?|\n/g, '<br>')
}
```

- [ ] **Step 6: Use title + description in `renderFeedXml`.** Replace the item title line:

```ts
    lines.push(`<title>${xmlEscape(it.name)}</title>`)
```

with:

```ts
    lines.push(`<title>${xmlEscape(it.title || it.name)}</title>`)
```

Then, immediately before `if (it.type === 'file') {`, add:

```ts
    const note = it.description ? `<p>${descHtml(it.description)}</p>` : ''
```

Replace the image-branch description line:

```ts
        lines.push(`<description><![CDATA[<p><img src="${media}" alt="${htmlAttr(it.name)}" /></p>]]></description>`)
```

with:

```ts
        lines.push(`<description><![CDATA[${note}<p><img src="${media}" alt="${htmlAttr(it.name)}" /></p>]]></description>`)
```

Replace the non-image `else` branch:

```ts
      } else {
        const size = humanSize(it.size)
        lines.push(`<description>${xmlEscape(size ? `${it.name} (${size})` : it.name)}</description>`)
      }
```

with:

```ts
      } else if (note) {
        lines.push(`<description><![CDATA[${note}]]></description>`)
      } else {
        const size = humanSize(it.size)
        lines.push(`<description>${xmlEscape(size ? `${it.name} (${size})` : it.name)}</description>`)
      }
```

Replace the Site branch:

```ts
    } else {
      // Site: a one-line description so the reader shows a body, not "no content".
      lines.push(`<description>${xmlEscape(it.name)}</description>`)
    }
```

with:

```ts
    } else if (note) {
      lines.push(`<description><![CDATA[${note}]]></description>`)
    } else {
      // Site: a one-line description so the reader shows a body, not "no content".
      lines.push(`<description>${xmlEscape(it.name)}</description>`)
    }
```

- [ ] **Step 7: Run tests to verify they pass.**

Run: `pnpm test -- src/lib/feed.test.ts`
Expected: PASS (existing feed tests still green — no-description output is byte-identical).

- [ ] **Step 8: Commit.**

```bash
git add src/lib/feed.ts src/lib/feed.test.ts
git commit -m "feat(handoff): feed item title override + description body"
```

---

### Task 3: Feed pipeline ports — mirror title/description in both embedded `select` handlers

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (the `select` `function_handler` in **both** the `/feed.xml` rule and the `/feed/*` rule — the code strings are identical; apply the same edits to each)
- Test: `src/lib/feedRule.test.ts`

**Interfaces:**
- Consumes: raw node rows now carry optional `title`/`description` columns.
- Produces: the embedded `select` handlers render `<title>` and `<description>` identically to `feed.ts` (Task 2). Parity is asserted by `feedRule.test.ts`.

> The `select` code is a JS string inside JSON. Make each change as a unique-substring Edit; the same substring appears once per rule, so do each replacement twice (once per rule) — or use `replace_all: true` since the two copies are byte-identical.

- [ ] **Step 1: Write the failing parity tests.** In `src/lib/feedRule.test.ts`, add two file rows with metadata to the fixtures and a test. Near the other `const F* = {...}` rows add:

```ts
const FT = { id: '22222222-0000-4000-8000-000000000008', nodeType: 'file', displayName: 'deck.png', parentId: PUB.id, content_type: 'image/png', size: 50, createdMs: 500, title: 'Board Deck', description: 'see slide 4 & 5' }
const ST = { id: '33333333-0000-4000-8000-000000000009', nodeType: 'site', displayName: 'Portfolio2', parentId: PUB.id, createdMs: 600, description: 'my work' }
```

Add a test (place it with the other `describe`/`it` blocks; it runs the `/feed.xml` root select over the Public subtree via a token-scoped or public run consistent with the existing helpers):

```ts
it('renders item title override + description note (pipeline == reference)', () => {
  const res = runSelect([], { isRoot: true, nodes: [ROOT, PUB, FT, ST].map((n) => ({ ...n })) })
  expect(res.found).toBe(true)
  expect(res.xml).toContain('<title>Board Deck</title>')
  expect(res.xml).toContain('<description><![CDATA[<p>see slide 4 &amp; 5</p><p><img')
  expect(res.xml).toContain('<description><![CDATA[<p>my work</p>]]></description>')
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/lib/feedRule.test.ts`
Expected: FAIL — pipeline emits `<title>deck.png</title>` and the plain image description with no note.

- [ ] **Step 3: Add title/description to the item projection.** In `bffless/handoff.proxy-rules.json`, find (appears twice — use `replace_all`):

```js
      name: String(lf.displayName || lf.original_name || lf.filename || 'Untitled'),
      path: contentPath(idOf(lf)),
```

Replace with:

```js
      name: String(lf.displayName || lf.original_name || lf.filename || 'Untitled'),
      title: (lf.title != null && String(lf.title) !== '') ? String(lf.title) : null,
      description: (lf.description != null && String(lf.description) !== '') ? String(lf.description) : null,
      path: contentPath(idOf(lf)),
```

- [ ] **Step 4: Add the `descHtml` helper to the port.** Find (appears twice — `replace_all`) the `htmlAttr` function's closing, i.e.:

```js
  function humanSize(bytes) {
```

Replace with:

```js
  function descHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\r\n?|\n/g, '<br>');
  }
  function humanSize(bytes) {
```

- [ ] **Step 5: Use title in the item `<title>`.** Find (`replace_all`):

```js
    out.push('<title>' + xmlEscape(it.name) + '</title>');
```

Replace with:

```js
    out.push('<title>' + xmlEscape(it.title || it.name) + '</title>');
```

- [ ] **Step 6: Render the description note.** Find (`replace_all`) the enclosure + image/else block:

```js
      out.push('<enclosure url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" length="' + length + '"/>');
      var isImage = !!it.mime && it.mime.indexOf('image/') === 0;
      if (isImage) {
        // Reader/article views render <description>, NOT <enclosure>; an inline
        // <img> gives them a body + the picture. CDATA keeps the HTML literal.
        out.push('<description><![CDATA[<p><img src="' + mediaUrl + '" alt="' + htmlAttr(it.name) + '" /></p>]]></description>');
        out.push('<media:content url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" medium="image"/>');
        out.push('<media:thumbnail url="' + xmlEscape(mediaUrl) + '"/>');
      } else {
        out.push('<description>' + xmlEscape(fileSummary(it.name, it.size)) + '</description>');
      }
    } else {
      // Site item: a one-line description so the reader shows a body, not "no content".
      out.push('<description>' + xmlEscape(it.name) + '</description>');
    }
```

Replace with:

```js
      out.push('<enclosure url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" length="' + length + '"/>');
      var note = it.description ? ('<p>' + descHtml(it.description) + '</p>') : '';
      var isImage = !!it.mime && it.mime.indexOf('image/') === 0;
      if (isImage) {
        // Reader/article views render <description>, NOT <enclosure>; an inline
        // <img> gives them a body + the picture. CDATA keeps the HTML literal.
        out.push('<description><![CDATA[' + note + '<p><img src="' + mediaUrl + '" alt="' + htmlAttr(it.name) + '" /></p>]]></description>');
        out.push('<media:content url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" medium="image"/>');
        out.push('<media:thumbnail url="' + xmlEscape(mediaUrl) + '"/>');
      } else if (note) {
        out.push('<description><![CDATA[' + note + ']]></description>');
      } else {
        out.push('<description>' + xmlEscape(fileSummary(it.name, it.size)) + '</description>');
      }
    } else if (it.description) {
      out.push('<description><![CDATA[<p>' + descHtml(it.description) + '</p>]]></description>');
    } else {
      // Site item: a one-line description so the reader shows a body, not "no content".
      out.push('<description>' + xmlEscape(it.name) + '</description>');
    }
```

- [ ] **Step 7: Validate JSON + run tests.**

Run: `node -e "JSON.parse(require('fs').readFileSync('bffless/handoff.proxy-rules.json','utf8'));console.log('ok')"`
Expected: `ok`
Run: `pnpm test -- src/lib/feedRule.test.ts src/lib/feed.test.ts`
Expected: PASS (both feed rules render identically to the reference).

- [ ] **Step 8: Commit.**

```bash
git add bffless/handoff.proxy-rules.json src/lib/feedRule.test.ts
git commit -m "feat(handoff): embed feed title/description in both feed pipeline ports"
```

---

### Task 4: Node projections — pass `title`/`description` through GET/list/register

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (the `shape` `function_handler` in the `GET /api/node`, `GET /api/nodes`, and `POST /api/nodes` rules)
- Modify: `src/mocks/handlers.ts` (mock GET already spreads `...node`, but `seedFile`/`seedSite` and the register handler must default the fields)
- Test: `src/lib/nodes.test.ts` already covers coercion; add a mock round-trip test in `src/store/rootMeta.test.ts` neighbour or a new focused test (see Step 1)

**Interfaces:**
- Consumes: `title`/`description` columns on the node record.
- Produces: `GET /api/node` and `GET /api/nodes` responses carry `title`/`description`; `getNode`/`listNodes` (through `toNode`) expose them on `HandoffNode`.

- [ ] **Step 1: Write the failing test.** Create `src/store/nodeMetaProjection.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const proxy = JSON.parse(readFileSync(new URL('../../bffless/handoff.proxy-rules.json', import.meta.url), 'utf8')) as { rules: any[] }

function shapeSource(method: string, path: string): string {
  const rule = proxy.rules.find((r) => r.pathPattern === path && r.method === method)
  const step = rule.pipelineConfig.steps.find((s: any) => s.id === 'shape')
  return step.config.code
}

describe('node shape projections expose title/description', () => {
  it('GET /api/node projects title and description', () => {
    expect(shapeSource('GET', '/api/node')).toContain('title:')
    expect(shapeSource('GET', '/api/node')).toContain('description:')
  })
  it('GET /api/nodes projects title and description', () => {
    expect(shapeSource('GET', '/api/nodes')).toContain('title:')
    expect(shapeSource('GET', '/api/nodes')).toContain('description:')
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/store/nodeMetaProjection.test.ts`
Expected: FAIL — projections don't mention title/description.

- [ ] **Step 3: Add to the GET /api/node shape.** In `bffless/handoff.proxy-rules.json`, in the `GET`/`/api/node` rule's `shape` step, locate where the returned node object is built (it assembles `id`, `type`, `name`, `mime`, `size`, `url`, `grants`, …). Add these two properties to that returned node literal (adjacent to `size`/`mime`), reading the raw row `r`:

```js
    title: (r.title != null && String(r.title) !== '') ? String(r.title) : null,
    description: (r.description != null && String(r.description) !== '') ? String(r.description) : null,
```

(The exact anchor is the `name: ...` line in that shape's `return { node: { ... } }`; insert the two lines right after it.)

- [ ] **Step 4: Add to the GET /api/nodes list shape.** In the `GET`/`/api/nodes` rule's `shape` step, the per-node projection is built inside the map over rows. Add the same two lines to that per-node object literal, right after its `name:` property, reading the row variable that step uses (match the surrounding variable name — e.g. `n`/`r`).

- [ ] **Step 5: Default the fields in the mock seeds + register.** In `src/mocks/handlers.ts`:
  - In `seedFile` and `seedSite`, add `title: null, description: null,` to the node object they push into `nodes`.
  - In the `POST /api/nodes` handler's created node object (line ~619–646), add `title: null, description: null,`.
  - Confirm `GET /api/node` (line ~747) and `GET /api/nodes` (line ~714) responses include them — they spread `...node`, so once the stored node has the fields, they pass through. No change needed there beyond the seeds.

- [ ] **Step 6: Validate JSON + run tests.**

Run: `node -e "JSON.parse(require('fs').readFileSync('bffless/handoff.proxy-rules.json','utf8'));console.log('ok')"`
Run: `pnpm test -- src/store/nodeMetaProjection.test.ts`
Expected: `ok`, then PASS.

- [ ] **Step 7: Commit.**

```bash
git add bffless/handoff.proxy-rules.json src/mocks/handlers.ts src/store/nodeMetaProjection.test.ts
git commit -m "feat(handoff): project title/description through node GET/list/register"
```

---

### Task 5: Metadata write endpoint — `PATCH /api/node/meta` + `updateNodeMeta` mutation

**Files:**
- Modify: `bffless/handoff.proxy-rules.json` (add a new rule: `PATCH /api/node/meta`)
- Modify: `src/mocks/handlers.ts` (add `http.patch('/api/node/meta', …)`)
- Modify: `src/store/handoffApi.ts` (add `updateNodeMeta` mutation + export hook)
- Test: `src/store/updateNodeMeta.test.ts`

**Interfaces:**
- Consumes: the DELETE gate's `evalAccess`/`folderChain`/`readCookie`/`vtok` logic (copied verbatim), Task 1 fields.
- Produces: `PATCH /api/node/meta` with body `{ id, title?, description? }` → `200 { id, title, description }` for a writer on a file/site; `400` invalid/non-leaf/no-field; `401` no credential; `403` insufficient. Client hook `useUpdateNodeMetaMutation`.

> **Why a new path, not `PATCH /api/node`:** the existing PATCH is folder-only with an owner gate (`mode`/`feedExcluded`); the metadata write targets file/site leaves with an *edit* gate over the parent-folder chain. A dedicated rule reuses the DELETE gate wholesale and leaves the working folder-settings PATCH untouched. `/api/node` is an exact (non-wildcard) pattern, so `/api/node/meta` does not collide.

- [ ] **Step 1: Write the failing test.** Create `src/store/updateNodeMeta.test.ts` modeled on the existing store tests (they drive the MSW handlers through the RTK endpoint). Use the mock seams (`seedRoot`, `seedFolder`, `seedFile`, `setMockUser`/`nodeAcl` — match the helpers the sibling tests import from `../mocks/handlers`):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setupStore } from './index' // match how sibling store tests build a store
import { handoffApi } from './handoffApi'
import { seedRoot, seedFolder, seedFile, resetMockState, setMockUser, nodeAcl } from '../mocks/handlers'

// (Follow the exact reset/seed/user helpers the neighbouring *.test.ts files use.)

describe('updateNodeMeta', () => {
  beforeEach(() => { resetMockState(); seedRoot('owner-1') })

  it('a writer sets title + description (200) and clears on empty string', async () => {
    setMockUser({ id: 'owner-1', role: 'user' })
    const folder = seedFolder('Docs', 'root')
    const file = seedFile('a.png', folder.id)
    const store = setupStore()
    const res = await store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: 'Deck', description: 'note', parentId: folder.id })).unwrap()
    expect(res).toMatchObject({ id: file.id, title: 'Deck', description: 'note' })
    const cleared = await store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: '', parentId: folder.id })).unwrap()
    expect(cleared.title).toBeNull()
  })

  it('a view-only user is forbidden (403)', async () => {
    const folder = seedFolder('Docs', 'root')
    nodeAcl.set(folder.id, { ownerId: 'owner-1', grants: [{ principalId: 'viewer-2', level: 'view' }], mode: 'inheriting' })
    const file = seedFile('a.png', folder.id)
    setMockUser({ id: 'viewer-2', role: 'user' })
    const store = setupStore()
    const p = store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: file.id, title: 'X', parentId: folder.id }))
    await expect(p.unwrap()).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a folder target (400)', async () => {
    setMockUser({ id: 'owner-1', role: 'user' })
    const folder = seedFolder('Docs', 'root')
    const store = setupStore()
    const p = store.dispatch(handoffApi.endpoints.updateNodeMeta.initiate({ id: folder.id, title: 'X', parentId: 'root' }))
    await expect(p.unwrap()).rejects.toMatchObject({ status: 400 })
  })
})
```

> If the neighbouring store tests use `renderHook`+`waitFor` instead of `store.dispatch(...initiate)`, mirror their style. The three behaviours to assert are unchanged: writer 200 + clear, viewer 403, folder 400.

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/store/updateNodeMeta.test.ts`
Expected: FAIL — `updateNodeMeta` endpoint and the `/api/node/meta` route don't exist.

- [ ] **Step 3: Add the `updateNodeMeta` RTK mutation.** In `src/store/handoffApi.ts`, after the `setNodeFeedExcluded` mutation (line ~596) add:

```ts
    /**
     * PATCH /api/node/meta { id, title?, description? } → { id, title, description }
     * Sets a File/Site's display title + description (feed-surfaced metadata).
     * Requires `edit` on the parent-folder chain (mirrors the DELETE gate);
     * 400 for a non-leaf/no-field body, 401 no credential, 403 insufficient.
     * An empty string clears a field to null. Single isolated write — never
     * Promise.all with another same-node write (CE data_update clobbers, #194).
     */
    updateNodeMeta: builder.mutation<
      { id: string; title: string | null; description: string | null },
      { id: string; title?: string; description?: string; parentId?: string }
    >({
      query: ({ id, title, description }) => ({
        url: 'api/node/meta',
        method: 'PATCH',
        body: {
          id,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      }),
      invalidatesTags: (_result, _err, { id, parentId }) => [
        { type: 'Node' as const, id },
        ...(parentId ? [{ type: 'Node' as const, id: `LIST:${parentId}` }] : []),
      ],
    }),
```

Then add `useUpdateNodeMetaMutation,` to the exported hooks block at the bottom.

- [ ] **Step 4: Add the mock handler.** In `src/mocks/handlers.ts`, after the `http.patch('/api/node', …)` handler (line ~879) add:

```ts
  /**
   * PATCH /api/node/meta
   * Body: { id, title?, description? } → { id, title, description }.
   * Mirrors the live meta pipeline at the toNode seam: edit-gated over the
   * parent-folder chain (checkAccess min 'edit'); 400 bad/missing id, non-leaf,
   * or no editable field; 401 no credential; 403 insufficient. Writes only the
   * provided fields; '' clears to null.
   */
  http.patch('/api/node/meta', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { id?: string; title?: unknown; description?: unknown }
    const id = String(body.id ?? '')
    const hasTitle = typeof body.title === 'string'
    const hasDescription = typeof body.description === 'string'
    const node = id ? nodes.get(id) : undefined
    const isLeaf = !!node && (node.type === 'file' || node.type === 'site')
    if (!id || (!hasTitle && !hasDescription) || !isLeaf) {
      return HttpResponse.json({ error: 'invalid request' }, { status: 400 })
    }
    const access = checkAccess(id, 'edit')
    if (access === '401') return HttpResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (access === '403') return HttpResponse.json({ error: 'forbidden' }, { status: 403 })

    let updated = { ...node! }
    if (hasTitle) {
      const t = String(body.title).trim()
      updated = { ...updated, title: t ? t.slice(0, 200) : null }
    }
    if (hasDescription) {
      const d = String(body.description)
      updated = { ...updated, description: d ? d.slice(0, 2000) : null }
    }
    nodes.set(id, updated)
    return HttpResponse.json({ id, title: updated.title ?? null, description: updated.description ?? null })
  }),
```

> Note: `checkAccess` here must reach `'edit'` for a leaf via its parent chain. It already does this for DELETE (`checkAccess(id, 'edit')`), so no change to `checkAccess` is needed.

- [ ] **Step 5: Add the live `PATCH /api/node/meta` rule.** In `bffless/handoff.proxy-rules.json`, add a new object to the `rules` array (place it just before the existing `PATCH /api/node` rule; give it a unique `order` — one less than that rule's order so it matches first, though the paths are distinct). Insert this rule verbatim:

```json
{
  "pathPattern": "/api/node/meta",
  "method": "PATCH",
  "targetUrl": "pipeline",
  "stripPrefix": true,
  "order": 32,
  "timeout": 30000,
  "preserveHost": false,
  "forwardCookies": false,
  "proxyType": "pipeline",
  "isEnabled": true,
  "description": "Set a File/Site's display title + description; edit on the parent folder required",
  "pipelineConfig": {
    "name": "node-set-meta",
    "steps": [
      {
        "id": "pre",
        "name": "pre",
        "handlerType": "function_handler",
        "config": {
          "code": "function handler({ request }) { var b=(request&&request.body)||{}; var id=String(b.id||''); var UUID=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; var hasTitle=(typeof b.title==='string'); var hasDescription=(typeof b.description==='string'); var titleRaw=hasTitle?String(b.title).replace(/^\\s+|\\s+$/g,''):''; var title=hasTitle?(titleRaw?titleRaw.slice(0,200):null):null; var description=hasDescription?(String(b.description)?String(b.description).slice(0,2000):null):null; var idOk=!!id&&UUID.test(id); var hasField=hasTitle||hasDescription; return { id:id, idOk:idOk, hasTitle:hasTitle, hasDescription:hasDescription, title:title, description:description, hasField:hasField }; }"
        }
      },
      {
        "id": "query",
        "name": "query",
        "handlerType": "data_query",
        "config": { "recordId": "request.body.id", "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "condition": "steps.pre.idOk" }
      },
      {
        "id": "allFolders",
        "name": "allFolders",
        "handlerType": "data_query",
        "config": { "filters": { "nodeType": { "op": "in", "value": ["folder", "root"] } }, "pageSize": 500, "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0" }
      },
      {
        "id": "gate",
        "name": "gate",
        "handlerType": "function_handler",
        "config": {
          "code": "function handler({ user, request, steps, utils }) { var UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/; function readCookie(name){ var raw=(request&&request.headers&&request.headers.cookie)||''; if(Object.prototype.toString.call(raw)==='[object Array]')raw=raw[0]||''; raw=String(raw); var parts=raw.split(';'); for(var i=0;i<parts.length;i++){var kv=parts[i];var p=kv.indexOf('=');if(p<0)continue;var k=kv.slice(0,p).replace(/^\\s+|\\s+$/g,'');if(k===name)return decodeURIComponent(kv.slice(p+1));} return ''; } function vtok(tok){ if(!tok)return null; var d=tok.lastIndexOf('.'); if(d<1)return null; var body=tok.slice(0,d); var sig=tok.slice(d+1); if(!body||!sig)return null; if(!utils.verify(body,sig))return null; var o=null; try{o=JSON.parse(utils.base64urlDecode(body));}catch(e){return null;} if(!o||typeof o!=='object')return null; if(typeof o.exp!=='number'||Date.now()>o.exp)return null; return o; } function rank(l){return l==='owner'?3:l==='edit'?2:l==='view'?1:0;} function evalAccess(ch,vw){ if(vw.isAdmin)return 'owner'; if(vw.userId){for(var i=0;i<ch.length;i++){if(ch[i].ownerId===vw.userId)return 'owner';}} var s=0;for(var k=ch.length-1;k>=0;k--){if(ch[k].mode==='restricted'){s=k;break;}} var best='none';for(var d=s;d<ch.length;d++){var gs=ch[d].grants||[];for(var e=0;e<gs.length;e++){var g=gs[e]||{};if(g.principalId==='anyone'){if(rank('view')>rank(best))best='view';}else if(vw.userId&&g.principalId===vw.userId&&rank(g.level)>rank(best))best=g.level;}} if(!vw.userId&&vw.shareLinkFolderId){var inC=false;for(var j=0;j<ch.length;j++){if(ch[j].id===vw.shareLinkFolderId){inC=true;break;}}if(inC&&rank('view')>rank(best))best='view';} return best; } function folderChain(folders,startId){ var byId={};var rootId='';for(var a=0;a<folders.length;a++){var f=folders[a]||{};var id=f.id||f.recordId||f.record_id;if(id){byId[id]=f;if(f.nodeType==='root')rootId=id;}} var rev=[];var cur=(String(startId||'')==='root'&&rootId)?rootId:String(startId||'');var g=0; while(cur&&UUID.test(cur)&&byId[cur]&&g<64){var n=byId[cur];var gr=n.grantsJson;if(typeof gr==='string'){try{gr=JSON.parse(gr);}catch(e){gr=[];}}if(!gr||Object.prototype.toString.call(gr)!=='[object Array]')gr=[];rev.push({id:cur,ownerId:n.ownerId||null,grants:gr,mode:n.mode==='restricted'?'restricted':'inheriting'});cur=(n.parentId==='root'&&rootId)?rootId:(n.parentId||'');g++;} var ch=[];for(var b=rev.length-1;b>=0;b--)ch.push(rev[b]);return ch; } var pre=(steps&&steps.pre)||{}; var uid=(user&&user.id)||null; var isAdmin=!!user&&user.role==='admin'; var stok=vtok(readCookie('hf_s')); var shareFolderId=(stok&&stok.s)?String(stok.s):''; var ftok=vtok(readCookie('hf_f')); var viewer; if(uid)viewer={userId:uid,isAdmin:isAdmin}; else if(shareFolderId)viewer={shareLinkFolderId:shareFolderId}; else viewer={}; var folders=(steps&&steps.allFolders)||[]; var node=(steps&&steps.query)||null; if(node&&typeof node==='object'){ var hasId=node.id||node.recordId||node.record_id; if(!hasId)node=null; } else { node=null; } var nodeType=node?(node.nodeType||'file'):''; var isLeaf=(nodeType==='file'||nodeType==='site'); var badRequest=(pre.idOk!==true)||(pre.hasField!==true)||!node||!isLeaf; var level='none'; var allow=false; if(node&&isLeaf){ var nid=node.id||node.recordId||node.record_id; var ch=folderChain(folders,node.parentId); ch.push({id:nid,ownerId:node.ownerId||null,grants:[],mode:'inheriting'}); level=evalAccess(ch,viewer); allow=rank(level)>=2; } var hasCred=!!uid||!!shareFolderId||!!ftok; var deny401=!badRequest&&!allow&&!hasCred; var deny403=!badRequest&&!allow&&hasCred; var doSave=!badRequest&&allow; return { badRequest:badRequest, deny401:deny401, deny403:deny403, doSave:doSave, level:level }; }"
        }
      },
      {
        "id": "save",
        "name": "save",
        "handlerType": "data_update",
        "config": { "schemaId": "1c5d4802-596e-4f50-a08f-c41fb8f9fab0", "recordId": "steps.pre.id", "fields": { "title": "steps.pre.title", "description": "steps.pre.description" }, "condition": "steps.gate.doSave" }
      },
      {
        "id": "ok",
        "name": "ok",
        "handlerType": "response_handler",
        "config": { "body": "{\"id\":\"{{steps.pre.id}}\",\"title\":{{steps.pre.titleJson}},\"description\":{{steps.pre.descriptionJson}}}", "status": 200, "condition": "steps.gate.doSave", "contentType": "application/json" }
      },
      {
        "id": "bad",
        "name": "bad",
        "handlerType": "response_handler",
        "config": { "body": "{\"error\":\"invalid request\"}", "status": 400, "condition": "steps.gate.badRequest", "contentType": "application/json" }
      },
      {
        "id": "deny401",
        "name": "deny401",
        "handlerType": "response_handler",
        "config": { "body": "{\"error\":\"unauthorized\"}", "status": 401, "condition": "steps.gate.deny401", "contentType": "application/json" }
      },
      {
        "id": "deny403",
        "name": "deny403",
        "handlerType": "response_handler",
        "config": { "body": "{\"error\":\"forbidden\"}", "status": 403, "condition": "steps.gate.deny403", "contentType": "application/json" }
      }
    ]
  }
}
```

> The `ok` response uses `{{steps.pre.titleJson}}` / `{{steps.pre.descriptionJson}}` so `null` serializes correctly (unquoted). Update the `pre` handler's return to also emit JSON-encoded forms — extend its `return { ... }` to include: `titleJson: (title==null?'null':JSON.stringify(title)), descriptionJson: (description==null?'null':JSON.stringify(description))`. (Add these two keys to the `pre` code in this same step before saving.)

- [ ] **Step 6: Fold the JSON-encoded fields into `pre`.** Edit the `pre` handler `code` string added in Step 5 so its `return` reads:

```js
return { id:id, idOk:idOk, hasTitle:hasTitle, hasDescription:hasDescription, title:title, description:description, hasField:hasField, titleJson:(title==null?'null':JSON.stringify(title)), descriptionJson:(description==null?'null':JSON.stringify(description)) };
```

- [ ] **Step 7: Validate JSON + run tests.**

Run: `node -e "JSON.parse(require('fs').readFileSync('bffless/handoff.proxy-rules.json','utf8'));console.log('ok')"`
Run: `pnpm test -- src/store/updateNodeMeta.test.ts`
Expected: `ok`, then PASS.

- [ ] **Step 8: Commit.**

```bash
git add bffless/handoff.proxy-rules.json src/mocks/handlers.ts src/store/handoffApi.ts src/store/updateNodeMeta.test.ts
git commit -m "feat(handoff): PATCH /api/node/meta write endpoint + updateNodeMeta"
```

---

### Task 6: Viewer UI — details block + edit dialog

**Files:**
- Create: `src/components/NodeDetails.tsx` (read view + edit dialog)
- Modify: `src/pages/HandoffViewer.tsx` (render `<NodeDetails>` under the control bar; thread the edit gate)
- Test: `src/components/nodeDetails.test.tsx`

**Interfaces:**
- Consumes: `HandoffNode` (with `title`/`description`), `useUpdateNodeMetaMutation` (Task 5), the parent-folder edit gate the `ControlBar` already computes (`canShare` via `canShareParentFolder`, or reuse `canDeleteNode` as the write gate — match what the bar uses for write actions).
- Produces: `<NodeDetails node={node} canEdit={boolean} />` — a self-contained block.

- [ ] **Step 1: Write the failing test.** Create `src/components/nodeDetails.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { setupStore } from '../store' // match sibling component tests
import { NodeDetails } from './NodeDetails'
import type { HandoffNode } from '../lib/nodes'

function node(over: Partial<HandoffNode>): HandoffNode {
  return { id: 'id1', type: 'file', name: 'a.png', mime: 'image/png', size: 1, url: null, storageKey: null, path: 'a.png', parentId: 'p', createdAt: 1, ownerId: null, grants: [], mode: 'inheriting', title: null, description: null, ...over }
}
function renderWith(ui: React.ReactElement) {
  return render(<Provider store={setupStore()}>{ui}</Provider>)
}

describe('NodeDetails', () => {
  it('shows the title as heading and the description when set', () => {
    renderWith(<NodeDetails node={node({ title: 'Board Deck', description: 'the note' })} canEdit={false} />)
    expect(screen.getByRole('heading', { name: 'Board Deck' })).toBeInTheDocument()
    expect(screen.getByText('the note')).toBeInTheDocument()
  })

  it('falls back to filename heading when no title is set (still shows for empty when canEdit)', () => {
    renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /add title/i })).toBeInTheDocument()
  })

  it('a non-editor with no metadata renders nothing', () => {
    const { container } = renderWith(<NodeDetails node={node({ title: null, description: null })} canEdit={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('an editor sees an Edit control when metadata is set', () => {
    renderWith(<NodeDetails node={node({ title: 'T' })} canEdit={true} />)
    expect(screen.getByRole('button', { name: /edit details/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `pnpm test -- src/components/nodeDetails.test.tsx`
Expected: FAIL — `NodeDetails` does not exist.

- [ ] **Step 3: Implement `NodeDetails`.** Create `src/components/NodeDetails.tsx`:

```tsx
/**
 * Details block for the file/site viewer: shows the node's display Title
 * (falling back to its filename) + Description, and — for writers — an
 * "Edit details" dialog that PATCHes /api/node/meta. Additive metadata: the
 * filename stays the node's identity; title/description only enrich the viewer
 * and the RSS feed.
 */
import { useState } from 'react'
import type { HandoffNode } from '../lib/nodes'
import { useUpdateNodeMetaMutation } from '../store/handoffApi'
import { toast } from '../lib/toast'

const TITLE_MAX = 200
const DESC_MAX = 2000

export function NodeDetails({ node, canEdit }: { node: HandoffNode; canEdit: boolean }) {
  const [open, setOpen] = useState(false)
  const hasMeta = !!node.title || !!node.description
  if (!hasMeta && !canEdit) return null

  return (
    <div className="border-b border-border bg-surface px-4 py-3">
      {hasMeta ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
              {node.title || node.name}
            </h1>
            {canEdit && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="shrink-0 rounded px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Edit details
              </button>
            )}
          </div>
          {node.title && <p className="mt-0.5 text-xs text-muted">{node.name}</p>}
          {node.description && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{node.description}</p>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm text-muted transition-colors hover:text-ink"
        >
          + Add title &amp; description
        </button>
      )}
      {open && <EditDetailsDialog node={node} onClose={() => setOpen(false)} />}
    </div>
  )
}

function EditDetailsDialog({ node, onClose }: { node: HandoffNode; onClose: () => void }) {
  const [title, setTitle] = useState(node.title ?? '')
  const [description, setDescription] = useState(node.description ?? '')
  const [updateMeta, { isLoading }] = useUpdateNodeMetaMutation()

  async function handleSave() {
    try {
      await updateMeta({ id: node.id, title, description, parentId: node.parentId }).unwrap()
      toast('Details saved.')
      onClose()
    } catch {
      toast('Couldn’t save details. Please try again.', 'error')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit details"
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 'var(--z-modal)' }}
      onClick={() => { if (!isLoading) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" />
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-ink">Edit details</h2>
        <label className="block text-xs font-medium text-muted">Title</label>
        <input
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={node.name}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <label className="mt-3 block text-xs font-medium text-muted">Description</label>
        <textarea
          value={description}
          maxLength={DESC_MAX}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={isLoading}
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isLoading}
            onClick={handleSave}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isLoading ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the component test to verify it passes.**

Run: `pnpm test -- src/components/nodeDetails.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount it in the viewer.** In `src/pages/HandoffViewer.tsx`, in `ViewerBody`'s returned JSX, insert `<NodeDetails>` between `<ControlBar … />` and the content `<div ref={contentRef} …>`. Compute the edit gate the same way the control bar's write actions do — the bar already derives a writer gate (`canShare`/`canDelete`) from the parent node; lift that into `ViewerBody` (fetch the parent via `useGetNodeQuery(node.parentId, …)` as `ControlBar` does, or pass a `canEdit` prop down). Minimal change:

```tsx
import { NodeDetails } from '../components/NodeDetails'
import { canDeleteNode } from '../lib/deleteGate'
// ...inside ViewerBody, after `const node` is resolved and before return:
// (reuse the parent lookup pattern from ControlBar)
```

Add, inside `ViewerBody`, the parent lookup + gate (guests skip it), then render:

```tsx
      <ControlBar … />
      <NodeDetails node={node} canEdit={canEditMeta} />
      <div ref={contentRef} …>
```

where `canEditMeta` is `canDeleteNode({ session, node, parentNode })` (writers of the parent folder — the same gate delete uses). Import `useSession` is already present. Fetch `parentNode` with `useGetNodeQuery(node.parentId, { skip: node.parentId === 'root' || !(session?.authenticated) })`.

- [ ] **Step 6: Run viewer tests + full suite.**

Run: `pnpm test -- src/pages src/components/nodeDetails.test.tsx`
Expected: PASS (existing `HandoffViewer` tests unaffected — the block renders nothing for a guest with no metadata).

- [ ] **Step 7: Typecheck + lint.**

Run: `pnpm -s exec tsc -b && pnpm -s lint`
Expected: no errors.

- [ ] **Step 8: Commit.**

```bash
git add src/components/NodeDetails.tsx src/components/nodeDetails.test.tsx src/pages/HandoffViewer.tsx
git commit -m "feat(handoff): viewer details block + edit dialog for title/description"
```

---

### Task 7: Docs — glossary + ADR-0009

**Files:**
- Modify: `CONTEXT.md`
- Create: `docs/adr/0009-content-title-description-metadata.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Add glossary terms.** In `CONTEXT.md`, at the end of the `## Feeds` section (or a new `## Content metadata` subsection), add:

```markdown
**Title**:
An optional display-title override on a [[File]] or [[Site]]. Additive — the filename stays
the leaf's identity (path, listings, name-uniqueness); the title only replaces the viewer
heading and the [[Feed Item]] `<title>`, falling back to the filename when unset.
_Avoid_: Name, rename, label

**Description**:
An optional plain-text, multi-line note on a [[File]] or [[Site]], surfaced as the
[[Feed Item]] `<description>` body (above the inline image for an image [[File]]). Additive
metadata; escaped into the feed, never executed.
_Avoid_: Caption, summary, body (in access/structural contexts)
```

- [ ] **Step 2: Write ADR-0009.** Create `docs/adr/0009-content-title-description-metadata.md` mirroring the format of `docs/adr/0007-*.md` (Status / Context / Decision / Consequences). Record: additive-not-rename (filename stays identity); plain text (escaped, no Markdown in v1); leaf-only scope (folders keep auto channel metadata); write gated by `edit` on the parent chain via a dedicated `PATCH /api/node/meta` reusing the DELETE gate; feed logic quadruplicated and parity-tested.

- [ ] **Step 3: Commit.**

```bash
git add CONTEXT.md docs/adr/0009-content-title-description-metadata.md
git commit -m "docs(handoff): title/description glossary + ADR-0009"
```

---

### Task 8: Post-merge — sync the live BFFless rules (human-gated)

**Files:** none (operational; runs against the live `handoff` proxy set via the `j5s-dev` MCP after the PR merges).

> This is NOT a code commit. The exported `handoff.proxy-rules.json` does not touch the live rules (Sandcastle doesn't deploy live proxy rules). It is a checklist for the maintainer to run post-merge; keep it in the PR description too.

- [ ] **Step 1: Diff the live set against the repo.** Using the `j5s-dev` MCP, `get_proxy_rule_set` for the live `handoff` set (the shared base set both prod + preview aliases resolve to) and compare the two feed `select` handlers + confirm there is no `PATCH /api/node/meta` rule yet.
- [ ] **Step 2: Update the two feed rules' `select` handlers** to the Task-3 code (title projection + `descHtml` + title/description render). Fold into the shared base set — do not attach a separate "preview" override.
- [ ] **Step 3: Create the `PATCH /api/node/meta` rule** (Task-5 JSON) on the live set via `create_proxy_rule`.
- [ ] **Step 4: Verify end-to-end.** With an authenticated key, `PATCH https://handoff.j5s.dev/api/node/meta` with `{ id, title, description }` for an owned file → 200; then fetch `https://handoff.j5s.dev/feed.xml` (public folder) and confirm the item shows the new `<title>` + `<description>`. A view-only identity → 403; a folder id → 400.
- [ ] **Step 5: Re-export drift check.** Confirm `chore(handoff): sync rules export with live set` is unnecessary (the repo JSON already matches what you applied). If the live apply differed at all, reconcile the JSON and open a sync PR.

---

## Self-Review

**Spec coverage:**
- Data model (title/description on node) → Task 1 ✓
- API PATCH extension (edit-gate write) → Task 5 (as dedicated `/api/node/meta`, refining the spec's "extend PATCH /api/node" — rationale documented in Task 5 and ADR-0009) ✓
- Feed rendering (title override + description body) → Task 2 (reference) + Task 3 (pipeline ports) ✓
- Node projections passthrough → Task 4 ✓
- Viewer UI (read block + edit dialog, edit-gated, read-only for viewers/guests) → Task 6 ✓
- Mocks + tests (mock==real, parity, coercion, gate, UI) → Tasks 1–6 ✓
- Live deployment → Task 8 ✓
- Docs (glossary + ADR) → Task 7 ✓
- Out of scope held: folder channel metadata; title in listings — not implemented, noted ✓

**Placeholder scan:** No TBD/TODO. Test steps carry real assertions; handler edits carry exact old→new strings; the new rule JSON is complete. The one deliberate "match the sibling test's setup helpers" note (Tasks 5–6) is because the repo's store/component test harness (`setupStore`/reset/seed helpers) must be used as-is rather than invented — the behaviours asserted are fully specified.

**Type consistency:** `HandoffNode.title/description: string | null` (Task 1) = `FeedItem.title/description: string | null` (Task 2) = mutation result `{ id, title: string | null, description: string | null }` (Task 5) = `NodeDetails` prop `node: HandoffNode` (Task 6). Mutation arg uses optional `title?/description?: string` (undefined = "don't touch", '' = "clear"), consistent between `handoffApi`, the mock, and the pipeline `pre` handler. Hook name `useUpdateNodeMetaMutation` consistent across Tasks 5–6.
