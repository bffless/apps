# Listing, navigation & action information architecture

**Decision.** The uploader/manager surface is restructured around four patterns:

1. **Table/list-hybrid listing** — rows become a sortable table (icon+name, type, size, **Added**
   date), with real file-type iconography that distinguishes a [[Folder]] from a [[File]] from a
   [[Site]] (today they share a generic icon) and per-kind icons for PDF/image/video/markdown.
   Sortable by name/date/size; collapses to compact rows on mobile.
2. **Persistent sidebar folder tree** — a collapsible left-hand tree of [[Folder]]s beside the
   listing, lazy-loading children via the existing per-parent `listNodes`, highlighting the current
   folder, ACL-aware (folders the viewer can't see don't appear), scoped to the shared subtree in
   share-link mode, and collapsing to a drawer on mobile.
3. **One "New ▾" menu + a persistent drop target** — the four upload controls (Upload / Upload
   folder / Upload .zip / New folder) collapse into a single `New ▾` menu, and the drag-drop zone is
   **always visible** (today it only appears mid-drag, so it's undiscoverable).
4. **Kebab (⋮) row actions + one Share dialog everywhere** — each row gets a `⋮` overflow menu;
   Share/Copy-link, and (when their endpoints exist) Rename/Move/Delete live there. A **single Share
   component** (People/[[Grant]]s + [[Share Link]] sections) opens identically from the folder
   toolbar, the row kebab, and the viewer — replacing today's split between `ManageAccessPanel`, the
   viewer Share popover, and the per-row copy button.

**Feedback** is **hybrid**: transient confirmations (link copied, uploaded, granted) are toasts;
detail-bearing or located feedback (which files failed an import, the post-upload copy-link panel,
access errors) stays inline near its action.

**Why.**
- The uploader/manager is the prioritized audience and the listing is their main screen; a table is
  the most scannable home for many items and surfaces metadata the data already carries (`createdAt`,
  `size`, `type`) at zero API cost.
- A sidebar tree matches how people organize deep folder structures and is the natural anchor for a
  future move-via-drag — and it's buildable frontend-only on the per-parent listing that already
  exists.
- Collapsing four add-controls into one menu and making the dropzone persistent removes real
  sprawl/discoverability friction.
- One Share surface everywhere kills the three-way inconsistency; because [[Grant]]s and
  [[Share Link]]s are both **folder-scoped**, sharing a file is framed as "shares the containing
  folder" (root-level items can't be shared — they have no folder).

**Consequence.**
- **Rename/Move/Delete are not built this pass.** Scope is **frontend-only** and there are no
  rename/move endpoints; **Delete** is being implemented on `feat/handoff-delete` in a separate
  session. The kebab ships with **Open + Copy link** and reserves clean slots for Delete (merge) and
  Rename/Move (future — needs API). We do **not** build dead menu items. Coordinate the kebab's
  Delete item with the delete branch at merge time.
- Empty/loading/no-results states are authored per context (root vs sub-folder vs no-access vs
  filtered-no-results); loading uses **skeleton rows + tree skeleton**, not "Loading…".
- A **within-folder filter** box sits above the listing; cross-tree search is deferred (it would need
  a new endpoint, out of frontend-only scope).
- Builds on the token system in [[#docs/adr/0003-bold-visual-identity-design-tokens]].
