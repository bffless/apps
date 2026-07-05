/**
 * Pure request/paging math for the server-side items endpoint. The server only
 * ever returns pages newest-first, so an "oldest first" client page has to be
 * translated into the newest-first server page that holds the same rows, read
 * in reverse ({@link buildItemsQuery}'s `reverse` flag tells the caller to
 * flip the returned page before rendering). No I/O, no React — this is the
 * tested seam between a {@link Selection} + page and the request `api.ts`
 * issues.
 */

import type { Selection } from './river'

/** Client-chosen sort: newest-first (server's native order) or oldest-first. */
export type SortOrder = 'newest' | 'oldest'

/** Items page size — shared by client paging math and the request itself. */
export const PAGE_SIZE = 20

/** What `buildItemsQuery` produces: the request params, and whether the caller must reverse the returned page. */
export type ItemsQuery = {
  params: URLSearchParams
  reverse: boolean
}

/** The `view` query param for a selection — the server-side counterpart of `selectionKey`. */
export function viewOf(sel: Selection): 'all' | 'river' | 'starred' | 'feed' | 'folder' {
  return sel.kind
}

/**
 * Build the request params + reverse flag for a selection/page/order. Oldest-first
 * pages are served by requesting the mirrored newest-first server page (last
 * client page ↔ first server page) and having the caller reverse the rows; that
 * requires knowing `total` up front, so a `total===null` first load falls back to
 * requesting the same page newest-first — the caller re-issues once `total` is known.
 */
export function buildItemsQuery(
  sel: Selection,
  page: number,
  limit: number,
  order: SortOrder,
  total: number | null,
): ItemsQuery {
  let serverPage = page
  let reverse = false

  if (order === 'oldest') {
    if (total === null) {
      serverPage = page
      reverse = false
    } else {
      const totalPages = Math.max(1, Math.ceil(total / limit))
      const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max)
      serverPage = clamp(totalPages - page + 1, 1, totalPages)
      reverse = true
    }
  }

  const params = new URLSearchParams()
  params.set('view', viewOf(sel))
  if (sel.kind === 'feed') params.set('feedId', sel.url)
  if (sel.kind === 'folder') params.set('folder', sel.name)
  params.set('page', String(serverPage))
  params.set('limit', String(limit))

  return { params, reverse }
}
