# Viewer Margin Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google-Docs-style anchored comments (threads, resolve, reactions) over rendered Markdown, HTML Sites, and images in the Handoff viewer, stored in a new `handoff_comments` data table behind four new ACL-gated rules-as-code routes.

**Architecture:** The parent app reaches directly into the same-origin, unsandboxed viewer iframes (`contentDocument`) to capture selections, measure anchor positions, sync scroll, and paint CSS Custom Highlights — no postMessage, no build/serve-time changes to documents. Comments live one-record-per-comment in a new data table; four folder-per-route rules reuse `_shared/acl.ts` gates. Spec: `docs/superpowers/specs/2026-07-28-viewer-margin-comments-design.md`.

**Tech Stack:** React 19 + RTK Query + Tailwind (frontend), BFFless rules-as-code pipelines (`function_handler` + `data_query`/`data_create`/`data_update`/`data_delete`), Vitest + Testing Library + MSW, `bffless` CLI compiler for rule tests.

## Global Constraints

- Repo root for git commands: `/home/rico/bffless/repos/apps` (the `bffless-apps` monorepo). Work on branch `feature/viewer-comments` off `main`. **Never push or open a PR without explicit user approval** — commits on the branch are fine.
- App root: `apps/handoff`. Run app commands as `pnpm --filter handoff <script>` from the repo root, or `pnpm <script>` from `apps/handoff`.
- No changes to document content at build or serve time; no `sandbox` attribute added to any iframe (ADR-0001 relies on same-origin unsandboxed frames).
- Never `Promise.all` two writes to the same data-table record (CE `data_update` read-modify-writes whole records — issue #194). One record per comment keeps writes isolated.
- A pipeline step `condition` can only reference a **simple path** (e.g. `steps.gate.doEdit`) — all conjunctions must be precomputed booleans returned by a gate `function_handler`.
- Comment write rule: **session `user.id` required AND ACL rank ≥ 1 (view)** on the node. Read: rank ≥ 1, where a verified `hf_s` share-cookie also qualifies. Edit/delete: comment author only.
- Comment affordances only for preview kinds `markdown`, `site`, `image`; never in `?embed=1` mode.
- `.fn.ts` handlers use the sandbox subset: no DOM, no Node APIs; `Date.now()` is available; esbuild strips types only, so code must be valid JS after type-stripping. Typecheck with `pnpm --filter handoff typecheck:rules`.
- Do NOT run `bffless rules push` — rules deploy via CI (`deploy-handoff.yml`) after merge. `rules validate` / the vitest rule tests are the local verification.
- MSW mock == real: every new endpoint gets an MSW handler returning the same shape, and responses pass through the same `toComment` coercion seam.

---

### Task 1: Branch + comment domain types and coercion (`src/lib/comments.ts`)

**Files:**
- Create: `apps/handoff/src/lib/comments.ts`
- Test: `apps/handoff/src/lib/comments.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by every later task):
  - `type CommentAnchor = CommentAnchorText | CommentAnchorPin`
  - `interface CommentAnchorText { type: 'text'; quote: string; prefix: string; suffix: string; start: number; end: number }`
  - `interface CommentAnchorPin { type: 'pin'; x: number; y: number }`
  - `interface HandoffComment { id: string; nodeId: string; parentId: string | null; authorId: string; authorName: string; body: string; anchor: CommentAnchor | null; resolved: boolean; resolvedBy: string | null; resolvedMs: number | null; reactions: Record<string, string[]>; deleted: boolean; createdMs: number; updatedMs: number | null }`
  - `toComment(raw: unknown): HandoffComment` · `toCommentList(raw: unknown): HandoffComment[]`
  - `interface CommentThread { root: HandoffComment; replies: HandoffComment[] }`
  - `threadsFor(comments: HandoffComment[]): CommentThread[]` — roots sorted by `anchor.start`/`anchor.y` then `createdMs`; replies sorted by `createdMs`; a reply whose root is missing is dropped.

- [ ] **Step 1: Create the branch**

```bash
cd /home/rico/bffless/repos/apps
git checkout main && git pull && git checkout -b feature/viewer-comments
```

- [ ] **Step 2: Write the failing test**

`apps/handoff/src/lib/comments.test.ts` — model on `src/lib/nodes.test.ts` (coercion seam style):

```ts
import { describe, it, expect } from 'vitest'
import { toComment, toCommentList, threadsFor } from './comments'

describe('toComment', () => {
  it('coerces a full record, parsing anchorJson and reactionsJson strings', () => {
    const c = toComment({
      id: 'c1', nodeId: 'n1', parentId: '', authorId: 'u1', authorName: 'a@b.c',
      body: 'hi', anchorJson: '{"type":"text","quote":"q","prefix":"p","suffix":"s","start":5,"end":6}',
      resolved: 'true', resolvedBy: 'u2', resolvedMs: 10, reactionsJson: '{"👍":["u1"]}',
      deleted: false, createdMs: 1, updatedMs: 2,
    })
    expect(c).toEqual({
      id: 'c1', nodeId: 'n1', parentId: null, authorId: 'u1', authorName: 'a@b.c',
      body: 'hi', anchor: { type: 'text', quote: 'q', prefix: 'p', suffix: 's', start: 5, end: 6 },
      resolved: true, resolvedBy: 'u2', resolvedMs: 10, reactions: { '👍': ['u1'] },
      deleted: false, createdMs: 1, updatedMs: 2,
    })
  })

  it('never throws on garbage: bad anchor JSON → null, bad reactions → {}', () => {
    const c = toComment({ id: 1, anchorJson: '{nope', reactionsJson: 42, resolved: 'false' })
    expect(c.id).toBe('1')
    expect(c.anchor).toBeNull()
    expect(c.reactions).toEqual({})
    expect(c.resolved).toBe(false)
    expect(c.parentId).toBeNull()
    expect(c.deleted).toBe(false)
  })

  it('accepts an already-parsed anchor object and a pin anchor', () => {
    const c = toComment({ id: 'c', anchorJson: { type: 'pin', x: 0.5, y: 0.25 } })
    expect(c.anchor).toEqual({ type: 'pin', x: 0.5, y: 0.25 })
  })

  it('rejects anchors of unknown type or out-of-range pin coords', () => {
    expect(toComment({ id: 'c', anchorJson: { type: 'blob' } }).anchor).toBeNull()
    expect(toComment({ id: 'c', anchorJson: { type: 'pin', x: 2, y: 0 } }).anchor).toBeNull()
  })
})

describe('toCommentList', () => {
  it('unwraps { comments: [...] } and drops non-objects', () => {
    expect(toCommentList({ comments: [{ id: 'a' }, null, 'x'] }).map((c) => c.id)).toEqual(['a'])
    expect(toCommentList(null)).toEqual([])
  })
})

describe('threadsFor', () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => toComment({ id, nodeId: 'n', ...over })
  it('groups replies under roots, sorts roots by anchor position then createdMs', () => {
    const list = [
      mk('r2', { anchorJson: { type: 'text', quote: 'b', prefix: '', suffix: '', start: 90, end: 91 }, createdMs: 1 }),
      mk('r1', { anchorJson: { type: 'text', quote: 'a', prefix: '', suffix: '', start: 10, end: 11 }, createdMs: 2 }),
      mk('rep1', { parentId: 'r2', createdMs: 5 }),
      mk('rep0', { parentId: 'r2', createdMs: 3 }),
      mk('orphan', { parentId: 'missing' }),
    ]
    const threads = threadsFor(list)
    expect(threads.map((t) => t.root.id)).toEqual(['r1', 'r2'])
    expect(threads[1].replies.map((r) => r.id)).toEqual(['rep0', 'rep1'])
  })
  it('sorts pin roots by y and unanchored roots (anchor null) last by createdMs', () => {
    const threads = threadsFor([
      mk('pin', { anchorJson: { type: 'pin', x: 0.1, y: 0.9 }, createdMs: 9 }),
      mk('none', { createdMs: 1 }),
      mk('txt', { anchorJson: { type: 'text', quote: 'q', prefix: '', suffix: '', start: 1, end: 2 } }),
    ])
    expect(threads.map((t) => t.root.id)).toEqual(['txt', 'pin', 'none'])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm test:run src/lib/comments.test.ts`
Expected: FAIL — cannot resolve `./comments`.

- [ ] **Step 4: Implement `src/lib/comments.ts`**

Follow the `toNode` style (never throw; coerce field-by-field). Key implementation points:

```ts
/**
 * Comment coercion + threading helpers. Both live pipeline responses and MSW
 * mocks pass through `toComment()` — the same single-seam contract as `toNode`.
 */

export interface CommentAnchorText {
  type: 'text'
  quote: string
  prefix: string
  suffix: string
  start: number
  end: number
}
export interface CommentAnchorPin {
  type: 'pin'
  /** Fractions of the image's natural width/height, 0..1. */
  x: number
  y: number
}
export type CommentAnchor = CommentAnchorText | CommentAnchorPin

export interface HandoffComment {
  id: string
  nodeId: string
  /** Null for thread roots; the root comment's id for replies. */
  parentId: string | null
  authorId: string
  authorName: string
  body: string
  /** Roots only; replies carry null. */
  anchor: CommentAnchor | null
  resolved: boolean
  resolvedBy: string | null
  resolvedMs: number | null
  /** emoji → user ids who reacted. */
  reactions: Record<string, string[]>
  /** Soft-deleted root husk (kept so its replies survive). */
  deleted: boolean
  createdMs: number
  updatedMs: number | null
}

function parseAnchor(raw: unknown): CommentAnchor | null {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.type === 'text') {
    const start = Number(o.start), end = Number(o.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null
    return {
      type: 'text',
      quote: typeof o.quote === 'string' ? o.quote : '',
      prefix: typeof o.prefix === 'string' ? o.prefix : '',
      suffix: typeof o.suffix === 'string' ? o.suffix : '',
      start, end,
    }
  }
  if (o.type === 'pin') {
    const x = Number(o.x), y = Number(o.y)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null
    return { type: 'pin', x, y }
  }
  return null
}

function parseReactions(raw: unknown): Record<string, string[]> {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return {} }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string[]> = {}
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(ids)) {
      const clean = ids.filter((i): i is string => typeof i === 'string')
      if (clean.length) out[k] = clean
    }
  }
  return out
}
```

Booleans arrive as `true` or the string `'true'` from the data table (same as `feedExcluded` in `toNode`) — coerce with `raw === true || raw === 'true'`. `parentId`: empty string / non-string → `null`. Numbers via `Number.isFinite` else `null` (or `0` for `createdMs`). `toCommentList` mirrors `toNodeList` but unwraps the `comments` key. `threadsFor` sort key for roots: text anchor → `anchor.start`; pin anchor → `100000 + anchor.y * 1000` (pins render after text in the list when mixed, images never mix with text in practice); null anchor → `Infinity`; tie-break `createdMs`.

- [ ] **Step 5: Run the tests and lint**

Run: `pnpm test:run src/lib/comments.test.ts` → PASS. Then `pnpm lint` (repo lints `.` + `.bffless`).

- [ ] **Step 6: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/lib/comments.ts apps/handoff/src/lib/comments.test.ts
git commit -m "feat(handoff): comment domain types + coercion seam"
```

---

### Task 2: Text-anchor engine (`src/lib/commentAnchors.ts`)

**Files:**
- Create: `apps/handoff/src/lib/commentAnchors.ts`
- Test: `apps/handoff/src/lib/commentAnchors.test.ts`

**Interfaces:**
- Consumes: `CommentAnchorText` from `./comments` (Task 1).
- Produces (used by the bridge in Task 10):
  - `interface TextIndex { text: string; nodes: Text[]; nodeStarts: number[] }`
  - `buildTextIndex(root: Node): TextIndex` — concatenated visible text of the DOM subtree, with per-text-node start offsets.
  - `anchorFromRange(index: TextIndex, range: Range): CommentAnchorText | null` — serialize a selection.
  - `resolveTextAnchor(text: string, anchor: CommentAnchorText): { start: number; end: number } | null` — pure re-anchoring against a (possibly changed) document text.
  - `rangeFromSpan(index: TextIndex, start: number, end: number, doc: Document): Range | null` — back to a DOM Range for highlighting/measuring.
  - `const CONTEXT_CHARS = 32`

- [ ] **Step 1: Write the failing tests**

The resolver is pure string logic — test it hard. `buildTextIndex`/`rangeFromSpan` run in jsdom (vitest default env for this repo's `src/` tests).

```ts
import { describe, it, expect } from 'vitest'
import {
  buildTextIndex, anchorFromRange, resolveTextAnchor, rangeFromSpan, CONTEXT_CHARS,
} from './commentAnchors'
import type { CommentAnchorText } from './comments'

const anchor = (over: Partial<CommentAnchorText>): CommentAnchorText => ({
  type: 'text', quote: 'target phrase', prefix: 'before the ', suffix: ' and after',
  start: 100, end: 113, ...over,
})

describe('resolveTextAnchor', () => {
  it('finds the exact quote at the stored offset', () => {
    const text = 'x'.repeat(100) + 'target phrase' + 'y'.repeat(50)
    expect(resolveTextAnchor(text, anchor({}))).toEqual({ start: 100, end: 113 })
  })

  it('finds the quote when it moved', () => {
    const text = 'moved! target phrase tail'
    expect(resolveTextAnchor(text, anchor({}))).toEqual({ start: 7, end: 20 })
  })

  it('disambiguates duplicates by prefix/suffix', () => {
    const text = 'aaa target phrase zzz ... before the target phrase and after'
    const r = resolveTextAnchor(text, anchor({}))
    expect(text.slice(r!.start - 11, r!.start)).toBe('before the ')
  })

  it('prefers the occurrence nearest the stored start when context ties', () => {
    const text = 'target phrase ' + 'x'.repeat(200) + 'target phrase'
    const r = resolveTextAnchor(text, anchor({ prefix: '', suffix: '', start: 210 }))
    expect(r!.start).toBe(214)
  })

  it('fuzzy-matches when whitespace changed', () => {
    const text = 'before   the\n target   phrase and  after'
    const r = resolveTextAnchor(text, anchor({}))
    expect(text.slice(r!.start, r!.end).replace(/\s+/g, ' ')).toBe('target phrase')
  })

  it('returns null when the quote is gone', () => {
    expect(resolveTextAnchor('completely different content', anchor({}))).toBeNull()
  })

  it('returns null for an empty quote', () => {
    expect(resolveTextAnchor('anything', anchor({ quote: '' }))).toBeNull()
  })
})

describe('buildTextIndex + anchorFromRange + rangeFromSpan (jsdom)', () => {
  function setup(html: string) {
    document.body.innerHTML = html
    return buildTextIndex(document.body)
  }

  it('round-trips a selection to an anchor and back', () => {
    const index = setup('<p>Hello <b>brave</b> world</p>')
    expect(index.text).toBe('Hello brave world')
    const range = document.createRange()
    const bold = document.querySelector('b')!.firstChild!
    range.setStart(bold, 0)
    range.setEnd(bold, 5)
    const a = anchorFromRange(index, range)
    expect(a).toMatchObject({ quote: 'brave', start: 6, end: 11 })
    expect(a!.prefix).toBe('Hello ')
    expect(a!.prefix.length).toBeLessThanOrEqual(CONTEXT_CHARS)

    const back = rangeFromSpan(index, a!.start, a!.end, document)
    expect(back!.toString()).toBe('brave')
  })

  it('spans element boundaries', () => {
    const index = setup('<p>one <em>two</em> three</p>')
    const r = rangeFromSpan(index, 2, 9, document) // "e two t"
    expect(r!.toString()).toBe('e two t')
  })

  it('anchorFromRange returns null for a collapsed range', () => {
    const index = setup('<p>abc</p>')
    const range = document.createRange()
    const t = document.querySelector('p')!.firstChild!
    range.setStart(t, 1); range.setEnd(t, 1)
    expect(anchorFromRange(index, range)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run src/lib/commentAnchors.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
/**
 * Text-anchor engine for viewer margin comments (spec §4).
 *
 * Anchors are W3C-Web-Annotation-style: exact quote + ≤32 chars of context +
 * character offsets into the document's concatenated text. `resolveTextAnchor`
 * is pure string logic (unit-hard); the TextIndex maps offsets ↔ DOM so the
 * bridge can build Ranges for highlighting. Resolution is read-only — stored
 * anchors are never rewritten (re-uploading old content restores its anchors).
 */
import type { CommentAnchorText } from './comments'

export const CONTEXT_CHARS = 32

export interface TextIndex {
  /** Concatenated data of every text node under the root, in document order. */
  text: string
  nodes: Text[]
  /** nodeStarts[i] = offset of nodes[i]'s first character within `text`. */
  nodeStarts: number[]
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

export function buildTextIndex(root: Node): TextIndex {
  const nodes: Text[] = []
  const nodeStarts: number[] = []
  let text = ''
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && SKIP_TAGS.has(n.parentElement.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    nodeStarts.push(text.length)
    text += (n as Text).data
  }
  return { text, nodes, nodeStarts }
}

/** Map a text offset to (text node, in-node offset). Binary search over nodeStarts. */
function domPosition(index: TextIndex, pos: number): { node: Text; offset: number } | null {
  const { nodes, nodeStarts } = index
  if (!nodes.length || pos < 0 || pos > index.text.length) return null
  let lo = 0, hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (nodeStarts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  const offset = Math.min(pos - nodeStarts[lo], nodes[lo].data.length)
  return { node: nodes[lo], offset }
}

export function anchorFromRange(index: TextIndex, range: Range): CommentAnchorText | null {
  if (range.collapsed) return null
  // Offset of a boundary = start of its text node + boundary offset; for
  // element boundaries, walk to the nearest text position by comparing with
  // each node via range comparison (keep it simple: build a probe range).
  const start = textOffsetOf(index, range.startContainer, range.startOffset)
  const end = textOffsetOf(index, range.endContainer, range.endOffset)
  if (start == null || end == null || end <= start) return null
  const quote = index.text.slice(start, end)
  if (!quote.trim()) return null
  return {
    type: 'text',
    quote,
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: index.text.slice(end, end + CONTEXT_CHARS),
    start,
    end,
  }
}

function textOffsetOf(index: TextIndex, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const i = index.nodes.indexOf(container as Text)
    if (i < 0) return null
    return index.nodeStarts[i] + Math.min(offset, (container as Text).data.length)
  }
  // Element container: the boundary sits before `container.childNodes[offset]`.
  // Find the first indexed text node at/after that point in document order.
  const doc = container.ownerDocument!
  const probe = doc.createRange()
  probe.setStart(container, offset)
  for (let i = 0; i < index.nodes.length; i++) {
    const r = doc.createRange()
    r.selectNodeContents(index.nodes[i])
    if (probe.compareBoundaryPoints(Range.START_TO_START, r) <= 0) return index.nodeStarts[i]
  }
  return index.text.length
}

export function rangeFromSpan(
  index: TextIndex, start: number, end: number, doc: Document,
): Range | null {
  const s = domPosition(index, start)
  const e = domPosition(index, end)
  if (!s || !e) return null
  const range = doc.createRange()
  range.setStart(s.node, s.offset)
  range.setEnd(e.node, e.offset)
  return range
}

/** Score an exact-quote occurrence: context agreement, then distance from the stored start. */
function scoreOccurrence(text: string, at: number, a: CommentAnchorText): number {
  const pre = text.slice(Math.max(0, at - a.prefix.length), at)
  const suf = text.slice(at + a.quote.length, at + a.quote.length + a.suffix.length)
  let score = 0
  if (a.prefix && pre === a.prefix) score += 2
  if (a.suffix && suf === a.suffix) score += 2
  return score
}

export function resolveTextAnchor(
  text: string, anchor: CommentAnchorText,
): { start: number; end: number } | null {
  if (!anchor.quote) return null

  // Pass 1: exact occurrences, best context score, nearest to stored start.
  const hits: number[] = []
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    hits.push(at)
    if (hits.length > 200) break // pathological duplication — bail to nearest
  }
  if (hits.length) {
    let best = hits[0], bestScore = -1
    for (const at of hits) {
      const s = scoreOccurrence(text, at, anchor) * 1_000_000 - Math.abs(at - anchor.start)
      if (s > bestScore) { bestScore = s; best = at }
    }
    return { start: best, end: best + anchor.quote.length }
  }

  // Pass 2: whitespace-normalized fuzzy match. Build a normalized copy of the
  // document text with an offset map back to raw positions, then search for the
  // normalized quote in it.
  const rawToNorm: number[] = []
  let norm = ''
  let lastWasSpace = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (!lastWasSpace) { rawToNorm.push(i); norm += ' '; lastWasSpace = true }
    } else {
      rawToNorm.push(i); norm += ch; lastWasSpace = false
    }
  }
  const normQuote = anchor.quote.replace(/\s+/g, ' ').trim()
  if (!normQuote) return null
  const at = norm.indexOf(normQuote)
  if (at < 0) return null
  const rawStart = rawToNorm[at]
  const lastIdx = at + normQuote.length - 1
  const rawEnd = rawToNorm[lastIdx] + 1
  return { start: rawStart, end: rawEnd }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:run src/lib/commentAnchors.test.ts` → PASS. Adjust only implementation (not test expectations) until green.

- [ ] **Step 5: Commit**

```bash
cd /home/rico/bffless/repos/apps
git add apps/handoff/src/lib/commentAnchors.ts apps/handoff/src/lib/commentAnchors.test.ts
git commit -m "feat(handoff): text-anchor engine — serialize, fuzzy re-anchor, DOM round-trip"
```

---

### Task 3: `handoff_comments` schema + `GET /api/comments` rule

**Files:**
- Create: `apps/handoff/.bffless/proxy-rules/handoff/schemas/handoff_comments.schema.yaml`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/get/rule.yaml`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/get/pre.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/get/gate.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/get/shape.fn.ts`
- Test: `apps/handoff/src/lib/commentsListRule.test.ts`

**Interfaces:**
- Consumes: `_shared/acl.ts` (`evalAccess`, `folderChain`, `idOf`, `rank`, types), test harness `src/test/proxyRules.ts` (`loadProxyRules`, `compileHandler`).
- Produces: `GET /api/comments?nodeId=<uuid>` → `{ "comments": [...] }` (raw records; soft-deleted roots stripped to husks `{ id, nodeId, parentId, deleted: true, createdMs }`). Responses: 200 / 400 (bad or missing nodeId / node not found) / 401 / 403. Schema name `handoff_comments` (referenced as `$schema:handoff_comments`).

- [ ] **Step 1: Write the schema**

`schemas/handoff_comments.schema.yaml` (no `id:` — the table doesn't exist yet; `rules push` creates it by name, per `bffless/README.md` "data-table-by-name resolution"):

```yaml
name: handoff_comments
fields:
  - name: nodeId
    type: string
    required: true
  - name: parentId
    type: string
    required: false
  - name: authorId
    type: string
    required: true
  - name: authorName
    type: string
    required: false
  - name: body
    type: string
    required: false
  - name: anchorJson
    type: json
    required: false
  - name: resolved
    type: boolean
    required: false
  - name: resolvedBy
    type: string
    required: false
  - name: resolvedMs
    type: number
    required: false
  - name: reactionsJson
    type: json
    required: false
  - name: deleted
    type: boolean
    required: false
  - name: createdMs
    type: number
    required: false
  - name: updatedMs
    type: number
    required: false
```

(`body` is required-in-API but not required-in-schema: soft delete clears it to `''`.)

- [ ] **Step 2: Write the failing rule test**

`src/lib/commentsListRule.test.ts` — copy the structure of `deleteNodeRule.test.ts` (compile real YAML via `loadProxyRules`, execute the gate with fixture rows). Include the shared `utils`/`token` helpers verbatim from that file:

```ts
// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { loadProxyRules, compileHandler } from '../test/proxyRules'

const proxy = await loadProxyRules()
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'GET')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

const FOLDER = '00000000-0000-4000-8000-0000000000b1'
const FILE = '00000000-0000-4000-8000-0000000000f1'

const utils = {
  verify: (body: string, sig: string) => sig === `sig-${body}`,
  base64urlDecode: (b: string) => Buffer.from(b, 'base64url').toString('utf8'),
}
function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.sig-${body}`
}

const folderRow = (grants: unknown[] = []) => ({
  id: FOLDER, nodeType: 'folder', parentId: 'root', ownerId: 'alice',
  grantsJson: JSON.stringify(grants), mode: 'inheriting',
})
const fileRow = { id: FILE, nodeType: 'file', parentId: FOLDER, ownerId: 'alice' }

it('schema handoff_comments is exported with the comment fields', () => {
  const schema = proxy.schemas.find((s) => s.name === 'handoff_comments')
  expect(schema).toBeDefined()
  const names = schema!.fields.map((f: any) => f.name)
  for (const f of ['nodeId', 'parentId', 'authorId', 'body', 'anchorJson', 'resolved', 'reactionsJson', 'deleted', 'createdMs']) {
    expect(names).toContain(f)
  }
})

it('rule exists and the comments query is gated on steps.gate.allow', () => {
  expect(rule).toBeDefined()
  expect(step('comments').config.condition).toBe('steps.gate.allow')
  expect(step('comments').config.schemaId).toBe('$schema:handoff_comments')
})

describe('gate', () => {
  const gate = compileHandler(step('gate').config.code)
  const run = (opts: { user?: any; cookie?: string; node?: any; folders?: any[]; pre?: any }) =>
    gate({
      user: opts.user ?? null,
      request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
      utils,
      steps: { pre: opts.pre ?? { idOk: true }, allFolders: opts.folders ?? [folderRow()], query: opts.node ?? fileRow },
    })

  it('owner reads', () => expect(run({ user: { id: 'alice' } }).allow).toBe(true))
  it('admin reads', () => expect(run({ user: { id: 'zed', role: 'admin' } }).allow).toBe(true))
  it('granted viewer reads', () =>
    expect(run({ user: { id: 'bob' }, folders: [folderRow([{ principalId: 'bob', level: 'view' }])] }).allow).toBe(true))
  it('share-cookie visitor reads (folder in chain)', () =>
    expect(run({ cookie: `hf_s=${token({ s: FOLDER, exp: Date.now() + 60000 })}` }).allow).toBe(true))
  it('anon → 401', () => {
    const r = run({})
    expect(r.allow).toBe(false); expect(r.deny401).toBe(true); expect(r.deny403).toBe(false)
  })
  it('ungranted user → 403', () => {
    const r = run({ user: { id: 'mallory' } })
    expect(r.allow).toBe(false); expect(r.deny403).toBe(true)
  })
  it('bad nodeId → badRequest', () =>
    expect(run({ user: { id: 'alice' }, pre: { idOk: false }, node: null }).badRequest).toBe(true))
})

describe('shape', () => {
  const shape = compileHandler(step('shape').config.code)
  it('passes live comments through and strips soft-deleted roots to husks', () => {
    const out = shape({
      steps: {
        comments: [
          { id: 'c1', nodeId: FILE, parentId: '', authorId: 'u1', authorName: 'a@b', body: 'hi', createdMs: 1 },
          { id: 'c2', nodeId: FILE, parentId: '', authorId: 'u2', authorName: 'x@y', body: 'secret', deleted: true, createdMs: 2 },
        ],
      },
    } as any)
    const list = JSON.parse(out.comments)
    expect(list[0].body).toBe('hi')
    expect(list[1]).toEqual({ id: 'c2', nodeId: FILE, parentId: '', deleted: true, createdMs: 2 })
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:run src/lib/commentsListRule.test.ts` → FAIL (`no rule` / rule undefined).

- [ ] **Step 4: Write the rule**

`rules/api/comments/get/pre.fn.ts`:

```ts
import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const q = (request && request.query) || ({} as Record<string, unknown>);
  const nodeId = String((q as { nodeId?: unknown }).nodeId || '');
  return { nodeId: nodeId, idOk: !!nodeId && UUID.test(nodeId) };
}
```

`rules/api/comments/get/gate.fn.ts` — copy `rules/api/node/get/gate.fn.ts` **verbatim** (including `readCookie` + `verifyToken` + the chain build) with these changes: import path stays `../../../../_shared/acl` (comments/get is the same depth as node/get: `rules/api/comments/get/` → four `../`); add `pre` to `GateSteps` and compute `badRequest`:

```ts
interface GateSteps {
  pre?: { idOk?: boolean };
  allFolders?: NodeRow[];
  query?: NodeRow | null;
}
// ...inside handler, after `node` is normalized:
const pre = (s.pre || {}) as { idOk?: boolean };
const badRequest = pre.idOk !== true || !node;
// level/allow exactly as node/get computes them (allow = level !== 'none'), then:
const hasCred = !!uid || !!shareFolderId;
const deny401 = !badRequest && !allow && !hasCred;
const deny403 = !badRequest && !allow && hasCred;
return { allow: !badRequest && allow, badRequest: badRequest, deny401: deny401, deny403: deny403, level: level };
```

`rules/api/comments/get/shape.fn.ts`:

```ts
/**
 * Shape the comment listing. Soft-deleted roots (kept so their replies
 * survive) go out as husks: id/nodeId/parentId/deleted/createdMs only — no
 * body, author, anchor, or reactions leak after deletion.
 */
import type { HandlerContext } from 'bffless/handlers';

interface Row { [key: string]: unknown }

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as { comments?: Row[] };
  const rows: Row[] = Array.isArray(s.comments) ? s.comments : [];
  const out: Row[] = [];
  for (const raw of rows) {
    const r = raw || ({} as Row);
    const id = r.id || r.recordId || r.record_id || null;
    if (!id) continue;
    const isDeleted = r.deleted === true || r.deleted === 'true';
    if (isDeleted) {
      out.push({ id: id, nodeId: r.nodeId, parentId: r.parentId || '', deleted: true, createdMs: r.createdMs });
      continue;
    }
    out.push({
      id: id, nodeId: r.nodeId, parentId: r.parentId || '',
      authorId: r.authorId, authorName: r.authorName || '',
      body: r.body || '', anchorJson: r.anchorJson || null,
      resolved: r.resolved === true || r.resolved === 'true',
      resolvedBy: r.resolvedBy || null, resolvedMs: r.resolvedMs || null,
      reactionsJson: r.reactionsJson || null,
      deleted: false, createdMs: r.createdMs, updatedMs: r.updatedMs || null,
    });
  }
  return { comments: JSON.stringify(out) };
}
```

`rules/api/comments/get/rule.yaml`:

```yaml
targetUrl: pipeline
order: 20
pipeline:
  name: Handoff list comments
  description: List comments for a node — read-gated (view+) per-folder ACL incl. hf_s share-cookie visitors (spec §7).
  steps:
    - id: pre
      name: pre
      handler: function_handler
      code: ./pre.fn.ts
    - id: query
      name: query
      handler: data_query
      config:
        recordId: request.query.nodeId
        schemaId: $schema:handoff_nodes
        condition: steps.pre.idOk
    - id: allFolders
      name: allFolders
      handler: data_query
      config:
        filters:
          nodeType:
            op: in
            value:
              - folder
              - root
        pageSize: 500
        schemaId: $schema:handoff_nodes
    - id: gate
      name: gate
      handler: function_handler
      code: ./gate.fn.ts
    - id: comments
      name: comments
      handler: data_query
      config:
        filters:
          nodeId:
            op: eq
            value: request.query.nodeId
        pageSize: 500
        schemaId: $schema:handoff_comments
        condition: steps.gate.allow
    - id: shape
      name: shape
      handler: function_handler
      code: ./shape.fn.ts
      config:
        condition: steps.gate.allow
    - id: ok
      name: ok
      handler: response_handler
      config:
        body: '{"comments": {{{steps.shape.comments}}}}'
        status: 200
        condition: steps.gate.allow
        contentType: application/json
    - id: bad
      name: bad
      handler: response_handler
      config:
        body: '{"error":"invalid request"}'
        status: 400
        condition: steps.gate.badRequest
        contentType: application/json
    - id: deny401
      name: deny401
      handler: response_handler
      config:
        body: '{"error":"unauthorized"}'
        status: 401
        condition: steps.gate.deny401
        contentType: application/json
    - id: deny403
      name: deny403
      handler: response_handler
      config:
        body: '{"error":"forbidden"}'
        status: 403
        condition: steps.gate.deny403
        contentType: application/json
description: List comments for a node (margin comments, spec 2026-07-28)
```

- [ ] **Step 5: Verify**

Run: `pnpm test:run src/lib/commentsListRule.test.ts` → PASS.
Run: `pnpm typecheck:rules` → clean.
Run: `cd /home/rico/bffless/repos/apps && npx bffless rules validate apps/handoff/.bffless/proxy-rules/handoff` (exact invocation per `npx bffless rules validate --help` if it differs) → valid.

- [ ] **Step 6: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/schemas/handoff_comments.schema.yaml \
        apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/get \
        apps/handoff/src/lib/commentsListRule.test.ts
git commit -m "feat(handoff): handoff_comments schema + GET /api/comments rule (read-gated)"
```

---

### Task 4: `POST /api/comments` rule (create root / reply)

**Files:**
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/post/rule.yaml`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/post/pre.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/post/gate.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/post/shape.fn.ts`
- Test: `apps/handoff/src/lib/commentsCreateRule.test.ts`

**Interfaces:**
- Produces: `POST /api/comments` body `{ nodeId, body, parentId?, anchor? }` → 200 `{ "comment": {...} }`. Server stamps `authorId` (`user.id`), `authorName` (`steps.gate.authorName` from `user.email`), `createdMs` (`now()`), `reactionsJson: "{}"`. Rejections: 400 invalid body / node missing / reply target invalid; **401 when no session user (share cookie alone is NOT enough to write)**; 403 session user without view.

- [ ] **Step 1: Write the failing rule test**

`src/lib/commentsCreateRule.test.ts` — same harness/fixtures as Task 3 (redeclare `utils`, `token`, `folderRow`, `fileRow`, `FOLDER`, `FILE` — tests are read standalone). Test the gate:

```ts
const rule = proxy.rules.find((r) => r.pathPattern === '/api/comments' && r.method === 'POST')
const gate = compileHandler(step('gate').config.code)
const ROOT_COMMENT = '00000000-0000-4000-8000-0000000000c1'

const goodPre = {
  ok: true, isReply: false, bodyValue: 'hi', parentIdValue: '',
  anchorValue: '{"type":"text","quote":"q","prefix":"","suffix":"","start":1,"end":2}',
}
const run = (opts: { user?: any; cookie?: string; pre?: any; node?: any; folders?: any[]; parentComment?: any }) =>
  gate({
    user: opts.user ?? null,
    request: { headers: opts.cookie ? { cookie: opts.cookie } : {} },
    utils,
    steps: {
      pre: opts.pre ?? goodPre,
      allFolders: opts.folders ?? [folderRow([{ principalId: 'bob', level: 'view' }])],
      query: opts.node ?? fileRow,
      parentComment: opts.parentComment ?? null,
    },
  })

it('a granted viewer with a session may comment', () => {
  const r = run({ user: { id: 'bob', email: 'bob@x.y' } })
  expect(r.allow).toBe(true)
  expect(r.authorName).toBe('bob@x.y')
})
it('share-cookie visitor CANNOT write → 401', () => {
  const r = run({ cookie: `hf_s=${token({ s: FOLDER, exp: Date.now() + 60000 })}` })
  expect(r.allow).toBe(false); expect(r.deny401).toBe(true)
})
it('anon → 401; sessioned but ungranted → 403', () => {
  expect(run({}).deny401).toBe(true)
  const r = run({ user: { id: 'mallory' }, folders: [folderRow()] })
  expect(r.deny403).toBe(true)
})
it('owner and admin may comment', () => {
  expect(run({ user: { id: 'alice' }, folders: [folderRow()] }).allow).toBe(true)
  expect(run({ user: { id: 'z', role: 'admin' }, folders: [folderRow()] }).allow).toBe(true)
})
it('reply must target an existing ROOT comment on the SAME node', () => {
  const replyPre = { ...goodPre, isReply: true, parentIdValue: ROOT_COMMENT, anchorValue: '' }
  const rootOk = { id: ROOT_COMMENT, nodeId: FILE, parentId: '' }
  expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: rootOk }).allow).toBe(true)
  expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: null }).badRequest).toBe(true)
  expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, nodeId: 'other' } }).badRequest).toBe(true)
  expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, parentId: ROOT_COMMENT } }).badRequest).toBe(true)
  expect(run({ user: { id: 'bob' }, pre: replyPre, parentComment: { ...rootOk, deleted: true } }).badRequest).toBe(true)
})
it('create step stamps server-owned fields', () => {
  const create = step('create')
  expect(create.config.condition).toBe('steps.gate.allow')
  expect(create.config.fields.authorId).toBe('user.id')
  expect(create.config.fields.createdMs).toBe('now()')
  expect(create.config.fields.authorName).toBe('steps.gate.authorName')
  expect(create.config.fields.reactionsJson).toBe('"{}"')
})
```

Also test `pre` directly (`compileHandler(step('pre').config.code)`): body length caps (empty body → `ok:false`; 5001-char body → `ok:false`), non-object anchor → `anchorValue: ''`, anchor serialized as a JSON string, bad `parentId` (non-UUID) → `ok:false`.

- [ ] **Step 2: Run to verify failure** — `pnpm test:run src/lib/commentsCreateRule.test.ts` → FAIL.

- [ ] **Step 3: Write the rule**

`pre.fn.ts`:

```ts
import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY = 5000;

interface Body { nodeId?: unknown; body?: unknown; parentId?: unknown; anchor?: unknown }

/** Validate an anchor object; returns its JSON string or '' when absent/invalid. */
function anchorString(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const o = raw as Record<string, unknown>;
  if (o.type === 'text') {
    const start = Number(o.start), end = Number(o.end);
    if (!isFinite(start) || !isFinite(end) || start < 0 || end < start) return '';
    return JSON.stringify({
      type: 'text',
      quote: String(o.quote || '').slice(0, 1000),
      prefix: String(o.prefix || '').slice(0, 64),
      suffix: String(o.suffix || '').slice(0, 64),
      start: start, end: end,
    });
  }
  if (o.type === 'pin') {
    const x = Number(o.x), y = Number(o.y);
    if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return '';
    return JSON.stringify({ type: 'pin', x: x, y: y });
  }
  return '';
}

export default function handler({ request }: HandlerContext) {
  const b: Body = ((request && request.body) as Body) || {};
  const nodeId = String(b.nodeId || '');
  const parentId = b.parentId == null ? '' : String(b.parentId);
  const bodyText = typeof b.body === 'string' ? b.body : '';
  const trimmed = bodyText.replace(/^\s+|\s+$/g, '');

  const nodeOk = !!nodeId && UUID.test(nodeId);
  const parentOk = parentId === '' || UUID.test(parentId);
  const bodyOk = trimmed.length > 0 && trimmed.length <= MAX_BODY;
  const isReply = parentOk && parentId !== '';

  return {
    ok: nodeOk && parentOk && bodyOk,
    isReply: isReply,
    bodyValue: trimmed,
    parentIdValue: isReply ? parentId : '',
    anchorValue: isReply ? '' : anchorString(b.anchor),
  };
}
```

`gate.fn.ts` — same skeleton as Task 3's gate (`readCookie`/`verifyToken`/viewer/chain), with the write twist:

```ts
export default function handler({ user, request, steps, utils }: HandlerContext) {
  // ...viewer construction identical to comments/get gate...
  const s = (steps || {}) as GateSteps; // { pre, allFolders, query, parentComment }
  const pre = s.pre || {};
  const folders: NodeRow[] = s.allFolders || [];
  let node: NodeRow | null = s.query || null;
  if (!(node && typeof node === 'object' && idOf(node))) node = null;

  // Reply target validation: must exist, be a live root, and belong to this node.
  let replyOk = true;
  if (pre.isReply === true) {
    const pc = s.parentComment;
    const pcId = pc ? (pc.id || pc.recordId || pc.record_id || null) : null;
    const pcDeleted = !!pc && (pc.deleted === true || pc.deleted === 'true');
    replyOk = !!pcId && !pcDeleted && !pc!.parentId && String(pc!.nodeId || '') === String((node && node.nodeIdSelf) || (request.body && (request.body as { nodeId?: unknown }).nodeId) || '');
  }
  const badRequest = pre.ok !== true || !node || !replyOk;

  let level: AccessLevel = 'none';
  if (node) {
    const nid = idOf(node) as string;
    const ch = folderChain(folders, node.parentId);
    ch.push({ id: nid, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    level = evalAccess(ch, viewer);
  }

  // WRITE rule (spec §7): a session user id is mandatory — hf_s alone never writes.
  const allow = !badRequest && !!uid && rank(level) >= 1;
  const deny401 = !badRequest && !allow && !uid;         // no session (incl. cookie-only visitor)
  const deny403 = !badRequest && !allow && !!uid;        // sessioned but no view access

  const email = ((user && (user as { email?: unknown }).email) || '') as string;
  return {
    allow: allow, badRequest: badRequest, deny401: deny401, deny403: deny403,
    authorName: String(email || ''),
    level: level,
  };
}
```

(Note the reply nodeId comparison reads `request.body.nodeId` — the node row's own id is `idOf(node)`; compare `String(pc.nodeId) === String(idOf(node))`. Implement it that way; the sketch above shows intent, the test pins behavior.)

`shape.fn.ts` — emit the created record (from `steps.create`) in the same field layout as Task 3's shape (single record, not husk):

```ts
import type { HandlerContext } from 'bffless/handlers';

interface Row { [key: string]: unknown }

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as { create?: Row };
  const r: Row = (s.create && typeof s.create === 'object' ? s.create : {}) as Row;
  const id = r.id || r.recordId || r.record_id || null;
  return {
    comment: JSON.stringify({
      id: id, nodeId: r.nodeId, parentId: r.parentId || '',
      authorId: r.authorId, authorName: r.authorName || '',
      body: r.body || '', anchorJson: r.anchorJson || null,
      resolved: false, resolvedBy: null, resolvedMs: null,
      reactionsJson: r.reactionsJson || null, deleted: false,
      createdMs: r.createdMs, updatedMs: null,
    }),
  };
}
```

`rule.yaml` (order 21):

```yaml
targetUrl: pipeline
order: 21
pipeline:
  name: Handoff create comment
  description: Create a comment root or reply — requires a session user (401 for share-cookie/anon) AND view+ on the node (spec §7).
  steps:
    - id: pre
      name: pre
      handler: function_handler
      code: ./pre.fn.ts
    - id: query
      name: query
      handler: data_query
      config:
        recordId: request.body.nodeId
        schemaId: $schema:handoff_nodes
        condition: steps.pre.ok
    - id: parentComment
      name: parentComment
      handler: data_query
      config:
        recordId: request.body.parentId
        schemaId: $schema:handoff_comments
        condition: steps.pre.isReply
    - id: allFolders
      name: allFolders
      handler: data_query
      config:
        filters:
          nodeType:
            op: in
            value:
              - folder
              - root
        pageSize: 500
        schemaId: $schema:handoff_nodes
    - id: gate
      name: gate
      handler: function_handler
      code: ./gate.fn.ts
    - id: create
      name: create
      handler: data_create
      config:
        fields:
          nodeId: request.body.nodeId
          parentId: steps.pre.parentIdValue
          authorId: user.id
          authorName: steps.gate.authorName
          body: steps.pre.bodyValue
          anchorJson: steps.pre.anchorValue
          resolved: false
          deleted: false
          reactionsJson: '"{}"'
          createdMs: now()
        schemaId: $schema:handoff_comments
        condition: steps.gate.allow
    - id: shape
      name: shape
      handler: function_handler
      code: ./shape.fn.ts
      config:
        condition: steps.gate.allow
    - id: ok
      name: ok
      handler: response_handler
      config:
        body: '{"comment": {{{steps.shape.comment}}}}'
        status: 200
        condition: steps.gate.allow
        contentType: application/json
    - id: bad
      name: bad
      handler: response_handler
      config:
        body: '{"error":"invalid request"}'
        status: 400
        condition: steps.gate.badRequest
        contentType: application/json
    - id: deny401
      name: deny401
      handler: response_handler
      config:
        body: '{"error":"unauthorized"}'
        status: 401
        condition: steps.gate.deny401
        contentType: application/json
    - id: deny403
      name: deny403
      handler: response_handler
      config:
        body: '{"error":"forbidden"}'
        status: 403
        condition: steps.gate.deny403
        contentType: application/json
description: Create a margin comment or reply (spec 2026-07-28)
```

(Check how `grantsJson: "[]"` is quoted in `share-links/post/rule.yaml:37` — mirror that quoting for the literal `reactionsJson` `{}` value; if a literal-vs-path ambiguity arises, move the literal into the gate return and reference `steps.gate.emptyReactions`.)

- [ ] **Step 4: Verify** — `pnpm test:run src/lib/commentsCreateRule.test.ts` → PASS; `pnpm typecheck:rules` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/post apps/handoff/src/lib/commentsCreateRule.test.ts
git commit -m "feat(handoff): POST /api/comments — session+view write gate, root/reply create"
```

---

### Task 5: `PATCH /api/comments` rule (edit / resolve / reopen / react)

**Files:**
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/patch/rule.yaml`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/patch/pre.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/patch/gate.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/patch/shape.fn.ts`
- Test: `apps/handoff/src/lib/commentsPatchRule.test.ts`

**Interfaces:**
- Produces: `PATCH /api/comments` body `{ id, op: 'edit'|'resolve'|'reopen'|'react', body?, emoji? }` → 200 `{ "comment": {...} }` (the re-read record, same shape as Task 4). `edit`: author only, sets `body` + `updatedMs`. `resolve`/`reopen`: any session user with view, roots only, sets `resolved`/`resolvedBy`/`resolvedMs`. `react`: toggles the caller's id in `reactionsJson[emoji]`. 400/401/403 as before.

- [ ] **Step 1: Write the failing rule test**

Gate cases to pin (same fixture style; comment fixture `{ id: COMMENT, nodeId: FILE, parentId: '', authorId: 'bob', body: 'old', reactionsJson: '{"👍":["alice"]}', resolved: false }`):

```ts
// op: edit
it('author edits own comment', () => { const r = run({ user: { id: 'bob' }, pre: editPre }); expect(r.doEdit).toBe(true); expect(r.newBody).toBe('new text'); expect(typeof r.nowMs).toBe('number') })
it('non-author (even admin) cannot edit body → 403', () => {
  expect(run({ user: { id: 'alice' }, pre: editPre }).deny403).toBe(true)
  expect(run({ user: { id: 'z', role: 'admin' }, pre: editPre }).deny403).toBe(true)
})
// op: resolve / reopen
it('any viewer with session resolves a root; resolvedBy is the caller', () => {
  const r = run({ user: { id: 'alice' }, pre: resolvePre })
  expect(r.doResolve).toBe(true); expect(r.newResolved).toBe(true); expect(r.resolvedBy).toBe('alice')
})
it('reopen sets newResolved false', () => expect(run({ user: { id: 'alice' }, pre: reopenPre }).newResolved).toBe(false))
it('resolve on a reply → badRequest', () =>
  expect(run({ user: { id: 'alice' }, pre: resolvePre, comment: { ...commentRow, parentId: ROOT } }).badRequest).toBe(true))
// op: react
it('react toggles the caller in/out and drops empty arrays', () => {
  const on = run({ user: { id: 'bob' }, pre: reactPre })   // 👍 not yet by bob
  expect(JSON.parse(on.newReactionsJson)).toEqual({ '👍': ['alice', 'bob'] })
  const off = run({ user: { id: 'alice' }, pre: reactPre }) // alice already reacted
  expect(JSON.parse(off.newReactionsJson)).toEqual({})
})
// common
it('share-cookie only → 401 for every op', () => { /* run each op with cookie, expect deny401 */ })
it('soft-deleted comment → badRequest for every op', () => { /* comment: {...commentRow, deleted: true} */ })
it('exactly one do* flag true per op', () => { /* assert doEdit ^ doResolve ^ doReact per pre */ })
```

Also assert step wiring: `step('editUpdate').config.condition === 'steps.gate.doEdit'`, `resolveUpdate` → `doResolve`, `reactUpdate` → `doReact`, `final` → `steps.gate.okFlag`, and all three updates use `recordId: request.body.id` + `schemaId: $schema:handoff_comments`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Write the rule**

`pre.fn.ts` — parse `{ id, op, body, emoji }`: `idOk` (UUID), `op` ∈ {edit,resolve,reopen,react}; `newBody` trimmed 1..5000 for edit; `emoji` a non-empty string ≤ 16 chars for react. Return `{ idOk, op, opOk, newBody, bodyOk, emoji, emojiOk }`.

`gate.fn.ts` — standard viewer/chain skeleton over `steps: { pre, comment, query (node), allFolders }`, then:

```ts
const c = s.comment && idOf(s.comment as NodeRow) ? (s.comment as Row) : null;
const cDeleted = !!c && (c.deleted === true || c.deleted === 'true');
const isRoot = !!c && !c.parentId;
const isAuthor = !!c && !!uid && String(c.authorId || '') === uid;

const opOk =
  pre.opOk === true &&
  (pre.op !== 'edit' || pre.bodyOk === true) &&
  (pre.op !== 'react' || pre.emojiOk === true) &&
  ((pre.op !== 'resolve' && pre.op !== 'reopen') || isRoot);

const badRequest = pre.idOk !== true || !c || cDeleted || !node || !opOk;

const canRead = !!uid && rank(level) >= 1;            // all ops need session + view
const permitted =
  pre.op === 'edit' ? canRead && isAuthor : canRead;   // edit additionally author-only

const allow = !badRequest && permitted;
const deny401 = !badRequest && !allow && !uid;
const deny403 = !badRequest && !allow && !!uid;

// react toggle — computed here because data_update can only write literals/paths
let reactions: Record<string, unknown> = {};
try { reactions = JSON.parse(String((c && c.reactionsJson) || '{}')) || {}; } catch { reactions = {}; }
if (allow && pre.op === 'react' && uid) {
  const key = String(pre.emoji);
  const cur = Array.isArray(reactions[key]) ? (reactions[key] as unknown[]).map(String) : [];
  const next = cur.indexOf(uid) >= 0 ? cur.filter((u) => u !== uid) : cur.concat([uid]);
  if (next.length) reactions[key] = next; else delete reactions[key];
}

return {
  badRequest: badRequest, deny401: deny401, deny403: deny403,
  doEdit: allow && pre.op === 'edit',
  doResolve: allow && (pre.op === 'resolve' || pre.op === 'reopen'),
  doReact: allow && pre.op === 'react',
  okFlag: allow,
  newBody: String(pre.newBody || ''),
  newResolved: pre.op === 'resolve',
  resolvedBy: uid || '',
  newReactionsJson: JSON.stringify(reactions),
  nowMs: Date.now(),
};
```

`rule.yaml` (order 22) steps: `pre` → `comment` (data_query `recordId: request.body.id`, `$schema:handoff_comments`, condition `steps.pre.idOk`) → `query` (node, `recordId: steps.comment.nodeId`, `$schema:handoff_nodes`, condition `steps.pre.idOk`) → `allFolders` → `gate` → three `data_update` steps:

```yaml
    - id: editUpdate
      name: editUpdate
      handler: data_update
      config:
        fields:
          body: steps.gate.newBody
          updatedMs: steps.gate.nowMs
        recordId: request.body.id
        schemaId: $schema:handoff_comments
        condition: steps.gate.doEdit
    - id: resolveUpdate
      name: resolveUpdate
      handler: data_update
      config:
        fields:
          resolved: steps.gate.newResolved
          resolvedBy: steps.gate.resolvedBy
          resolvedMs: steps.gate.nowMs
        recordId: request.body.id
        schemaId: $schema:handoff_comments
        condition: steps.gate.doResolve
    - id: reactUpdate
      name: reactUpdate
      handler: data_update
      config:
        fields:
          reactionsJson: steps.gate.newReactionsJson
        recordId: request.body.id
        schemaId: $schema:handoff_comments
        condition: steps.gate.doReact
```

then `final` (data_query re-read, condition `steps.gate.okFlag`) → `shape` (same output as Task 4's shape but reading `steps.final`) → response handlers `ok` (condition `steps.gate.okFlag`) / `bad` / `deny401` / `deny403` (exact copies of Task 4's).

`shape.fn.ts`: identical to Task 4's shape but `const r = s.final || {}` and pass through `resolved`/`resolvedBy`/`resolvedMs`/`updatedMs` from the record (with the `'true'` string coercion for `resolved`).

- [ ] **Step 4: Verify** — `pnpm test:run src/lib/commentsPatchRule.test.ts` → PASS; `pnpm typecheck:rules` → clean.

- [ ] **Step 5: Commit** — `git add` the patch route + test; `git commit -m "feat(handoff): PATCH /api/comments — edit/resolve/reopen/react ops"`.

---

### Task 6: `DELETE /api/comments` rule (author-only; soft-delete roots with replies)

**Files:**
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/delete/rule.yaml`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/delete/pre.fn.ts`
- Create: `apps/handoff/.bffless/proxy-rules/handoff/rules/api/comments/delete/gate.fn.ts`
- Test: `apps/handoff/src/lib/commentsDeleteRule.test.ts`

**Interfaces:**
- Produces: `DELETE /api/comments?id=<uuid>` → 200 `{ "id": "<id>", "soft": true|false }`. Author only (admins do NOT moderate-delete in v1). Root with ≥1 reply → soft delete (`deleted: true`, `body: ''`, `authorName: ''`, `anchorJson` kept so position survives for the husk). Root without replies, or a reply → hard `data_delete`.

- [ ] **Step 1: Write the failing rule test**

Gate cases: author deletes own reply → `doHard`; author deletes root with replies (steps.replies = `[{ id: 'x' }]`) → `doSoft` not `doHard`; author deletes root without replies → `doHard`; non-author → 403; admin non-author → 403 (pin the v1 policy!); anon → 401; missing comment → `badRequest`. Wiring: `step('softDelete').config.condition === 'steps.gate.doSoft'` with `fields: { deleted: true, body: '', authorName: '' }`… wait — literal `''` vs path ambiguity again: put the empty strings in the gate return (`emptyStr: ''`) and reference `steps.gate.emptyStr`, or use the same literal quoting as the repo uses for `parentId: ""` in `share-links/post/rule.yaml:35` (empty string literal is proven there — use `body: ""`). Assert `step('hardDelete').handler === 'data_delete'` gated on `steps.gate.doHard`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Write the rule**

`pre.fn.ts`: `{ id, idOk }` from `request.query.id` (UUID test, same as Task 3's pre but for `id`).

`gate.fn.ts` — viewer skeleton (only needs `uid`; no ACL chain required — author-only is the whole rule, but keep the standard 401/403 split):

```ts
const c = s.comment && idOf(s.comment as NodeRow) ? (s.comment as Row) : null;
const alreadyDeleted = !!c && (c.deleted === true || c.deleted === 'true');
const badRequest = pre.idOk !== true || !c || alreadyDeleted;
const isAuthor = !!c && !!uid && String(c.authorId || '') === uid;
const isRoot = !!c && !c.parentId;
const hasReplies = Array.isArray(s.replies) && s.replies.length > 0;

const allow = !badRequest && isAuthor;
const deny401 = !badRequest && !allow && !uid;
const deny403 = !badRequest && !allow && !!uid;
return {
  badRequest: badRequest, deny401: deny401, deny403: deny403,
  doSoft: allow && isRoot && hasReplies,
  doHard: allow && !(isRoot && hasReplies),
  okFlag: allow,
  softFlag: allow && isRoot && hasReplies,
};
```

`rule.yaml` (order 23) steps: `pre` → `comment` (data_query `recordId: request.query.id`, comments schema, condition `steps.pre.idOk`) → `replies` (data_query filters `parentId eq request.query.id`, `pageSize: 1`, comments schema, condition `steps.pre.idOk`) → `gate` → `softDelete` (data_update fields `deleted: true`, `body: ""`, `authorName: ""`, recordId `request.query.id`, condition `steps.gate.doSoft`) → `hardDelete` (data_delete, recordId `request.query.id`, `schemaId: $schema:handoff_comments`, condition `steps.gate.doHard` — copy the exact `data_delete` config shape from `rules/api/node/delete/rule.yaml:67`) → responses: `ok` body `'{"id":"{{steps.pre.id}}","soft":{{steps.gate.softFlag}}}'` status 200 condition `steps.gate.okFlag`, plus `bad`/`deny401`/`deny403`.

- [ ] **Step 4: Verify** — test PASS; `pnpm typecheck:rules` clean; run the **full** rule-test suite once: `pnpm test:run src/lib/comments src/lib/commentsListRule.test.ts src/lib/commentsCreateRule.test.ts src/lib/commentsPatchRule.test.ts src/lib/commentsDeleteRule.test.ts`.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): DELETE /api/comments — author-only, soft-delete roots with replies"`.

---

### Task 7: RTK Query endpoints + MSW handlers

**Files:**
- Modify: `apps/handoff/src/store/handoffApi.ts` (tagTypes line ~157; new endpoints after `updateNodeMeta` ~line 617; export hooks at the bottom where the other `use*` hooks are exported)
- Modify: `apps/handoff/src/mocks/handlers.ts` (new in-memory store + 4 handlers)
- Test: `apps/handoff/src/mocks/comments.test.ts`

**Interfaces:**
- Consumes: `toComment`, `toCommentList`, `HandoffComment`, `CommentAnchor` (Task 1); mock ACL helpers already in `handlers.ts` (`evaluateAccess`, `nodeAcl`, `nodes`).
- Produces hooks used by the UI (Tasks 9/12): `useListCommentsQuery({ nodeId })`, `useAddCommentMutation`, `usePatchCommentMutation`, `useDeleteCommentMutation`. Tag type `'Comment'` with id `LIST:<nodeId>`.

- [ ] **Step 1: Write the failing MSW test**

`src/mocks/comments.test.ts` — follow `src/mocks/shareLinks.test.ts` style (node env + direct handler invocation or msw server). Cases: POST as logged-in viewer creates and GET returns it (through `toCommentList`); POST anonymous → 401; POST by share-cookie visitor → 401; PATCH edit by non-author → 403; PATCH react toggles; DELETE root-with-reply → GET returns husk (`deleted: true`, empty body); DELETE reply → gone.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: MSW handlers**

In `handlers.ts` add an in-memory store and 4 handlers mirroring the pipeline gates exactly (the mock viewer/session mechanism already exists in the file — reuse whatever `currentUser()`/session helper the other handlers use; read it before writing):

```ts
/** Stored comment records, keyed by id. Mirrors handoff_comments. */
export const comments = new Map<string, {
  id: string; nodeId: string; parentId: string; authorId: string; authorName: string
  body: string; anchorJson: string | null; resolved: boolean; resolvedBy: string | null
  resolvedMs: number | null; reactionsJson: string; deleted: boolean
  createdMs: number; updatedMs: number | null
}>()
```

- `GET /api/comments`: 400 bad nodeId; run the same mock-ACL read check the node GET handler uses; emit husks for `deleted` rows.
- `POST /api/comments`: 401 when no mock session user; 403 when no view; validate body/parent like `pre.fn.ts`; create with `crypto.randomUUID()`, `Date.now()`.
- `PATCH /api/comments`: implement the same op table as the gate (author-only edit, root-only resolve, react toggle).
- `DELETE /api/comments`: author-only; soft/hard identical to Task 6.

- [ ] **Step 4: RTK endpoints**

In `handoffApi.ts`: `tagTypes: ['Node', 'Grant', 'ShareLink', 'Comment']`, then:

```ts
/**
 * GET /api/comments?nodeId=… → { comments: [...] } (view-gated; share-cookie ok).
 * Polled while the comment panel is open (pollingInterval at the hook call site)
 * so teammates' comments arrive without a refresh.
 */
listComments: builder.query<HandoffComment[], { nodeId: string }>({
  query: ({ nodeId }) => `api/comments?nodeId=${encodeURIComponent(nodeId)}`,
  transformResponse: toCommentList,
  providesTags: (_r, _e, { nodeId }) => [{ type: 'Comment' as const, id: `LIST:${nodeId}` }],
}),

/** POST /api/comments — create a root (anchor) or reply (parentId). Session+view. */
addComment: builder.mutation<
  HandoffComment,
  { nodeId: string; body: string; parentId?: string; anchor?: CommentAnchor }
>({
  query: ({ nodeId, body, parentId, anchor }) => ({
    url: 'api/comments',
    method: 'POST',
    body: { nodeId, body, ...(parentId ? { parentId } : {}), ...(anchor ? { anchor } : {}) },
  }),
  transformResponse: (r) => toComment((r as { comment?: unknown }).comment),
  invalidatesTags: (_r, _e, { nodeId }) => [{ type: 'Comment' as const, id: `LIST:${nodeId}` }],
}),

/**
 * PATCH /api/comments { id, op, … }. Optimistic for snappy react/resolve/edit;
 * rolled back on failure (RTK undo). Single isolated write per comment record.
 */
patchComment: builder.mutation<
  HandoffComment,
  { id: string; nodeId: string; op: 'edit' | 'resolve' | 'reopen' | 'react'; body?: string; emoji?: string; userId?: string }
>({
  query: ({ id, op, body, emoji }) => ({
    url: 'api/comments',
    method: 'PATCH',
    body: { id, op, ...(body !== undefined ? { body } : {}), ...(emoji ? { emoji } : {}) },
  }),
  transformResponse: (r) => toComment((r as { comment?: unknown }).comment),
  async onQueryStarted({ id, nodeId, op, body, emoji, userId }, { dispatch, queryFulfilled }) {
    const patch = dispatch(
      handoffApi.util.updateQueryData('listComments', { nodeId }, (draft) => {
        const c = draft.find((x) => x.id === id)
        if (!c) return
        if (op === 'edit' && body !== undefined) { c.body = body; c.updatedMs = Date.now() }
        if (op === 'resolve') c.resolved = true
        if (op === 'reopen') c.resolved = false
        if (op === 'react' && emoji && userId) {
          const cur = c.reactions[emoji] ?? []
          c.reactions[emoji] = cur.includes(userId) ? cur.filter((u) => u !== userId) : [...cur, userId]
          if (!c.reactions[emoji].length) delete c.reactions[emoji]
        }
      }),
    )
    try { await queryFulfilled } catch { patch.undo() }
  },
  invalidatesTags: (_r, _e, { nodeId }) => [{ type: 'Comment' as const, id: `LIST:${nodeId}` }],
}),

/** DELETE /api/comments?id=… — author only; server decides soft vs hard. */
deleteComment: builder.mutation<{ id: string }, { id: string; nodeId: string }>({
  query: ({ id }) => ({ url: `api/comments?id=${encodeURIComponent(id)}`, method: 'DELETE' }),
  invalidatesTags: (_r, _e, { nodeId }) => [{ type: 'Comment' as const, id: `LIST:${nodeId}` }],
}),
```

Import `toComment, toCommentList, type HandoffComment, type CommentAnchor` from `../lib/comments`. Export the four hooks alongside the existing exports.

- [ ] **Step 5: Verify** — `pnpm test:run src/mocks/comments.test.ts` → PASS; `pnpm lint`; `pnpm exec tsc -b` (app typecheck via the build config) or `pnpm build` to confirm types.

- [ ] **Step 6: Commit** — `git commit -m "feat(handoff): comments RTK endpoints + MSW mock backend"`.

---

### Task 8: Client comment gate (`src/lib/commentGate.ts`)

**Files:**
- Create: `apps/handoff/src/lib/commentGate.ts`
- Test: `apps/handoff/src/lib/commentGate.test.ts`

**Interfaces:**
- Consumes: `evaluateAccess`, `FolderLink` from `./acl`; `Session` from `./session`; `HandoffNode` from `./nodes`.
- Produces: `canComment(input: { session: Session | null; node: HandoffNode; parentNode: HandoffNode | undefined }): boolean` — true iff `session?.authenticated` and evaluated level ≥ view. (Read-only visitors are handled by the server + UI state, not this gate.)

- [ ] **Step 1: Write the failing test** — copy `src/lib/deleteGate.test.ts` structure; cases: unauthenticated → false; authenticated owner → true; authenticated with `view` grant on parent → **true** (this is the difference from `canDeleteNode`, which needs edit); authenticated stranger → false; admin → true.

- [ ] **Step 2: Implement** — copy `deleteGate.ts` verbatim, rename to `canComment`, change the last line to `return level !== 'none'`, and update the doc comment (comment authorship needs only VIEW + login; the backend enforces the full chain).

- [ ] **Step 3: Verify + commit** — `pnpm test:run src/lib/commentGate.test.ts` → PASS. `git commit -m "feat(handoff): canComment client gate (view + session)"`.

---

### Task 9: Card layout engine + comment panel components (gutter UI)

**Files:**
- Create: `apps/handoff/src/lib/commentLayout.ts`
- Test: `apps/handoff/src/lib/commentLayout.test.ts`
- Create: `apps/handoff/src/components/comments/CommentCard.tsx`
- Create: `apps/handoff/src/components/comments/CommentComposer.tsx`
- Create: `apps/handoff/src/components/comments/CommentPanel.tsx`
- Test: `apps/handoff/src/components/comments/commentPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 types + `threadsFor`; Task 7 hooks; Task 8 gate; `useSession` from `../../lib/session`.
- Produces:
  - `layoutCards(cards: { id: string; anchorY: number; height: number }[], activeId: string | null, gap?: number): Map<string, number>` — id → top-Y in document space; cards never overlap; the active card sits exactly at its `anchorY`.
  - `<CommentPanel nodeId={string} threads={CommentThread[]} positions={Map<string, number> | null} scrollTop={number} docHeight={number} activeId={string | null} onActivate={(id: string | null) => void} canWrite={boolean} draft={{ anchorY: number; anchor: CommentAnchor } | null} onDraftDone={() => void} />` — renders the ~20rem gutter: positioned cards for anchored threads (translated by `-scrollTop`), a draft composer card when `draft` is set, and sticky bottom sections "Unanchored" (threads whose id is missing from `positions`) and a "Show resolved" toggle (resolved threads hidden by default).
  - `<CommentCard thread={CommentThread} active={boolean} canWrite={boolean} onActivate={() => void} nodeId={string} />` — author + relative time + body (+"(edited)" when `updatedMs`), reactions row (toggle via `patchComment` op react), reply composer (canWrite), Resolve/Re-open button on the root, ⋯ menu with Edit/Delete for `session.user.id === comment.authorId`. Soft-deleted root renders body as *"Comment deleted"* muted text.
  - `<CommentComposer onSubmit={(body: string) => void} busy={boolean} placeholder={string} autoFocus?={boolean} />` — textarea + Post button, Cmd/Ctrl+Enter submits.

- [ ] **Step 1: Layout engine test-first**

```ts
import { describe, it, expect } from 'vitest'
import { layoutCards } from './commentLayout'

const card = (id: string, anchorY: number, height = 80) => ({ id, anchorY, height })

describe('layoutCards', () => {
  it('keeps non-overlapping cards at their anchors', () => {
    const m = layoutCards([card('a', 0), card('b', 200)], null)
    expect(m.get('a')).toBe(0); expect(m.get('b')).toBe(200)
  })
  it('pushes overlapping cards down with the gap', () => {
    const m = layoutCards([card('a', 100), card('b', 120)], null, 8)
    expect(m.get('a')).toBe(100); expect(m.get('b')).toBe(100 + 80 + 8)
  })
  it('active card is pinned at its anchor; earlier cards are pushed up', () => {
    const m = layoutCards([card('a', 100), card('b', 130)], 'b', 8)
    expect(m.get('b')).toBe(130)
    expect(m.get('a')).toBe(130 - 8 - 80) // pushed above the active card
  })
  it('input order does not matter (sorts by anchorY)', () => {
    const m = layoutCards([card('b', 200), card('a', 0)], null)
    expect(m.get('a')).toBe(0)
  })
  it('never returns negative tops', () => {
    const m = layoutCards([card('a', 0), card('b', 10)], 'b')
    expect(m.get('a')).toBeGreaterThanOrEqual(0)
  })
})
```

Implementation: sort by `anchorY`; if no active: forward pass `top = max(anchorY, prevBottom + gap)`. With active: place active at its anchor; walk backward from it (`top = min(anchorY, nextTop - gap - height)`, clamp ≥ 0 in a final forward fix-up pass), then forward from it as the no-active case.

- [ ] **Step 2: Panel component test**

`commentPanel.test.tsx` (Testing Library + jsdom, MSW active as in `nodeDetails.test.tsx` — read that file's setup and reuse its store/provider wrapper): render `CommentPanel` with two threads (one anchored via `positions`, one missing → unanchored), assert: anchored card at translated position, "Unanchored" section lists the other, resolved thread hidden until "Show resolved" clicked, composer hidden when `canWrite={false}` with a "Sign in to comment" note instead.

- [ ] **Step 3: Implement the three components**

Styling: reuse the app's Tailwind vocabulary (`border-border`, `bg-surface`, `text-ink`, `text-muted`, `bg-surface-2`, `rounded-xl`, `shadow-sm`) — see `NodeDetails.tsx` and the delete dialog in `HandoffViewer.tsx` for the idiom. Gutter container: `w-80 shrink-0 border-l border-border relative overflow-hidden`; inner canvas `absolute inset-x-0 top-0` with `height: docHeight`, `transform: translateY(-${scrollTop}px)`; cards `absolute left-3 right-3 rounded-xl border border-border bg-surface p-3 shadow-sm transition-[top] duration-150` with `top` from `layoutCards`. Card heights: measure with a `ref` + `ResizeObserver` per card, feeding real heights back into the layout input (state `Map<string, number>`, default 96). Active card gets `ring-1 ring-accent-600`. Reactions row: the toggled emoji set from `Object.keys(reactions)` plus a small "+" popover with a fixed palette `['👍','❤️','🎉','🚀','👀','😕']`. Relative time: a tiny local `timeAgo(ms)` helper in `CommentPanel.tsx` (no new dependency).

- [ ] **Step 4: Verify** — `pnpm test:run src/lib/commentLayout.test.ts src/components/comments/commentPanel.test.tsx` → PASS; `pnpm lint`.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): comment gutter — layout engine, panel, cards, composer"`.

---

### Task 10: Same-origin iframe bridge (selection, scroll, highlights, measurement)

**Files:**
- Create: `apps/handoff/src/lib/commentDocBridge.ts`
- Test: `apps/handoff/src/lib/commentDocBridge.test.ts`

**Interfaces:**
- Consumes: Task 2 (`buildTextIndex`, `anchorFromRange`, `resolveTextAnchor`, `rangeFromSpan`); Task 1 types.
- Produces the one module that touches `contentDocument` (spec §3's narrow seam):

```ts
export interface AnchoredPosition { id: string; y: number }          // document-space px
export interface SelectionInfo { anchor: CommentAnchorText; rect: { top: number; left: number; bottom: number } } // doc-space
export interface BridgeCallbacks {
  /** Fired on scroll/resize/mutation with fresh geometry. */
  onGeometry(g: { positions: AnchoredPosition[]; unresolved: string[]; scrollTop: number; docHeight: number; viewportHeight: number }): void
  /** Fired when the user finishes a non-collapsed selection (mouseup/keyup); null when cleared. */
  onSelection(sel: SelectionInfo | null): void
}
export interface CommentDocBridge {
  setAnchors(anchors: { id: string; anchor: CommentAnchorText }[]): void
  setActive(id: string | null): void        // repaints the active highlight
  scrollToAnchor(id: string): void          // smooth-scroll the iframe to the anchor
  clearSelection(): void
  detach(): void
}
export function attachCommentBridge(iframe: HTMLIFrameElement, cb: BridgeCallbacks): CommentDocBridge | null
```

- [ ] **Step 1: Write the failing test (jsdom)**

jsdom has no real iframe layout, so test the internals against a plain `Document`: export a second, lower-level factory the iframe wrapper delegates to —

```ts
export function createDocBridge(doc: Document, win: Pick<Window, 'addEventListener' | 'removeEventListener'> & { CSS?: unknown }, cb: BridgeCallbacks): CommentDocBridge
```

Tests: `setAnchors` resolves anchors against the doc text and reports `positions` (mock `getBoundingClientRect` on ranges via `vi.spyOn(Range.prototype, 'getBoundingClientRect')` returning stub rects) and `unresolved` for a dead quote; a `selectionchange`+`mouseup` with a non-collapsed selection produces `onSelection` with the right quote; `detach()` removes listeners (assert via `removeEventListener` spy); highlight painting is skipped without crashing when `win.CSS?.highlights` is undefined (jsdom).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

Key mechanics (all same-origin, per spec §3):

```ts
export function attachCommentBridge(iframe: HTMLIFrameElement, cb: BridgeCallbacks): CommentDocBridge | null {
  const doc = iframe.contentDocument
  const win = iframe.contentWindow
  if (!doc || !win || doc.readyState === 'loading') return null   // caller retries on iframe `load`
  return createDocBridge(doc, win as never, cb)
}
```

Inside `createDocBridge`:
- Build `TextIndex` lazily; rebuild on mutation (`MutationObserver` on `doc.body`, `{ subtree: true, childList: true, characterData: true }`, debounced 250 ms) — Sites with their own JS re-anchor best-effort (spec §3).
- `report()` (rAF-throttled): for each anchor id, `resolveTextAnchor(index.text, anchor)` → `rangeFromSpan` → `range.getBoundingClientRect()`; document-space `y = rect.top + scrollTop` where `scrollTop = doc.documentElement.scrollTop || doc.body.scrollTop` (`srcDoc` iframes scroll on either depending on UA); `docHeight = doc.documentElement.scrollHeight`; misses → `unresolved`.
- Listeners: `doc.addEventListener('scroll', report, { passive: true, capture: true })` (capture catches a Site's inner scroller too), `win.addEventListener('resize', report)`, `doc.addEventListener('selectionchange', …)` + `doc.addEventListener('mouseup', emitSelection)` + `doc.addEventListener('keyup', emitSelection)`.
- Highlights: guard `const H = (win as { Highlight?: new (...r: Range[]) => unknown }).Highlight; const reg = (win.CSS as { highlights?: Map<string, unknown> })?.highlights` — when both exist, `reg.set('hf-comment', new H(...ranges))` and `reg.set('hf-comment-active', activeRange ? new H(activeRange) : new H())`; once per attach, append a `<style>` to `doc.head`:

```css
::highlight(hf-comment) { background: rgba(250, 204, 21, 0.30); }
::highlight(hf-comment-active) { background: rgba(250, 204, 21, 0.60); }
```

- `scrollToAnchor(id)`: resolved range → `range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })`.
- `emitSelection`: `doc.getSelection()`; collapsed/empty → `cb.onSelection(null)`; else `anchorFromRange(index, sel.getRangeAt(0))` + the range's doc-space rect.
- `detach()`: remove every listener, disconnect the observer, `reg?.delete('hf-comment')`, `reg?.delete('hf-comment-active')`, remove the injected `<style>`.

- [ ] **Step 4: Verify** — `pnpm test:run src/lib/commentDocBridge.test.ts` → PASS; `pnpm lint`.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): same-origin iframe bridge — selection, geometry, CSS highlights"`.

---

### Task 11: Image pin layer

**Files:**
- Create: `apps/handoff/src/components/comments/ImagePinLayer.tsx`
- Test: `apps/handoff/src/components/comments/imagePinLayer.test.tsx`

**Interfaces:**
- Consumes: `CommentAnchorPin` (Task 1).
- Produces: `<ImagePinLayer imgRef={React.RefObject<HTMLImageElement | null>} pins={{ id: string; pin: CommentAnchorPin; n: number }[]} activeId={string | null} canWrite={boolean} onActivate={(id: string) => void} onPlacePin={(pin: CommentAnchorPin) => void} />` — absolutely-positioned overlay sized/positioned to the displayed image box (`object-contain` inside its flex wrapper: compute the *rendered* image rect from `naturalWidth/naturalHeight` vs element box); renders numbered dots at `(x * w, y * h)`; when `canWrite`, a click on the overlay converts to fractions and calls `onPlacePin`; clicking a dot calls `onActivate`. Also exports the pure helper `renderedImageRect(box: { width: number; height: number }, natural: { width: number; height: number }): { left: number; top: number; width: number; height: number }` (letterbox math for `object-contain`).

- [ ] **Step 1: Test-first** — pure-function tests for `renderedImageRect` (wide image in tall box → letterboxed top/bottom; tall in wide → left/right; exact fit) and a component test: given a mocked `imgRef` with `naturalWidth: 200, naturalHeight: 100` and a 400×400 box, a pin `{x: 0.5, y: 0.5}` renders a dot centered at (200, 200); a click at (100, 200) with `canWrite` produces `onPlacePin({ type: 'pin', x: 0.25, y: 0.5 })`.

- [ ] **Step 2: Implement** — overlay `<div className="absolute" style={rect}>` inside a `relative` wrapper the parent provides; dots: `h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-600 text-white text-xs font-semibold flex items-center justify-center shadow ring-2 ring-white cursor-pointer` (active: `scale-110 ring-accent-600`). Recompute rect on `ResizeObserver` of the img element and on `load`.

- [ ] **Step 3: Verify + commit** — tests PASS; `git commit -m "feat(handoff): image pin overlay for comment anchors"`.

---

### Task 12: Wire `CommentLayer` into `ViewerBody`

**Files:**
- Create: `apps/handoff/src/components/comments/CommentLayer.tsx`
- Modify: `apps/handoff/src/pages/HandoffViewer.tsx` — `ControlBar` props + toggle button (~line 200 block), `MarkdownPreview` (forward an iframe ref, ~383), site iframe (~664), image block (~650), `ViewerBody` content row (~638-678)
- Test: `apps/handoff/src/components/comments/commentLayer.test.tsx`

**Interfaces:**
- Consumes: everything above. Produces the assembled feature:
  - `<CommentLayer node={HandoffNode} kind={'markdown' | 'site' | 'image'} iframeRef={React.RefObject<HTMLIFrameElement | null>} imgRef={React.RefObject<HTMLImageElement | null>} open={boolean} canWrite={boolean} />`
  - `ControlBar` gains props `commentsOpen: boolean`, `onToggleComments: () => void`, `commentCount: number` and renders a "Comments" button (chat-bubble SVG icon in the existing button idiom, count badge when > 0) between "View source" and "Open".

- [ ] **Step 1: Component test** — mount `ViewerBody` with MSW (markdown node fixture, logged-in session mock as existing viewer tests do; read `src/components/nodeDetails.test.tsx` for the wrapper): comments panel hidden by default; clicking "Comments" opens the gutter; with an anonymous session and one existing comment, the panel shows the thread read-only with "Sign in to comment"; for `kind: 'download'` (or `?embed=1`) the button is absent.

- [ ] **Step 2: Implement `CommentLayer`**

State + data flow (one component owns it all):

```
listComments({ nodeId: node.id }, { pollingInterval: 20000 })  // ViewerBody already fetched once for the badge; this instance polls while the layer is mounted (open)
threads = threadsFor(comments)
geometry: useState<{ positions, unresolved, scrollTop, docHeight, viewportHeight } | null>
draft: useState<{ anchor: CommentAnchor; anchorY: number } | null>
activeId: useState<string | null>
```

- markdown/site: `useEffect` attaches `attachCommentBridge(iframeRef.current, { onGeometry: setGeometry, onSelection: setSelection })` — retry on the iframe's `load` event (srcDoc swaps recreate the document); `bridge.setAnchors(threads with text anchors)` whenever threads change; `bridge.setActive(activeId)`; cleanup `detach()`.
- Selection bubble: when `selection` is non-null and `canWrite`, render a floating "＋ Comment" button positioned at `iframeBox.top + selection.rect.top - geometry.scrollTop` (clamped to the content box), parent-side, `absolute` in the layer wrapper; click → `setDraft({ anchor: selection.anchor, anchorY: selection.rect.top })`, `bridge.clearSelection()`.
- image: no bridge; `geometry` synthesized (`scrollTop: 0`, `docHeight` = wrapper height); pins = threads with pin anchors; `onPlacePin` → `setDraft({ anchor: pin, anchorY: pin.y * renderedRect.height })`.
- Draft → `<CommentPanel draft>` composer card; submit → `addComment({ nodeId: node.id, body, anchor: draft.anchor })`; on success clear draft, set the new id active.
- `positions` map fed to `CommentPanel`: text threads from bridge geometry; pin threads at `pin.y * height`; `unresolved` ids → the panel's Unanchored section.
- Read-only when `!canWrite` (from `canComment`, Task 8): no bubble, no pin placement, composers replaced by "Sign in to comment" (the panel already supports this).

- [ ] **Step 3: Wire `ViewerBody`**

- `const [commentsOpen, setCommentsOpen] = useState(false)`; `const iframeRef = useRef<HTMLIFrameElement>(null)`; `const imgRef = useRef<HTMLImageElement>(null)`.
- `MarkdownPreview` gets an `iframeRef` prop and sets it on its `<iframe>`; same ref passed to the site iframe (`~:664`); `imgRef` on the image `<img>` (`~:650`). PDF and media keep no ref — no comments (spec non-goal).
- `const commentKind = (kind === 'markdown' || kind === 'site' || kind === 'image') && !sourceShown ? kind : null`
- `const canWrite = canComment({ session, node, parentNode: parentNode ?? undefined })`
- `const { data: allComments } = useListCommentsQuery({ nodeId: node.id }, { skip: !commentKind || embed })` — count badge = open (unresolved, non-deleted) root count.
- ControlBar: show the Comments button only when `commentKind && !embed`.
- Content row restructure (inside `contentRef`, so Fullscreen keeps the gutter — spec §5):

```tsx
<div ref={contentRef} className="flex flex-1 flex-row overflow-auto">
  <div className="relative flex min-w-0 flex-1 flex-col">
    {/* …all existing renderer branches, unchanged, plus ImagePinLayer overlay for images… */}
  </div>
  {commentKind && commentsOpen && !embed && (
    <CommentLayer node={node} kind={commentKind} iframeRef={iframeRef} imgRef={imgRef} open canWrite={canWrite} />
  )}
</div>
```

(The wrapper div changes `flex-col` → `flex-row` + an inner column — verify the existing branches still fill width when the gutter is closed; the inner column keeps `flex-col`.)

- [ ] **Step 4: Full verification**

```bash
pnpm --filter handoff test:run          # whole suite
pnpm --filter handoff lint
pnpm --filter handoff typecheck:rules
pnpm --filter handoff build
```

All green. Then a live smoke (headless, from the workspace root — see `localdev-tools/README.md`):

```bash
cd /home/rico/bffless/repos/apps && pnpm handoff:dev &   # port 5173
cd /home/rico/bffless/localdev-tools
node shot.mjs "http://localhost:5173/?mocks=on" --out /tmp/claude-1000/-home-rico-bffless/e0adc520-36ee-4f83-bc12-311b3298e91d/scratchpad/comments-smoke.png --full
```

Then use chrome-devtools MCP to open a seeded markdown blob with `?mocks=on`, toggle Comments, select text in the iframe, post a comment, and screenshot the gutter. Kill the dev server after.

- [ ] **Step 5: Commit** — `git commit -m "feat(handoff): comment layer wired into viewer — gutter, selection, pins, badge"`.

---

### Task 13: Docs, ADR, and final review pass

**Files:**
- Create: `apps/handoff/docs/adr/0010-margin-comments-same-origin-overlay.md`
- Modify: `apps/handoff/bffless/README.md` (manual-setup data-tables list: add `handoff_comments`)
- Modify: `apps/handoff/CONTEXT.md` (domain language: **Comment**, **Thread**, **Anchor**, **Resolve**)

**Steps:**

- [ ] **Step 1: ADR** — short (≤1 page), following `docs/adr/0001`'s format: context (comments must overlay iframe content), decision (direct same-origin `contentDocument` access confined to `commentDocBridge`; no injection, no postMessage; CSS Custom Highlights; anchors are fuzzy-re-anchored quotes, never rewritten), consequences (breaks if content moves cross-origin — swap the bridge behind its interface; `?embed=1` excluded), alternatives rejected (postMessage bridge, parent-DOM markdown — spec §3).

- [ ] **Step 2: Docs edits** — one-line data-table addition to `bffless/README.md`; four one-line glossary entries in `CONTEXT.md` matching its existing voice.

- [ ] **Step 3: Self-review the diff**

```bash
cd /home/rico/bffless/repos/apps && git diff main...feature/viewer-comments --stat
```

Check against the spec §2 goals: (1) anchored comments for view+session users ✓Tasks 4/10/11/12; (2) threads/resolve/reactions ✓5/9; (3) edit/delete own only ✓5/6; (4) share-link read-only ✓3+9; (5) fuzzy re-anchor + unanchored section ✓2/10/9; (6) no build/serve-time content changes ✓ (grep the diff for any change under `rules/api/uploads/` or `markdown.ts` — there should be none beyond the iframe ref prop).

- [ ] **Step 4: Final commit + stop**

```bash
git add apps/handoff/docs apps/handoff/bffless/README.md apps/handoff/CONTEXT.md
git commit -m "docs(handoff): ADR-0010 + comments docs"
```

**STOP — do not push or open a PR.** Report to the user: branch name, commit list (`git log --oneline main..`), test summary, and the two remaining deploy facts: merging runs `deploy-handoff.yml`, which syncs the rule set (creating the `handoff_comments` table by name) before uploading the artifact; no manual admin steps expected.
