# Handoff — UX overhaul (impeccable pass)

> Outcome of a `/grill-with-docs` session. Design decisions live in `docs/adr/0003` (visual identity
> + tokens) and `docs/adr/0004` (listing/nav/action IA). This file is the **sequenced build plan**.
> Execution: `/impeccable:impeccable`, verified in headless Chrome. Worktree: `handoff-ux` off `main`.

## Resolved constraints

- **Goal**: full audit → prioritized fixes, **all 10 workstreams in scope** (Tiers 1–3).
- **Scope**: **frontend-only** — `src/**`, `index.css`, `public/favicon.svg`. No proxy-rule / MSW
  changes. ⇒ cross-tree search deferred; Rename/Move deferred (no endpoints); Delete arrives via
  `feat/handoff-delete`.
- **Audience**: uploader/manager first.
- **Identity**: bolder + delightful; **own violet/indigo accent**; token system; **light + dark**
  (header toggle, default = system, persisted).

## Build sequence

Ordered so each step rests on the previous; verify in headless Chrome after each phase.

1. **Design tokens & theme** (ADR-0003) — `@theme` in `index.css`: accent scale + semantic role
   tokens (folder/site/file/edit/danger/surface/border/text), shadow scale, motion primitives, type
   scale. Wire dark mode (`color-scheme`, `.dark` strategy, `localStorage` + system default).
   *Substrate for everything below.*
2. **App shell & header** — migrate `App.tsx` shell to tokens; add **dark-mode toggle** + compact
   **account menu**; add `public/favicon.svg` (accent glyph). `prefers-reduced-motion` respected.
3. **Table/list-hybrid listing** (ADR-0004) — replace card-rows with a sortable table: file-type
   iconography (Folder/File/Site distinct + PDF/image/video/md), `size` + **Added** columns, sort by
   name/date/size. Within-folder **filter** box above it.
4. **Kebab row actions** — `⋮` menu per row: **Open + Copy link** now; reserved slots for Delete
   (merge) / Rename / Move (future). Fold the per-row copy button into it.
5. **"New ▾" menu + persistent dropzone** — collapse the four upload controls into one menu; make the
   drag-drop target **always visible**. Preserve the existing Site-or-tree import flow underneath.
6. **Unified Share dialog** — one component (People/grants + share-link sections) opened from folder
   toolbar, row kebab, and viewer; replaces `ManageAccessPanel` panel + viewer Share popover +
   ad-hoc copy. File context reads "shares the containing folder".
7. **Empty / loading / no-results states** — characterful, accent-tinted, primary "New ▾" CTA;
   per-context copy (root / sub-folder / no-access / filtered-empty); **skeletons** for table + tree.
8. **Persistent sidebar folder tree** — lazy-loaded (per-parent `listNodes`), ACL-aware, current
   folder highlighted, share-mode scoped, mobile drawer. (Heaviest item — do after the listing is
   stable.)
9. **Toast system + feedback hybrid** — global toasts for transient confirmations; keep
   detail/located feedback inline (partial-import failures, post-upload copy-link, access errors).
10. **Viewer & motion polish** — restyle the viewer control bar to tokens (Share opens the unified
    dialog), richer upload progress, hover/transition micro-interactions throughout.

## Verification

- After each phase: `node localdev-tools/shot.mjs` screenshots + console/network smoke (per root
  `CLAUDE.md`). Seed a session cookie for authed flows.
- Run `pnpm -C apps/handoff test` + `lint` + `build`; the mock-first contract means every screen
  works against MSW with no live backend.

## Status — all 10 phases shipped (worktree `handoff-ux`)

All phases built and verified in headless Chrome (light + dark); `pnpm test` (207),
`lint`, and `build` green. Notable additions discovered during the build:

- **Button reset** in `index.css` — Tailwind preflight isn't imported, so bare `<button>`s
  were picking up the UA border/background (boxes around sort headers / kebabs). Added a
  scoped reset.
- **`.markdown-body` styles** — there's no typography plugin, so the viewer's rendered
  markdown is styled against tokens directly (light + dark).
- **Viewer Share** now opens the same `ShareDialog` (toolbar + kebab + viewer all unified).
- Reusable primitives added: `components/Menu` (portal + keyboard), `components/icons`,
  `lib/theme`, `lib/toast` + `components/Toaster`, `components/FolderTree`,
  `components/ShareDialog`, `lib/fileKind`.
- The `<blockquote>` left-border in `.markdown-body` is the canonical rendered-markdown
  convention (not the banned decorative card side-stripe); left as-is intentionally.

## Deferred (follow-up list, not discarded)

- Cross-tree search (needs a search endpoint).
- Rename / Move (need endpoints).
- Bulk select + bulk actions (pairs with Delete).
- Card-grid/thumbnail view toggle.
- Anchoring identity to the BFFless brand.
