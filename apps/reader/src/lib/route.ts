/**
 * URL ↔ selection mapping — the pure, tested seam for story #144 (RESTful
 * routing). The URL is the single source of truth for which view / folder /
 * feed is selected and which item is open, so every navigable state survives a
 * hard reload and Back / Forward + bookmarking work.
 *
 * The internal {@link Selection} keys a feed by its `url`, a folder by its
 * `name`, and an item by its `guid` — none URL-safe — so each is carried in the
 * path as `encodeURIComponent(...)` of that value and read back as the
 * router-decoded param (react-router decodes `useParams()` for us, which is the
 * exact inverse of `encodeURIComponent`). Keeping the mapping here means
 * `ReaderApp` only orchestrates `navigate(...)`; the decisions are unit-tested.
 *
 * URL scheme:
 *
 * | View        | Path                    |
 * | ----------- | ----------------------- |
 * | River (home)| `/`                     |
 * | All items   | `/all`                  |
 * | Starred     | `/starred`              |
 * | A folder    | `/folder/:folder`       |
 * | A feed      | `/feed/:feedId`         |
 * | An open item| `<view-path>/item/:itemId` |
 */

import type { Selection } from './river'

/** The view a path selects, independent of any open item. */
export type ViewName = 'river' | 'all' | 'starred' | 'folder' | 'feed'

/**
 * The route params as react-router surfaces them (already %-decoded): `folder`
 * and `feedId` are the raw folder name / feed url. `view` is derived from the
 * pathname (see {@link viewFromPathname}) since it isn't a dynamic segment.
 */
export type RouteParams = {
  view: ViewName
  folder?: string
  feedId?: string
}

/** The path for a view selection — the base under which an item nests. */
export function pathForSelection(sel: Selection): string {
  switch (sel.kind) {
    case 'river':
      return '/'
    case 'all':
      return '/all'
    case 'starred':
      return '/starred'
    case 'folder':
      return `/folder/${encodeURIComponent(sel.name)}`
    case 'feed':
      return `/feed/${encodeURIComponent(sel.url)}`
  }
}

/**
 * The path for an open item in the context of its view — the item form nests
 * under whichever view it was opened from (`/feed/:feedId/item/:itemId`,
 * `/item/:itemId` from the river, …). `itemId` is the item's guid.
 */
export function pathForItem(sel: Selection, itemId: string): string {
  const base = pathForSelection(sel)
  const item = `item/${encodeURIComponent(itemId)}`
  return base === '/' ? `/${item}` : `${base}/${item}`
}

/**
 * The {@link ViewName} a pathname selects. The view keyword is always the first
 * segment, so item forms (`/all/item/:id`, `/item/:id`) resolve to the same
 * view as their base. Anything unrecognized — including `/` and `/item/:id` —
 * is the river.
 */
export function viewFromPathname(pathname: string): ViewName {
  const first = pathname.split('/').filter(Boolean)[0]
  switch (first) {
    case 'all':
      return 'all'
    case 'starred':
      return 'starred'
    case 'folder':
      return 'folder'
    case 'feed':
      return 'feed'
    default:
      return 'river'
  }
}

/**
 * The internal {@link Selection} for a set of route params. Params carry the
 * already-decoded folder name / feed url, so this maps straight through. An
 * unknown / missing folder or feed id yields an empty-keyed selection (which
 * scopes to an empty list rather than crashing) — the caller keeps the view.
 */
export function selectionFromParams(params: RouteParams): Selection {
  switch (params.view) {
    case 'all':
      return { kind: 'all' }
    case 'starred':
      return { kind: 'starred' }
    case 'folder':
      return { kind: 'folder', name: params.folder ?? '' }
    case 'feed':
      return { kind: 'feed', url: params.feedId ?? '' }
    case 'river':
    default:
      return { kind: 'river' }
  }
}
