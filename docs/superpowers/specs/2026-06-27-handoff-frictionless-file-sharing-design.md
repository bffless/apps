# Handoff frictionless file sharing — design

**Date:** 2026-06-27
**Builds on:** [bffless/apps#27](https://github.com/bffless/apps/pull/27) (viewer Share button). This work is a stacked branch (`feat/handoff-file-direct-share`) on top of `feat/handoff-viewer-share-button`.
**Origin:** follow-up to issue #23. User wants the whole journey to be effortless: *drag a screenshot into a folder → one-click copy its share link → paste it to a recipient (e.g. Claude), who opens it straight to the file.*

## Problem

Sharing one file today is a multi-step chore:
1. Upload is **click-to-select only** — no drag-and-drop.
2. To share, you open the file, open the Share popover, mint a **folder** link, and copy `/s/{token}` — which drops the recipient at the **folder listing**, not the file, so you must also tell them which file.
3. Once minted, a link isn't re-copyable — only the brief green "just created" box has a Copy button; listed links have only Revoke.

## Goal

Make "share a file with someone" a two-action flow: **drag in → click Copy link**. The copied link is a single URL that both grants access and opens the file:

```
https://handoff.j5s.dev/view/{fileId}?token={shareToken}
```

## Scope: four parts, one PR

| Part | What | Depends on |
| --- | --- | --- |
| **A** | File-direct URL + token-aware viewer | — (foundation) |
| **B** | One-click "Copy share link" per file (folder row + post-upload) | A |
| **C** | Drag-and-drop upload to a folder | — |
| **D** | Re-copyable links (Copy on every listed link) | — (small) |

Build order: **A → D → B → C**.

## Key decision: no backend changes

The share token stays **folder-scoped** and unchanged — same `handoff_share_links` table, same mint/claim/validate/gate proxy rules. The user accepts folder-scoped access and wants **one token reused for all files in the same folder**. The file is just where the recipient lands. Therefore: **no** schema, proxy-rule, gate, or ACL change. (Per-file ACL scoping was considered and rejected — it would touch the security-sensitive gate for no benefit the user wants.)

## Non-goals

- Per-file ACL scoping (hiding folder siblings). The token grants the folder.
- A file-vs-folder scope toggle.
- Backend / proxy-rule / schema / `acl.ts` changes.
- Changing the `/s/{token}` folder route (kept as-is).
- Bulk "copy all links" / multi-select. One file at a time.

## Background (current mechanics, unchanged)

- `POST /api/share-links/claim` `{ token }` → validates, sets signed `hf_s` cookie (`{ s: folderId, exp }`, 30-min). Frontend baseQuery uses `credentials: 'include'`.
- `ShareLinkEntry` (`/s/:token`) → `claimShareLink(token)`, `dispatch(setShareLinkFolderId)`, `navigate('/folder/{folderId}')`.
- `HandoffViewer` (`/view/:id`) → `useGetNodeQuery(id)`; the gate allows a share-link viewer when the node's folder chain contains the claimed `shareLinkFolderId`.
- `FolderView`: derives `canManage` (owner/admin) and `canWrite` (owner/edit) via `evaluateAccess`. Upload is `UploadButton` (file input) → `handleFile(file)` → `uploadFile({ file, parentId })` (prepare → PUT → register `POST /api/nodes`). File rows are `<Link to={/view/:id}>`. No drag-drop, no per-file actions.
- `useListShareLinksQuery({ folderId })`, `useMintShareLinkMutation`, `useRevokeShareLinkMutation` already exist; share links carry `{ token, url, expiresAt, revoked }`.

---

## Part A — File-direct URL + token-aware viewer

### A1. Viewer reads `?token`
`HandoffViewer` reads `token` via `useSearchParams`. On mount, in order:
1. `token` present **and** not authenticated (`useSession`) → run claim (shared hook, below). On success: `dispatch(setShareLinkFolderId(folderId))`, then load the node. **Gate the node query until claim resolves** (skip `useGetNodeQuery` while a claim is pending) so it doesn't fire an unauthenticated 401 first.
2. `token` absent → behave as today.
3. Already authenticated → skip claim (own access); `?token` ignored.

### A2. Shared claim hook
Factor `ShareLinkEntry`'s "claim → set store" into a reusable `useClaimShareToken` (in `lib/` or `store/`) used by both `ShareLinkEntry` (then navigates to folder) and `HandoffViewer` (then loads file). Behavior of `/s/:token` unchanged.

### A3. Error state
Invalid/expired/revoked token for a guest → dedicated "This share link is no longer valid or has expired." viewer state (not generic "File not found"). Valid token but `fileId` not in folder → same no-access state. Authenticated user → normal access.

---

## Part D — Re-copyable links

In `ShareLinksSection`, add a **Copy** button to every link in the active-links list (today only the green just-created box has one). Reuse `handleCopy`. Fix the "Copied!" affordance to be **per-link** (today's shared `copied` boolean lights every button — key it to the copied token).

---

## Part B — One-click "Copy share link"

### B1. Get-or-mint helper
A pure selector `pickReusableToken(links, nowMs)` → the first active, non-expired, non-revoked link, or `null`. The action: list folder links → `pickReusableToken`; if `null`, mint one (default **No expiry**, matching the popover default); then copy `${origin}/view/${fileId}?token=${token}`. Reusing the existing token gives "one token per folder."

Encapsulate as `useCopyFileShareLink()` returning `copyLink(fileId, folderId)` plus `{ status: 'idle'|'working'|'copied'|'error' }`. Used by both entry points below.

### B2. Per-file Copy-link in the folder listing
Each **file** row in `FolderView` gets a "Copy link" affordance, shown only to managers (`canManage`). Click → `copyLink(node.id, folderId)` → "Copied!" (per-row). Folders don't get it. Errors (e.g. unexpected 403) show a brief inline message; the server stays authoritative.

### B3. Post-upload copy prompt
After an upload completes (button or drag-drop), show a success region listing the uploaded file(s), each with a **Copy link** button (same `useCopyFileShareLink`). This is the payoff path: drag → "Copy link" → paste.

### B4. URL formatting in the viewer popover (from A)
`ShareLinksSection` gains optional `nodeId?: string`. When present (viewer popover), its created box + listed links copy/display `${origin}/view/${nodeId}?token=${token}`; when absent (folder "Manage access" panel), unchanged `/s/{token}`. **Formatting only — no ACL meaning.** `HandoffViewer` passes `nodeId={node.id}`.

---

## Part C — Drag-and-drop upload

Add a drop zone to the `FolderView` container, enabled only for writers (`canWrite`):
- `onDragOver`/`onDragEnter` → `preventDefault()` + `setDragActive(true)`; `onDragLeave`/`onDrop` → `setDragActive(false)`.
- `onDrop` → `preventDefault()`, read `e.dataTransfer.files`, call the existing `handleFile(file)` for each (sequential), into the current `folderId`.
- Visual drag-active state (overlay/highlighted border). Non-writers: drops ignored (no zone).
- On completion, feed the uploaded node(s) into the Part B3 post-upload copy prompt.

---

## Data flow (the happy path)

```
Owner in /folder/{folderId} (canWrite + canManage):
  drag screenshot onto folder view ─→ onDrop → handleFile → uploadFile → POST /api/nodes → new fileId
    ─→ post-upload prompt shows "Q3.png  [Copy link]"
        └─ copyLink(fileId, folderId): list links → pickReusableToken ?? mint(No expiry)
             → clipboard: {origin}/view/{fileId}?token={token}  →  "Copied!"
  (also: per-file row "Copy link" any time)

Recipient opens {origin}/view/{fileId}?token={token}:
  HandoffViewer: token present & guest → claimShareToken(token)
    ├─ ok  → setShareLinkFolderId → useGetNodeQuery(fileId) → render file
    └─ fail→ "link no longer valid" state
```

## Error handling

- Claim fails (guest, bad/expired/revoked token) → "no longer valid" viewer state.
- Copy when no token exists → mint first (handled in `useCopyFileShareLink`); mint 403 (non-manager) → inline error (button is manager-gated, so rare).
- `navigator.clipboard` unavailable/denied → fall back to selecting the URL text / show the URL to copy manually.
- Drag-drop upload failure → reuse existing upload error surface; other files in the drop still proceed.
- Authenticated user opening a `?token` URL → token ignored, normal access.

## Testing & validation

**Unit (pure, `lib/*.test.ts`):**
- `fileShareUrl(origin, nodeId, token)` / folder-URL formatter.
- `pickReusableToken(links, nowMs)` — picks active non-expired non-revoked; null when none/all expired/revoked.
- claim-decision: claim when `token && !authenticated`; skip otherwise.

**MSW + headless browser:**
- `/view/{id}?token=` as guest → claim fires, file renders, no folder bounce.
- Per-file "Copy link" (manager) → reuses/mints one folder token; second file reuses same token; clipboard has `/view/{id}?token=`.
- Drag-drop a file onto the folder → uploads, then post-upload "Copy link" appears and works.
- Listed links each copy; per-link "Copied!".
- Invalid token → "no longer valid" state.
- Non-manager → no per-file Copy-link; non-writer → no drop zone.

**Live curl dogfood:** claim a real folder token, `GET /api/node?id={fileId}` with the `hf_s` cookie succeeds for a file in that folder (mirrors the manual check already done).

## Files touched (all frontend)

| File | Change |
| --- | --- |
| `src/pages/HandoffViewer.tsx` | Read `?token`; claim-then-load for guests; "link invalid" state; pass `nodeId={node.id}` to `ShareLinksSection`. |
| `src/pages/ShareLinkEntry.tsx` | Use the shared `useClaimShareToken` (behavior unchanged). |
| `src/pages/FolderView.tsx` | Drag-and-drop drop zone (writer-gated); per-file "Copy link" (manager-gated); post-upload copy prompt. |
| `src/components/ShareLinksSection.tsx` | Optional `nodeId` → file-direct URL formatting; Copy on listed links; per-link "Copied!". |
| `src/components/` (new) | `CopyLinkButton` (uses `useCopyFileShareLink`); post-upload prompt UI; optional `DropZone` wrapper. |
| `src/lib/` + `store/` (+ tests) | `useClaimShareToken`; `useCopyFileShareLink`; pure helpers `fileShareUrl`, `pickReusableToken`, claim-decision + unit tests. |

No backend, proxy-rule, schema, or `acl.ts` changes.

## Acceptance criteria

- [ ] Drag-and-drop one or more files onto a folder uploads them (writer-gated); non-writers see no drop behavior.
- [ ] After upload, a per-file "Copy link" prompt appears and copies a working `/view/{fileId}?token={t}` URL.
- [ ] Each file row (for managers) has a one-click "Copy link" producing the same file-direct URL.
- [ ] The same folder token is reused for every file in that folder (mint only when none exists).
- [ ] Opening `/view/{fileId}?token={t}` as a guest claims the token (same effect as `/s/{t}`) and lands on the file — no folder load.
- [ ] Every listed share link is re-copyable, with a correct per-link "Copied!".
- [ ] Invalid/expired/revoked token shows a clear "link no longer valid" state.
- [ ] No backend / proxy-rule / schema / ACL changes.
