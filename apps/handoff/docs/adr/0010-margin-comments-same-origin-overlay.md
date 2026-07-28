# Margin comments: direct same-origin overlay, no injection or postMessage

**Decision.** Margin comments live entirely in the parent frame. The parent reads
`iframe.contentDocument` **directly** — selection, scroll, and text ranges — to anchor and position
comment cards next to Markdown and Site content, and highlights the anchored text with the CSS
Custom Highlight API. All of this same-origin DOM access is confined to one module,
`src/lib/commentDocBridge.ts` (`attachCommentBridge`/`createDocBridge`), behind a narrow interface
(`setAnchors`, `setActive`, `scrollToAnchor`, `clearSelection`, `detach`). No script is injected into
any document, and no `postMessage` protocol exists to version. Anchors are stored as quotes
(`{ quote, prefix, suffix, start, end }` or, for images, `{ x, y }` pin fractions) and are
**fuzzy-re-anchored client-side on every load** — never rewritten in storage — so re-uploading the
original content restores its anchors, and an anchor that no longer resolves surfaces in an
"Unanchored" section instead of disappearing.

**Why.**
- Every commentable surface is **already same-origin** with the app by existing design (ADR-0001):
  Markdown is an unsandboxed `srcDoc` iframe, Sites and the SPA share one host
  (`/api/uploads/content/*` is a proxy rule on the app's own alias), and images render as a plain
  `<img>` in the parent. Given that, `contentDocument` access is direct and legal — no bridge script
  needs to be injected into the document being commented on, which would mean **build- or
  serve-time changes to content** (Goal 6 explicitly rules this out).
- **CSS Custom Highlights** (`CSS.highlights` + `::highlight()`) paint highlights without mutating
  the document DOM, so an uploaded Site's own JavaScript is undisturbed. Where the API is
  unsupported (older browsers, jsdom in tests), cards still align at the correct position — there is
  simply no in-document tint. Decoration degrades; positioning does not.
- **Anchors as re-resolved quotes, not live DOM references or rewritten markup.** Long documents
  scroll *inside* the iframe, and a Site's own JS can mutate its DOM at any time (a debounced
  `MutationObserver` re-runs measurement when that happens — best-effort for dynamic Sites). Storing
  a quote plus prefix/suffix disambiguation and resolving it fresh each load is robust to both; it
  also means the resolver is read-only and idempotent, so it can never accumulate drift in storage.

**Alternatives rejected.**
- **postMessage bridge.** Would require injecting a listener script into every Markdown/Site
  document — a build- or serve-time content change this feature explicitly avoids (Goal 6), and a
  protocol surface to version across the injected and parent sides. Same-origin access needs none of
  that today.
- **Rendering Markdown in the parent DOM** (instead of the `srcDoc` iframe) so comments could anchor
  to ordinary parent elements. Rejected because Markdown documents can set a `<base href>` for
  relative asset resolution, which only works inside its own document context; moving rendering to
  the parent breaks that resolution.

**Consequence.** This only works because the content is same-origin *today*. If a future change
serves Sites (or anything commentable) from a separate origin — e.g. to sandbox untrusted uploads,
the tradeoff ADR-0001 already flags — direct `contentDocument` access breaks (cross-origin frames
throw on read). The narrow `commentDocBridge` interface is the intended swap seam: replace its
internals with a postMessage-based implementation behind the same four methods, without touching
call sites. Two things are consequences of the model itself, not of same-origin-only: comments are
excluded from `?embed=1` (the Reader embeds the viewer cross-origin, where this technique doesn't
hold regardless), and re-anchoring on a Site whose JS mutates the DOM heavily is best-effort, not
guaranteed.
