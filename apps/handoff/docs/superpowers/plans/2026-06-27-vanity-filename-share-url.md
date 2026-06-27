# Vanity Filename Share URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Handoff `/r/` file share links self-describing by appending a slugified filename segment (`/r/{id}/my-report.rar?token=...`) so the file type is visible in the link.

**Architecture:** Frontend-only. A new pure `slugifyFilename` helper and an extended `shareLinkCopyUrl` build the decorative segment; the file name is threaded from the React components (which already hold the node) down to the URL builder. The `/r/*` BFFless pipeline already strips any trailing path segment, so no backend change is needed. Existing `/r/{id}?token=` links keep working (the segment is additive).

**Tech Stack:** TypeScript, React, React Router, Vitest. App: `repos/apps/apps/handoff` (pnpm package `handoff`).

## Global Constraints

- Scope is `/r/` links **only**. Do not touch `/view/{id}` routing.
- This is cosmetic (URL readability). It does **not** change the downloaded filename (the 302 target's `Content-Disposition` owns that). Do not add UI copy implying a rename.
- Slug output must be pure ASCII `[a-z0-9.-]` so no URL-encoding is needed. No length cap (no truncation).
- Backward compatibility: calls without a `fileName` must produce the exact current URLs.
- Git root is `repos/apps` (the monorepo). Per workspace rule, **commits require explicit user approval** — at each commit step, stage and show the diff, then ask before running `git commit`.
- Run tests from the app dir: `cd repos/apps/apps/handoff`.

---

### Task 1: `slugifyFilename` helper + extend `shareLinkCopyUrl`

**Files:**
- Modify: `repos/apps/apps/handoff/src/lib/share.ts`
- Test: `repos/apps/apps/handoff/src/lib/share.test.ts`

**Interfaces:**
- Produces: `slugifyFilename(name: string): string` — returns a URL-safe slug preserving the (last) extension.
- Produces: `shareLinkCopyUrl(origin: string, link: { token: string; url: string }, nodeId?: string, fileName?: string): string` — adds optional 4th `fileName` param; when `nodeId` + `fileName` are present, inserts `/${slugifyFilename(fileName)}` before `?token=`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/share.test.ts` (inside the file, after the existing `describe('shareLinkCopyUrl', ...)` block add a new describe, and extend the existing one):

```ts
import { shareLinkCopyUrl, slugifyFilename, pickReusableToken, shouldClaimToken } from './share'

// ...existing link() helper and describes stay...

describe('slugifyFilename', () => {
  it('slugifies the base and lowercases the extension', () => {
    expect(slugifyFilename('My Report (Final).rar')).toBe('my-report-final.rar')
  })
  it('keeps a name with no extension', () => {
    expect(slugifyFilename('README')).toBe('readme')
  })
  it('falls back to "file" when the base slugifies to empty', () => {
    expect(slugifyFilename('报告.pdf')).toBe('file.pdf')
  })
  it('keeps only the last extension for double extensions', () => {
    expect(slugifyFilename('archive.tar.gz')).toBe('archive-tar.gz')
  })
  it('lowercases an uppercase extension', () => {
    expect(slugifyFilename('photo.JPEG')).toBe('photo.jpeg')
  })
  it('treats a dotfile as all-base', () => {
    expect(slugifyFilename('.env')).toBe('env')
  })
})
```

And add two cases inside the existing `describe('shareLinkCopyUrl', ...)`:

```ts
  it('inserts a vanity filename segment when fileName is provided', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9', 'My Report.rar')).toBe(
      'https://h.dev/r/n9/my-report.rar?token=abc',
    )
  })
  it('omits the segment when fileName is absent (backward compatible)', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9')).toBe('https://h.dev/r/n9?token=abc')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm test:run src/lib/share.test.ts`
Expected: FAIL — `slugifyFilename is not a function` / `shareLinkCopyUrl` ignores the 4th arg.

- [ ] **Step 3: Implement `slugifyFilename` and extend `shareLinkCopyUrl`**

In `src/lib/share.ts`, add the helper and update the builder:

```ts
/**
 * URL-safe slug for a filename, preserving the (last) extension — the part that
 * signals the file type. Output is pure ASCII `[a-z0-9.-]`, so it needs no
 * URL-encoding. Decorative only: never used to resolve the file.
 */
export function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot + 1) : ''
  const baseSlug =
    base
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'file'
  const extSlug = ext.toLowerCase().replace(/[^a-z0-9]/g, '')
  return extSlug ? `${baseSlug}.${extSlug}` : baseSlug
}
```

Then replace the body of `shareLinkCopyUrl` (and its signature) with:

```ts
export function shareLinkCopyUrl(
  origin: string,
  link: { token: string; url: string },
  nodeId?: string,
  fileName?: string,
): string {
  if (!nodeId) return `${origin}${link.url}`
  const seg = fileName ? `/${slugifyFilename(fileName)}` : ''
  return `${origin}/r/${nodeId}${seg}?token=${link.token}`
}
```

Also update the JSDoc above `shareLinkCopyUrl` to mention the optional vanity `fileName` segment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm test:run src/lib/share.test.ts`
Expected: PASS (all slugifyFilename + shareLinkCopyUrl cases green).

- [ ] **Step 5: Lint**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm lint`
Expected: no errors.

- [ ] **Step 6: Commit** (ask for approval first — see Global Constraints)

```bash
cd /home/rico/bffless/repos/apps && git add apps/handoff/src/lib/share.ts apps/handoff/src/lib/share.test.ts && git status
# after user approval:
git commit -m "feat(handoff): slugifyFilename + vanity filename in /r/ share URLs"
```

---

### Task 2: Thread the filename through the share UI

**Files:**
- Modify: `repos/apps/apps/handoff/src/store/useCopyFileShareLink.ts`
- Modify: `repos/apps/apps/handoff/src/components/ShareLinksSection.tsx`
- Modify: `repos/apps/apps/handoff/src/components/ShareDialog.tsx`
- Modify: `repos/apps/apps/handoff/src/pages/FolderView.tsx`

**Interfaces:**
- Consumes: `shareLinkCopyUrl(origin, link, nodeId?, fileName?)` and `slugifyFilename` from Task 1.
- Produces: `useCopyFileShareLink(...).copyLink(nodeId: string, fileName?: string)`; `ShareLinksSection` gains optional prop `fileName?: string`; `ShareDialog` passes its `title` (the node name) as `fileName` when sharing a file.

- [ ] **Step 1: Add `fileName` to `copyLink`**

In `src/store/useCopyFileShareLink.ts`, change the `copyLink` callback signature and the URL build:

```ts
  const copyLink = useCallback(
    async (nodeId: string, fileName?: string) => {
      // ...unchanged token logic...
        const url = shareLinkCopyUrl(window.location.origin, { token, url: `/s/${token}` }, nodeId, fileName)
      // ...unchanged...
    },
    [folderId, links, mint],
  )
```

(Only the `(nodeId: string, fileName?: string)` param and the extra `fileName` arg to `shareLinkCopyUrl` change; leave the rest of the body intact.)

- [ ] **Step 2: Pass the node name at the FolderView call sites**

In `src/pages/FolderView.tsx`:

- Line ~1176 (uploadedNodes list): change
  `onClick={() => void copy.copyLink(n.id)}` → `onClick={() => void copy.copyLink(n.id, n.name)}`
- Line ~1308 (ListingRow): change
  `onCopyLink={() => void copy.copyLink(node.id)}` → `onCopyLink={() => void copy.copyLink(node.id, node.name)}`

- [ ] **Step 3: Add `fileName` prop to `ShareLinksSection`**

In `src/components/ShareLinksSection.tsx`:

Extend the props interface:

```ts
export interface ShareLinksSectionProps {
  folderId: string
  /** When true (default) renders a top divider above the section. */
  topDivider?: boolean
  /** When set, copy/display URLs are file-direct (/r/{nodeId}?token=) for this file. */
  nodeId?: string
  /** Optional file name; when set, appends a vanity slug segment to file-direct URLs. */
  fileName?: string
}
```

Destructure it:

```ts
export function ShareLinksSection({ folderId, topDivider = true, nodeId, fileName }: ShareLinksSectionProps) {
```

Pass it in `handleCopy` and both display spots:

```ts
  function handleCopy(link: ShareLink) {
    const fullUrl = shareLinkCopyUrl(window.location.origin, link, nodeId, fileName)
    // ...unchanged...
  }
```

Line ~141: `{shareLinkCopyUrl(window.location.origin, newLink, nodeId, fileName)}`
Line ~162: `{shareLinkCopyUrl(window.location.origin, link, nodeId, fileName)}`

- [ ] **Step 4: Pass the name down from `ShareDialog`**

In `src/components/ShareDialog.tsx`, the dialog already receives `title` (the file's name when `isFile`). Forward it to the link section only for files:

```tsx
        <ShareLinksSection folderId={folderId} nodeId={nodeId} fileName={isFile ? title : undefined} />
```

- [ ] **Step 5: Typecheck + lint**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm build && pnpm lint`
Expected: `tsc -b` passes (no type errors from the new params), lint clean.

- [ ] **Step 6: Run the full handoff test suite**

Run: `cd /home/rico/bffless/repos/apps/apps/handoff && pnpm test:run`
Expected: PASS (existing suite + Task 1 additions; no regressions).

- [ ] **Step 7: Manual smoke (optional, headless)**

Per `localdev-tools/README.md`, run the app (`cd repos/apps && pnpm install && pnpm handoff:dev`), open a folder with an uploaded file, click "Copy link", and confirm the clipboard URL is `/r/{id}/{slug.ext}?token=...`. (Authed flow needs a seeded session cookie — see CLAUDE.md gotchas.)

- [ ] **Step 8: Commit** (ask for approval first — see Global Constraints)

```bash
cd /home/rico/bffless/repos/apps && git add apps/handoff/src/store/useCopyFileShareLink.ts apps/handoff/src/components/ShareLinksSection.tsx apps/handoff/src/components/ShareDialog.tsx apps/handoff/src/pages/FolderView.tsx && git status
# after user approval:
git commit -m "feat(handoff): thread file name into /r/ share links for vanity slug"
```

---

## Self-Review

**Spec coverage:**
- Slug helper (slug + real extension, fallbacks, double-ext, no truncation) → Task 1, Step 3. ✓
- `shareLinkCopyUrl` extension + backward compatibility → Task 1. ✓
- Thread through all 3 call sites (useCopyFileShareLink, ShareLinksSection, ShareDialog, FolderView) → Task 2. ✓
- Tests → Task 1, Step 1. ✓
- `/r/` only, no `/view/` change, no backend change → respected (no pipeline/router edits). ✓
- Cosmetic-only / no download-rename copy → Global Constraints. ✓

**Placeholder scan:** none — all code shown verbatim.

**Type consistency:** `slugifyFilename(name: string): string`, `shareLinkCopyUrl(..., fileName?: string)`, `copyLink(nodeId, fileName?)`, and `ShareLinksSection` `fileName?: string` are used consistently across both tasks.
