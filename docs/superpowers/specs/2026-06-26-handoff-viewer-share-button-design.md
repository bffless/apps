# Handoff viewer Share button — design

**Date:** 2026-06-26
**Issue:** [bffless/apps#23](https://github.com/bffless/apps/issues/23) — "handoff: add Share control to the viewer toolbar"
**Scope:** Option A (folder-scoped Share button in the viewer). Option B (per-item links) is explicitly out of scope.

## Problem

The handoff viewer's control bar (`HandoffViewer` → `ControlBar`) renders only **Back / Open in new tab / Fullscreen / Download**. The design spec (`apps/handoff/stories/00-architecture-and-design.md`) calls for a **Share** control there, but it was never implemented. Today, creating a share link is only reachable from a **folder** page: `FolderView` → "Manage access" (owner-only) → `ManageAccessPanel` → "Share links". A user viewing a file or site has no discoverable way to share it.

The backend already supports share links end-to-end (mint/list/revoke + claim). This is a **frontend-only** gap.

## Goal

Add a **Share** control to the viewer control bar that mints/copies/revokes a share link **scoped to the viewed item's parent folder**, reusing the existing endpoints and share UI, shown only to users who can manage that folder.

## Non-goals

- Per-item / per-file / per-site share links (Option B — a larger ACL + proxy-rule change).
- Grants / people management (add person, directory search) inside the viewer — that stays on the folder page's "Manage access".
- Any backend / proxy-rule change. Existing endpoints are sufficient.

## Background: how access works today

- **ACL evaluation** is the pure function `lib/acl.ts:evaluateAccess({ folderChain, viewer })` → `'none' | 'view' | 'edit' | 'owner'`. `FolderView` derives `canManage = effectiveLevel === 'owner'` and uses it to show "Manage access".
- **Share-link mint** (`POST /api/share-links`, via `useMintShareLinkMutation`) is authorized **server-side** on the **target folder's `ownerId`** (or `admin` role). List/revoke likewise. The server is the source of truth; the frontend gate only decides whether to *show* the control.
- **`HandoffNode`** (`lib/nodes.ts`) carries `parentId` (`'root'` for top-level items) and, for folders, `ownerId`.
- **Share UI** lives as a private `ShareLinksSection` component inside `components/ManageAccessPanel.tsx` (create with expiry, list active/revoked, copy, revoke). It already takes a single `folderId` prop.
- **Tests** in this app are pure-function unit tests (`lib/*.test.ts`); there is no component/RTL harness. UI is validated via MSW mocks + the headless browser.

## Design

### 1. Gating helper (pure, unit-tested)

Add a small pure helper that decides whether the current viewer may share the parent folder:

```ts
// lib/acl.ts (or a focused new lib module + test)
export function canShareParentFolder(input: {
  session: Session | null
  parentNode: HandoffNode | undefined   // the node.parentId folder, or undefined while loading / for root
}): boolean
```

Rule (mirrors the server's mint authorization exactly):

```
isAdmin                         → true
parentNode?.ownerId === userId  → true
otherwise                       → false
```

Rationale for gating on the **immediate parent's `ownerId`** rather than running full `evaluateAccess` over the ancestor chain:

- The mint endpoint authorizes on the **target folder's `ownerId`/admin** — so this is the *exact* predicate the server will enforce. Showing the button when mint would 403 (or hiding it when mint would succeed) is the failure mode to avoid, and immediate-parent ownership matches mint 1:1.
- It avoids importing the breadcrumb ancestor-resolution machinery (which `FolderView` drives via its `Breadcrumb`) into the viewer, which has no such chain today.
- It is a pure function, trivially unit-testable in the existing `lib/*.test.ts` style.

### 2. Reuse the share UI

Extract `ShareLinksSection` out of `components/ManageAccessPanel.tsx` into its own file `components/ShareLinksSection.tsx` and export it. **No behavior change** — `ManageAccessPanel` imports it back and renders it exactly as before. This makes the share UI reusable by the viewer without duplicating mint/list/copy/revoke logic.

Add a one-line **scope clarifier** to `ShareLinksSection` (or pass it as a prop/caption from the viewer): *"Anyone with the link can view this folder and everything in it."* This satisfies the acceptance criterion that copy makes the folder-wide grant clear. (Confirm placement so it reads well in both the folder panel and the viewer popover — a caption under the "Share links" heading works for both.)

### 3. Viewer Share control

In `pages/HandoffViewer.tsx` `ControlBar`:

- `ControlBar` gains `useSession()` and `useGetNodeQuery(node.parentId, { skip: node.parentId === 'root' })` to obtain the viewer identity and the parent folder's `ownerId`.
- Compute `canShare = canShareParentFolder({ session, parentNode })`.
- Render a **Share** button between "Open in new tab" and the existing controls (matching the spec ordering: Back, title, Share, Open, Fullscreen, Download). Use the existing button styling in the bar.
- Clicking toggles a small **popover** anchored to the button containing `<ShareLinksSection folderId={node.parentId} />` + the scope clarifier. Close on outside-click / Escape (follow the existing `DirectorySearch` outside-click pattern already in the codebase).

### 4. Root-level disabled state

When `node.parentId === 'root'` there is no folder to scope to. Render the Share button **disabled** with a tooltip / inline note: *"Move this into a folder to share it."* No dead button, no popover. This is shown regardless of ownership (root items simply aren't shareable via Option A).

### 5. Share-mode / guest visitors

A visitor who arrived via a share link has a guest session and won't match `parentNode.ownerId`, so `canShare` is `false` and the button is hidden. No special-casing required — the gate already excludes them.

## Data flow

```
HandoffViewer (node via useGetNodeQuery(id))
  └─ ControlBar(node)
       ├─ useSession()                                  → viewer identity
       ├─ useGetNodeQuery(node.parentId, skip=root)     → parentNode.ownerId
       ├─ canShareParentFolder({ session, parentNode }) → canShare
       └─ Share button
            ├─ parentId === 'root' → disabled + tooltip
            ├─ !canShare           → hidden
            └─ canShare            → popover → ShareLinksSection(folderId=parentId)
                                                  └─ mint/list/copy/revoke (existing endpoints)
```

## Error handling

- `ShareLinksSection` already handles 403 on mint ("You do not have permission…") and generic failures — reused unchanged. Server remains the authority even if the client gate is ever wrong.
- While `parentNode` is still loading, `canShare` is `false` (button hidden, not flashing) — same "wait until resolved" principle `FolderView` uses with `chainReady`.

## Testing & validation

**Unit (pure):**
- `canShareParentFolder` — admin true; matching owner true; non-owner false; `undefined`/loading parent false; root (no parentNode) false.

**Visual / integration (MSW + headless browser, per `localdev-tools/`):**
- Owner session + a node with a folder parent → Share button visible; popover opens; mint flow renders a link + copy.
- Root-level node (`parentId === 'root'`) → Share button disabled with tooltip.
- Non-owner session → no Share button.

**Live dogfood:** mint a real share link for a folder via the `j5s-dev` MCP API key, open `/s/{token}` headless to confirm the end-to-end claim → view path still works after the change.

## Files touched

| File | Change |
| --- | --- |
| `lib/acl.ts` (+ `lib/acl.test.ts`) | Add `canShareParentFolder` pure helper + tests (or a focused new `lib/` module). |
| `components/ShareLinksSection.tsx` | **New** — extracted from `ManageAccessPanel.tsx`, exported. Add scope clarifier. |
| `components/ManageAccessPanel.tsx` | Import the extracted `ShareLinksSection` (no behavior change). |
| `pages/HandoffViewer.tsx` | `ControlBar` gains session + parent query + Share button + popover + root disabled state. |

## Acceptance criteria (from the issue) — to verify at completion

- [ ] Viewer control bar shows a Share control for users who can manage the item's parent folder.
- [ ] Mints / copies / revokes a share link for the parent folder via existing endpoints.
- [ ] Root-level items show a clear disabled/explanatory state (no dead button).
- [ ] Copy clarifies the link grants View to the folder + its contents.

How each is covered by this design: the Share button + `canShareParentFolder` gate (criterion 1); reused `ShareLinksSection` calling the existing endpoints (criterion 2); the `parentId === 'root'` disabled state (criterion 3); the scope clarifier copy (criterion 4).
