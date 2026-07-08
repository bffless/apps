# Reader inline bodies via embedding the Handoff viewer — design

**Date:** 2026-07-08
**Status:** Approved (brainstorm), pending spec review
**Scope:** apps monorepo only — apps/reader (consumer) + a small apps/handoff change (embed mode). **No CE change.**
**Supersedes (for this scope):** the deferred CE-pipeline design (`apps/handoff/docs/superpowers/specs/2026-07-08-feed-content-bodies-design.md`) — see "Relationship to the deferred design".

## Problem

In our reader ([[Rivulet]]), a Handoff markdown post renders as an empty body: the feed
`<enclosure type="text/markdown">` is an attachment reference, and the item's stored `content`
is only a `name (size)` line. We want the **post body visible inline in the reader** — markdown
now, and **HTML sites next** — without re-solving rendering in the reader.

## Decisions (from brainstorm)

- **Embed the Handoff viewer in an `<iframe>`; the reader does NO rendering.** The item's `<link>`
  is the Handoff viewer URL; the reader embeds it and Handoff renders. We do **not** fetch the raw
  markdown and render it reader-side.
- **Why not fetch-and-render:** rendered markdown references **relative assets** (`assets/logo.png`).
  Rendering reader-side would need URL rewriting + token handling and re-introduces the same
  relative-asset / sanitization problems. Handoff **already solves this**: its viewer renders
  markdown into an iframe with a `<base href>` (`markdownDocument(renderMarkdown(text), base)` in
  `HandoffViewer.tsx`), so relative refs resolve against the file's own folder with no rewriting.
  Embedding inherits that solution for free.
- **Markdown is a "dummy simple HTML site."** Once Handoff renders it, it *is* an HTML document —
  so it rides the **same embed mechanism HTML sites will use.** Building the reader around
  "embed a Handoff content item" means Site support later is only new *detection*, not new
  rendering. The iframe path is shared.
- **Add a chromeless embed mode to Handoff now.** Iframing `/blob/<path>` today shows the full
  Handoff app chrome. A `?embed=1` mode that renders only the content is a small apps/handoff
  change, **shared with future sites**, so it's built now, not later.
- **v1: public renders everywhere; private renders when the reader shares Handoff's registrable
  domain.** Handoff's share-token claim writes a cookie, so private content depends on that cookie
  reaching the embedded viewer. "Third-party" is judged by **registrable domain (eTLD+1)**, not
  exact host: when the reader and Handoff are on the **same registrable domain** (e.g. both
  `*.j5s.dev` — the self-hosted / enterprise norm), the iframe is **same-site**, the cookie flows,
  and **private content renders**. It only fails when the reader is on a **different registrable
  domain** from the Handoff instance (cross-site → third-party cookie blocked) — an inherently more
  public distribution where the content is typically public anyway (and third-party RSS readers
  strip iframes wholesale regardless — the deferred any-reader path). So we build **no cookie-free
  path**; the only gap is private-content-viewed-from-a-foreign-domain-reader, deferred to later
  reader fallback UX (e.g. "Open in Handoff").
- **v1 detection = the `text/markdown` enclosure.** Sites get their own trigger later; the embed
  mechanism is shared.

## Key findings (verified)

- **`xml_feed_parse` already emits enclosures.** Its per-entry output is
  `{ source, guid, title, link, author, publishedAt, content, summary, enclosures: [{ url, type?, length? }], extensions }`
  (`repos/ce/apps/backend/src/pipelines/feed-parser.service.ts`). The Handoff feed emits
  `<enclosure type="text/markdown">`, so the mime signal is already parsed — the reader's `enrich`
  step (`reader.proxy-rules.json`) just drops it. **No CE change needed to detect markdown.**
- **The reader's item pipeline** is `data_query(reader_feeds) → xml_feed_parse → enrich →
  data_upsert_many(reader_items)`. `enrich` maps `source,guid,title,link,author,content,summary,
  publishedAt` — enclosure is not carried. `reader_items` has no enclosure column.
- **`ReadingPane.tsx`** renders `sanitizeHtml(itemBodyHtml(item))` via `dangerouslySetInnerHTML`
  and already has a `loading` state. `item.link` is stored and, for a Handoff feed, is the viewer
  URL (`/blob/<path>`, plus `?token=` for a private feed — see `feed.ts`).
- **Handoff's viewer already renders markdown as an iframe with a base URL** (`HandoffViewer.tsx`
  → `markdownDocument`/`renderMarkdown` with `viewerBase(node)`), and uses more iframes for other
  content. `renderMarkdown` uses `marked` + DOMPurify. This rendering stays entirely in Handoff.
- **No embed/chromeless mode exists** in Handoff routing/viewer today.
- **Private content depends on the share cookie reaching the embedded viewer.** The viewer takes
  `?token=` and `claimToken(token)` writes a share cookie before the gated fetch. In an iframe this
  cookie is sent **when reader and Handoff share a registrable domain** (same-site — e.g. both
  `*.j5s.dev`) and **blocked** only when they differ (cross-site third-party cookie). Public
  content needs no claim and renders either way.

## Architecture

### 1. apps/handoff — chromeless embed mode

Add an **`?embed=1`** mode to the viewer route (`/blob/<path>?embed=1`) that renders **only** the
content — the existing markdown iframe (`markdownDocument(renderMarkdown(text), base)`) — with the
app chrome (nav, header, control bar, details block) suppressed. Reuse the current rendering path
unchanged; `embed=1` just gates the surrounding chrome. This is the URL the reader embeds, and the
**same mode will render HTML sites** chromelessly later.

- Preserve `?token=` alongside `embed=1` (public renders regardless; private renders when reader
  and Handoff are same-registrable-domain, per the auth decision above).
- No new rendering code — a layout flag on the existing viewer.

### 2. apps/reader backend — carry the enclosure type

So the reader can detect an embeddable item:

- **`enrich`** (`reader.proxy-rules.json`): from each parsed entry, take the primary enclosure's
  `type` (first entry of `e.enclosures[]`, or the first with a renderable type) → add
  `enclosureType` (and, for future use, `enclosureUrl`) to the emitted entry.
- **`reader_items` schema**: add `enclosureType` (string, nullable). Confirm whether the schema
  needs an explicit field definition or accepts new keys.
- **`upsert` map**: add `enclosureType: steps.item.enclosureType`.
- **`/api/items` projection**: include `enclosureType` in returned rows.

### 3. apps/reader frontend — embed on detection

- **`Item` / `shapeItem`** (`items.ts`): add `enclosureType: string | null`.
- **`embedUrl(link)` helper**: append `embed=1` to the viewer link, preserving any existing
  `?token=`. Returns null if `link` is absent.
- **Trust gate (security):** only embed when `item.link`'s **origin is in a trusted allowlist**
  (the known Handoff origin(s)). A hostile feed must not be able to set `enclosureType:
  text/markdown` + `link: evil.com` and get the reader to iframe an arbitrary site.
- **`ReadingPane`**: when `enclosureType === 'text/markdown'` **and** the trust gate passes,
  render an **`<iframe>`** (a real element — NOT via `dangerouslySetInnerHTML`, so DOMPurify is not
  involved and does not strip it) pointed at `embedUrl(item.link)`, in place of the sanitized text
  body. Otherwise, current behaviour is unchanged. Give the iframe a generous default height (or
  postMessage-driven resize as a later enhancement) and a scoped `sandbox`
  (`allow-scripts allow-same-origin` — the Handoff embed page runs JS to mount its inner render
  iframe). Keep the header (title/author/date) as today.
- **Rendering type is generic** — a `text/markdown` enclosure from *any* feed on a trusted origin
  is embeddable; nothing Handoff-specific beyond the origin allowlist.

### 4. Mocks + tests

- `items` shaping — `enclosureType` string/null.
- `embedUrl` — appends `embed=1`, preserves `token`, null on no link.
- Trust gate — trusted origin embeds; untrusted origin falls back to normal rendering.
- `ReadingPane` — a `text/markdown` item on a trusted origin renders an `<iframe>` with the embed
  URL; a normal item renders sanitized content unchanged; an untrusted markdown item does **not**
  iframe.
- apps/handoff — `embed=1` suppresses chrome and still renders the markdown iframe; without it,
  the viewer is unchanged.

## Isolation & interfaces

- **Handoff embed mode** — a layout flag on the existing viewer; zero new rendering; the single
  seam future sites reuse.
- **`enclosureType` carry-through** — one field threaded `enrich → schema → upsert → /api/items →
  Item`; isolated, additive.
- **`embedUrl` + trust gate** — small pure helpers, unit-tested, the only place a URL becomes an
  iframe src.
- **`ReadingPane`** — one branch: embeddable → iframe; else → today's sanitized body. No change to
  the sanitize path.

## Sequencing & live deploy

Both changes are in the apps monorepo; ship together on one branch:

1. **apps/handoff** — `?embed=1` chromeless mode (+ tests).
2. **apps/reader** — backend `enclosureType` carry-through, then frontend embed rendering (+ tests).
3. **Live proxy-rules sync (post-merge):** the reader backend change (`enrich`/schema/`upsert`/
   projection) edits `reader.proxy-rules.json`; Sandcastle doesn't deploy live rules, so the live
   BFFless `reader` set must be updated via MCP after merge (fold into the shared base set,
   diff-verify) — same pattern as Handoff. The Handoff embed mode is frontend-only (no rule
   change).

## Risks

- **Hostile-feed iframe injection.** Without the origin allowlist, a feed could make the reader
  iframe an attacker page. Mitigation: the **trust gate** — embed only for `item.link` on an
  allowlisted Handoff origin; everything else renders normally.
- **Private content blank for cross-domain readers only.** When the reader is on a *different*
  registrable domain from the Handoff instance, the share cookie is blocked and private posts stay
  blank (public posts still render). Same-registrable-domain deployments (the self-hosted norm) are
  unaffected — private renders. Mitigation: documented; add an "Open in Handoff" fallback for the
  cross-domain case later.
- **Iframe sizing.** A fixed height is clunky for long posts. Mitigation: generous default height
  in v1; postMessage height-reporting from the embed page as a follow-up.
- **Embed chrome-strip completeness.** `embed=1` must hide *all* chrome (nav, control bar, details)
  and leave only the content. Mitigation: explicit test asserting the embed DOM contains the
  content iframe and none of the chrome elements.
- **`enclosures[]` shape.** Multiple or non-text enclosures. Mitigation: take the first renderable
  (`text/*`) enclosure; ignore others in v1.

## Open items for spec review

- **Iframe default height** — pick a v1 value (e.g. 60vh / 800px) pending postMessage resize.
- **Trusted-origin allowlist source** — hard-coded Handoff origin(s) vs a per-feed "embeddable"
  flag. v1: a small configured allowlist.
- **`reader_items` schema** — confirm add-field mechanics (explicit def vs schemaless).

## Relationship to the deferred design

The CE-pipeline design (server-rendered `<content:encoded>` via a loop/`read_object_text`/
`markdown_render` pipeline) is **deferred** (issue logged) as the **any-reader** path — it's the
only way to show bodies in third-party readers (Feedly, NetNewsWire…), which strip iframes. This
spec is the **our-reader-only** path: cheaper, no CE, and forward-compatible with HTML sites. If
universal-reader support is ever needed, the deferred design is ready to pull off the shelf; the
two are complementary, not conflicting.
