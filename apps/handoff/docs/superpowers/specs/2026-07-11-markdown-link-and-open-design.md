# Markdown links and "Open" — design

Date: 2026-07-11
Scope: Handoff viewer (`apps/handoff`), markdown preview only. No backend, proxy-rule, or
response-header changes.

## 1. Problem

A rendered Markdown file is shown in a same-origin `srcDoc` iframe (`MarkdownPreview`,
`src/pages/HandoffViewer.tsx:340`), built by `markdownDocument()` (`src/lib/markdown.ts:82`) from
`marked` + DOMPurify output, with `<base href>` set to the file's own folder on the content endpoint
so relative images resolve.

Two bugs follow from that.

**A. Links inside a doc navigate the iframe.** Nothing sets a link target, so a Markdown link to
`https://github.com/...` loads GitHub *into the iframe*. GitHub (like most sites) refuses to be
framed, and the reader sees `github.com refused to connect` where the document used to be, with no
obvious way back.

A relative link to a sibling doc is broken differently: `<base href>` points at the content endpoint,
so `./other.md` resolves to `/api/uploads/content/<folder>/other.md` — the raw bytes, which the
browser downloads rather than renders.

**B. "Open" downloads Markdown instead of rendering it.** Open and Download are the same anchor
pointing at the same URL (`node.url`, `HandoffViewer.tsx:207` and `:237`). Content is served by
`file_serve_handler` with the `Content-Type` recorded at upload (`text/markdown`) and no
`Content-Disposition`. Chrome does not render `text/markdown`, so "Open in new tab" downloads the
file — indistinguishable from pressing Download.

## 2. Goals

1. A link to another site opens in a new tab; the doc stays put.
2. A link to a sibling file in the same Handoff folder opens that file's Handoff viewer page.
3. In-document `#anchor` links keep scrolling the doc.
4. "Open" on a Markdown file shows the *rendered* document in its own tab, at a shareable URL.
5. Embedding an inline doc in another app (the RSS reader, `?embed=1`) is never navigated away from
   underneath the host.

Non-goals: Sites (uploaded HTML bundles) hit bug A too, but they are third-party HTML we don't
generate and need a different mechanism (a click interceptor on the same-origin iframe document).
Tracked separately.

## 3. Design

### 3.1 Anchor rewriting in `markdown.ts`

After DOMPurify sanitizes the rendered HTML, and before it is serialized into the iframe document,
walk the anchors and rewrite them. Implemented as a pure function over the sanitized HTML string
(parse with `DOMParser`, mutate, re-serialize `body.innerHTML`), so it is unit-testable and no code
reaches into the iframe's DOM.

Each `href` is resolved against the document's `<base href>` (the file's folder on the content
endpoint) and classified:

| `href` | Treatment |
| --- | --- |
| `#section` (hash-only) | untouched — stays an in-frame scroll |
| same-origin, under `/api/uploads/content/` | rewrite to the viewer URL (`/api/uploads/content/<p>` → `/blob/<p>`; the two differ only by prefix, the encoding is identical) and set the top target |
| same-origin, any other path (e.g. a pasted `/blob/…` link) | set the top target, href unchanged |
| cross-origin (`https://github.com/…`) | `target="_blank" rel="noopener noreferrer"` |
| non-http scheme (`mailto:`, `tel:`) | untouched — the browser hands these off without navigating the frame |

**The top target is `_top` normally, `_blank` in embed mode.** When the doc is iframed inline by
another app, `_top` would navigate *the host app* away, which is worse than the bug being fixed; in
embed mode an internal link therefore opens the Handoff viewer in a new tab instead. `markdownDocument`
already takes `{ embed }`, so no new plumbing.

A rewritten internal link whose path is not a real Handoff node lands on the viewer's normal
not-found — the correct failure, and better than downloading a 404.

### 3.2 "Open" for Markdown

`ControlBar`'s Open anchor becomes kind-aware: for `previewFor(node) === 'markdown'` its href is
`` `${blobUrl(path)}?embed=1` `` — the existing chromeless viewer — instead of `node.url`. Every
other kind (Site, PDF, image, video) keeps `node.url`. Download is untouched and keeps pointing at
`node.url` with the `download` attribute.

### 3.3 Embed CSS is gated on actually being framed

`MARKDOWN_EMBED_CSS` drops the 48rem reading measure and horizontal padding because the *embedder*
owns the width. Opened directly as a tab (which §3.2 now does), that override yields edge-to-edge
full-bleed text.

The measure override therefore applies only when the viewer is really inside an iframe
(`window.self !== window.top`). `useEmbedMode()` continues to gate app chrome exactly as today, so
`?embed=1` in a tab means "no chrome, normal reading measure", and `?embed=1` inside the RSS reader
behaves identically to today.

## 4. Testing

`src/lib/markdown.test.ts` — one case per row of the §3.1 table: external link gets
`target="_blank" rel="noopener noreferrer"`; a relative sibling link is rewritten to `/blob/…` with
`target="_top"`; a hash link is untouched; a same-origin app link gets `_top` without rewriting; a
`mailto:` is untouched; and in embed mode internal links get `_blank`, not `_top`. Plus: rewriting
preserves percent-encoding, and image `src`s are not touched.

Viewer tests — Open's href for a Markdown node is `/blob/<path>?embed=1`, and is still `node.url` for
a PDF/image/Site node.

## 5. Risks

- **DOMPurify ordering.** The rewrite runs *after* sanitization, on the sanitized DOM, so it cannot
  reintroduce anything DOMPurify stripped, and DOMPurify's own attribute allow-list can't strip the
  `target`/`rel` we add.
- **Full page reload on internal links.** `_top` is a document navigation, so following a doc-to-doc
  link reboots the SPA. Accepted: the alternative (a click interceptor doing client-side routing)
  costs iframe-DOM access in effects, loses free middle/cmd-click behavior, and is not testable as a
  pure function. It can be layered on later without changing this contract.
