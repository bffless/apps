# Reader inline embed — HTML sites + Outlook-style content gate — design

**Date:** 2026-07-08
**Status:** Draft (brainstorm → spec review)
**Scope:** apps monorepo only — `apps/handoff` (feed handler) + `apps/reader` (backend rules already pass it through; frontend gate). **No CE change.**
**Builds on:** `2026-07-08-reader-embed-content-design.md` (#205–#208, merged). This extends that mechanism from `text/markdown` to `text/html` sites and adds a per-domain, remember-once consent gate.

## Problem

Rivulet now embeds a Handoff **markdown** post inline by iframing the chromeless Handoff viewer
(`/blob/<path>?embed=1`). A Handoff **site** (an uploaded HTML site) is already a feed leaf, but:

1. The feed emits **no `<enclosure>`** for a site (the enclosure line is gated on `it.type === 'file'`),
   so the reader receives `enclosureType = null` and never treats it as embeddable — it falls back to
   the one-line description body.
2. Even if it did, `isEmbeddable` hardcodes `enclosureType === 'text/markdown'`.

We want sites to embed **the same way** markdown does. And — because a site is **real HTML that runs
JS** (unlike sanitized markdown) — we want an **Outlook-style gate**: embedded content is not loaded
by default; the reader shows a placeholder and the user clicks to load it, with a **"always allow this
domain" that is remembered** so they only decide once per domain.

## Correcting the mental model — where `srcDoc` actually lives

This tripped us up, so it is written down here as the load-bearing fact of the whole design:

- **The reader's iframe is a plain `src=` iframe.** `ReadingPane.tsx` renders
  `<iframe src={embedUrl(item.link)} sandbox="allow-scripts allow-same-origin">`, pointing at
  `handoff.j5s.dev/blob/<path>?embed=1`. There is **no `srcDoc` in the reader**, and the reader does
  **no** content rendering or type-branching.
- **`srcDoc` is a Handoff-internal detail, and it is markdown-only.** Inside the Handoff viewer page,
  the renderer is chosen by `previewFor(node)`:
  - **markdown** → `MarkdownPreview`: fetch the raw `.md`, `renderMarkdown` (marked + DOMPurify) →
    `markdownDocument(html, base, {embed})` builds a full HTML string → rendered via a nested
    **`<iframe srcDoc={doc}>`** with a `<base href>` so relative assets resolve.
  - **site** → a plain **`<iframe src={node.url}>`** pointing at the stored site's served HTML (BFFless
    serves it and injects its client `<script>`, per ADR-0001). **No `srcDoc`, no DOMPurify, no
    `markdownDocument`.**

**Consequence:** the two content kinds share the **outer** contract (reader → `/blob/<path>?embed=1`)
but use **different inner mechanisms** inside Handoff. That is exactly why "pretty much the same" holds
for the reader: the reader is content-agnostic — it hands Handoff an embed URL and Handoff picks the
renderer. `?embed=1` already strips chrome for **every** kind (it only gates `ControlBar` +
`NodeDetails`), and the `kind === 'site'` iframe branch **already exists**. So **no Handoff viewer
change is needed** — the viewer already renders a chromeless site. The only Handoff change is in the
**feed handler** (emit the signal); the only reader render change is **letting `text/html` through the
gate**.

## Decisions

- **Site detection = a `text/html` enclosure on a trusted origin.** Symmetric with markdown. The
  reader's existing `enrich` already selects the first `text/*` enclosure, so `text/html` flows through
  with **zero reader-backend change** — the change is one mime in the feed + one mime in `isEmbeddable`.
- **The reader stays content-agnostic.** No markdown-vs-html branch in the reader render path; both
  resolve to `<iframe src={embedUrl(link)}>` and Handoff decides how to render.
- **Outlook-style consent gate, keyed on the embed host.** Embedded content is **not auto-loaded**.
  The pane shows a placeholder naming the domain (`handoff.j5s.dev`). Two actions:
  - **Show content** — loads this one item's iframe for the session (per-item, ephemeral).
  - **Always allow `<host>`** — persists the host to a local allowlist (localStorage); future embeds
    from that host auto-load. **Decide once.**
  The gate keys on **`embedHost(item.link)`** — the domain that actually loads and executes code — not
  the feed. Today every embed resolves to the one hardcoded trusted origin, so in practice the user
  allows `handoff.j5s.dev` once and all embeds load thereafter.
- **The gate applies to *every* embed (markdown + HTML), keyed on the link origin — never the mime
  (decided).** Consent is required to mount *any* Handoff embed frame; once the user allows the origin
  (once), all embeds from it auto-load. The `open` predicate is
  `isAllowedHost(host) || isAllowedOnce(item.id)` with **no** markdown exception.

  **Why not gate HTML-only via the mime — the mime is forgeable.** `enclosureType` is supplied by the
  **feed**, and a reader can subscribe to any feed. The reader does **not** render from the mime — it
  iframes `link` (`/blob/<path>?embed=1`) and **Handoff decides what to render from the node at that
  path.** So an attacker can upload a JS-laden **site** to the trusted origin
  (`handoff.j5s.dev/blob/evil`), then publish a feed (from anywhere) with
  `<link>https://handoff.j5s.dev/blob/evil</link>` + `<enclosure type="text/markdown">` — a lie. An
  HTML-only, mime-keyed gate would see "markdown → auto-load, no consent," iframe the link, and Handoff
  would serve the **site verbatim and run the author's JS**. Gate bypassed. The mime is asserted by
  exactly the untrusted party the gate defends against, so it can **never** be a security signal.

  **Why origin is the sound key.** The reader derives `host`/`origin` by parsing `link` itself
  (`URL(link).origin`) — canonical, not feed-asserted. An attacker can point `link` *at* the trusted
  origin but cannot forge a link that points elsewhere yet parses as it. There is **no forgery-proof
  per-item "runs JS" signal** available through a feed, so the only meaningful, unspoofable question is
  *"do you trust embedded content from this origin?"* — answered once per origin. This is honest about
  the underlying trust: the whole embed feature (markdown included) already runs Handoff's own SPA JS in
  a `sandbox="allow-scripts allow-same-origin"` frame from the allowlisted origin; consenting to the
  origin is consenting to everything it hosts, which is the real boundary.

  **Mime's remaining role: detection only.** `isEmbeddable`'s `text/*` check still answers "is this an
  embeddable content item?" (vs a plain article link), and its security comes entirely from the origin
  allowlist. Mime never influences the consent/auto-load decision.
- **Two independent trust layers, unchanged in spirit.**
  1. **`TRUSTED_EMBED_ORIGINS`** (hardcoded) — *can this origin ever be embedded?* Gates hostile feeds
     (`enclosureType: text/html` + `link: evil.com` is rejected). Unchanged.
  2. **Per-user consent allowlist** (new, runtime, persisted) — *do I want to load it now / always?*
     Layered on top; only offered for origins that already pass layer 1.
- **Sandbox is unchanged and sufficient.** `sandbox="allow-scripts allow-same-origin"` already runs
  JS; a Handoff-served site runs under the same flags (nested iframes cannot escalate a parent's
  sandbox). This is the same privilege the site has when viewed in Handoff directly.

## Architecture

### 1. apps/handoff — emit a `text/html` enclosure for site items

In the feed's per-item loop, the `else` branch (site, no description) and the `else if (note)` branch
(site with description) currently emit only a `<description>`. Add an `<enclosure type="text/html">`
for `it.type === 'site'`, mirroring the file branch. The enclosure `url` points at the site's viewer
link (`ctx.origin + blobUrl(it.path) + tokenQs`), `length="0"`. The `<description>` stays as-is so
non-embedding (third-party) readers still show a body.

This lives in **three synchronized copies** (per the triplicated-feed-handler note):
- `apps/handoff/src/lib/feed.ts` — `renderFeedXml`, the `for (const it of items)` loop (~L199–222).
- `apps/handoff/bffless/handoff.proxy-rules.json` — **both** "Public folder RSS feed" handlers
  (root `/feed.xml` and path `/feed/<path>.xml`, ~L2247 and ~L2343). Byte-port the JS.
- **Live BFFless `handoff` rule set** via MCP (post-merge, human-gated) — Sandcastle does not deploy
  live rules. Fold into the shared base set + diff-verify.

The reader's `enrich` already picks the first `text/*` enclosure → `enclosureType = 'text/html'` flows
through `reader_items` → `/api/items` with **no reader-backend change**.

### 2. apps/reader frontend — let `text/html` embed

- **`isEmbeddable`** (`lib/embed.ts`): accept a small set `{ 'text/markdown', 'text/html' }` instead of
  the single `=== 'text/markdown'`. Trust gate (origin allowlist) and everything else unchanged.
- **`embedUrl`** — unchanged (appends `embed=1`, preserves `?token=`). The reader render path does not
  branch on type.

### 3. apps/reader frontend — the consent gate (the new surface)

- **`lib/embedConsent.ts`** (new, pure + injectable storage, unit-tested):
  - `loadAllowedHosts(storage?): string[]` — read the persisted allowlist (localStorage key
    `rivulet.embed.allowedHosts`, JSON array; tolerant of parse failure → `[]`).
  - `persistAllowedHost(host, storage?): string[]` — add host, dedupe, write, return the new list.
  - `isHostAllowed(host, allowed): boolean`.
  - Session (ephemeral) "show once": a module-level `Set<string>` of item ids with
    `allowOnce(id)` / `isAllowedOnce(id)` (survives `ReadingPane` remounts within the session; reset
    only on reload — matches Outlook's per-message "show once").
- **`useEmbedConsent()` hook** — holds the allowlist in state (seeded from `loadAllowedHosts`),
  exposes `isAllowed(host)`, `allowAlways(host)` (persists + updates state → re-render), and the
  session show-once helpers. Keeps `ReadingPane` declarative.
- **`EmbedConsentGate` component** — the placeholder shown in place of the iframe: an icon, copy
  ("Embedded content from **`<host>`** isn't shown by default."), and actions **Show content**
  (`allowOnce(item.id)`), **Always allow `<host>`** (`allowAlways(host)`), and **Open original ↗**.
  Sized to match the iframe region so the layout doesn't jump when it loads.
- **`ReadingPane`** — in the embeddable branch, compute `host = embedHost(item.link)` and
  `open = !!host && (isAllowed(host) || isAllowedOnce(item.id))` — **keyed on origin, not mime; every
  embed (markdown and HTML alike) is gated identically.** `open` → today's `<iframe>`; otherwise →
  `<EmbedConsentGate>`. The header + "embedded from" bar are unchanged.
  **Hook-order note:** `useEmbedConsent` must be called at the top of `ReadingPane`, before the
  existing `if (!item)` early return, to keep hook order stable.

### 4. Tests

- **apps/handoff** — feed: a `site` leaf emits `<enclosure type="text/html">` (with, and without, a
  description); a `file` leaf is unchanged. (`feed.test.ts`; assert on both json handlers via the
  existing rules-parity test if present.)
- **apps/reader `embed.test.ts`** — `isEmbeddable` true for `text/html` on a trusted origin; false for
  `text/html` on an untrusted origin; markdown still true; other mimes false.
- **apps/reader `embedConsent.test.ts`** — persist/load round-trip; dedupe; parse-failure tolerance;
  `isHostAllowed`; session show-once.
- **apps/reader `ReadingPane.test.tsx`** — any embeddable item with **no** consent renders the gate (no
  iframe) — **including a `text/markdown` item** (regression guard: no mime bypass); after **Show
  content** renders the iframe for that item only; after **Always allow** an item from the same host
  auto-loads; a **forged** item (`enclosureType: text/markdown`, trusted-origin link) is gated exactly
  like a site — asserts the mime cannot skip consent; untrusted-origin item still falls back to
  sanitized body.

## Risks

- **HTML runs the author's JS.** A site executes author script in the embed iframe. Mitigations,
  layered: origin allowlist (layer 1) + per-origin consent so **nothing** loads until the user opts in
  (layer 2) + the existing `sandbox`. This is the same code the site runs when viewed in Handoff
  directly — no *new* trust boundary versus Handoff, only a conscious "run it inline in the reader" step.
- **Forged mime (defended).** A feed can lie about `enclosureType` to make a JS site look like markdown.
  Because the consent gate keys on the parsed link **origin** and covers **every** embed regardless of
  mime, the lie gains nothing — the site is gated identically. See the origin-key decision above.
- **Triplicated feed handler drift.** The site-enclosure edit must land in all three copies or the live
  feed won't carry the signal. Mitigation: rules-parity test + explicit post-merge MCP sync step.
- **Enclosure URL semantics for a site.** A `text/html` enclosure pointing at the `/blob` viewer (an
  SPA page, not a downloadable file) is slightly unusual for third-party readers. The reader ignores
  `enclosureUrl` for rendering (it uses `link` + `embed=1`), so this is cosmetic. See Open items.

## Open items for spec review

- **Gate scope** — **decided: all embeds, keyed on origin (not mime).** The mime is forgeable by the
  feed, so an HTML-only/mime-keyed gate is bypassable; every embed is gated on the parsed link origin.
- **Site enclosure `url`** — the `/blob` viewer link (chosen) vs a raw served-site content URL. Does
  any target third-party reader mis-handle a `text/html` enclosure at an SPA URL?
- **"Show content" scope** — per-item (chosen, matches Outlook) vs per-host-for-the-session.
- **Consent copy + i18n** — final wording of the placeholder.
