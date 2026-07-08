# Reader inline bodies via embedding the Handoff viewer — implementation plan

**Design:** `apps/reader/docs/superpowers/specs/2026-07-08-reader-embed-content-design.md`
**Date:** 2026-07-08
**Scope:** apps/reader + a small apps/handoff change. No CE. One branch (`reader-inline-markdown`).

## Global constraints

- **Reader does no rendering** — it embeds the Handoff viewer (`item.link`) in an `<iframe>`;
  Handoff renders (markdown now, HTML sites later, same path).
- **v1 detection:** a `text/markdown` enclosure. **Trust gate:** only embed when `item.link`'s
  origin is in an allowlist of known Handoff origins.
- **Auth:** public renders everywhere; private renders when reader + Handoff share a registrable
  domain (same-site cookie). No cookie-free path in v1.
- **Live rules:** the reader-backend edit ships to the live BFFless `reader` set via MCP
  post-merge (Sandcastle doesn't deploy live rules).

## Tasks (dependency order; frontend can build against mocks in parallel with the backend)

### Task 1 — apps/handoff: chromeless `?embed=1` mode
- In the viewer (`apps/handoff/src/pages/HandoffViewer.tsx`), read an `embed` search param and,
  when set, suppress ALL app chrome (nav, header, control bar, details block) — render only the
  existing content iframe (`markdownDocument(renderMarkdown(text), base)`), unchanged.
- Preserve `?token=` behaviour alongside `embed=1`.
- **DoD:** with `?embed=1`, the rendered DOM contains the content iframe and none of the chrome
  elements; without it, the viewer is byte-for-byte today's. Test asserts both.

### Task 2 — apps/reader backend: carry `enclosureType` through
- `enrich` step (`apps/reader/bffless/reader.proxy-rules.json`): from each entry take the first
  renderable (`text/*`) enclosure's `type` (and `url`, stored for future) → emit `enclosureType`
  (+ `enclosureUrl`).
- `reader_items` schema: add `enclosureType` (string, nullable). Confirm add-field mechanics.
- `upsert` map: add `enclosureType: steps.item.enclosureType`.
- `/api/items` projection: include `enclosureType`.
- **DoD:** a refresh over a feed with a `text/markdown` enclosure stores + returns `enclosureType`;
  a feed without enclosures is unaffected (null). Covered by the reader's rule tests / a fixture.

### Task 3 — apps/reader frontend: `Item` + embed helpers
- `apps/reader/src/lib/items.ts`: add `enclosureType: string | null` to `Item` + `shapeItem`.
- New small helpers (in `items.ts` or a new `embed.ts`):
  - `isEmbeddable(item, trustedOrigins)` — true when `enclosureType === 'text/markdown'` AND
    `item.link` parses to an origin in `trustedOrigins`.
  - `embedUrl(link)` — appends `embed=1`, preserving existing query (incl. `token`); null if no link.
- Configure the trusted-origin allowlist (v1: a small constant of the known Handoff origin(s)).
- **DoD:** unit tests for `shapeItem` (enclosureType string/null), `embedUrl` (appends embed=1,
  keeps token, null on no link), `isEmbeddable` (trusted markdown → true; untrusted or non-markdown
  → false).

### Task 4 — apps/reader frontend: `ReadingPane` embed branch
- In `ReadingPane.tsx`: when `isEmbeddable(item, …)`, render an `<iframe src={embedUrl(item.link)}>`
  (a real element — not via `dangerouslySetInnerHTML`, so DOMPurify is untouched) in place of the
  sanitized body, with a generous default height (Open item: pick value) and
  `sandbox="allow-scripts allow-same-origin"`. Keep the existing header (title/author/date).
  Otherwise render today's sanitized `content ?? summary`.
- **DoD:** a trusted `text/markdown` item renders an `<iframe>` whose src is the embed URL; a normal
  item renders sanitized content unchanged; an untrusted markdown item does NOT iframe (falls back).

### Task 5 — mocks + test round-up
- Reader mocks (`src/mocks/…`): `/api/items` returns `enclosureType` so the frontend branch is
  exercised offline.
- Ensure the four test intents above pass; no regression to existing ReadingPane/items tests.

### Task 6 — live deploy (post-merge, human-gated)
- Update the live BFFless `reader` set via MCP to match the `reader.proxy-rules.json` changes from
  Task 2 (enrich/schema/upsert/projection) — fold into the shared base set, diff-verify. The
  Handoff embed mode is frontend-only (no live-rule change).
- End-to-end verify: subscribe the reader to a Handoff feed with a public markdown post → the post
  body renders inline in the reading pane.

## Definition of done (feature)
A public Handoff markdown post, read in our reader, shows its **rendered body inline** (via the
embedded chromeless Handoff viewer, relative images resolving), with the trust gate preventing
embeds of non-Handoff origins, and no change to how non-markdown items render. HTML-site support is
a later detection extension on the same embed path.
