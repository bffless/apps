# Design: Vanity filename segment on `/r/` share links

**Date:** 2026-06-27
**App:** Handoff (`repos/apps/apps/handoff`)
**Status:** Approved design — ready for implementation plan

## Problem

Handoff file share links look like:

```
https://handoff.j5s.dev/r/2306877b-b9a5-4f06-8209-0acde5f5b13d?token=1b215a6c-...
```

The `/r/{nodeId}?token=` URL is opaque: a recipient (human or agent) cannot tell
what kind of file is behind it. It reads like a web page, but it actually
302-redirects to a download from a Google bucket. If the file is a `.rar`, the
URL gives no hint of that.

## Goal & scope

Make the `/r/` URL **self-describing** by appending a vanity filename segment
derived from the file's name, so the type is visible in the link itself:

```
https://handoff.j5s.dev/r/2306877b-.../my-report-final.rar?token=1b215a6c-...
```

**In scope:** `/r/` share links only.

**Explicitly out of scope:**

- `/view/{id}` (the React `HandoffViewer` page) — it already renders filename,
  MIME, size, and a preview once loaded, so it gains little; and adding an
  extension-bearing path segment risks an SPA-fallback 404 on the static host.
  Decided against for this change.
- Changing the **actual downloaded filename**. The `/r/` route 302-redirects to a
  signed bucket URL; the download name comes from the bucket's
  `Content-Disposition`, not from this path segment. This change is cosmetic
  (URL readability) only and must not be described as renaming downloads.

## Key finding: backend needs no change

The `/r/*` proxy-rule pipeline (`bffless/handoff.proxy-rules.json`, the `parse`
step) already extracts the id from the **first** path segment after `/r/` and
ignores anything after the next `/`:

```js
var slash = rest.indexOf('/');
var fileId = (slash >= 0) ? rest.slice(0, slash) : rest;
```

So `/r/{id}/my-report.rar?token=...` already resolves `fileId = {id}`. The
pipeline is already forward-compatible. **This is a frontend-only change.**
Existing `/r/{id}?token=` links continue to work unchanged (the segment is
purely additive).

## Design

### 1. New pure helper: `slugifyFilename(name)` (`src/lib/share.ts`)

Produces a clean, ASCII-only, URL-safe segment that preserves the extension
(the extension is what signals the file type).

Algorithm:

- Find the last `.` (only when it is not the first character, so dotfiles like
  `.env` are treated as all-base).
- **Base** = text before the last `.`; slugify: lowercase, Unicode NFKD
  normalize, replace runs of non-`[a-z0-9]` with `-`, collapse repeated `-`,
  trim leading/trailing `-`.
- **Extension** = text after the last `.`; lowercase, strip to `[a-z0-9]`.
- If the base slug is empty (e.g. an all-CJK name like `报告.pdf`), fall back to
  `file`.
- Result: `extSlug ? `${baseSlug}.${extSlug}` : baseSlug`.

Examples:

| Input | Output |
|---|---|
| `My Report (Final).rar` | `my-report-final.rar` |
| `README` | `readme` |
| `报告.pdf` | `file.pdf` |
| `archive.tar.gz` | `archive-tar.gz` (last extension only) |
| `photo.JPEG` | `photo.jpeg` |

Output is pure `[a-z0-9.-]`, so **no URL-encoding is needed** — no `%20` noise.
No length cap (per decision: no truncation).

**Decided defaults:**

- Double extensions (`.tar.gz`) → keep only the last segment (`.gz`); the base
  retains `tar` as `archive-tar`. Still signals "gzip"; avoids special-casing.
- No truncation, even for very long filenames.

### 2. Extend `shareLinkCopyUrl(origin, link, nodeId?, fileName?)`

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

- With `nodeId` + `fileName` → `/r/{id}/{slug}?token=`.
- With `nodeId`, no `fileName` → unchanged `/r/{id}?token=` (backward compatible).
- Without `nodeId` → unchanged folder `/s/{token}` URL.

### 3. Thread the filename through call sites

All three call sites already have the node (and thus its `name`) in hand:

- **`src/store/useCopyFileShareLink.ts`** — `copyLink(nodeId, fileName?)`; pass
  `fileName` into `shareLinkCopyUrl`.
- **`src/pages/FolderView.tsx`** (lines ~1176, ~1308) — pass `n.name` /
  `node.name` to `copy.copyLink(...)`.
- **`src/components/ShareLinksSection.tsx`** — add optional `fileName?` prop; use
  it in `handleCopy` and the two displayed-URL spots (lines ~141, ~162).
- **`src/components/ShareDialog.tsx`** — pass the node's name down to
  `ShareLinksSection` as `fileName`.

### 4. Tests (`src/lib/share.test.ts`)

- `slugifyFilename`: spaces/parens, no extension, all-Unicode → `file`, double
  extension, uppercase extension, dotfile.
- `shareLinkCopyUrl`: with `fileName` → `/r/{id}/{slug}?token=`; without
  `fileName` → unchanged `/r/{id}?token=`; without `nodeId` → unchanged `/s/`.

## Risks & non-issues

- **Backend regression:** none — pipeline already ignores the trailing segment;
  existing links unaffected.
- **Stale/wrong filename in a link:** harmless — lookup is by `nodeId`; the slug
  is decorative and never used for resolution.
- **Download name unchanged:** by design (see scope). Do not imply otherwise in
  UI copy.

## Out-of-scope follow-ups (noted, not done)

- `/view/{id}` vanity segment — would require a React Router param change plus a
  spike confirming SPA fallback serves `index.html` for an extension-bearing deep
  path. Revisit only if there's demand.
