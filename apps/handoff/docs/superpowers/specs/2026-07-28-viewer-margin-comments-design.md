# Viewer margin comments — design

Date: 2026-07-28
Scope: Handoff viewer (`apps/handoff`) — a Google-Docs-style anchored-comments layer over rendered
Markdown, uploaded HTML Sites, and images; plus a new `handoff_comments` data table and four new
rules-as-code routes under `.bffless/proxy-rules/handoff/`. No build-time or serve-time changes to
document content.

## 1. Problem

Handoff renders documents for review, but reviewers have no way to leave feedback *on* a document.
Discussion happens out of band (chat, email) with hand-written references like "the paragraph about
SSL, about two-thirds down" — exactly the problem margin comments solve in Google Docs.

The documents live inside child iframes (Markdown via `srcDoc`, `HandoffViewer.tsx:383`; Sites via
`src=/api/uploads/content/…`, `HandoffViewer.tsx:664`), so a comments layer must live in the parent
(like the header and ControlBar) while staying visually aligned with content that scrolls inside
the iframe.

## 2. Goals

1. A logged-in user with **view** access to a document can write comments anchored to a text
   selection (Markdown/Site) or a pinned point on an image, Google-Docs style: cards sit in a right
   gutter, in line with the content they reference, with in-document highlights.
2. Threads: replies, resolve/re-open, emoji reactions.
3. Authors can edit and delete **their own** comments only.
4. Anonymous share-link visitors (valid `?token=`/`hf_s` cookie) see comments **read-only**.
5. When a document is replaced, anchors re-attach by fuzzy text match; comments whose anchor no
   longer exists surface in an "Unanchored" section instead of disappearing.
6. No changes to document content at build or serve time; no change to how documents render today.

Non-goals: comments on PDF (opaque plugin viewer), video/audio, source view, or in `?embed=1` mode
(the Reader embeds the viewer cross-origin, where the same-origin techniques below don't hold);
notifications/mentions; real-time presence; comment search.

## 3. Architecture — direct same-origin DOM access

Chosen over an injected postMessage bridge and over rendering Markdown in the parent DOM.

Every commentable surface is same-origin with the app, by existing design (ADR-0001): Markdown is a
`srcDoc` iframe with no `sandbox`; Sites and the SPA share one host (`/api/uploads/content/*` is a
proxy rule on the app's own alias); images are a plain `<img>` in the parent (`HandoffViewer.tsx:650`).
So the parent can, directly and legally:

- read `iframe.contentDocument` to observe text selections (`selectionchange`/`mouseup`) and measure
  anchor rectangles via `Range.getClientRects()`;
- listen to the iframe document's internal `scroll` (long documents scroll inside the iframe — the
  parent page barely scrolls) and reposition gutter cards each `requestAnimationFrame`;
- paint highlights with the CSS Custom Highlight API (`iframeWin.CSS.highlights` +
  `::highlight(hf-comment)` rules added to the iframe's stylesheet) — no DOM mutation of the
  document, so an uploaded Site's own JavaScript is undisturbed. Where the API is unsupported,
  cards still align; there is simply no in-document highlight.

No script is injected into any document, nothing changes at build or serve time, and there is no
postMessage protocol to version. All same-origin access is confined to one module
(`src/lib/commentAnchors.ts`) with a narrow interface (`measureAnchor`, `observeScroll`,
`applyHighlights`, `resolveAnchors`) so a postMessage adapter could be substituted later if content
ever moves cross-origin.

A debounced `MutationObserver` on the iframe body re-runs measurement when a Site's own JS mutates
the DOM; anchors on dynamic Sites are best-effort.

## 4. Anchor model and re-anchoring

Stored on the thread root as `anchorJson`, W3C-Web-Annotation-style:

- **Text** (Markdown/Site): `{ "type": "text", "quote": "<exact selected text>",
  "prefix": "<≤32 chars before>", "suffix": "<≤32 chars after>", "start": n, "end": n }` — offsets
  into the document's whitespace-normalized text content.
- **Pin** (image): `{ "type": "pin", "x": 0..1, "y": 0..1 }` — fractions of the image's natural
  dimensions, so pins survive zoom and responsive resizing. Pins render as numbered dots overlaid
  on the `<img>`.

The client-side resolver re-attaches text anchors on every load: exact `quote` occurrence nearest
`start` → disambiguate multiple occurrences by `prefix`/`suffix` → whitespace-normalized fuzzy
match → unanchored. Resolution is read-only — stored anchors are never rewritten — so re-uploading
the original content restores its anchors. Replies carry no anchor; they follow their root.

## 5. Frontend composition

`CommentLayer` mounts **inside** the existing `contentRef` div in `ViewerBody`
(`HandoffViewer.tsx:638`) — deliberately, because the Fullscreen button fullscreens `contentRef`
(`HandoffViewer.tsx:108`), and mounting inside keeps comments working in fullscreen. With the panel
open, the content area becomes a flex row: document region + right gutter (~20rem) of cards.

- **ControlBar** gains a "Comments" toggle with an open-thread count badge.
- **Create (text):** select text → floating "＋ comment" bubble appears beside the selection
  (parent-rendered; position = selection rect + iframe offset − iframe scrollTop) → draft card
  opens in the gutter aligned with the selection.
- **Create (pin):** with the panel open, clicking the image drops a pin at that point and opens a
  draft card.
- **Cards:** author, relative time, body ("(edited)" when `updatedMs > createdMs`), reaction row
  with toggleable emoji, reply composer, Resolve on the root, ⋯ menu with Edit/Delete on own
  comments. Resolved threads hide behind a "Show resolved" filter. Unanchored threads list at the
  gutter's bottom.
- **Alignment engine:** cards lay out top-down at their anchor's current Y, pushed apart to avoid
  overlap; selecting a highlight scrolls/expands its card and vice versa (Google-Docs clustering).
  Pure function of `(anchors, activeId, cardHeights)` → positions, unit-testable.
- **Read-only visitors** (share-link, or logged-out users on an `anyone`-granted doc) see
  highlights and threads with a "Sign in to comment" note instead of composers.
- Comment affordances render only for `markdown`, `site`, and `image` kinds, and never when
  `?embed=1`.

## 6. Storage — `handoff_comments` data table

One record per comment. Not a JSON blob on the node: CE's `data_update` read-modify-writes whole
records (`handoffApi.ts:574` caveat, issue #194), so concurrent commenters must never share a
record. Per-record reactions/edit toggles keep contention to a single author's own comment, which
is acceptable.

New `.bffless/proxy-rules/handoff/schemas/handoff_comments.schema.yaml`; `rules push` creates the
table by name, no manual admin step:

| Field | Type | Notes |
|---|---|---|
| `nodeId` | string, required | document node UUID (stable across rename/move; never the path) |
| `parentId` | string | null = thread root; else id of the root this replies to (flat threads) |
| `authorId` | string, required | from server session only |
| `authorName` | string | display snapshot (email) |
| `body` | string, required | comment text |
| `anchorJson` | json | roots only |
| `resolved` | boolean | roots only |
| `resolvedBy` / `resolvedMs` | string / number | audit trail |
| `reactionsJson` | json | `{ "👍": ["<userId>", …] }` |
| `deleted` | boolean | soft-delete marker for roots that have replies |
| `createdMs` / `updatedMs` | number | server-set |

## 7. API — four rules under `rules/api/comments/`

Each route folder carries a `gate.fn.ts` importing `_shared/acl.ts`, modeled directly on
`rules/api/node/meta/patch/gate.fn.ts`: build the viewer from session `user` or verified `hf_s`
share cookie, walk the folder chain, `evalAccess`, and precompute `deny401`/`deny403`/`allow`
booleans for the rule's conditional `response_handlers` (step conditions can only reference simple
paths).

| Route | Gate | Behavior |
|---|---|---|
| `GET /api/comments?nodeId=` | rank ≥ 1 (session **or** share cookie) | All records for the node. Soft-deleted roots return as `{ deleted: true }` husks (no body/author) so threads keep shape. |
| `POST /api/comments` | **session `user.id` required** AND rank ≥ 1 | Create root (`anchorJson`) or reply (`parentId`). Server stamps `id`, `authorId`, `authorName`, `createdMs`; client-sent author/timestamps ignored. Share cookie alone → 401. |
| `PATCH /api/comments` | per-op, all require session + rank ≥ 1 | Body `{ id, op, … }`. `op: "edit"` (body — author only, bumps `updatedMs`); `op: "resolve"` / `"reopen"` (root — any commenter, sets `resolvedBy`/`resolvedMs`); `op: "react"` (toggle one emoji for the caller in `reactionsJson`). Editing another author's body → 403. |
| `DELETE /api/comments?id=` | author only (session) | Reply → hard delete. Root without replies → hard delete. Root with replies → soft delete (`deleted: true`, body cleared) so replies survive. |

Comment authorship is intentionally independent of the node ACL's `edit` level: **view + login is
enough to comment**, matching the product rule. Admins pass every read/write gate via the existing
`isAdmin` path in `_shared/acl.ts` but still cannot edit another author's body (delete-as-moderation
is likewise out of scope for v1 — only authors delete).

Deployment: schema + rules join the existing `handoff` rule set, already synced and attached by
`deploy-handoff.yml`; `typecheck:rules` covers the new `.fn.ts` files.

## 8. Data layer

`handoffApi.ts` gains tag `Comment` and endpoints `listComments(nodeId)`, `addComment`,
`patchComment`, `deleteComment`, with optimistic updates for edit/react/resolve and
`pollingInterval` (~20 s) while the panel is open so teammates' comments arrive without refresh.
`src/lib/commentGate.ts` mirrors `deleteGate.ts` for UI gating (`authenticated && rank ≥ 1`); the
server remains the enforcer. MSW handlers cover all four routes for dev and component tests.

## 9. Error handling

- 401 from any comment route → existing `baseQueryWithReauth` refresh-and-retry; if still 401, the
  composer collapses to the "Sign in to comment" state.
- Optimistic patch/delete failures roll back via RTK Query's `undo` and surface a toast.
- A `POST` that races a concurrent document delete returns 403/404; the panel shows "This document
  no longer accepts comments."
- Anchor measurement failures (detached iframe, PDF-like opaque state) degrade to the Unanchored
  section — never a crash.

## 10. Testing

- **Pipeline tests** (`src/lib/commentsRule.test.ts` via `src/test/proxyRules.ts`): compile the
  real YAML, execute gates against the ACL fixture matrix — owner / editor / viewer / `anyone`
  grant / share-cookie / anon / admin / wrong-author — for all four routes, plus soft-vs-hard
  delete and author-field stamping.
- **Anchor resolver unit tests**: quote unchanged / moved / duplicated (prefix–suffix
  disambiguation) / edited (fuzzy) / removed (orphan); pin math under resize.
- **Layout engine unit tests**: overlap pushing, active-card priority, stable ordering.
- **Component tests** (Vitest + MSW): panel rendering, create/edit/delete-own flows, read-only
  visitor state, resolved filter.
- **Manual smoke** via `localdev-tools/shot.mjs` against `pnpm handoff:dev`.

## 11. Decisions log

- Anchoring: text selection + image pins (element/heading and scroll-offset anchoring rejected as
  imprecise).
- v1 lifecycle includes replies, resolve/re-open, and reactions.
- Doc replacement: fuzzy re-anchor + orphan list (version-pinned and fixed-position rejected).
- Share-link visitors: read-only visibility (hidden and per-link toggle rejected).
- Architecture: direct same-origin DOM access (postMessage bridge and parent-DOM markdown
  rejected — see §3).
