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

// ⚠️ These are percentages, but `react-resizable-panels` v4 reads bare numeric
// panel sizes as *pixels* — pass them to `Panel` as `%` strings (e.g. `22%`).

/** Sidebar width as a percentage of the group, with enforced min/max bounds. */
export const SIDEBAR_DEFAULT_SIZE = 22
export const SIDEBAR_MIN_SIZE = 14
export const SIDEBAR_MAX_SIZE = 42

/** The content region (list + reading pane) never shrinks below this share. */
export const CONTENT_MIN_SIZE = 45

/**
 * A collapsible panel reports its collapsed size (0%) via `onResize`; anything at
 * or below this threshold counts as collapsed. Kept just above 0 to absorb
 * sub-pixel rounding without a real, narrow sidebar reading as collapsed.
 */
export const COLLAPSED_THRESHOLD = 0.5

/** Whether a panel size (percentage of the group) should be treated as collapsed. */
export function isCollapsedSize(pct: number): boolean {
  return pct <= COLLAPSED_THRESHOLD
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
