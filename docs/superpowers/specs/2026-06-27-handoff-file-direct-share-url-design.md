# Handoff file-direct share URLs — design

**Date:** 2026-06-27
**Builds on:** [bffless/apps#27](https://github.com/bffless/apps/pull/27) (viewer Share button, branch `feat/handoff-viewer-share-button`).
**Origin:** follow-up to issue #23. User feedback: sharing a single file is a two-step chore (send a `/s/{token}` folder link, then separately tell the recipient which file), and once a link is created it can't be re-copied.

## Problem

To hand someone one file today you: upload it to a folder, create a **folder**-scoped share link (`/s/{token}`), send the link, then *also* tell them which file — because `/s/{token}` claims the token and drops the recipient at the **folder** listing (`/folder/{folderId}`), not the file. Separately, the share UI only lets you copy a link in the brief moment after creating it (the green "just created" box); links in the active list have no Copy button, so they're effectively un-retrievable afterward.

## Goal

A single URL that is **share + view in one**: it points at a specific file and carries a share token, so opening it validates the token, sets the access cookie (exactly as `/s/{token}` does today), and lands directly on the file — no folder bounce, no second message.

```
https://handoff.j5s.dev/view/{fileId}?token={shareToken}
```

## Key decision: no backend changes

The share token stays **folder-scoped** and unchanged — same `handoff_share_links` table, same mint/claim/validate/gate proxy rules. The user explicitly accepts folder-scoped access ("I'm ok with sharing just the folder"). The file is simply *where the recipient lands*; the token grants the enclosing folder. Therefore:

- **No** data-table schema change.
- **No** proxy-rule / gate / ACL change.
- The **same token works for any file in its folder** — "Copy link to this file" stitches the current `fileId` onto an existing (or freshly minted) folder token.

This is deliberately smaller and lower-risk than a per-file ACL token (which was considered and rejected for now): it touches no security-sensitive gate logic.

## Non-goals

- Per-file ACL scoping (a token that hides folder siblings). Out of scope — the token grants the folder.
- A scope toggle (file vs folder). Not needed: scope is always folder; the URL only changes where you land.
- Backend / proxy-rule / schema changes of any kind.
- Changing the existing `/s/{token}` folder route (it stays as-is for folder sharing).

## Background (current mechanics, unchanged)

- `POST /api/share-links/claim` with `{ token }` validates the token and sets the signed `hf_s` cookie (`{ s: folderId, exp }`, 30-min). Frontend baseQuery uses `credentials: 'include'` so the `Set-Cookie` sticks.
- `ShareLinkEntry` (`/s/:token`) calls `claimShareLink(token)`, then `dispatch(setShareLinkFolderId(folderId))` and `navigate('/folder/{folderId}')`.
- `HandoffViewer` (`/view/:id`) fetches the node via `useGetNodeQuery(id)` → `GET /api/node?id=...`, which the gate allows for a share-link viewer when the node's folder chain contains the claimed `shareLinkFolderId`.
- The viewer's Share popover (from #27) renders `ShareLinksSection folderId={node.parentId}`, which mints/lists/copies/revokes **folder** links and currently shows/copies `/s/{token}` URLs.

## Design

### 1. Viewer becomes token-aware

`HandoffViewer` reads a `token` query param (`useSearchParams`). On mount, in order:

1. If `token` is present **and** the user is **not** already authenticated (check via `useSession`), call the existing claim (`claimShareLink(token)`):
   - On success: `dispatch(setShareLinkFolderId(folderId))`, then proceed to load the node. The node query is **gated until the claim resolves** (skip `useGetNodeQuery` while a claim is pending) so it doesn't fire an unauthenticated 401 first.
   - On failure (invalid/expired/revoked): show a clear "this share link is no longer valid" state (see Error handling).
2. If `token` is absent, behave exactly as today.
3. If the user is already authenticated, skip the claim entirely (they have their own access) and load the node directly — the `?token` is harmless/ignored.

This reuses the exact claim logic `ShareLinkEntry` already uses; factor the shared claim-then-set-store step into a small reusable hook/function so both entry points stay in sync (e.g. `useClaimShareToken`). The `/s/:token` route keeps using it for folder sharing.

### 2. "Copy link to this file" in the viewer

`ShareLinksSection` gains an optional `nodeId?: string` prop (the file currently in view):

- **When `nodeId` is present** (viewer popover): the copied URL — for the freshly-minted green box **and** each listed link — is `${window.location.origin}/view/${nodeId}?token=${token}`. Label the action "Copy link to this file."
- **When `nodeId` is absent** (folder "Manage access" panel): unchanged — `${origin}/s/${token}`.

This is **URL formatting only**; it carries no ACL meaning. The displayed code snippet should show the file-direct URL in the viewer context so what you see is what you copy.

The viewer passes `nodeId={node.id}` (the file being viewed) into `ShareLinksSection`; the token(s) come from the existing folder-scoped mint/list for `node.parentId` (already wired in #27).

### 3. Re-copyable links (the "hidden link" fix)

Add a **Copy** button to each link in the active-links list in `ShareLinksSection` (today only the green just-created box has one). Reuse the existing `handleCopy`, which already formats per the `nodeId` rule above. Keep the existing per-button "Copied!" affordance, but fix it to be per-link (the current shared `copied` boolean lights every button — scope it to the copied token).

## Data flow

```
Owner: open file in viewer → Share popover (ShareLinksSection nodeId={fileId}, folderId={parentId})
  → mint/list folder token(s) (existing) → Copy → {origin}/view/{fileId}?token={token}

Recipient: open {origin}/view/{fileId}?token={token}
  HandoffViewer:
    token present? ── yes, not authed ─→ claimShareLink(token)
                                           ├─ ok  → setShareLinkFolderId(folderId) → useGetNodeQuery(fileId) → render file
                                           └─ fail→ "link no longer valid" state
    token present & authed ─→ load node directly
    token absent ─→ load node as today (auth required)
```

## Error handling

- **Invalid / expired / revoked token, guest viewer:** claim returns `{ valid: false }` (or errors). Show a dedicated "This share link is no longer valid or has expired." message in the viewer (not the generic "File not found"), so the recipient understands it's the link, not the file.
- **Valid token, but `fileId` not in that folder:** the node fetch will 403/return null; fall back to the same "no longer valid / no access" state. (Stitching is owner-controlled, so this is an edge case.)
- **Claim succeeds but node fetch later fails (cookie expired mid-session):** existing viewer error path; re-opening the URL re-claims.
- **Authenticated user:** `?token` is ignored; normal access applies.

## Testing & validation

**Unit (pure, `lib/*.test.ts`):**
- URL formatter: `nodeId` present → `/view/{id}?token={t}`; absent → `/s/{t}`.
- Claim-decision helper: claim when `token && !authenticated`; skip when authed or no token.

**MSW + headless browser:**
- `/view/{id}?token={t}` as a guest → claim fires, file renders (no folder bounce).
- Viewer Share popover → Copy yields the `/view/{id}?token=` URL; the created box and listed links both copy; per-link "Copied!".
- Invalid token → "no longer valid" state.

**Live curl dogfood** (mirrors the manual check already done): claim a real folder token, then `GET /api/node?id={fileId}` with the `hf_s` cookie succeeds for a file in that folder.

## Files touched

| File | Change |
| --- | --- |
| `src/pages/HandoffViewer.tsx` | Read `?token`; claim-then-load when guest; "link invalid" state; pass `nodeId={node.id}` to `ShareLinksSection`. |
| `src/pages/ShareLinkEntry.tsx` | Refactor its claim-then-set-store into a shared hook/util (`useClaimShareToken`); behavior unchanged. |
| `src/components/ShareLinksSection.tsx` | Optional `nodeId` prop → file-direct URL formatting; Copy button on listed links; per-link "Copied!". |
| `src/lib/` (+ test) | Pure URL-format + claim-decision helpers with unit tests. |

No backend, proxy-rule, schema, or `acl.ts` changes.

## Acceptance criteria

- [ ] `/view/{fileId}?token={t}` opens directly on the file for a guest, claiming the token (same effect as `/s/{t}`) — no folder load.
- [ ] The viewer's Share popover copies a `/view/{fileId}?token={t}` link ("share + view in one").
- [ ] The same folder token works stitched onto any file in that folder.
- [ ] Every listed share link is re-copyable (Copy button), with a correct per-link "Copied!".
- [ ] Invalid/expired/revoked token shows a clear "link no longer valid" state, not a generic error.
- [ ] No backend / proxy-rule / schema / ACL changes.
