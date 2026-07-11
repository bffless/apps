# Markdown Links and "Open" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Handoff Markdown viewer, make external links open in a new tab, sibling-file links open that file's Handoff page, and "Open" show the *rendered* doc in a new tab instead of downloading it.

**Architecture:** All three fixes live in the client. `src/lib/markdown.ts` gains a pure `retargetLinks()` pass that rewrites the anchors of the sanitized HTML before it is serialized into the viewer's `srcDoc` iframe. `src/pages/HandoffViewer.tsx` makes the "Open" anchor kind-aware (Markdown → the chromeless `/blob/<path>?embed=1` viewer) and gates embed-mode *rendering* behavior on actually being inside an iframe. No backend, proxy-rule, or response-header changes.

**Tech Stack:** React 19 + Vite + TypeScript, `marked` + `dompurify`, RTK Query, Vitest + Testing Library + MSW.

**Spec:** `apps/handoff/docs/superpowers/specs/2026-07-11-markdown-link-and-open-design.md`

## Global Constraints

- Work in the worktree `/home/rico/bffless/repos/apps-handoff-md-links` on branch `handoff-md-links`. Never switch the shared `repos/apps` checkout's branch.
- All paths below are relative to `apps/handoff/` inside that worktree.
- Commands run from `apps/handoff/`: tests `pnpm test:run`, lint `pnpm lint`, typecheck+build `pnpm build`.
- The link rewrite runs **after** DOMPurify, on already-sanitized HTML. Never move sanitization after it, and never reintroduce `dangerouslySetInnerHTML` anywhere.
- The content prefix constant is `CONTENT_PREFIX` from `src/lib/contentPath.ts` (`'/api/uploads/content/'`). Never hardcode the string.
- The viewer URL builder is `blobUrl(path)` from `src/lib/pathUrl.ts` (`` `/blob/${encodePath(path)}` ``).
- Conventional-commit messages, each ending with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/lib/markdown.ts` | Modify | Add `retargetLinks()`; call it from `markdownDocument()`. Owns *what a link does* in the rendered doc. |
| `src/lib/markdown.test.ts` | Modify | Unit tests for every anchor class. |
| `src/lib/embed.ts` | Modify | Add `isFramed()` — "am I really inside an iframe", the signal the rendering half of embed mode keys off. |
| `src/pages/HandoffViewer.tsx` | Modify | Kind-aware "Open" href (`ControlBar`); pass `embed && isFramed()` to `markdownDocument` (`MarkdownPreview`). |
| `src/pages/viewerOpen.test.tsx` | Create | Route-level tests for the Open href and for the framed/unframed rendering split. |

---

## Task 1: Retarget the anchors of a rendered Markdown doc

**Files:**
- Modify: `src/lib/markdown.ts` (add `retargetLinks`; call it in `markdownDocument`, currently at lines 82-96)
- Test: `src/lib/markdown.test.ts` (append to the existing `describe('markdownDocument')`)

**Interfaces:**
- Consumes: `CONTENT_PREFIX` from `src/lib/contentPath.ts`.
- Produces: `export function retargetLinks(bodyHtml: string, base: string | null, opts?: { embed?: boolean }): string`. `markdownDocument(bodyHtml, base, { embed })` keeps its exact signature and now calls it internally — Task 3 relies on the `embed` flag driving BOTH the CSS override and the link target.

**Behavior table** (each row is a test below). `href` is resolved against `base` (the doc's `<base href>`, i.e. the file's folder on the content endpoint):

| `href` | Result |
| --- | --- |
| `#section-2` | untouched (in-frame scroll) |
| relative/absolute, same-origin, under `CONTENT_PREFIX` | href rewritten to `/blob/<rest>`, `target="_top"` |
| same-origin, any other path | href unchanged, `target="_top"` |
| cross-origin `http(s)` | `target="_blank" rel="noopener noreferrer"` |
| `mailto:` / `tel:` / any non-http scheme | untouched |
| any of the above in embed mode | the `_top` target becomes `_blank` + `rel="noopener noreferrer"` |

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/markdown.test.ts`, inside the existing `describe('markdownDocument', ...)` block:

```ts
  const BASE = '/api/uploads/content/Docs/'

  it('opens a cross-origin link in a new tab', () => {
    const doc = markdownDocument('<a href="https://github.com/bffless/ce/issues/446">446</a>', BASE)
    expect(doc).toContain('href="https://github.com/bffless/ce/issues/446"')
    expect(doc).toContain('target="_blank"')
    expect(doc).toContain('rel="noopener noreferrer"')
  })

  it('routes a relative sibling link to that file’s viewer page, preserving encoding', () => {
    const doc = markdownDocument('<a href="other doc.md">next</a>', BASE)
    expect(doc).toContain('href="/blob/Docs/other%20doc.md"')
    expect(doc).toContain('target="_top"')
  })

  it('leaves an in-document anchor alone', () => {
    const doc = markdownDocument('<a href="#section-2">jump</a>', BASE)
    expect(doc).toContain('href="#section-2"')
    expect(doc).not.toContain('target=')
  })

  it('targets the top window for a same-origin app link', () => {
    const doc = markdownDocument('<a href="/tree/Docs">folder</a>', BASE)
    expect(doc).toContain('href="/tree/Docs"')
    expect(doc).toContain('target="_top"')
  })

  it('leaves a mailto: link alone', () => {
    const doc = markdownDocument('<a href="mailto:a@b.com">mail</a>', BASE)
    expect(doc).toContain('href="mailto:a@b.com"')
    expect(doc).not.toContain('target=')
  })

  it('opens internal links in a new tab in embed mode — never navigates the host', () => {
    const doc = markdownDocument('<a href="other.md">next</a>', BASE, { embed: true })
    expect(doc).toContain('href="/blob/Docs/other.md"')
    expect(doc).toContain('target="_blank"')
    expect(doc).not.toContain('target="_top"')
  })

  it('does not touch image sources', () => {
    const doc = markdownDocument(renderMarkdown('![logo](assets/logo.png)'), BASE)
    expect(doc).toContain('src="assets/logo.png"')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run src/lib/markdown.test.ts`
Expected: FAIL — the new cases fail on the missing `target=` / unrewritten `href` (e.g. `expected '<!doctype html>…<a href="https://github.com/bffless/ce/issues/446">446</a>…' to contain 'target="_blank"'`). The seven pre-existing cases in the file must still PASS.

- [ ] **Step 3: Implement `retargetLinks` and call it from `markdownDocument`**

In `src/lib/markdown.ts`, add the import at the top (below the `dompurify` import):

```ts
import { CONTENT_PREFIX } from './contentPath'
```

Add the function above `markdownDocument`:

```ts
/**
 * Retarget the anchors of a rendered Markdown document for iframe display.
 *
 * The doc renders in a same-origin iframe whose `<base href>` is the file's own
 * Folder on the content endpoint, so by default EVERY link navigates the frame:
 * an external link loads a site that (like github.com) usually refuses to be
 * framed, and a relative link to a sibling doc resolves to the raw content URL,
 * which the browser downloads instead of rendering. Both are fixed here rather
 * than by rewriting the stored Markdown.
 *
 * Runs on the already-sanitized HTML (after DOMPurify), so it cannot reintroduce
 * anything sanitization stripped, and DOMPurify's attribute allow-list cannot
 * strip the `target`/`rel` added here.
 *
 * `embed` (the doc is inside a HOST app's iframe) turns the top-window target
 * into a new tab: `_top` would navigate the *host* away, which is worse than the
 * bug being fixed.
 */
export function retargetLinks(
  bodyHtml: string,
  base: string | null,
  { embed = false }: { embed?: boolean } = {},
): string {
  const origin = window.location.origin
  const baseUrl = new URL(base ?? '/', origin)
  const topTarget = embed ? '_blank' : '_top'

  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue // in-document anchor — scroll the frame

    let resolved: URL
    try {
      resolved = new URL(href, baseUrl)
    } catch {
      continue // unparseable — leave exactly as authored
    }
    // mailto:, tel:, … — the browser hands these off without navigating the frame.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue

    if (resolved.origin !== origin) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      continue
    }

    // Same origin: a content-endpoint link is a Handoff node — send it to that
    // node's viewer page instead of its raw bytes. The two URLs differ only by
    // prefix, so the per-segment encoding carries over untouched.
    if (resolved.pathname.startsWith(CONTENT_PREFIX)) {
      const rest = resolved.pathname.slice(CONTENT_PREFIX.length)
      a.setAttribute('href', `/blob/${rest}${resolved.search}${resolved.hash}`)
    }
    a.setAttribute('target', topTarget)
    if (topTarget === '_blank') a.setAttribute('rel', 'noopener noreferrer')
  }

  return doc.body.innerHTML
}
```

Then, in `markdownDocument`, retarget the body before injecting it. Replace the `return (...)` expression's body line so the function reads:

```ts
export function markdownDocument(
  bodyHtml: string,
  base: string | null,
  { embed = false }: { embed?: boolean } = {},
): string {
  const baseTag = base ? `<base href="${base}">` : ''
  const css = embed ? MARKDOWN_IFRAME_CSS + MARKDOWN_EMBED_CSS : MARKDOWN_IFRAME_CSS
  const body = retargetLinks(bodyHtml, base, { embed })
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    baseTag +
    `<style>${css}</style></head>` +
    `<body><div class="markdown-body">${body}</div></body></html>`
  )
}
```

Also extend `markdownDocument`'s existing doc comment with a line noting that anchors are retargeted by `retargetLinks` (external → new tab, sibling content → that file's `/blob/` page).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run src/lib/markdown.test.ts`
Expected: PASS — all cases, old and new.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/markdown.ts src/lib/markdown.test.ts
git commit -m "fix(handoff): open external markdown links in a new tab, sibling links in the viewer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Point "Open" at the rendered doc for Markdown

**Files:**
- Modify: `src/pages/HandoffViewer.tsx` (the `pathUrl` import at line 24; `ControlBar`, whose Open anchor is at lines 207-221)
- Create: `src/pages/viewerOpen.test.tsx`

**Interfaces:**
- Consumes: `previewFor` from `src/lib/preview.ts` (already imported in this file), `blobUrl` from `src/lib/pathUrl.ts`, `HandoffNode.path` (the verbatim content path, e.g. `Posts/Post.md`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/pages/viewerOpen.test.tsx`. It reuses the route-level harness from `src/pages/embedMode.test.tsx` (MSW + real route table + the `BasedRequest` origin workaround) — copied, not imported, exactly as `embedMode.test.tsx` copied it from `pathRoutes.test.tsx`:

```tsx
/**
 * "Open in new tab" tests for the Handoff viewer.
 *
 * Markdown must NOT open its raw bytes: the content endpoint serves it as
 * text/markdown, which browsers download rather than render (the button became
 * a second Download). It opens the chromeless viewer instead. Every other kind
 * still opens its content URL directly.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import {
  handlers,
  resetMockState,
  seedFolder,
  seedFile,
  mockNodePath,
  mockCurrentUser,
  nodes,
  objects,
} from '../mocks/handlers'
import { handoffApi } from '../store/handoffApi'
import handoffReducer from '../store/handoffSlice'
import App from '../App'
import { __resetSessionCache } from '../lib/session'

const sessionHandler = http.get('/api/auth/session', () => {
  if (!mockCurrentUser) {
    return HttpResponse.json({ authenticated: false, user: null })
  }
  return HttpResponse.json({
    authenticated: true,
    user: { id: mockCurrentUser.id, email: mockCurrentUser.email, role: mockCurrentUser.role },
  })
})

const server = setupServer(...handlers, sessionHandler)

const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}

function makeStore() {
  return configureStore({
    reducer: {
      handoff: handoffReducer,
      [handoffApi.reducerPath]: handoffApi.reducer,
    },
    middleware: (gDM) => gDM().concat(handoffApi.middleware),
  })
}

beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  resetMockState()
  server.resetHandlers()
  __resetSessionCache()
})
afterAll(() => {
  globalThis.Request = RealRequest
  server.close()
})

/** Seed a markdown File with real bytes so the viewer renders MarkdownPreview. */
function seedMarkdown(name: string, parentId: string, body = '# Hello world'): string {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)!
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'text/markdown' })
  objects.set(path, { body: new TextEncoder().encode(body).buffer, type: 'text/markdown' })
  return path
}

/** Seed a PDF File — a kind whose raw content URL the browser renders fine. */
function seedPdf(name: string, parentId: string): string {
  const f = seedFile(name, parentId)
  const path = mockNodePath(f.id)!
  nodes.set(f.id, { ...nodes.get(f.id)!, url: `/api/uploads/content/${path}`, mime: 'application/pdf' })
  return path
}

function renderApp(entry: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('viewer "Open in new tab"', () => {
  it('opens the rendered doc — not the raw bytes — for Markdown', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id)

    renderApp('/blob/Posts/Post.md')

    const open = await screen.findByTitle('Open in new tab')
    expect(open).toHaveAttribute('href', '/blob/Posts/Post.md?embed=1')
    expect(open).toHaveAttribute('target', '_blank')
  })

  it('opens the content URL directly for a PDF', async () => {
    const folder = seedFolder('Posts', 'root')
    seedPdf('Report.pdf', folder.id)

    renderApp('/blob/Posts/Report.pdf')

    const open = await screen.findByTitle('Open in new tab')
    expect(open).toHaveAttribute('href', '/api/uploads/content/Posts/Report.pdf')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run src/pages/viewerOpen.test.tsx`
Expected: FAIL on the Markdown case — `expected element to have attribute href="/blob/Posts/Post.md?embed=1", received href="/api/uploads/content/Posts/Post.md"`. The PDF case already PASSes.

- [ ] **Step 3: Make the Open href kind-aware**

In `src/pages/HandoffViewer.tsx`, extend the existing `pathUrl` import (line 24):

```ts
import { treeUrl, parentPath, blobUrl } from '../lib/pathUrl'
```

In `ControlBar`, next to the other derived values (below `const backTo = backTarget(node)`), add:

```ts
  // "Open" must not point at the raw bytes for Markdown: the content endpoint
  // serves it as text/markdown, which browsers download instead of rendering —
  // making the button a second Download. Send the new tab to the chromeless
  // viewer, which shows the *rendered* document at a shareable URL.
  const openUrl =
    previewFor(node) === 'markdown' && node.path ? `${blobUrl(node.path)}?embed=1` : node.url
```

Then change the Open anchor (lines 207-221) to use it — the `{node.url && (` guard and the `href` both:

```tsx
      {/* Open in new tab */}
      {openUrl && (
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
```

Leave the rest of the anchor (classes, icon, label) and the Download anchor untouched.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run src/pages/viewerOpen.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite + lint**

Run: `pnpm test:run && pnpm lint`
Expected: all tests PASS, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/HandoffViewer.tsx src/pages/viewerOpen.test.tsx
git commit -m "fix(handoff): Open a markdown file as a rendered page, not a download

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Key embed-mode *rendering* off being framed, not the query param

`?embed=1` means "no app chrome" — which is now also what Task 2's new tab wants. But the two differ in what the *content* should do:

| | app chrome | reading measure | internal link target |
| --- | --- | --- | --- |
| `?embed=1` inside a host iframe (RSS reader) | none | host's (measure lifted) | `_blank` (never navigate the host) |
| `?embed=1` as a standalone tab (Open) | none | Handoff's 48rem | `_top` (own the tab) |

`useEmbedMode()` keeps gating chrome off the query param. The rendering half moves to `isFramed()`. Without this, Open's tab would render edge-to-edge full-bleed text.

**Files:**
- Modify: `src/lib/embed.ts` (add `isFramed`)
- Modify: `src/pages/HandoffViewer.tsx` (`MarkdownPreview`, lines 340-358)
- Test: `src/pages/viewerOpen.test.tsx` (append a `describe`)

**Interfaces:**
- Consumes: `markdownDocument(bodyHtml, base, { embed })` from Task 1 — its `embed` flag drives both the CSS override and the `_blank`-vs-`_top` link target.
- Produces: `export function isFramed(): boolean` in `src/lib/embed.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/viewerOpen.test.tsx`:

```tsx
/** Read the srcdoc of the markdown iframe the viewer rendered. */
async function markdownSrcDoc(name: string): Promise<string> {
  const frame = await screen.findByTitle(name)
  return frame.getAttribute('srcdoc') ?? ''
}

describe('embed-mode rendering keys off being framed, not ?embed=1', () => {
  it('keeps Handoff’s reading measure and targets the tab when NOT framed', async () => {
    const folder = seedFolder('Posts', 'root')
    seedMarkdown('Post.md', folder.id, '[next](other.md)')

    renderApp('/blob/Posts/Post.md?embed=1')

    const doc = await markdownSrcDoc('Post.md')
    expect(doc).toContain('.markdown-body { max-width: 48rem;')
    expect(doc).not.toContain('max-width: none')
    expect(doc).toContain('target="_top"')
  })

  it('lifts the measure and opens internal links in a new tab when framed', async () => {
    const realTop = window.top
    Object.defineProperty(window, 'top', { configurable: true, value: {} as Window })
    try {
      const folder = seedFolder('Posts', 'root')
      seedMarkdown('Post.md', folder.id, '[next](other.md)')

      renderApp('/blob/Posts/Post.md?embed=1')

      const doc = await markdownSrcDoc('Post.md')
      expect(doc).toContain('max-width: none')
      expect(doc).toContain('target="_blank"')
      expect(doc).not.toContain('target="_top"')
    } finally {
      Object.defineProperty(window, 'top', { configurable: true, value: realTop })
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run src/pages/viewerOpen.test.tsx`
Expected: FAIL on the first (not-framed) case — today `?embed=1` alone lifts the measure, so the srcdoc contains `max-width: none` and `target="_blank"`. The second (framed) case already PASSes.

- [ ] **Step 3: Add `isFramed` and use it in `MarkdownPreview`**

In `src/lib/embed.ts`, append:

```ts
/**
 * True when this document is really inside an iframe.
 *
 * `?embed=1` means "no app chrome", which is what a HOST app iframing a doc
 * wants — and also what "Open in new tab" wants for a Markdown file. The two
 * part ways on the CONTENT: an embedded doc lets the host own the reading
 * measure and must never navigate the host away, while a standalone tab keeps
 * Handoff's measure and owns its own window. So the chrome half of embed mode
 * keys off the query param and the rendering half keys off this.
 */
export function isFramed(): boolean {
  return window.self !== window.top
}
```

In `src/pages/HandoffViewer.tsx`, extend the `embed` import (line 27):

```ts
import { useEmbedMode, isFramed } from '../lib/embed'
```

In `MarkdownPreview`, derive the flag inside the effect and pass it to both `markdownDocument` calls:

```tsx
  useEffect(() => {
    let cancelled = false
    const base = viewerBase(node)
    // Embed mode suppresses chrome for BOTH a host iframe and Open's standalone
    // tab; only a real iframe should hand the reading measure and the link
    // target to a host (src/lib/embed.ts).
    const framed = embed && isFramed()
    fetchWithReauth(url)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) {
          setResult({ url, doc: markdownDocument(renderMarkdown(text), base, { embed: framed }) })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            url,
            doc: markdownDocument('<p>Failed to load Markdown.</p>', base, { embed: framed }),
          })
        }
      })
    return () => { cancelled = true }
  }, [url, node, embed])
```

Update `MarkdownPreview`'s doc comment to say the `embed` prop suppresses chrome, while the *rendering* override applies only when actually framed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run src/pages/viewerOpen.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite, lint, and typecheck**

Run: `pnpm test:run && pnpm lint && pnpm build`
Expected: all tests PASS, no lint errors, build succeeds. `src/pages/embedMode.test.tsx` must still pass unchanged — it asserts chrome suppression, which is still driven by the query param.

- [ ] **Step 6: Commit**

```bash
git add src/lib/embed.ts src/pages/HandoffViewer.tsx src/pages/viewerOpen.test.tsx
git commit -m "fix(handoff): only hand the reading measure and link target to a real host frame

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verify in the real app

**Files:** none — this task changes no code. It exists because both bugs were invisible to the unit tests and only showed up in a browser.

- [ ] **Step 1: Run the dev server**

From the worktree root (`/home/rico/bffless/repos/apps-handoff-md-links`):

```bash
pnpm install
pnpm handoff:dev   # http://localhost:5173/
```

- [ ] **Step 2: Drive the viewer**

Open a Markdown doc that contains an external link (e.g. the `proxy-rules-as-code.md` plan, which links to `github.com/bffless/ce/issues/446`), and confirm:

1. Clicking the GitHub link opens a **new tab** — the doc stays on screen, no `github.com refused to connect`.
2. An in-document heading/TOC link still scrolls the doc in place.
3. "Open" gives a new tab showing the **rendered** document (not a download, not raw text), with the normal centered reading column — and the Downloads list gains no new entry.
4. "Download" still downloads the `.md`.

`/home/rico/bffless/localdev-tools/shot.mjs` can screenshot it (`node shot.mjs http://localhost:5173/blob/<path> --out /tmp/shot.png --full`); a clean run reports `consoleErrors:0, failedRequests:0`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin handoff-md-links
gh pr create --title "fix(handoff): markdown links open out of the iframe, and Open renders instead of downloading" --body "$(cat <<'EOF'
The viewer renders Markdown in a same-origin iframe, so every link in a doc navigated the frame itself:

- **External links broke the page.** A link to github.com loaded GitHub *into the iframe*, and GitHub refuses to be framed — the reader got `github.com refused to connect` where the doc used to be. Now external links open in a new tab.
- **Sibling links downloaded.** The iframe's `<base href>` points at the content endpoint, so `./other.md` resolved to the raw bytes. Now it opens that file's `/blob/` viewer page.
- **"Open" was a second Download.** Open and Download pointed at the same URL, and the content endpoint serves `.md` as `text/markdown`, which browsers download. Open now points at the chromeless viewer (`?embed=1`), so the new tab shows the rendered document.

Anchors are retargeted after DOMPurify, in `retargetLinks()` — `#anchor` and `mailto:` links are left alone. Embed-mode *rendering* (the lifted reading measure, and `_blank` instead of `_top`) now keys off actually being inside an iframe, so an inline-embedded doc can never navigate its host away, and Open's tab keeps Handoff's reading column.

Sites (uploaded HTML bundles) have the same in-iframe link problem and are not addressed here — they are third-party HTML we don't generate, so they need a click interceptor rather than a build-time rewrite.

Spec: `apps/handoff/docs/superpowers/specs/2026-07-11-markdown-link-and-open-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
