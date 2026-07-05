import { describe, expect, it } from 'vitest'
import {
  pageFromSearch,
  pathForItem,
  pathForSelection,
  selectionFromParams,
  viewFromPathname,
  withPage,
  type RouteParams,
} from './route'
import type { Selection } from './river'

/**
 * Simulate what react-router hands `ReaderApp`: derive the view from the
 * pathname and read the dynamic segment back decoded (the router applies
 * `decodeURIComponent` to `useParams()` values). This closes the round-trip so
 * a test asserts path → selection is the inverse of selection → path.
 */
function paramsForPath(pathname: string): RouteParams {
  const segs = pathname.split('/').filter(Boolean)
  const view = viewFromPathname(pathname)
  const params: RouteParams = { view }
  if (view === 'folder') params.folder = decodeURIComponent(segs[1] ?? '')
  if (view === 'feed') params.feedId = decodeURIComponent(segs[1] ?? '')
  return params
}

const VIEW_SELECTIONS: Selection[] = [
  { kind: 'river' },
  { kind: 'all' },
  { kind: 'starred' },
  { kind: 'folder', name: 'Tech' },
  { kind: 'feed', url: 'https://example.com/feed.xml' },
]

describe('pathForSelection', () => {
  it('maps each view to its path', () => {
    expect(pathForSelection({ kind: 'river' })).toBe('/')
    expect(pathForSelection({ kind: 'all' })).toBe('/all')
    expect(pathForSelection({ kind: 'starred' })).toBe('/starred')
    expect(pathForSelection({ kind: 'folder', name: 'Tech' })).toBe('/folder/Tech')
    expect(pathForSelection({ kind: 'feed', url: 'https://a.com/f' })).toBe(
      '/feed/https%3A%2F%2Fa.com%2Ff',
    )
  })

  it('percent-encodes folder names with unsafe characters', () => {
    expect(pathForSelection({ kind: 'folder', name: 'News & Tech / Daily' })).toBe(
      '/folder/News%20%26%20Tech%20%2F%20Daily',
    )
  })
})

describe('pathForItem', () => {
  it('nests the item under its view path', () => {
    expect(pathForItem({ kind: 'river' }, 'g1')).toBe('/item/g1')
    expect(pathForItem({ kind: 'all' }, 'g1')).toBe('/all/item/g1')
    expect(pathForItem({ kind: 'starred' }, 'g1')).toBe('/starred/item/g1')
    expect(pathForItem({ kind: 'folder', name: 'Tech' }, 'g1')).toBe('/folder/Tech/item/g1')
    expect(pathForItem({ kind: 'feed', url: 'https://a.com/f' }, 'g1')).toBe(
      '/feed/https%3A%2F%2Fa.com%2Ff/item/g1',
    )
  })

  it('percent-encodes guids with unsafe characters', () => {
    expect(pathForItem({ kind: 'river' }, 'tag:example.com,2024:/post?id=1&x')).toBe(
      '/item/tag%3Aexample.com%2C2024%3A%2Fpost%3Fid%3D1%26x',
    )
  })
})

describe('viewFromPathname', () => {
  it('derives the view from the first segment, including item forms', () => {
    expect(viewFromPathname('/')).toBe('river')
    expect(viewFromPathname('/item/g1')).toBe('river')
    expect(viewFromPathname('/all')).toBe('all')
    expect(viewFromPathname('/all/item/g1')).toBe('all')
    expect(viewFromPathname('/starred/item/g1')).toBe('starred')
    expect(viewFromPathname('/folder/Tech/item/g1')).toBe('folder')
    expect(viewFromPathname('/feed/https%3A%2F%2Fa.com%2Ff')).toBe('feed')
  })

  it('treats an unknown first segment as the river', () => {
    expect(viewFromPathname('/bogus/path')).toBe('river')
  })
})

describe('selectionFromParams', () => {
  it('maps params to a selection', () => {
    expect(selectionFromParams({ view: 'river' })).toEqual({ kind: 'river' })
    expect(selectionFromParams({ view: 'all' })).toEqual({ kind: 'all' })
    expect(selectionFromParams({ view: 'starred' })).toEqual({ kind: 'starred' })
    expect(selectionFromParams({ view: 'folder', folder: 'Tech' })).toEqual({
      kind: 'folder',
      name: 'Tech',
    })
    expect(selectionFromParams({ view: 'feed', feedId: 'https://a.com/f' })).toEqual({
      kind: 'feed',
      url: 'https://a.com/f',
    })
  })

  it('falls back to an empty-keyed selection for a missing id (no crash)', () => {
    expect(selectionFromParams({ view: 'folder' })).toEqual({ kind: 'folder', name: '' })
    expect(selectionFromParams({ view: 'feed' })).toEqual({ kind: 'feed', url: '' })
  })
})

describe('pageFromSearch', () => {
  it('reads the page number from the query string', () => {
    expect(pageFromSearch('?page=3')).toBe(3)
    expect(pageFromSearch('?page=1')).toBe(1)
    expect(pageFromSearch('?page=42')).toBe(42)
  })

  it('reads page alongside other query params', () => {
    expect(pageFromSearch('?foo=bar&page=5')).toBe(5)
    expect(pageFromSearch('?page=5&foo=bar')).toBe(5)
  })

  it('defaults to 1 when absent or empty', () => {
    expect(pageFromSearch('')).toBe(1)
    expect(pageFromSearch('?')).toBe(1)
    expect(pageFromSearch('?foo=bar')).toBe(1)
  })

  it('clamps non-numeric or non-positive values to 1', () => {
    expect(pageFromSearch('?page=abc')).toBe(1)
    expect(pageFromSearch('?page=0')).toBe(1)
    expect(pageFromSearch('?page=-4')).toBe(1)
    expect(pageFromSearch('?page=')).toBe(1)
  })

  it('floors fractional values', () => {
    expect(pageFromSearch('?page=2.9')).toBe(2)
  })
})

describe('withPage', () => {
  it('appends ?page for pages beyond the first', () => {
    expect(withPage('/feed/abc', 3)).toBe('/feed/abc?page=3')
    expect(withPage('/', 2)).toBe('/?page=2')
  })

  it('omits ?page for page 1 (clean path)', () => {
    expect(withPage('/feed/abc', 1)).toBe('/feed/abc')
    expect(withPage('/', 1)).toBe('/')
  })

  it('preserves an existing query string when adding page', () => {
    expect(withPage('/feed/abc?foo=bar', 3)).toBe('/feed/abc?foo=bar&page=3')
  })

  it('replaces an existing page rather than duplicating it', () => {
    expect(withPage('/feed/abc?page=2', 4)).toBe('/feed/abc?page=4')
    expect(withPage('/feed/abc?foo=bar&page=2', 4)).toBe('/feed/abc?foo=bar&page=4')
  })

  it('drops an existing page when navigating back to page 1', () => {
    expect(withPage('/feed/abc?page=2', 1)).toBe('/feed/abc')
    expect(withPage('/feed/abc?foo=bar&page=2', 1)).toBe('/feed/abc?foo=bar')
  })
})

describe('round-trip: selection → path → params → selection', () => {
  it('recovers each view selection through the URL', () => {
    for (const sel of VIEW_SELECTIONS) {
      const path = pathForSelection(sel)
      expect(selectionFromParams(paramsForPath(path))).toEqual(sel)
    }
  })

  it('recovers the view when an item is open under it', () => {
    for (const sel of VIEW_SELECTIONS) {
      const path = pathForItem(sel, 'the-guid')
      expect(selectionFromParams(paramsForPath(path))).toEqual(sel)
    }
  })

  it('round-trips identifiers with unsafe characters through encode/decode', () => {
    const folder: Selection = { kind: 'folder', name: 'News & Tech / Daily' }
    const feed: Selection = { kind: 'feed', url: 'https://a.com/f?q=1&x=/y' }
    expect(selectionFromParams(paramsForPath(pathForSelection(folder)))).toEqual(folder)
    expect(selectionFromParams(paramsForPath(pathForSelection(feed)))).toEqual(feed)

    // The item guid survives the same encode → router-decode round-trip.
    const guid = 'tag:example.com,2024:/post?id=1&x=/y'
    const itemPath = pathForItem(feed, guid)
    const seg = itemPath.split('/item/')[1]
    expect(decodeURIComponent(seg)).toBe(guid)
  })
})
