/**
 * Desktop pane-layout constants + pure helpers (#140).
 *
 * The desktop reading surface is an Outlook-style three-region layout: a
 * resizable/collapsible feed sidebar, the item list, and the reading pane, each
 * scrolling within its own container under a fixed header. The horizontal split
 * between the sidebar and the rest is driven by `react-resizable-panels`, whose
 * sizes are **percentages of the group** (0..100).
 *
 * These constants live here, in one place, so the sizing is trivial to tune and
 * the small size/scroll decisions stay pure and unit-testable — mirroring the
 * reading-width preset convention in {@link ./width.ts}.
 */

/** Group identity for `useDefaultLayout` localStorage persistence, and stable panel ids. */
export const PANES_STORAGE_ID = 'rivulet:panes'
export const SIDEBAR_PANEL_ID = 'sidebar'
export const CONTENT_PANEL_ID = 'content'

/**
 * The content region is itself a nested horizontal split — a resizable item list
 * and the reading pane — so the list column can be dragged wider (its own group,
 * persisted separately from the sidebar split above).
 */
export const CONTENT_STORAGE_ID = 'rivulet:content-panes'
export const LIST_PANEL_ID = 'list'
export const READING_PANEL_ID = 'reading'

/** Item-list column width as a percentage of the content group, with min/max bounds. */
export const LIST_DEFAULT_SIZE = 36
export const LIST_MIN_SIZE = 24
export const LIST_MAX_SIZE = 62

/** The reading pane never shrinks below this share of the content group. */
export const READING_MIN_SIZE = 30

// ⚠️ These are percentages, but `react-resizable-panels` v4 reads bare numeric
// panel sizes as *pixels* — pass them to `Panel` as `%` strings (e.g. `22%`).

/** Sidebar width as a percentage of the group, with enforced min/max bounds. */
export const SIDEBAR_DEFAULT_SIZE = 22
export const SIDEBAR_MIN_SIZE = 14
export const SIDEBAR_MAX_SIZE = 42

/** The content region (list + reading pane) never shrinks below this share. */
export const CONTENT_MIN_SIZE = 45

/**
 * Collapsed width, in **pixels**, of the feed sidebar's icon rail. Collapsing
 * doesn't hide the sidebar — it shrinks to this fixed strip of square icon
 * buttons (River / All / ★ / one per feed), so feeds stay switchable while the
 * list + reading panes reclaim the width. Passed to `Panel` as `collapsedSize`
 * (the library accepts a `px`-suffixed string; see the pixels-vs-% note above).
 */
export const SIDEBAR_RAIL_PX = 56

/**
 * The measured-width bound (pixels) at or below which the sidebar is the
 * collapsed icon rail. `react-resizable-panels` reports each panel's pixel width
 * via `onResize`; the rail sits at {@link SIDEBAR_RAIL_PX}, while the smallest
 * *expanded* sidebar is `SIDEBAR_MIN_SIZE`% of the group — ≳130px on any desktop
 * viewport — so this bound cleanly separates the two with room for rounding.
 */
export const SIDEBAR_COLLAPSED_MAX_PX = 96

/** Whether a measured sidebar width (pixels) is the collapsed icon-rail state. */
export function isCollapsedWidth(px: number): boolean {
  return Number.isFinite(px) && px <= SIDEBAR_COLLAPSED_MAX_PX
}

/** How far a page-down keystroke advances a scroll container, as a fraction of its height. */
export const PAGE_SCROLL_FRACTION = 0.9

/**
 * The pixel delta a `space`/page keystroke should scroll a container — a shade
 * under a full page so a line of context carries over. Clamps negatives (a
 * zero-height/unmeasured container) to 0.
 */
export function pageScrollDelta(clientHeight: number): number {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return 0
  return Math.round(clientHeight * PAGE_SCROLL_FRACTION)
}
